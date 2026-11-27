// Package server 是 PC 端的本地网关：
//   - 只监听 127.0.0.1，所有请求需要一个随机会话 token（放在 URL 或 cookie 里）；
//   - /api/stream 负责把 HTTP Range 精确透传给密文库，返回 206/416；
//   - /api/upload 走流式写入，不落整包内存；
//   - 错误统一分类，前端按 retryable 决定是否自动重试。
package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"vaultd/internal/cloud139"
	"vaultd/internal/localcfg"
	"vaultd/internal/vault"
	"vaultd/internal/webui"
)

const cookieName = "vaultd_token"

type Server struct {
	cfg   *localcfg.Config
	token string

	mu        sync.RWMutex
	v         *vault.Vault
	vErr      error
	lastRetry time.Time

	// ready 在首次建立密文库连接后关闭。网关先开始监听、先吐前端，
	// 需要云端数据的接口再等它，冷启动就不用卡在“连云端”上。
	ready chan struct{}

	cache *previewCache
}

func New(cfg *localcfg.Config, token string) *Server {
	s := &Server{cfg: cfg, token: token, ready: make(chan struct{}), cache: newPreviewCache(cfg.MasterKey)}
	go func() {
		s.reload(context.Background())
		close(s.ready)
	}()
	return s
}

func (s *Server) waitReady(ctx context.Context) {
	if s.ready == nil {
		return
	}
	select {
	case <-s.ready:
	case <-ctx.Done():
	}
}

// wantReconnect 做一次 10 秒限流，避免前端反复轮询时反复发起重连。
func (s *Server) wantReconnect() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.lastRetry) < 10*time.Second {
		return false
	}
	s.lastRetry = time.Now()
	return true
}

// reload 重新建立密文库连接（配置变更后调用）。
func (s *Server) reload(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.cfg.Configured() {
		if s.v != nil {
			s.v.Close()
		}
		s.v, s.vErr = nil, nil
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	v, err := vault.Open(ctx, s.cfg)
	if err == nil && s.v != nil && s.v != v {
		s.v.Close() // native 模式下旧实例占着进程内端点，必须释放
	}
	s.v, s.vErr = v, err
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.guard(s.handleIndex))
	mux.HandleFunc("/app.js", s.guard(func(w http.ResponseWriter, r *http.Request) {
		serveAsset(w, r, "text/javascript; charset=utf-8", webui.AppJS)
	}))
	mux.HandleFunc("/style.css", s.guard(func(w http.ResponseWriter, r *http.Request) {
		serveAsset(w, r, "text/css; charset=utf-8", webui.StyleCSS)
	}))
	mux.HandleFunc("/api/status", s.guard(s.handleStatus))
	mux.HandleFunc("/api/list", s.guard(s.handleList))
	mux.HandleFunc("/api/upload", s.guard(s.handleUpload))
	mux.HandleFunc("/api/stream", s.guard(s.handleStream))
	mux.HandleFunc("/api/thumb", s.guard(s.handleThumb))
	mux.HandleFunc("/api/setup", s.guard(s.handleSetup))
	mux.HandleFunc("/api/delete", s.guard(s.handleDelete))
	mux.HandleFunc("/api/mkdir", s.guard(s.handleMkdir))
	mux.HandleFunc("/api/move", s.guard(s.handleMove))
	mux.HandleFunc("/api/cache/status", s.guard(s.handleCacheStatus))
	mux.HandleFunc("/api/cache/clear", s.guard(s.handleCacheClear))
	mux.HandleFunc("/api/config/export", s.guard(s.handleConfigExport))
	mux.HandleFunc("/api/config/import", s.guard(s.handleConfigImport))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) })
	return withLog(mux)
}

// withLog 只记录方法与路径，不记录 query（query 里带 token）。
func withLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

// guard 校验 token + Host，防 DNS rebinding 与本机其它进程乱调。
func (s *Server) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Host, "127.0.0.1:") && !strings.HasPrefix(r.Host, "localhost:") {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		ok := false
		if c, err := r.Cookie(cookieName); err == nil && c.Value == s.token {
			ok = true
		}
		if t := r.URL.Query().Get("t"); t != "" && t == s.token {
			ok = true
			http.SetCookie(w, &http.Cookie{
				Name: cookieName, Value: s.token, Path: "/",
				HttpOnly: true, SameSite: http.SameSiteStrictMode,
			})
		}
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next(w, r)
	}
}

