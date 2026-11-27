package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// previewCache 是「解密后原图」的加密落盘缓存。
//
// 为什么不能直接把 /api/stream 改成 max-age：那样解密后的照片会以明文
// 落进 WebView 的 HTTP 缓存。这里仍然是 no-store，但网关自己把读到的原图
// 用主密钥派生的 AES-GCM 密钥重新加密后写到 App 私有目录，第二次打开同一张
// 照片只需本机解密，不再走云端。容量按 LRU 清理，默认 512 MiB。
const previewCacheLimit = 512 << 20
const previewCacheMaxFile = 32 << 20

type previewCache struct {
	dir string
	key [32]byte
	max int64
	mu  sync.Mutex
}

func newPreviewCache(masterKey string) *previewCache {
	dir := filepath.Join(os.TempDir(), "preview-cache")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil
	}
	c := &previewCache{
		dir: dir,
		key: sha256.Sum256([]byte("vaultd-preview-cache:" + masterKey)),
		max: previewCacheLimit,
	}
	c.mu.Lock()
	c.pruneLocked()
	c.mu.Unlock()
	return c
}

func (c *previewCache) path(key string) string {
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(c.dir, hex.EncodeToString(sum[:20])+".bin")
}

func (c *previewCache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.path(key)
	f, err := os.Open(p)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, previewCacheMaxFile+64))
	if err != nil || len(b) < 13 {
		_ = os.Remove(p)
		return nil, false
	}
	block, err := aes.NewCipher(c.key[:])
	if err != nil {
		return nil, false
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, false
	}
	plain, err := gcm.Open(nil, b[:gcm.NonceSize()], b[gcm.NonceSize():], nil)
	if err != nil {
		_ = os.Remove(p)
		return nil, false
	}
	// 访问时间即 LRU 顺序，不额外维护索引。
	now := time.Now()
	_ = os.Chtimes(p, now, now)
	return plain, true
}

func (c *previewCache) put(key string, data []byte) {
	if len(data) == 0 || len(data) > previewCacheMaxFile {
		return
	}
	block, err := aes.NewCipher(c.key[:])
	if err != nil {
		return
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return
	}
	sealed := gcm.Seal(nonce, nonce, data, nil)

	c.mu.Lock()
	defer c.mu.Unlock()
	tmp, err := os.CreateTemp(c.dir, ".put-*")
	if err != nil {
		return
	}
	name := tmp.Name()
	if _, err := tmp.Write(sealed); err != nil {
		tmp.Close()
		_ = os.Remove(name)
		return
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return
	}
	if err := os.Rename(name, c.path(key)); err != nil {
		_ = os.Remove(name)
		return
	}
	c.pruneLocked()
}

func (c *previewCache) pruneLocked() {
	ents, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}
	type item struct {
		path string
		at   time.Time
		size int64
	}
	var items []item
	var total int64
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".bin") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, item{filepath.Join(c.dir, e.Name()), info.ModTime(), info.Size()})
		total += info.Size()
	}
	if total <= c.max {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].at.Before(items[j].at) })
	target := c.max * 9 / 10
	for _, it := range items {
		if total <= target {
			break
		}
		if err := os.Remove(it.path); err == nil {
			total -= it.size
		}
	}
}

func (c *previewCache) stats() (bytes, files, limit int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ents, err := os.ReadDir(c.dir)
	if err != nil {
		return 0, 0, c.max
	}
	var total int64
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".bin") {
			continue
		}
		if info, err := e.Info(); err == nil {
			total += info.Size()
			files++
		}
	}
	return total, files, c.max
}

func (c *previewCache) clear() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	ents, err := os.ReadDir(c.dir)
	if err != nil {
		return err
	}
	var first error
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".bin") {
			continue
		}
		if err := os.Remove(filepath.Join(c.dir, e.Name())); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func previewKey(remote string, size int64, mtime time.Time) string {
	return remote + "|" + strconv.FormatInt(size, 10) + "|" + strconv.FormatInt(mtime.UnixNano(), 10)
}

func isPreviewImage(remote string) bool {
	switch strings.ToLower(filepath.Ext(remote)) {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif", ".avif":
		return true
	}
	return false
}
