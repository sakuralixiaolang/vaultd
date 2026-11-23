// vaultd：PC 端本地网关 + 密文库客户端。
//
// 启动后只监听 127.0.0.1，浏览器通过带 token 的 URL 访问；
// 加密、文件名加密、分片全部由 rclone 的成熟实现完成，本程序不含密码学代码。
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"vaultd/internal/localcfg"
	"vaultd/internal/server"
)

func main() {
	var (
		listen   = flag.String("listen", "", "监听地址，默认取本机配置（127.0.0.1:0 表示随机端口）")
		withOpen = flag.Bool("open", true, "启动后自动打开浏览器")
		urlFile  = flag.String("writeurl", "", "把带 token 的访问地址写入指定文件（便于脚本化自测）")
	)
	flag.Parse()
	log.SetFlags(0)

	cfg, err := localcfg.Load()
	if err != nil {
		fatal(err)
	}
	generated, err := localcfg.EnsureKey(cfg)
	if err != nil {
		fatal(err)
	}
	if generated {
		log.Printf("首次运行：已生成本机主密钥，配置写入 %s", localcfg.Path())
		log.Printf("该文件不可外传；它一旦丢失，云端密文将无法解密。")
	}

	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		fatal(err)
	}
	token := hex.EncodeToString(tokenBytes)

	srv := server.New(cfg, token)

	addr := cfg.Listen
	if *listen != "" {
		addr = *listen
	}
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fatal(err)
	}

	url := fmt.Sprintf("http://%s/?t=%s", ln.Addr().String(), token)

	httpSrv := &http.Server{
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 15 * time.Second,
		// 大文件上传可能持续很久，不设 WriteTimeout
	}

	log.Printf("密文相册已启动：%s", url)
	if *urlFile != "" {
		_ = os.WriteFile(*urlFile, []byte(url), 0o600)
	}
	log.Printf("密钥指纹 %s…（配置文件：%s）", cfg.Fingerprint(), localcfg.Path())
	if !cfg.Configured() {
		log.Printf("尚未配置云端，请在页面里填写本机 WebDAV 接入信息。")
	}

	if *withOpen {
		go func() {
			time.Sleep(300 * time.Millisecond)
			openBrowser(url)
		}()
	}

	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
		<-ch
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(ctx)
	}()

	if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fatal(err)
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func fatal(err error) {
	log.Printf("错误：%v", err)
	os.Exit(1)
}