// serveAsset 给内嵌的静态资源加 ETag：内容没变时 WebView 拿到 304，
// 冷启动不用把 JS/CSS 重新解析一遍；内容变了（重新打包）哈希自然就变。
func serveAsset(w http.ResponseWriter, r *http.Request, contentType string, body []byte) {
	sum := sha256.Sum256(body)
	tag := `"` + hex.EncodeToString(sum[:8]) + `"`
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("ETag", tag)
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	if inm := strings.TrimSpace(r.Header.Get("If-None-Match")); inm != "" && inm == tag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(body)
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(webui.IndexHTML)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.waitReady(r.Context())
	s.mu.RLock()
	v, vErr := s.v, s.vErr
	s.mu.RUnlock()
	resp := map[string]any{
		"configured":      s.cfg.Configured(),
		"backend":         s.cfg.BackendName(),
		"webdav_url":      s.cfg.WebDAVURL,
		"key_fingerprint": s.cfg.Fingerprint(),
		"remote_path":     s.cfg.RemotePath,
		"chunk_size":      s.cfg.ChunkSize,
		"vault_ready":     v != nil,
	}
	if vErr != nil {
		resp["vault_error"] = vErr.Error()
	}
	// 未就绪时在后台补一次重连（限流，10 秒最多一次），
	// 手机开机后网络晚到、或笔记本刚从睡眠唤醒时，用户不用重启 App。
	if v == nil && s.cfg.Configured() && s.wantReconnect() {
		go func() {
			if _, err := s.needVault(); err == nil {
				log.Printf("后台重连成功，密文库已就绪")
			}
		}()
	}
	writeJSON(w, resp)
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	s.waitReady(r.Context())
	v, err := s.needVault()
	if err != nil {
		writeErr(w, err)
		return
	}
	dir := r.URL.Query().Get("path")
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	entries, err := v.List(ctx, dir)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"path": "/" + vaultPath(dir), "entries": entries})
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	s.waitReady(r.Context())
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	v, err := s.needVault()
	if err != nil {
		writeErr(w, err)
		return
	}
	remote := r.URL.Query().Get("path")
	if remote == "" || strings.HasSuffix(remote, "/") {
		writeErr(w, errors.New("上传路径不能为空且不能以 / 结尾"))
		return
	}
	size := r.ContentLength
	if size <= 0 {
		writeErr(w, errors.New("缺少 Content-Length，流式上传无法确定密文长度"))
		return
	}
	// 大文件给足时间：单次 PUT 的上限来自这里，而不是全局超时
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	if err := v.UploadAt(ctx, remote, r.Body, size, uploadMTime(r)); err != nil {
		writeErr(w, fmt.Errorf("上传失败: %w", err))
		return
	}
	writeJSON(w, map[string]any{"ok": true, "path": path.Join("/", remote), "size": size})
}

