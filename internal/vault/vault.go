// Package vault 把 rclone 的 chunker → crypt → webdav 三层组装成一个可用的“密文库”。
//
// 关键点：
//   - 用 connection string 组装，不落任何 rclone 配置文件，避免密钥在磁盘上出现第二份；
//   - 加密/文件名加密/分片全部由 rclone 的成熟实现完成，本包不含任何密码学代码；
//   - 只向上暴露 List / Upload / OpenRange 这类原语，方便后面换成自带驱动。
package vault

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	_ "github.com/rclone/rclone/backend/chunker"
	_ "github.com/rclone/rclone/backend/crypt"
	_ "github.com/rclone/rclone/backend/webdav"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/obscure"
	"github.com/rclone/rclone/fs/object"

	"vaultd/internal/cloud139"
	"vaultd/internal/dav"
	"vaultd/internal/localcfg"
)

// Entry 是列表页需要的最小信息。
type Entry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Dir     bool      `json:"dir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
}

type Vault struct {
	f      fs.Fs
	conn   string
	closer io.Closer

	// 原始修改时间索引：云盘只记「上传时间」，而照片/文档真正的拍摄、修改时间
	// 只在上传端拿得到。这里把 path → (mtime,size) 存成密文里的一张小表，
	// 跟着 crypt 一起加密，多设备打开同一把钥匙都能看到原始时间。
	idxMu     sync.Mutex
	idx       map[string]metaEntry
	idxLoaded bool
	idxDirty  bool
	idxTimer  *time.Timer
}

// metaName 是索引文件在密文库根目录下的名字；列表里会被隐藏。
const metaName = ".vaultd-index.json"

type metaEntry struct {
	MTime int64 `json:"mtime"`
	Size  int64 `json:"size"`
}

// ConnectionString 组装 chunker(crypt(webdav)) 三层。
//
// 说明：chunker 在外、crypt 在内 —— 云端看到的是整段被加密的文件名，
// 连 .rclone_chunk 这类结构性后缀都不会泄露，也没有工具指纹。
func ConnectionString(c *localcfg.Config) (string, error) {
	obscKey, err := obscure.Obscure(c.MasterKey)
	if err != nil {
		return "", fmt.Errorf("主密钥处理失败: %w", err)
	}
	obscSalt, err := obscure.Obscure(c.Salt)
	if err != nil {
		return "", fmt.Errorf("盐处理失败: %w", err)
	}
	obscPass, err := obscure.Obscure(c.WebDAVPass)
	if err != nil {
		return "", fmt.Errorf("WebDAV 口令处理失败: %w", err)
	}

	// connection string 的引号规则：值里含 ':' 或 ',' 要用引号包住；
	// 被引号包住的值里若还有引号，就把引号双写。
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

	url := strings.TrimRight(c.WebDAVURL, "/")
	dav := ":webdav,url=" + q(url) +
		",user=" + q(c.WebDAVUser) +
		",pass=" + q(obscPass) +
		",vendor=" + q("other") +
		":" + strings.Trim(c.RemotePath, "/")

	cryptLayer := ":crypt,remote=" + q(dav) +
		",password=" + q(obscKey) +
		",password2=" + q(obscSalt) +
		",directory_name_encryption=true" +
		",filename_encryption=standard" +
		",filename_encoding=base32" +
		",suffix=none" +
		":"

	chunkSize := c.ChunkSize
	if chunkSize == "" {
		chunkSize = "500Mi"
	}
	return ":chunker,remote=" + q(cryptLayer) +
		",chunk_size=" + chunkSize +
		",name_format=" + q("*.rcc##") +
		":", nil
}

// Open 建立密文库。首次调用会顺带创建云端根目录。
//
// native 模式下不需要任何外部常驻进程：这里在进程内起一个最小的 WebDAV
// 端点（直连云盘），再把 rclone 的 webdav 层指向 127.0.0.1 上的这个端点。
func Open(ctx context.Context, c *localcfg.Config) (*Vault, error) {
	local := *c
	var closer io.Closer

	if c.Backend == "native" {
		if c.CloudProvider != "" && c.CloudProvider != "139" {
			return nil, fmt.Errorf("暂不支持的云盘类型: %s", c.CloudProvider)
		}
		hc := &http.Client{Timeout: 0}
		cl, err := cloud139.New(c.CloudAuth, hc, func(newAuth string) {
			c.CloudAuth = newAuth
			if err := c.Save(); err != nil {
				log.Printf("回写云端授权失败: %v", err)
			}
		})
		if err != nil {
			return nil, err
		}
		if err := cl.Start(ctx); err != nil {
			return nil, fmt.Errorf("云端鉴权失败: %w", err)
		}
		ds := dav.New(cl)
		base, err := ds.Start()
		if err != nil {
			return nil, err
		}
		closer = ds
		local.WebDAVURL = base
		local.WebDAVUser = ds.User
		local.WebDAVPass = ds.Pass
	}

	conn, err := ConnectionString(&local)
	if err != nil {
		if closer != nil {
			_ = closer.Close()
		}
		return nil, err
	}
	f, err := fs.NewFs(ctx, conn)
	if err != nil {
		if closer != nil {
			_ = closer.Close()
		}
		return nil, fmt.Errorf("无法连接云端: %w", err)
	}
	v := &Vault{f: f, conn: conn, closer: closer}
	if err := v.f.Mkdir(ctx, ""); err != nil {
		// 目录已存在时不同后端报错不一致，这里不当作致命错误
		fs.Logf(v.f, "确保根目录存在时返回: %v", err)
	}
	return v, nil
}

// Close 释放 native 模式下进程内的 WebDAV 端点。
func (v *Vault) Close() {
	if v != nil && v.closer != nil {
		_ = v.closer.Close()
	}
}

// List 列出目录。dir 用 '/'-分隔的相对路径，根为 ""。
func (v *Vault) List(ctx context.Context, dir string) ([]Entry, error) {
	dir = cleanRel(dir)
	list, err := v.f.List(ctx, dir)
	if err != nil {
		return nil, err
	}
	v.loadMeta(ctx)
	out := make([]Entry, 0, len(list))
	v.idxMu.Lock()
	for _, e := range list {
		name := path.Base(e.Remote())
		if name == "." || name == "/" || name == "" || name == metaName {
			continue
		}
		_, isDir := e.(fs.Directory)
		size := e.Size()
		mt := e.ModTime(ctx)
		if !isDir && size > 0 {
			// 只有「名字 + 大小」都对得上才采用记录的时间：
			// 同一路径被重新上传/覆盖时 cloud 时间才是准的。
			if m, ok := v.idx[path.Join("/", dir, name)]; ok && m.Size == size && m.MTime > 0 {
				mt = time.Unix(m.MTime, 0)
			}
		}
		out = append(out, Entry{
			Name:    name,
			Path:    path.Join("/", dir, name),
			Dir:     isDir,
			Size:    size,
			ModTime: mt,
		})
	}
	v.idxMu.Unlock()
	return out, nil
}

// Stat 返回对象（用于取真实解密后的大小）。
// Mkdir 建目录（父目录必须已存在）。手机上按文件夹上传时先走这一步，
// 这样传完当前目录里多出来的是「文件夹」，而不是一堆散文件。
func (v *Vault) Mkdir(ctx context.Context, remote string) error {
	remote = cleanRel(remote)
	if remote == "" {
		return errors.New("目录名不能为空")
	}
	return v.f.Mkdir(ctx, remote)
}

func (v *Vault) Stat(ctx context.Context, remote string) (fs.Object, error) {
	return v.f.NewObject(ctx, cleanRel(remote))
}

// Upload 以流式方式写入一个对象；size 必须准确（浏览器上传时取 Content-Length）。
// 分片内重传由上层决定，这里只做一次写入。
func (v *Vault) Upload(ctx context.Context, remote string, r io.Reader, size int64) error {
	return v.UploadAt(ctx, remote, r, size, time.Time{})
}

// UploadAt 带原始修改时间上传。mtime 为空时退化为上传时间。
func (v *Vault) UploadAt(ctx context.Context, remote string, r io.Reader, size int64, mtime time.Time) error {
	remote = cleanRel(remote)
	putTime := mtime
	if putTime.IsZero() {
		putTime = time.Now()
	}
	// 名字必须带上完整相对路径：Fs.Put 是按 info.Name() 落盘的，
	// 只给 Base 会把所有上传都丢到根目录（子目录名被吃掉）。
	info := object.NewStaticObjectInfo(remote, putTime, size, true, nil, v.f)
	if _, err := v.f.Put(ctx, r, info); err != nil {
		return err
	}
	// 云端只会记下「此刻」，真正的原始时间靠密文库里的索引补回来。
	v.rememberMeta(ctx, remote, size, putTime.Unix())
	return nil
}

// rememberMeta 记下某个路径的原始时间，并合并写盘（1.2s 内的多次上传只写一次）。
func (v *Vault) rememberMeta(ctx context.Context, remote string, size, mtime int64) {
	v.idxMu.Lock()
	v.loadMetaLocked(ctx)
	v.idx[path.Join("/", remote)] = metaEntry{MTime: mtime, Size: size}
	v.idxDirty = true
	needTimer := v.idxTimer == nil
	v.idxMu.Unlock()
	if needTimer {
		v.idxTimer = time.AfterFunc(1200*time.Millisecond, func() {
			fctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			if err := v.FlushMeta(fctx); err != nil {
				fs.Logf(v.f, "写时间索引失败: %v", err)
			}
		})
	}
}

// forgetMeta 删除某个路径（及它下面所有子项）的时间记录。
func (v *Vault) forgetMeta(ctx context.Context, remote string) {
	p := path.Join("/", cleanRel(remote))
	v.idxMu.Lock()
	v.loadMetaLocked(ctx)
	changed := false
	for k := range v.idx {
		if k == p || strings.HasPrefix(k, p+"/") {
			delete(v.idx, k)
			changed = true
			continue
		}
	}
	if changed {
		v.idxDirty = true
	}
	need := v.idxTimer == nil
	v.idxMu.Unlock()
	if changed && need {
		v.idxTimer = time.AfterFunc(1200*time.Millisecond, func() {
			fctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			_ = v.FlushMeta(fctx)
		})
	}
}

func (v *Vault) loadMeta(ctx context.Context) {
	v.idxMu.Lock()
	defer v.idxMu.Unlock()
	v.loadMetaLocked(ctx)
}

func (v *Vault) loadMetaLocked(ctx context.Context) {
	if v.idxLoaded {
		return
	}
	v.idxLoaded = true
	v.idx = map[string]metaEntry{}
	o, err := v.f.NewObject(ctx, metaName)
	if err != nil {
		return
	}
	rc, err := o.Open(ctx)
	if err != nil {
		return
	}
	defer rc.Close()
	var doc metaDoc
	if err := json.NewDecoder(io.LimitReader(rc, 16<<20)).Decode(&doc); err == nil && doc.Files != nil {
		v.idx = doc.Files
	}
}

type metaDoc struct {
	Version int                  `json:"version"`
	Files   map[string]metaEntry `json:"files"`
}

// FlushMeta 把内存里的时间索引写回密文库（小文件，覆盖写）。
func (v *Vault) FlushMeta(ctx context.Context) error {
	v.idxMu.Lock()
	if !v.idxDirty {
		v.idxTimer = nil
		v.idxMu.Unlock()
		return nil
	}
	files := make(map[string]metaEntry, len(v.idx))
	for k, val := range v.idx {
		files[k] = val
	}
	v.idxDirty = false
	v.idxTimer = nil
	v.idxMu.Unlock()

	b, err := json.Marshal(metaDoc{Version: 1, Files: files})
	if err != nil {
		return err
	}
	info := object.NewStaticObjectInfo(metaName, time.Now(), int64(len(b)), true, nil, v.f)
	if _, err := v.f.Put(ctx, strings.NewReader(string(b)), info); err != nil {
		v.idxMu.Lock()
		v.idxDirty = true
		v.idxMu.Unlock()
		return err
	}
	return nil
}

// OpenRange 打开 [start, end] 闭区间的解密流。
// 底层会把区间换算成密文偏移，只请求需要的那一小段。
func (v *Vault) OpenRange(ctx context.Context, remote string, start, end int64) (io.ReadCloser, error) {
	o, err := v.f.NewObject(ctx, cleanRel(remote))
	if err != nil {
		return nil, err
	}
	return o.Open(ctx, &fs.RangeOption{Start: start, End: end})
}

// OpenFull 打开完整流（用于不支持 Range 的客户端）。
func (v *Vault) OpenFull(ctx context.Context, remote string) (io.ReadCloser, error) {
	o, err := v.f.NewObject(ctx, cleanRel(remote))
	if err != nil {
		return nil, err
	}
	return o.Open(ctx)
}

// Remove 删除对象。
func (v *Vault) Remove(ctx context.Context, remote string) error {
	o, err := v.f.NewObject(ctx, cleanRel(remote))
	if err != nil {
		return err
	}
	return o.Remove(ctx)
}

// Delete 删除文件或目录：先按文件取对象；取不到再试目录。
// 不同后端对「拿目录当对象」的报错不一致（ErrorIsDir / object not found），
// 所以统一用 List 判定目录（空目录也能 List 成功），判定不了再交给 Remove 报错。
func (v *Vault) Delete(ctx context.Context, remote string) error {
	remote = cleanRel(remote)
	if remote == "" {
		return errors.New("不能删除根目录")
	}
	var err error
	if _, e := v.f.NewObject(ctx, remote); e == nil {
		// 注意：crypt 后端里目录也能 NewObject 成功，所以这里不能只看这一步，
		// 真删失败（directory not empty）时再退回目录递归删除。
		if rerr := v.Remove(ctx, remote); rerr == nil {
			err = nil
		} else if strings.Contains(strings.ToLower(rerr.Error()), "not empty") {
			err = v.rmTree(ctx, remote, 0)
		} else {
			err = rerr
		}
	} else if _, e := v.f.List(ctx, remote); e == nil {
		err = v.rmTree(ctx, remote, 0)
	} else {
		err = v.Remove(ctx, remote)
	}
	if err == nil {
		v.forgetMeta(ctx, remote)
	}
	return err
}

// rmTree 递归清空目录再删掉它：WebDAV 不支持「递归删除目录」，
// 留着子文件会直接报 directory not empty。
func (v *Vault) rmTree(ctx context.Context, dir string, depth int) error {
	if depth > 8 {
		return errors.New("目录层级过深，已停止删除")
	}
	entries, err := v.f.List(ctx, dir)
	if err != nil {
		return err
	}
	// 有些后端把「单个文件」也当列表返回一条自己，遇到这种就直接删文件
	if len(entries) == 1 && path.Base(entries[0].Remote()) == path.Base(dir) {
		if _, isDir := entries[0].(fs.Directory); !isDir {
			o, oerr := v.f.NewObject(ctx, dir)
			if oerr != nil {
				return oerr
			}
			return o.Remove(ctx)
		}
	}
	for _, e := range entries {
		rel := path.Join(dir, path.Base(e.Remote()))
		// 目录要往下递归；crypt 后端里目录也能 NewObject 成功，
		// 直接 Remove 会报 directory not empty，所以必须先看类型。
		if _, isDir := e.(fs.Directory); isDir {
			if err := v.rmTree(ctx, rel, depth+1); err != nil {
				return err
			}
			continue
		}
		o, err := v.f.NewObject(ctx, rel)
		if err != nil {
			continue
		}
		if err := o.Remove(ctx); err != nil {
			return err
		}
	}
	// 139 云的目录列表有秒级最终一致性：刚删完子项的目录立刻 Rmdir 可能报
	// directory not empty，这里小退避重试几次。
	var err2 error
	for i := 0; i < 4; i++ {
		if err2 = v.f.Rmdir(ctx, dir); err2 == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(1200*(i+1)) * time.Millisecond):
		}
	}
	return err2
}

// cleanRel 归一化为安全的相对路径，禁止路径逃逸。
func cleanRel(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimSpace(p)
	p = strings.Trim(p, "/")
	cleaned := path.Clean("/" + p)
	return strings.TrimPrefix(cleaned, "/")
}

