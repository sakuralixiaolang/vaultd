// Package cloud139 是内置的个人云盘客户端（仅实现本工具需要的最小集合）。
//
// 设计要点：
//   - 只用账号密码体系派生出来的 authorization（base64 后的一串），不存 Cookie；
//   - 每 12 小时量级的过期检查，过期前用官方 refresh 接口换新，换到的新串回调持久化；
//   - 所有请求带统一的签名头（mcloud-sign），签名算法按接口约定实现；
//   - 下载走官方返回的 CDN 直链，Range 原样透传；
//   - 上传分片（100MB / 512MB），先落临时文件算 SHA256，再按分片 PUT。
package cloud139

import (
	"bytes"
	"context"
	"crypto/md5"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	routeURL   = "https://user-njs.yun.139.com/user/route/qryRoutePolicy"
	refreshURL = "https://aas.caiyun.feixin.10086.cn:443/tellin/authTokenRefresh.do"
)

// File 是列表里的一项。
type File struct {
	ID      string
	Name    string
	Size    int64
	Dir     bool
	ModTime time.Time
}

// Client 是个人云的最小客户端。
type Client struct {
	http *http.Client

	mu    sync.Mutex
	auth  string // base64(authorization)
	acct  string
	host  string // 个人云 API 根地址，由路由策略下发
	onNewAuth func(string)
}

// New 用 authorization 构造客户端；onNewAuth 用于把刷新后的 authorization 落盘。
func New(authorization string, hc *http.Client, onNewAuth func(string)) (*Client, error) {
	authorization = strings.TrimSpace(authorization)
	if authorization == "" {
		return nil, errors.New("缺少云端授权串")
	}
	dec, err := base64.StdEncoding.DecodeString(authorization)
	if err != nil {
		return nil, fmt.Errorf("授权串格式不对: %w", err)
	}
	parts := strings.Split(string(dec), ":")
	if len(parts) < 3 {
		return nil, errors.New("授权串内容不完整")
	}
	if hc == nil {
		hc = &http.Client{Timeout: 0}
	}
	return &Client{http: hc, auth: authorization, acct: parts[1], onNewAuth: onNewAuth}, nil
}

// Start 做一次令牌校验与路由下发。
func (c *Client) Start(ctx context.Context) error {
	if err := c.refreshIfNeeded(ctx); err != nil {
		return err
	}
	return c.loadRoute(ctx)
}

func splitAuth(authorization string) (prefix, account, token string, expireMS int64, err error) {
	dec, e := base64.StdEncoding.DecodeString(authorization)
	if e != nil {
		return "", "", "", 0, fmt.Errorf("授权串解码失败: %w", e)
	}
	parts := strings.Split(string(dec), ":")
	if len(parts) < 3 {
		return "", "", "", 0, errors.New("授权串分段不足")
	}
	strs := strings.Split(parts[2], "|")
	if len(strs) < 4 {
		return "", "", "", 0, errors.New("授权串内容异常")
	}
	exp, e2 := strconv.ParseInt(strs[3], 10, 64)
	if e2 != nil {
		return "", "", "", 0, errors.New("授权串过期时间异常")
	}
	return parts[0], parts[1], parts[2], exp, nil
}

func (c *Client) refreshIfNeeded(ctx context.Context) error {
	c.mu.Lock()
	auth := c.auth
	c.mu.Unlock()

	prefix, account, token, expireMS, err := splitAuth(auth)
	if err != nil {
		return err
	}
	left := time.Until(time.UnixMilli(expireMS))
	if left > 15*24*time.Hour {
		return nil
	}
	body := "<root><token>" + token + "</token><account>" + account + "</account><clienttype>656</clienttype></root>"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, refreshURL, strings.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/xml")
	req.Header.Set("Accept", "application/xml")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("刷新令牌失败: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var r struct {
		Return string `xml:"return"`
		Token  string `xml:"token"`
		Desc   string `xml:"desc"`
	}
	if err := xml.Unmarshal(raw, &r); err != nil || r.Return != "0" || r.Token == "" {
		return fmt.Errorf("刷新令牌被拒（%s）", strings.TrimSpace(r.Desc))
	}
	newAuth := base64.StdEncoding.EncodeToString([]byte(prefix + ":" + account + ":" + r.Token))
	c.mu.Lock()
	c.auth = newAuth
	c.mu.Unlock()
	if c.onNewAuth != nil {
		c.onNewAuth(newAuth)
	}
	return nil
}

