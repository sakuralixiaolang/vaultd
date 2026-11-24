// Package vault 把 rclone 的 chunker → crypt → webdav 三层组装成一个可用的“密文库”。
//
// 关键点：
//   - 用 connection string 组装，不落任何 rclone 配置文件，避免密钥在磁盘上出现第二份；
//   - 加密/文件名加密/分片全部由 rclone 的成熟实现完成，本包不含任何密码学代码；
//   - 只向上暴露 List / Upload / OpenRange 这类原语，方便后面换成自带驱动。
package vault

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path"
	"strings"
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
	out := make([]Entry, 0, len(list))
	for _, e := range list {
		name := path.Base(e.Remote())
		if name == "." || name == "/" || name == "" {
			continue
		}
		_, isDir := e.(fs.Directory)
		out = append(out, Entry{
			Name:    name,
			Path:    path.Join("/", dir, name),
			Dir:     isDir,
			Size:    e.Size(),
			ModTime: e.ModTime(ctx),
		})
	}
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
	remote = cleanRel(remote)
	// 名字必须带上完整相对路径：Fs.Put 是按 info.Name() 落盘的，
	// 只给 Base 会把所有上传都丢到根目录（子目录名被吃掉）。
	info := object.NewStaticObjectInfo(remote, time.Now(), size, true, nil, v.f)
	_, err := v.f.Put(ctx, r, info)
	return err
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
	if _, err := v.f.NewObject(ctx, remote); err == nil {
		return v.Remove(ctx, remote)
	}
	if _, err := v.f.List(ctx, remote); err == nil {
		return v.rmTree(ctx, remote, 0)
	}
	return v.Remove(ctx, remote)
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
	for _, e := range entries {
		rel := path.Join(dir, path.Base(e.Remote()))
		if o, err := v.f.NewObject(ctx, rel); err == nil {
			if err := o.Remove(ctx); err != nil {
				return err
			}
			continue
		}
		if err := v.rmTree(ctx, rel, depth+1); err != nil {
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

