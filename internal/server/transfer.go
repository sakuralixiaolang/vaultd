// 配置导入/导出：把本机凭据做成一个可搬家的 JSON 文件，供新设备（尤其手机）一次导入。
//
// 这份文件里含主密钥与云端授权串——等于整库的钥匙，导出动作必须由用户明确触发，
// 落盘文件名固定、带明显的警告字段，不做任何后台自动导出。
package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// transferDoc 是导出文件的格式。version 变化时导入端按低版本兼容处理。
type transferDoc struct {
	Type          string `json:"type"`
	Version       int    `json:"version"`
	Warning       string `json:"warning"`
	Backend       string `json:"backend"`
	CloudProvider string `json:"cloud_provider,omitempty"`
	CloudAuth     string `json:"cloud_authorization,omitempty"`
	MasterKey     string `json:"master_key,omitempty"`
	Salt          string `json:"salt,omitempty"`
	WebDAVURL     string `json:"webdav_url,omitempty"`
	WebDAVUser    string `json:"webdav_user,omitempty"`
	WebDAVPass    string `json:"webdav_pass,omitempty"`
	RemotePath    string `json:"remote_path"`
	ChunkSize     string `json:"chunk_size"`
	ExportedAt    string `json:"exported_at"`
}

const transferType = "vaultd-config"

func (s *Server) handleConfigExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.cfg.MasterKey == "" || s.cfg.Salt == "" {
		writeErr(w, errors.New("本机还没有主密钥，先配好云端再导出"))
		return
	}
	doc := transferDoc{
		Type:       transferType,
		Version:    1,
		Warning:    "这份文件等于密文库的钥匙：含主密钥、盐与云端授权串。不要发给任何人，导入完就删掉。",
		Backend:    "native",
		MasterKey:  s.cfg.MasterKey,
		Salt:       s.cfg.Salt,
		RemotePath: s.cfg.RemotePath,
		ChunkSize:  s.cfg.ChunkSize,
		ExportedAt: time.Now().Format(time.RFC3339),
	}
	if s.cfg.Backend == "native" {
		doc.CloudProvider = s.cfg.CloudProvider
		doc.CloudAuth = s.cfg.CloudAuth
	} else {
		doc.Backend = "webdav"
		doc.WebDAVURL = s.cfg.WebDAVURL
		doc.WebDAVUser = s.cfg.WebDAVUser
		doc.WebDAVPass = s.cfg.WebDAVPass
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="vaultd-config.json"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(append(b, '\n'))
}

func (s *Server) handleConfigImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// 不禁用未知字段：PC 的本机 config.json 里还有 listen 等设备相关项，
	// 直接把它拖进来导入也应当能用（多出来的字段忽略即可）。
	var doc transferDoc
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&doc); err != nil {
		writeErr(w, errors.New("不是有效的配置文件: "+err.Error()))
		return
	}
	if doc.Type != "" && doc.Type != transferType {
		writeErr(w, errors.New("这是 "+doc.Type+" 的文件，不是 vaultd 配置"))
		return
	}
	if doc.Version > 1 {
		writeErr(w, errors.New("配置文件版本过新，先升级客户端"))
		return
	}

	req := setupReq{
		Backend:    "native",
		MasterKey:  strings.TrimSpace(doc.MasterKey),
		Salt:       strings.TrimSpace(doc.Salt),
		RemotePath: doc.RemotePath,
		ChunkSize:  doc.ChunkSize,
	}
	if doc.Backend == "webdav" || (doc.CloudAuth == "" && doc.WebDAVURL != "") {
		req.Backend = ""
		req.URL = strings.TrimSpace(doc.WebDAVURL)
		req.User = doc.WebDAVUser
		req.Pass = doc.WebDAVPass
	} else {
		req.CloudProvider = doc.CloudProvider
		req.CloudAuth = strings.TrimSpace(doc.CloudAuth)
	}
	resp, err := s.applySetup(r.Context(), req)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, resp)
}