func (c *Client) loadRoute(ctx context.Context) error {
	var resp struct {
		Success bool   `json:"success"`
		Code    string `json:"code"`
		Message string `json:"message"`
		Data    struct {
			List []struct {
				ModName string `json:"modName"`
				HTTPS   string `json:"httpsUrl"`
			} `json:"routePolicyList"`
		} `json:"data"`
	}
	body := map[string]any{
		"userInfo":    map[string]any{"userType": 1, "accountType": 1, "accountName": c.acct},
		"modAddrType": 1,
	}
	if err := c.postJSON(ctx, routeURL, body, &resp, true); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("路由下发失败: %s", resp.Message)
	}
	for _, p := range resp.Data.List {
		if p.ModName == "personal" && p.HTTPS != "" {
			c.mu.Lock()
			c.host = strings.TrimRight(p.HTTPS, "/")
			c.mu.Unlock()
			return nil
		}
	}
	return errors.New("路由下发里没有个人云地址")
}

func (c *Client) baseHost() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.host == "" {
		return "", errors.New("个人云地址未就绪")
	}
	return c.host, nil
}

// ---------- 请求与签名 ----------

var unescaped = regexp.MustCompile(`[A-Za-z0-9\-_.!~*'()]`)

// encodeURIComponent 等价于 JS 的 encodeURIComponent。
func encodeURIComponent(s string) string {
	var b strings.Builder
	for _, r := range s {
		ch := string(r)
		if unescaped.MatchString(ch) {
			b.WriteString(ch)
			continue
		}
		b.WriteString(url.PathEscape(ch))
	}
	return b.String()
}

func md5Upper(s string) string {
	sum := md5.Sum([]byte(s))
	return strings.ToUpper(hex.EncodeToString(sum[:]))
}

func calSign(body, ts, randStr string) string {
	enc := encodeURIComponent(body)
	runes := strings.Split(enc, "")
	sort.Strings(runes)
	b64 := base64.StdEncoding.EncodeToString([]byte(strings.Join(runes, "")))
	return md5Upper(md5Upper(b64) + md5Upper(ts+":"+randStr))
}

func randHex(n int) string {
	buf := make([]byte, n)
	_, _ = io.ReadFull(crand.Reader, buf)
	return hex.EncodeToString(buf)
}

func (c *Client) setHeaders(req *http.Request, ts, randStr, svcType string) {
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Authorization", "Basic "+c.rawAuth())
	req.Header.Set("Caller", "web")
	req.Header.Set("Cms-Device", "default")
	req.Header.Set("Mcloud-Channel", "1000101")
	req.Header.Set("Mcloud-Client", "10701")
	req.Header.Set("Mcloud-Route", "001")
	req.Header.Set("Mcloud-Version", "7.14.0")
	req.Header.Set("x-DeviceInfo", "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||")
	req.Header.Set("x-huawei-channelSrc", "10000034")
	req.Header.Set("x-inner-ntwk", "2")
	req.Header.Set("x-m4c-caller", "PC")
	req.Header.Set("x-m4c-src", "10002")
	req.Header.Set("x-SvcType", svcType)
	req.Header.Set("X-Yun-Api-Version", "v1")
	req.Header.Set("X-Yun-App-Channel", "10000034")
	req.Header.Set("X-Yun-Channel-Source", "10000034")
	req.Header.Set("X-Yun-Client-Info", "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||dW5kZWZpbmVk||")
	req.Header.Set("X-Yun-Module-Type", "100")
	req.Header.Set("X-Yun-Svc-Type", "1")
}

func (c *Client) rawAuth() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.auth
}

