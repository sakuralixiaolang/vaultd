// Package mobile 把与 PC 端完全相同的 Go 核（rclone crypt + chunker + WebDAV）
// 封装成可供 Android/iOS 调用的入口：进程内起一个只监听 127.0.0.1 的网关，
// 由 App 内的 WebView 加载其地址。
//
// 约束（与 PC 端一致）：
//   - 加解密全部复用 rclone 的成熟实现，本包不含任何密码学代码；
//   - 主密钥在本机配置目录首次运行时自动生成并落盘，不硬编码、不入仓库；
//   - 网关只绑 127.0.0.1，且所有请求需要随机 token。
package mobile

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"vaultd/internal/localcfg"
	"vaultd/internal/server"
)

var (
	mu     sync.Mutex
	hs     *http.Server
	ln     net.Listener
	curURL string
)

// Start 启动进程内网关，返回带 token 的访问地址（形如 http://127.0.0.1:12345/?t=xxxx）。
// homeDir 传 App 的私有目录（Android: context.getFilesDir().getAbsolutePath()），
// 主密钥与配置都写在该目录下，不会离开本机。重复调用返回同一地址。
func Start(homeDir string) (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if hs != nil && curURL != "" {
		return curURL, nil
	}
	if homeDir != "" {
		if err := os.Setenv("VAULTD_HOME", homeDir); err != nil {
			return "", err
		}
	}
	cfg, err := localcfg.Load()
	if err != nil {
		return "", fmt.Errorf("读取本机配置失败: %w", err)
	}
	if _, err := localcfg.EnsureKey(cfg); err != nil {
		return "", fmt.Errorf("生成主密钥失败: %w", err)
	}

	tb := make([]byte, 16)
	if _, err := rand.Read(tb); err != nil {
		return "", err
	}
	token := hex.EncodeToString(tb)

	srv := server.New(cfg, token)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	h := &http.Server{
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	go func() {
		_ = h.Serve(l)
	}()

	hs, ln = h, l
	curURL = fmt.Sprintf("http://%s/?t=%s", l.Addr().String(), token)
	return curURL, nil
}

// Stop 关闭网关（App 退到后台或退出时调用）。
func Stop() error {
	mu.Lock()
	defer mu.Unlock()
	if hs == nil {
		return nil
	}
	err := hs.Close()
	hs, ln, curURL = nil, nil, ""
	return err
}

// Fingerprint 返回主密钥指纹，用于让用户在手机与 PC 上核对是否同一把钥匙。
func Fingerprint() string {
	cfg, err := localcfg.Load()
	if err != nil {
		return ""
	}
	return cfg.Fingerprint()
}

// Configured 表示是否已经填好云端接入信息。
func Configured() bool {
	cfg, err := localcfg.Load()
	if err != nil {
		return false
	}
	return cfg.Configured()
}

// SaveWebDAV 写入云端接入信息并落盘（供原生设置页使用；
// 若不实现原生设置页，直接用 WebView 里的 /api/setup 亦可）。
func SaveWebDAV(url, user, pass, remotePath string) error {
	cfg, err := localcfg.Load()
	if err != nil {
		return err
	}
	if url == "" || user == "" {
		return errors.New("WebDAV 地址与用户名不能为空")
	}
	cfg.WebDAVURL = url
	cfg.WebDAVUser = user
	cfg.WebDAVPass = pass
	if remotePath != "" {
		cfg.RemotePath = remotePath
	}
	return cfg.Save()
}

// Version 返回占位版本号，便于 App 侧展示。
func Version() string { return "android-mvp" }