// uploadMTime 取上传端给的原始修改时间（unix 秒）。浏览器用 file.lastModified，
// 安卓自动同步用 MediaStore 的 DATE_MODIFIED；没传就当作「现在」。
func uploadMTime(r *http.Request) time.Time {
	v := r.URL.Query().Get("mtime")
	if v == "" {
		return time.Time{}
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}
	}
	// 毫秒也兼容一下（超过 1e12 说明是毫秒）
	if n > 1e12 {
		n /= 1000
	}
	return time.Unix(n, 0)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	s.waitReady(r.Context())
	v, err := s.needVault()
	if err != nil {
		writeErr(w, err)
		return
	}
	remote := r.URL.Query().Get("path")
	if remote == "" {
		writeErr(w, errors.New("缺少 path"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()

	o, err := v.Stat(ctx, remote)
	if err != nil {
		writeErr(w, fmt.Errorf("对象不存在: %w", err))
		return
	}
	size := o.Size()

	h := w.Header()
	h.Set("Accept-Ranges", "bytes")
	h.Set("Content-Type", contentTypeFor(remote))
	h.Set("Cache-Control", "no-store")
	// dl=1 时按附件下发：浏览器/安卓端保存时用的是解密后的原名，而不是乱码对象名
	if r.URL.Query().Get("dl") == "1" {
		base := path.Base(remote)
		ascii := strings.Map(func(c rune) rune {
			if c < 0x20 || c > 0x7e {
				return '_'
			}
			return c
		}, base)
		if strings.Trim(ascii, "_") == "" {
			ascii = "download.bin"
		}
		h.Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s", ascii, url.PathEscape(base)))
	}

	if r.Method == http.MethodHead {
		h.Set("Content-Length", strconv.FormatInt(size, 10))
		w.WriteHeader(http.StatusOK)
		return
	}

	start, end, mode := parseRange(r.Header.Get("Range"), size)
	switch mode {
	case rangeInvalid:
		h.Set("Content-Range", fmt.Sprintf("bytes */%d", size))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	case rangeNone:
		h.Set("Content-Length", strconv.FormatInt(size, 10))
		w.WriteHeader(http.StatusOK)
		// 图片原图才缓存：视频有 Range、下载有 dl=1，都不该把整段塞进内存。
		// 缓存本身是 AES-GCM 加密落盘，HTTP 仍然是 no-store，WebView 拿不到明文副本。
		cacheable := s.cache != nil && r.Method == http.MethodGet &&
			r.URL.Query().Get("dl") != "1" && isPreviewImage(remote) && size <= previewCacheMaxFile
		var key string
		if cacheable {
			key = previewKey(remote, size, o.ModTime(ctx))
			if plain, ok := s.cache.get(key); ok {
				_, _ = w.Write(plain)
				return
			}
		}
		rc, err := v.OpenFull(ctx, remote)
		if err != nil {
			return
		}
		defer rc.Close()
		if cacheable {
			buf := bytes.NewBuffer(make([]byte, 0, size))
			_, err := io.Copy(io.MultiWriter(w, buf), rc)
			if err == nil && int64(buf.Len()) == size {
				data := buf.Bytes()
				go s.cache.put(key, data)
			}
			return
		}
		_, _ = io.Copy(w, rc)
		return
	}

	h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
	h.Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	w.WriteHeader(http.StatusPartialContent)
	rc, err := v.OpenRange(ctx, remote, start, end)
	if err != nil {
		return
	}
	defer rc.Close()
	_, _ = io.Copy(w, rc)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	s.waitReady(r.Context())
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	v, err := s.needVault()
	if err != nil {
		writeErr(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	// 目录和普通文件走同一个删除入口：Vault.Delete 自己判断是文件还是目录，
	// 手机上文件夹格子上的 × 按钮点下来就是这条路径。
	if err := v.Delete(ctx, r.URL.Query().Get("path")); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleMkdir 新建子目录。手机上「按文件夹上传」就是先建目录再把文件传进去，
// 这样当前目录里只多出一个文件夹，不会散落一堆文件。
func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	s.waitReady(r.Context())
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	v, err := s.needVault()
	if err != nil {
		writeErr(w, err)
		return
	}
	p := strings.Trim(r.URL.Query().Get("path"), "/")
	if p == "" {
		writeErr(w, errors.New("目录名不能为空"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if err := v.Mkdir(ctx, p); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "path": "/" + p})
}

// handleMove 移动/重命名文件或目录。跨目录走 139 的 batchMove，
// 不重新下载上传；云端任务是异步的，dav 层会等目标出现再返回。
// 大目录仍可能较慢，所以超时给到 30 分钟；前端逐个调用并显示进度。
func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	s.waitReady(r.Context())
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	v, err := s.needVault()
	if err != nil {
		writeErr(w, err)
		return
	}
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		writeErr(w, errors.New("请求格式必须是 JSON"))
		return
	}
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		writeErr(w, errors.New("移动参数不完整"))
		return
	}
	if strings.TrimSpace(req.From) == "" || strings.TrimSpace(req.To) == "" {
		writeErr(w, errors.New("移动参数不完整"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	if err := v.Move(ctx, req.From, req.To); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "from": req.From, "to": req.To})
}

func (s *Server) handleCacheStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var used, files, limit int64
	if s.cache != nil {
		used, files, limit = s.cache.stats()
	}
	writeJSON(w, map[string]any{"enabled": s.cache != nil, "bytes": used, "files": files, "limit": limit})
}

func (s *Server) handleCacheClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.cache == nil {
		writeJSON(w, map[string]any{"ok": true})
		return
	}
	if err := s.cache.clear(); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

type setupReq struct {
	Backend       string `json:"backend"`
	CloudProvider string `json:"cloud_provider"`
	CloudAuth     string `json:"cloud_authorization"`
	// 新设备导入同一把钥匙时用（留空表示不改动）
	MasterKey string `json:"master_key"`
	Salt      string `json:"salt"`

	URL        string `json:"url"`
	User       string `json:"user"`
	Pass       string `json:"pass"`
	RemotePath string `json:"remote_path"`
	ChunkSize  string `json:"chunk_size"`
	Listen     string `json:"listen"`
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req setupReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, err)
		return
	}
	resp, err := s.applySetup(r.Context(), req)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, resp)
}