func (c *Client) postJSON(ctx context.Context, fullURL string, body any, out any, isRoute bool) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	ts := time.Now().Format("2006-01-02 15:04:05")
	randStr := randHex(8) // 16 字符
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	c.setHeaders(req, ts, randStr, "1")
	req.Header.Set("Mcloud-Sign", ts+","+randStr+","+calSign(string(payload), ts, randStr))
	if isRoute {
		req.Header.Set("Origin", "https://yun.139.com")
		req.Header.Set("Referer", "https://yun.139.com/w/")
		req.Header.Set("Inner-Hcy-Router-Https", "1")
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("云端返回 HTTP %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	var base struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &base)
	if !base.Success {
		if base.Message != "" {
			return errors.New(base.Message)
		}
		return fmt.Errorf("云端拒绝请求: %s", truncate(string(raw), 200))
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) postPath(ctx context.Context, path string, body any, out any) error {
	host, err := c.baseHost()
	if err != nil {
		return err
	}
	return c.postJSON(ctx, host+path, body, out, false)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ---------- 目录与文件 ----------

type listResp struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    struct {
		Items []struct {
			FileID    string `json:"fileId"`
			Name      string `json:"name"`
			Size      int64  `json:"size"`
			Type      string `json:"type"`
			UpdatedAt string `json:"updatedAt"`
		} `json:"items"`
		NextPageCursor string `json:"nextPageCursor"`
	} `json:"data"`
}

// List 列出一个目录（parentID 传 "/" 表示根）。
func (c *Client) List(ctx context.Context, parentID string) ([]File, error) {
	if parentID == "" {
		parentID = "/"
	}
	var out []File
	cursor := ""
	for page := 0; page < 200; page++ {
		var r listResp
		body := map[string]any{
			"imageThumbnailStyleList": []string{"Small", "Large"},
			"orderBy":                 "updated_at",
			"orderDirection":          "DESC",
			"pageInfo":                map[string]any{"pageCursor": cursor, "pageSize": 100},
			"parentFileId":            parentID,
		}
		if err := c.postPath(ctx, "/file/list", body, &r); err != nil {
			return nil, err
		}
		if !r.Success {
			return nil, fmt.Errorf("列目录失败: %s", r.Message)
		}
		for _, it := range r.Data.Items {
			f := File{ID: it.FileID, Name: it.Name, Size: it.Size, Dir: it.Type == "folder"}
			if it.UpdatedAt != "" {
				for _, layout := range []string{"2006-01-02T15:04:05.999-07:00", "2006-01-02T15:04:05-07:00", "2006-01-02 15:04:05"} {
					if t, err := time.Parse(layout, it.UpdatedAt); err == nil {
						f.ModTime = t
						break
					}
				}
			}
			out = append(out, f)
		}
		if r.Data.NextPageCursor == "" {
			break
		}
		cursor = r.Data.NextPageCursor
	}
	return out, nil
}

// DownloadURL 取文件的 CDN 直链。
func (c *Client) DownloadURL(ctx context.Context, fileID string) (string, error) {
	var r struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			CdnURL    string `json:"cdnUrl"`
			CdnSwitch bool   `json:"cdnSwitch"`
			URL       string `json:"url"`
		} `json:"data"`
	}
	if err := c.postPath(ctx, "/file/getDownloadUrl", map[string]any{"fileId": fileID}, &r); err != nil {
		return "", err
	}
	if !r.Success {
		return "", fmt.Errorf("取下载地址失败: %s", r.Message)
	}
	if r.Data.CdnSwitch && r.Data.CdnURL != "" {
		return r.Data.CdnURL, nil
	}
	if r.Data.URL == "" {
		return "", errors.New("云端没有返回下载地址")
	}
	return r.Data.URL, nil
}

