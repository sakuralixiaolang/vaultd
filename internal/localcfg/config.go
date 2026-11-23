// Package localcfg 负责本机配置与主密钥的引导。
//
// 设计约束（硬要求）：
//   - 不要求用户输入密码、不做解锁步骤、不做恢复码；
//   - 首次运行若本机无密钥，则生成随机主密钥并持久化到本机配置文件，之后一直复用；
//   - 密钥/凭据只存在本机用户目录下的配置文件中，绝不写入源码、模板或仓库。
package localcfg

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config 是本机唯一的凭据/密钥载体。整个文件都在 .gitignore 覆盖范围内。
type Config struct {
	// 接入方式：webdav = 外部 WebDAV（历史形态）；native = 进程内直连云盘
	Backend string `json:"backend,omitempty"`
	// native 模式的云盘授权串（base64），由首次登录得到；刷新后会回写
	CloudAuth string `json:"cloud_authorization,omitempty"`
	// native 模式的云盘类型，目前支持 139
	CloudProvider string `json:"cloud_provider,omitempty"`

	// WebDAV 接入点（本机 AList/OpenList 暴露的地址，必须开启 Web 代理以确保 Range 生效）
	WebDAVURL  string `json:"webdav_url"`
	WebDAVUser string `json:"webdav_user"`
	WebDAVPass string `json:"webdav_pass"`
	// 密文根目录（WebDAV 上的一个子目录，避免与明文目录混放）
	RemotePath string `json:"remote_path"`

	// 主密钥与盐（hex）。两者一起决定 crypt 的真实密钥，改动即等于换库。
	MasterKey string `json:"master_key"`
	Salt      string `json:"salt"`

	// 分片大小（rclone chunker），默认 500Mi
	ChunkSize string `json:"chunk_size"`
	// 监听地址，默认 127.0.0.1:0（随机端口）
	Listen string `json:"listen"`
}

func defaults() *Config {
	return &Config{
		RemotePath: "vault",
		ChunkSize:  "500Mi",
		Listen:     "127.0.0.1:0",
	}
}

// Dir 返回本机配置目录（Windows: %LOCALAPPDATA%\EncryptedVault）。
func Dir() string {
	if v := os.Getenv("VAULTD_HOME"); v != "" {
		return v
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = "."
	}
	return filepath.Join(base, "EncryptedVault")
}

// Path 返回配置文件绝对路径。
func Path() string { return filepath.Join(Dir(), "config.json") }

// Load 读取配置；不存在时返回带默认值的新配置（但不会落盘）。
func Load() (*Config, error) {
	c := defaults()
	b, err := os.ReadFile(Path())
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, fmt.Errorf("配置文件解析失败: %w", err)
	}
	if c.RemotePath == "" {
		c.RemotePath = "vault"
	}
	if c.ChunkSize == "" {
		c.ChunkSize = "500Mi"
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:0"
	}
	return c, nil
}

// EnsureKey：首次运行时生成 32 字节随机主密钥与盐，并立即落盘。
// 返回 generated 表示本次是否是新生成。
func EnsureKey(c *Config) (generated bool, err error) {
	if validHex(c.MasterKey, 32) && validHex(c.Salt, 32) {
		return false, nil
	}
	var key, salt [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return false, err
	}
	if _, err := rand.Read(salt[:]); err != nil {
		return false, err
	}
	c.MasterKey = hex.EncodeToString(key[:])
	c.Salt = hex.EncodeToString(salt[:])
	if err := c.Save(); err != nil {
		return false, err
	}
	return true, nil
}

// Save 原子写入配置文件（0600）。
func (c *Config) Save() error {
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := Path() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, Path())
}

// Configured 表示接入信息是否齐备（native 模式看授权串）。
func (c *Config) Configured() bool {
	if c.Backend == "native" {
		return c.CloudAuth != ""
	}
	return c.WebDAVURL != "" && c.WebDAVUser != ""
}

// BackendName 返回人类可读的接入方式。
func (c *Config) BackendName() string {
	if c.Backend == "native" {
		return "内置直连（" + c.CloudProvider + "）"
	}
	return "外部 WebDAV"
}

// ClearCloud 清掉授权与接入信息（换账号/退出时用）。
func (c *Config) ClearCloud() {
	c.CloudAuth = ""
	c.WebDAVURL, c.WebDAVUser, c.WebDAVPass = "", "", ""
}

// Fingerprint 返回密钥指纹：对主密钥做一次 SHA-256，取前 8 位。
// 只用于在多台设备上核对「是不是同一把钥匙」，不含密钥本身、也不可反推。
func (c *Config) Fingerprint() string {
	if len(c.MasterKey) < 16 {
		return ""
	}
	sum := sha256.Sum256([]byte(c.MasterKey))
	return strings.ToUpper(hex.EncodeToString(sum[:4]))
}

func validHex(s string, bytes int) bool {
	if len(s) != bytes*2 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
