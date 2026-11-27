// Package dav 在进程内提供一个最小 WebDAV 服务，把请求翻译成个人云接口调用。
//
// 之所以要有它：rclone 的 webdav/crypt 这一层需要“能 Range 的 HTTP 文件系统”，
// 而个人云是 JSON 接口 + CDN 直链。这里只实现 rclone 实际会用到的方法
// （OPTIONS/PROPFIND/GET/HEAD/PUT/DELETE/MKCOL），保持最小攻击面。
package dav

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"vaultd/internal/cloud139"
)

type entry struct {
	list   []cloud139.File
	loaded time.Time
}

// Server 是内置的 WebDAV 端点。
type Server struct {
	c    *cloud139.Client
	User string
	Pass string

	ln  net.Listener
	srv *http.Server

	mu    sync.Mutex
	cache map[string]entry
}

func New(c *cloud139.Client) *Server {
	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	return &Server{
		c:     c,
		User:  "vault",
		Pass:  hex.EncodeToString(buf),
		cache: map[string]entry{},
	}
}

// Start 在 127.0.0.1 上随机端口起服务，返回可用的 base URL。
func (s *Server) Start() (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	s.ln = ln
	s.srv = &http.Server{Handler: s, ReadHeaderTimeout: 30 * time.Second}
	go func() { _ = s.srv.Serve(ln) }()
	return "http://" + ln.Addr().String(), nil
}

func (s *Server) Close() error {
	if s.srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return s.srv.Shutdown(ctx)
}

func (s *Server) invalidate(path string) {
	s.mu.Lock()
	delete(s.cache, path)
	s.mu.Unlock()
}

