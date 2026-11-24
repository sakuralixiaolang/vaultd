package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vaultd/internal/localcfg"
)

const (
	testKey  = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	testSalt = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("VAULTD_HOME", t.TempDir())
	cfg := &localcfg.Config{
		Backend:    "native",
		MasterKey:  testKey,
		Salt:       testSalt,
		RemotePath: "vault",
		ChunkSize:  "500Mi",
	}
	// 这里刻意不填授权串：Configured() 为假，reload 不会真的去连云端。
	return New(cfg, "tok")
}

func doReq(s *Server, method, target, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Host = "127.0.0.1:9999"
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "tok"})
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, req)
	return w
}

func TestConfigExport(t *testing.T) {
	s := testServer(t)
	w := doReq(s, http.MethodGet, "/api/config/export", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, "vaultd-config.json") {
		t.Fatalf("Content-Disposition=%q", cd)
	}
	var doc transferDoc
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Type != transferType || doc.Version != 1 {
		t.Fatalf("type/version=%q/%d", doc.Type, doc.Version)
	}
	if doc.MasterKey != testKey || doc.Salt != testSalt {
		t.Fatal("导出必须原样带上主密钥与盐，否则导入端解不开已有密文")
	}
	if doc.RemotePath != "vault" || doc.ChunkSize != "500Mi" {
		t.Fatalf("remote/chunk=%q/%q", doc.RemotePath, doc.ChunkSize)
	}
}

func TestConfigImportRejectsBadKey(t *testing.T) {
	s := testServer(t)
	body := `{"type":"vaultd-config","version":1,"backend":"native","cloud_authorization":"x","master_key":"short","salt":"` + testSalt + `"}`
	w := doReq(s, http.MethodPost, "/api/config/import", body)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "64 位 hex") {
		t.Fatalf("body=%s", w.Body.String())
	}
}

func TestConfigImportRejectsForeignFile(t *testing.T) {
	s := testServer(t)
	w := doReq(s, http.MethodPost, "/api/config/import", `{"type":"other","version":1}`)
	if !strings.Contains(w.Body.String(), "不是 vaultd 配置") {
		t.Fatalf("body=%s", w.Body.String())
	}
}

func TestConfigExportNeedsKey(t *testing.T) {
	t.Setenv("VAULTD_HOME", t.TempDir())
	s := New(&localcfg.Config{RemotePath: "vault", ChunkSize: "500Mi"}, "tok")
	w := doReq(s, http.MethodGet, "/api/config/export", "")
	if !strings.Contains(w.Body.String(), "还没有主密钥") {
		t.Fatalf("body=%s", w.Body.String())
	}
}