// applySetup 校验并落地一份接入配置，然后重建密文库连接。
// /api/setup 与 /api/config/import 共用这一段，避免两条写配置的路径行为不一致。
func (s *Server) applySetup(ctx context.Context, req setupReq) (map[string]any, error) {
	// 密钥导入：只接受成对出现、形状正确的 32 字节 hex。
	// 这一步会改变“能不能解开云端已有密文”，所以宁可不写也不写错一半。
	if req.MasterKey != "" || req.Salt != "" {
		if !localcfg.ValidKeyHex(req.MasterKey) || !localcfg.ValidKeyHex(req.Salt) {
			return nil, errors.New("主密钥与盐必须同时提供，且各是 64 位 hex（32 字节）")
		}
		s.cfg.MasterKey, s.cfg.Salt = req.MasterKey, req.Salt
	}

	if req.Backend == "native" {
		if req.CloudProvider != "" && req.CloudProvider != "139" {
			return nil, fmt.Errorf("暂不支持的云盘类型: %s", req.CloudProvider)
		}
		if err := cloud139.CheckAuthorization(req.CloudAuth); err != nil {
			return nil, fmt.Errorf("授权串不可用: %w", err)
		}
		s.cfg.Backend = "native"
		s.cfg.CloudProvider = "139"
		s.cfg.CloudAuth = strings.TrimSpace(req.CloudAuth)
		s.cfg.WebDAVURL, s.cfg.WebDAVUser, s.cfg.WebDAVPass = "", "", ""
	} else {
		if req.URL == "" || req.User == "" {
			return nil, errors.New("WebDAV 地址与用户名必填")
		}
		if !strings.HasPrefix(req.URL, "http://") && !strings.HasPrefix(req.URL, "https://") {
			return nil, errors.New("WebDAV 地址必须是 http(s) 开头")
		}
		s.cfg.Backend = ""
		s.cfg.CloudAuth = ""
		s.cfg.WebDAVURL = req.URL
		s.cfg.WebDAVUser = req.User
		s.cfg.WebDAVPass = req.Pass
	}
	if req.RemotePath != "" {
		if err := localcfg.ValidRemotePath(req.RemotePath); err != nil {
			return nil, err
		}
		s.cfg.RemotePath = strings.Trim(req.RemotePath, "/")
	}
	if req.ChunkSize != "" {
		if err := localcfg.ValidChunkSize(req.ChunkSize); err != nil {
			return nil, err
		}
		s.cfg.ChunkSize = req.ChunkSize
	}
	if err := s.cfg.Save(); err != nil {
		return nil, err
	}
	s.reload(ctx)
	s.mu.RLock()
	vErr := s.vErr
	s.mu.RUnlock()
	if vErr != nil {
		return nil, fmt.Errorf("配置已保存，但连接失败: %w", vErr)
	}
	return map[string]any{"ok": true, "fingerprint": s.cfg.Fingerprint(), "backend": s.cfg.BackendName()}, nil
}