// list 带 15 秒缓存；写操作后失效，避免“刚写的看不见”。
func (s *Server) list(ctx context.Context, path, id string) ([]cloud139.File, error) {
	s.mu.Lock()
	if e, ok := s.cache[path]; ok && time.Since(e.loaded) < 15*time.Second {
		s.mu.Unlock()
		return e.list, nil
	}
	s.mu.Unlock()

	files, err := s.c.List(ctx, id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.cache[path] = entry{list: files, loaded: time.Now()}
	s.mu.Unlock()
	return files, nil
}

// resolve 把 URL 路径解析成云端 ID；isDir 表示路径本身是目录。
func (s *Server) resolve(ctx context.Context, p string) (string, bool, error) {
	p = strings.TrimSuffix(p, "/")
	if p == "" {
		return "/", true, nil
	}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	id := "/"
	cur := ""
	isDir := true
	for i, name := range parts {
		files, err := s.list(ctx, cur, id)
		if err != nil {
			return "", false, err
		}
		found := false
		for _, f := range files {
			if f.Name == name {
				id, isDir, found = f.ID, f.Dir, true
				break
			}
		}
		if !found {
			return "", false, errNotFound
		}
		if i < len(parts)-1 && !isDir {
			return "", false, errNotFound
		}
		cur = cur + "/" + name
	}
	return id, isDir, nil
}

type notFound struct{}

func (notFound) Error() string { return "not found" }

var errNotFound error = notFound{}

// stat 在父目录列表里找到目标的 size / mtime。
func (s *Server) stat(ctx context.Context, p string) (int64, time.Time) {
	parentPath := parent(p)
	pid, isDir, err := s.resolve(ctx, parentPath)
	if err != nil || !isDir {
		return 0, time.Time{}
	}
	files, err := s.list(ctx, parentPath, pid)
	if err != nil {
		return 0, time.Time{}
	}
	name := lastSegment(p)
	for _, f := range files {
		if f.Name == name {
			return f.Size, f.ModTime
		}
	}
	return 0, time.Time{}
}

func (s *Server) authed(r *http.Request) bool {
	u, p, ok := r.BasicAuth()
	return ok && u == s.User && p == s.Pass
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.authed(r) {
		w.Header().Set("WWW-Authenticate", `Basic realm="vaultd"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	ctx := r.Context()
	p := r.URL.Path
	switch r.Method {
	case http.MethodOptions:
		w.Header().Set("DAV", "1,2")
		w.Header().Set("Allow", "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL")
		w.WriteHeader(http.StatusOK)

	case "PROPFIND":
		s.propfind(ctx, w, r, p)

	case http.MethodGet, http.MethodHead:
		s.get(ctx, w, r, p)

	case http.MethodPut:
		s.put(ctx, w, r, p)

	case http.MethodDelete:
		id, isDir, err := s.resolve(ctx, p)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if isDir && strings.TrimSuffix(p, "/") == "" {
			http.Error(w, "不能删根目录", http.StatusForbidden)
			return
		}
		if err := s.c.Delete(ctx, id); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		s.invalidate(parent(p))
		s.invalidate(p)
		w.WriteHeader(http.StatusNoContent)

	case "MKCOL":
		// 目录已存在时按 RFC 4918 返回 405：rclone 只把 405 当作“已经有了”，
		// 若真去建，云端会按 force_rename 另起一个带时间戳的新目录。
		if _, _, err := s.resolve(ctx, p); err == nil {
			http.Error(w, "目录已存在", http.StatusMethodNotAllowed)
			return
		}
		parentPath := parent(p)
		parentID, isDir, err := s.resolve(ctx, parentPath)
		if err != nil || !isDir {
			http.Error(w, "父目录不存在", http.StatusConflict)
			return
		}
		if _, err := s.c.CreateDir(ctx, parentID, lastSegment(p)); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		s.invalidate(parentPath)
		w.WriteHeader(http.StatusCreated)

	case "MOVE":
		s.move(ctx, w, r, p)

	case "COPY", "LOCK", "UNLOCK", "PROPPATCH":
		http.Error(w, "未实现", http.StatusNotImplemented)

	default:
		http.Error(w, "不支持的方法", http.StatusMethodNotAllowed)
	}
}

func parent(p string) string {
	p = strings.TrimSuffix(p, "/")
	i := strings.LastIndex(p, "/")
	if i <= 0 {
		return "/"
	}
	return p[:i]
}

func lastSegment(p string) string {
	p = strings.TrimSuffix(p, "/")
	i := strings.LastIndex(p, "/")
	return p[i+1:]
}

type davProp struct {
	Prop   davInner `xml:"prop"`
	Status string   `xml:"status"`
}

type davInner struct {
	DisplayName   string  `xml:"displayname"`
	ContentLength string  `xml:"getcontentlength,omitempty"`
	LastModified  string  `xml:"getlastmodified,omitempty"`
	ContentType   string  `xml:"getcontenttype,omitempty"`
	ResourceType  resType `xml:"resourcetype"`
}

type resType struct {
	Collection *struct{} `xml:"collection,omitempty"`
}

type davResponse struct {
	Href     string  `xml:"href"`
	Propstat davProp `xml:"propstat"`
}

type multiStatus struct {
	XMLName   xml.Name      `xml:"DAV: multistatus"`
	Responses []davResponse `xml:"response"`
}

func modTime(t time.Time) string {
	if t.IsZero() {
		t = time.Now()
	}
	return t.UTC().Format(http.TimeFormat)
}

func hrefOf(p string) string {
	if p == "" {
		return "/"
	}
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	h := strings.Join(segs, "/")
	if !strings.HasPrefix(h, "/") {
		h = "/" + h
	}
	return h
}

func (s *Server) propfind(ctx context.Context, w http.ResponseWriter, r *http.Request, p string) {
	id, isDir, err := s.resolve(ctx, p)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	clean := strings.TrimSuffix(p, "/")
	name := lastSegment(p)
	if name == "" {
		name = "root"
	}
	var size int64
	var mod time.Time
	if !isDir {
		size, mod = s.stat(ctx, p)
	}
	resp := multiStatus{}
	add := func(pth, display string, sz int64, dir bool, mt time.Time) {
		rt := resType{}
		cl, ct := "", "application/octet-stream"
		if dir {
			rt.Collection = &struct{}{}
			ct = "httpd/unix-directory"
		} else {
			cl = strconv.FormatInt(sz, 10)
		}
		resp.Responses = append(resp.Responses, davResponse{
			Href: hrefOf(pth),
			Propstat: davProp{
				Prop: davInner{
					DisplayName:   display,
					ContentLength: cl,
					LastModified:  modTime(mt),
					ContentType:   ct,
					ResourceType:  rt,
				},
				Status: "HTTP/1.1 200 OK",
			},
		})
	}

	self := clean
	if isDir && self != "" {
		self += "/"
	}
	add(self, name, size, isDir, mod)

	if isDir && r.Header.Get("Depth") != "0" {
		files, err := s.list(ctx, clean, id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		for _, f := range files {
			pth := clean + "/" + f.Name
			if f.Dir {
				pth += "/"
			}
			add(pth, f.Name, f.Size, f.Dir, f.ModTime)
		}
	}

	body, err := xml.Marshal(resp)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(http.StatusMultiStatus)
	_, _ = w.Write([]byte(xml.Header + string(body)))
}

func (s *Server) get(ctx context.Context, w http.ResponseWriter, r *http.Request, p string) {
	id, isDir, err := s.resolve(ctx, p)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if isDir {
		http.Error(w, "是目录", http.StatusBadRequest)
		return
	}
	link, err := s.c.DownloadURL(ctx, id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, link, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	// Range 与条件请求原样透传给 CDN，保证随机读语义不变。
	for _, h := range []string{"Range", "If-Range", "If-None-Match", "If-Modified-Since"} {
		if v := r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	req.Header.Set("Origin", "https://yun.139.com")
	req.Header.Set("Referer", "https://yun.139.com/")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, resp.Body)
}

// move 支持同目录改名和跨目录移动。跨目录走 139 的 /file/batchMove：
// 文件与整个目录都能一次搬走，不需要「读出来再重新上传」。
// 目标名字不同时先改名再移动；失败时最多停在源目录的新名字上，内容不会丢。
func (s *Server) move(ctx context.Context, w http.ResponseWriter, r *http.Request, p string) {
	dest := r.Header.Get("Destination")
	if dest == "" {
		http.Error(w, "缺少 Destination", http.StatusBadRequest)
		return
	}
	du, err := url.Parse(dest)
	if err != nil {
		http.Error(w, "Destination 不合法", http.StatusBadRequest)
		return
	}
	srcDir := parent(p)
	dstDir := parent(du.Path)
	id, _, err := s.resolve(ctx, p)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	dstName := lastSegment(du.Path)
	if dstName == "" {
		http.Error(w, "目标名为空", http.StatusBadRequest)
		return
	}
	if dstName != lastSegment(p) {
		if err := s.c.Rename(ctx, id, dstName); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}
	if srcDir != dstDir {
		s.invalidate(dstDir)
		dstParent, isDir, err := s.resolve(ctx, dstDir)
		if err != nil || !isDir {
			http.Error(w, "目标目录不存在", http.StatusConflict)
			return
		}
		if _, err := s.c.Move(ctx, []string{id}, dstParent); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		// 139 的 batchMove 是任务型接口：必须等目标真正出现在列表里再返回 201，
		// 否则 rclone 会立刻 NewObject 校验失败，甚至把源当成没搬走。
		if err := s.waitMove(ctx, du.Path, 25*time.Second); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		s.invalidate(dstDir)
	}
	s.invalidate(srcDir)
	w.WriteHeader(http.StatusCreated)
}

func (s *Server) waitMove(ctx context.Context, dest string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	dir := parent(dest)
	for {
		s.invalidate(dir)
		if _, _, err := s.resolve(ctx, dest); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("云端移动任务超时，目标还没出现")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (s *Server) put(ctx context.Context, w http.ResponseWriter, r *http.Request, p string) {
	parentPath := parent(p)
	parentID, isDir, err := s.resolve(ctx, parentPath)
	if err != nil || !isDir {
		http.Error(w, "父目录不存在", http.StatusConflict)
		return
	}
	name := lastSegment(p)
	if name == "" {
		http.Error(w, "文件名不能为空", http.StatusBadRequest)
		return
	}
	size := r.ContentLength
	if size <= 0 {
		http.Error(w, "需要 Content-Length", http.StatusLengthRequired)
		return
	}
	if err := s.c.Upload(ctx, parentID, name, r.Body, size, nil); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	s.invalidate(parentPath)
	w.WriteHeader(http.StatusCreated)
}
