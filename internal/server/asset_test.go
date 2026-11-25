package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// 静态资源要能走 304：WebView 冷启动时不用重新解析一遍 JS/CSS。
func TestServeAssetETag(t *testing.T) {
	body := []byte("console.log('vaultd');")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	serveAsset(rec, req, "text/javascript; charset=utf-8", body)

	if rec.Code != http.StatusOK {
		t.Fatalf("first GET = %d, want 200", rec.Code)
	}
	tag := rec.Header().Get("ETag")
	if tag == "" {
		t.Fatal("缺少 ETag")
	}
	if got := rec.Body.String(); got != string(body) {
		t.Fatalf("body = %q", got)
	}

	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	req2.Header.Set("If-None-Match", tag)
	serveAsset(rec2, req2, "text/javascript; charset=utf-8", body)

	if rec2.Code != http.StatusNotModified {
		t.Fatalf("GET with If-None-Match = %d, want 304", rec2.Code)
	}
	if rec2.Body.Len() != 0 {
		t.Fatalf("304 不应带 body，实际 %d 字节", rec2.Body.Len())
	}
}
