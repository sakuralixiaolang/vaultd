// Package vault 把 rclone 的 chunker → crypt → webdav 三层组装成一个可用的“密文库”。
//
// 关键点：
//   - 用 connection string 组装，不落任何 rclone 配置文件，避免密钥在磁盘上出现第二份；
//   - 加密/文件名加密/分片全部由 rclone 的成熟实现完成，本包不含任何密码学代码；
//   - 只向上暴露 List / Upload / OpenRange 这类原语，方便后面换成自带驱动。
package vault

import (
	"context"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	_ "github.com/rclone/rclone/backend/chunker"
	_ "github.com/rclone/rclone/backend/crypt"
	_ "github.com/rclone/rclone/backend/webdav"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/obscure"
	"github.com/rclone/rclone/fs/object"

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
	f    fs.Fs
	conn string
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
func Open(ctx context.Context, c *localcfg.Config) (*Vault, error) {
	conn, err := ConnectionString(c)
	if err != nil {
		return nil, err
	}
	f, err := fs.NewFs(ctx, conn)
	if err != nil {
		return nil, fmt.Errorf("无法连接云端: %w", err)
	}
	v := &Vault{f: f, conn: conn}
	if err := v.f.Mkdir(ctx, ""); err != nil {
		// 目录已存在时不同后端报错不一致，这里不当作致命错误
		fs.Logf(v.f, "确保根目录存在时返回: %v", err)
	}
	return v, nil
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
func (v *Vault) Stat(ctx context.Context, remote string) (fs.Object, error) {
	return v.f.NewObject(ctx, cleanRel(remote))
}

// Upload 以流式方式写入一个对象；size 必须准确（浏览器上传时取 Content-Length）。
// 分片内重传由上层决定，这里只做一次写入。
func (v *Vault) Upload(ctx context.Context, remote string, r io.Reader, size int64) error {
	remote = cleanRel(remote)
	info := object.NewStaticObjectInfo(path.Base(remote), time.Now(), size, true, nil, v.f)
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

// cleanRel 归一化为安全的相对路径，禁止路径逃逸。
func cleanRel(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimSpace(p)
	p = strings.Trim(p, "/")
	cleaned := path.Clean("/" + p)
	return strings.TrimPrefix(cleaned, "/")
}