func (s *Server) needVault() (*vault.Vault, error) {
	s.mu.RLock()
	v, vErr, configured := s.v, s.vErr, s.cfg.Configured()
	s.mu.RUnlock()
	if !configured {
		return nil, errors.New("尚未配置云端接入信息")
	}
	if vErr == nil && v != nil {
		return v, nil
	}
	// 手机/笔记本上网络常常比进程晚就绪：失败一次不代表真连不上。
	// 这里做一次带退避的重连，成功就恢复，避免用户必须重启 App。
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.v != nil && s.vErr == nil {
		return s.v, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	vv, err := vault.Open(ctx, s.cfg)
	if err != nil {
		s.v, s.vErr = nil, err
		return nil, err
	}
	s.v, s.vErr = vv, nil
	return vv, nil
}

// ---------- Range 解析 ----------

type rangeMode int

const (
	rangeNone rangeMode = iota
	rangeOK
	rangeInvalid
)

func parseRange(header string, size int64) (start, end int64, mode rangeMode) {
	if header == "" || size <= 0 {
		return 0, 0, rangeNone
	}
	if !strings.HasPrefix(header, "bytes=") {
		return 0, 0, rangeNone
	}
	spec := strings.TrimSpace(strings.TrimPrefix(header, "bytes="))
	if strings.Contains(spec, ",") {
		// 多区间：媒体播放几乎不会用，直接退化为整包，避免实现错误的 200/206 语义
		return 0, 0, rangeNone
	}
	a, b, ok := strings.Cut(spec, "-")
	if !ok {
		return 0, 0, rangeInvalid
	}
	if a == "" {
		// bytes=-N：最后 N 字节
		n, err := strconv.ParseInt(strings.TrimSpace(b), 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, rangeInvalid
		}
		if n > size {
			n = size
		}
		return size - n, size - 1, rangeOK
	}
	start, err := strconv.ParseInt(strings.TrimSpace(a), 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, rangeInvalid
	}
	if strings.TrimSpace(b) == "" {
		return start, size - 1, rangeOK
	}
	end, err = strconv.ParseInt(strings.TrimSpace(b), 10, 64)
	if err != nil || end < start {
		return 0, 0, rangeInvalid
	}
	if end >= size {
		end = size - 1
	}
	return start, end, rangeOK
}

func vaultPath(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.Trim(p, "/")
	if p == "" {
		return ""
	}
	return path.Clean(p)
}

func contentTypeFor(remote string) string {
	switch strings.ToLower(path.Ext(remote)) {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	case ".mov":
		return "video/quicktime"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".heic":
		return "image/heic"
	case ".mp3":
		return "audio/mpeg"
	case ".flac":
		return "audio/flac"
	case ".m4a":
		return "audio/mp4"
	}
	if t := mime.TypeByExtension(path.Ext(remote)); t != "" {
		return t
	}
	return "application/octet-stream"
}

// ---------- 错误分类 ----------

type apiError struct {
	OK        bool   `json:"ok"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func writeErr(w http.ResponseWriter, err error) {
	e := classify(err)
	status := http.StatusInternalServerError
	switch e.Code {
	case "AUTH":
		status = http.StatusUnauthorized
	case "NOTFOUND":
		status = http.StatusNotFound
	case "LOCKED", "TIMEOUT":
		status = http.StatusServiceUnavailable
	}
	writeJSONStatus(w, status, e)
}

func classify(err error) apiError {
	msg := err.Error()
	low := strings.ToLower(msg)
	e := apiError{OK: false, Code: "UNKNOWN", Message: msg}
	switch {
	case strings.Contains(low, "401") || strings.Contains(low, "unauthorized") || strings.Contains(low, "auth"):
		e.Code, e.Retryable = "AUTH", false
	case strings.Contains(low, "423") || strings.Contains(low, "locked"):
		e.Code, e.Retryable = "LOCKED", true
	case strings.Contains(low, "timeout") || strings.Contains(low, "deadline exceeded") || strings.Contains(low, "context canceled"):
		e.Code, e.Retryable = "TIMEOUT", true
	case strings.Contains(low, "not found") || strings.Contains(low, "object not found") || strings.Contains(low, "404"):
		e.Code, e.Retryable = "NOTFOUND", false
	case strings.Contains(low, "connection") || strings.Contains(low, "eof") || strings.Contains(low, "broken pipe") || strings.Contains(low, "reset by peer"):
		e.Code, e.Retryable = "NETWORK", true
	case strings.Contains(low, "50") && (strings.Contains(low, "500") || strings.Contains(low, "502") || strings.Contains(low, "503") || strings.Contains(low, "504")):
		e.Code, e.Retryable = "SERVER", true
	}
	if errors.Is(err, context.DeadlineExceeded) {
		e.Code, e.Retryable = "TIMEOUT", true
	}
	return e
}

func writeJSON(w http.ResponseWriter, v any) { writeJSONStatus(w, http.StatusOK, v) }

func writeJSONStatus(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Listen 解析监听地址，返回实际地址（支持 :0 随机端口）。
func Listen(addr string) (net.Listener, error) {
	return net.Listen("tcp", addr)
}