// CreateDir 建目录，返回新目录 ID（可能为空，调用方可用 List 校正）。
func (c *Client) CreateDir(ctx context.Context, parentID, name string) (string, error) {
	var r struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			FileID string `json:"fileId"`
		} `json:"data"`
	}
	body := map[string]any{
		"parentFileId":   parentID,
		"name":           name,
		"description":    "",
		"type":           "folder",
		"fileRenameMode": "force_rename",
	}
	if err := c.postPath(ctx, "/file/create", body, &r); err != nil {
		return "", err
	}
	if !r.Success {
		return "", fmt.Errorf("建目录失败: %s", r.Message)
	}
	return r.Data.FileID, nil
}

// Rename 原地改名（同目录），用于 chunker 把临时分片名改成最终名。
// 云端只提供改名接口，跨目录移动需由调用方用「读+写+删」实现。
func (c *Client) Rename(ctx context.Context, fileID, newName string) error {
	var r struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	body := map[string]any{"fileId": fileID, "name": newName, "description": ""}
	if err := c.postPath(ctx, "/file/update", body, &r); err != nil {
		return err
	}
	if !r.Success {
		return fmt.Errorf("改名失败: %s", r.Message)
	}
	return nil
}

// Delete 删除文件或目录（进回收站）。
func (c *Client) Delete(ctx context.Context, fileID string) error {
	var r struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := c.postPath(ctx, "/recyclebin/batchTrash", map[string]any{"fileIds": []string{fileID}}, &r); err != nil {
		return err
	}
	if !r.Success {
		return fmt.Errorf("删除失败: %s", r.Message)
	}
	return nil
}

// Quota 返回已用与总容量（拿不到就返回 0,0）。
func (c *Client) Quota(ctx context.Context) (int64, int64) {
	var r struct {
		Success bool `json:"success"`
		Data    struct {
			DiskSize     int64 `json:"diskSize"`
			FreeDiskSize int64 `json:"freeDiskSize"`
		} `json:"data"`
	}
	if err := c.postPath(ctx, "/file/quota", map[string]any{}, &r); err != nil || !r.Success {
		return 0, 0
	}
	return r.Data.DiskSize - r.Data.FreeDiskSize, r.Data.DiskSize
}

// ---------- 上传 ----------

const (
	partSmall = 100 << 20
	partLarge = 512 << 20
)

func partSize(size int64) int64 {
	if size > 30<<30 {
		return partLarge
	}
	return partSmall
}

type partInfo struct {
	PartNumber int   `json:"partNumber"`
	PartSize   int64 `json:"partSize"`
}
type uploadPartInfo struct {
	PartNumber int    `json:"partNumber"`
	UploadURL  string `json:"uploadUrl"`
}

// Upload 上传一个文件。r 会被完整读一次（落临时文件），以便算 SHA256 与分片重传。
func (c *Client) Upload(ctx context.Context, parentID, name string, r io.Reader, size int64, progress func(done, total int64)) error {
	tmp, err := os.CreateTemp("", "cloud139-*.part")
	if err != nil {
		return err
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()

	h := sha256.New()
	read, err := io.Copy(io.MultiWriter(tmp, h), r)
	if err != nil {
		return err
	}
	if size > 0 && read != size {
		return fmt.Errorf("收到的数据长度 %d 与声明 %d 不一致", read, size)
	}
	size = read
	fullHash := strings.ToUpper(hex.EncodeToString(h.Sum(nil)))

	ps := partSize(size)
	parts := (size + ps - 1) / ps
	if parts < 1 {
		parts = 1
	}
	firstN := parts
	if firstN > 100 {
		firstN = 100
	}
	infos := make([]partInfo, 0, firstN)
	for i := int64(0); i < firstN; i++ {
		n := ps
		if rem := size - i*ps; rem < n {
			n = rem
		}
		infos = append(infos, partInfo{PartNumber: int(i + 1), PartSize: n})
	}

	var created struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			FileID    string           `json:"fileId"`
			FileName  string           `json:"fileName"`
			UploadID  string           `json:"uploadId"`
			Exist     bool             `json:"exist"`
			PartInfos []uploadPartInfo `json:"partInfos"`
		} `json:"data"`
	}
	body := map[string]any{
		"contentHash":          fullHash,
		"contentHashAlgorithm": "SHA256",
		"contentType":          "application/octet-stream",
		"parallelUpload":       false,
		"partInfos":            infos,
		"size":                 size,
		"parentFileId":         parentID,
		"name":                 name,
		"type":                 "file",
		"fileRenameMode":       "auto_rename",
	}
	if err := c.postPath(ctx, "/file/create", body, &created); err != nil {
		return err
	}
	if !created.Success {
		return fmt.Errorf("创建上传任务失败: %s", created.Message)
	}
	if created.Data.Exist {
		return nil // 内容完全相同，云端已存在
	}
	if len(created.Data.PartInfos) == 0 {
		return errors.New("云端没有返回分片上传地址")
	}

	done := int64(0)
	if err := c.putParts(ctx, tmp.Name(), ps, infos, created.Data.PartInfos, func(n int64) {
		done += n
		if progress != nil {
			progress(done, size)
		}
	}); err != nil {
		return err
	}

	for i := int64(100); i < parts; i += 100 {
		end := i + 100
		if end > parts {
			end = parts
		}
		more := make([]partInfo, 0, end-i)
		for k := i; k < end; k++ {
			n := ps
			if rem := size - k*ps; rem < n {
				n = rem
			}
			more = append(more, partInfo{PartNumber: int(k + 1), PartSize: n})
		}
		var moreResp struct {
			Success bool `json:"success"`
			Data    struct {
				PartInfos []uploadPartInfo `json:"partInfos"`
			} `json:"data"`
		}
		body := map[string]any{
			"fileId":    created.Data.FileID,
			"uploadId":  created.Data.UploadID,
			"partInfos": more,
			"commonAccountInfo": map[string]any{
				"account":     c.acct,
				"accountType": 1,
			},
		}
		if err := c.postPath(ctx, "/file/getUploadUrl", body, &moreResp); err != nil {
			return err
		}
		if !moreResp.Success || len(moreResp.Data.PartInfos) == 0 {
			return errors.New("追加分片地址失败")
		}
		if err := c.putParts(ctx, tmp.Name(), ps, infos, moreResp.Data.PartInfos, func(n int64) {
			done += n
			if progress != nil {
				progress(done, size)
			}
		}); err != nil {
			return err
		}
	}

	var done2 struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	cbody := map[string]any{
		"contentHash":          fullHash,
		"contentHashAlgorithm": "SHA256",
		"fileId":               created.Data.FileID,
		"uploadId":             created.Data.UploadID,
	}
	if err := c.postPath(ctx, "/file/complete", cbody, &done2); err != nil {
		return err
	}
	if !done2.Success {
		return fmt.Errorf("合并分片失败: %s", done2.Message)
	}
	return nil
}

// putParts 从本地文件按偏移读取分片，PUT 到云端给的上传地址。
func (c *Client) putParts(ctx context.Context, path string, ps int64, all []partInfo, urls []uploadPartInfo, add func(int64)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	sort.Slice(urls, func(i, j int) bool { return urls[i].PartNumber < urls[j].PartNumber })
	for _, u := range urls {
		idx := u.PartNumber - 1
		if idx < 0 || idx >= len(all) {
			return fmt.Errorf("分片序号 %d 越界", u.PartNumber)
		}
		n := all[idx].PartSize
		off := int64(idx) * ps
		sec := io.NewSectionReader(f, off, n)
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, u.UploadURL, sec)
		if err != nil {
			return err
		}
		req.ContentLength = n
		req.Header.Set("Content-Type", "application/octet-stream")
		req.Header.Set("Content-Length", strconv.FormatInt(n, 10))
		req.Header.Set("Origin", "https://yun.139.com")
		req.Header.Set("Referer", "https://yun.139.com/")
		resp, err := c.http.Do(req)
		if err != nil {
			return fmt.Errorf("上传分片 %d 失败: %w", u.PartNumber, err)
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("上传分片 %d 返回 %d: %s", u.PartNumber, resp.StatusCode, truncate(string(raw), 120))
		}
		add(n)
	}
	return nil
}
