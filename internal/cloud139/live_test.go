package cloud139

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// 这是一个“真实云盘”冒烟测试：默认跳过，只有显式给了授权串才会跑。
//
//	$env:VAULTD_CLOUD_AUTH = "<授权串>"
//	go test ./internal/cloud139 -run TestLive -v
//
// 验证顺序：鉴权与路由 → 列根目录 → 取下载地址并做一次 Range 读 → 上传小文件 → 删除。
func TestLive(t *testing.T) {
	auth := strings.TrimSpace(os.Getenv("VAULTD_CLOUD_AUTH"))
	if auth == "" {
		t.Skip("未设置 VAULTD_CLOUD_AUTH，跳过真实云盘测试")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	c, err := New(auth, &http.Client{}, nil)
	if err != nil {
		t.Fatalf("构造客户端失败: %v", err)
	}
	if err := c.Start(ctx); err != nil {
		t.Fatalf("鉴权/路由失败: %v", err)
	}
	t.Logf("账号 %s，个人云地址已下发", c.acct)

	files, err := c.List(ctx, "/")
	if err != nil {
		t.Fatalf("列根目录失败: %v", err)
	}
	t.Logf("根目录 %d 项", len(files))
	for i, f := range files {
		if i >= 10 {
			break
		}
		t.Logf("  %-40s size=%d dir=%v", f.Name, f.Size, f.Dir)
	}

	// 可选：检查某个子目录里的密文对象，确认对象头没有被破坏
	if dirName := strings.TrimSpace(os.Getenv("VAULTD_CLOUD_DIR")); dirName != "" {
		for _, f := range files {
			if f.Dir && f.Name == dirName {
				sub, err := c.List(ctx, f.ID)
				if err != nil {
					t.Fatalf("列 %s 失败: %v", dirName, err)
				}
				t.Logf("%s 下 %d 个密文对象", dirName, len(sub))
				for i, s := range sub {
					if i >= 10 {
						break
					}
					t.Logf("  %-50s size=%d", s.Name, s.Size)
				}
				if len(sub) > 0 && !sub[0].Dir {
					link, err := c.DownloadURL(ctx, sub[0].ID)
					if err != nil {
						t.Fatalf("取密文下载地址失败: %v", err)
					}
					req, _ := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
					req.Header.Set("Range", "bytes=0-7")
					req.Header.Set("Origin", "https://yun.139.com")
					req.Header.Set("Referer", "https://yun.139.com/")
					resp, err := http.DefaultClient.Do(req)
					if err != nil {
						t.Fatalf("密文头读取失败: %v", err)
					}
					defer resp.Body.Close()
					head, _ := io.ReadAll(io.LimitReader(resp.Body, 8))
					t.Logf("密文对象头 8 字节: % x（文本 %q）", head, string(head))
					if string(head) != "RCLONE\x00\x00" {
						t.Errorf("密文头不是 RCLONE 魔数: % x", head)
					}
				}
				return
			}
		}
		t.Fatalf("根目录没有名为 %s 的目录", dirName)
	}

	// 找一个文件做 Range 读
	var target *File
	for i := range files {
		if !files[i].Dir && files[i].Size > 16 {
			target = &files[i]
			break
		}
	}
	if target == nil {
		t.Log("根目录没有可读文件，跳过 Range 检查")
		return
	}
	link, err := c.DownloadURL(ctx, target.ID)
	if err != nil {
		t.Fatalf("取下载地址失败: %v", err)
	}
	t.Logf("下载直链主机: %s", strings.SplitN(strings.TrimPrefix(link, "https://"), "/", 2)[0])

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	req.Header.Set("Range", "bytes=8-23")
	req.Header.Set("Origin", "https://yun.139.com")
	req.Header.Set("Referer", "https://yun.139.com/")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Range 请求失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("期望 206，实际 %d", resp.StatusCode)
	}
	t.Logf("Range 206，Content-Range=%s，取到 %d 字节", resp.Header.Get("Content-Range"), len(body))

	// 上传/删除：写一个随机小文件到根目录再删
	name := fmt.Sprintf("vaultd-probe-%d.bin", time.Now().Unix())
	payload := []byte("vaultd-probe-payload")
	if err := c.Upload(ctx, "/", name, strings.NewReader(string(payload)), int64(len(payload)), nil); err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	t.Logf("上传成功: %s (%d 字节)", name, len(payload))

	after, err := c.List(ctx, "/")
	if err != nil {
		t.Fatalf("复查列表失败: %v", err)
	}
	var id string
	for _, f := range after {
		if f.Name == name {
			id = f.ID
			break
		}
	}
	if id == "" {
		t.Fatalf("上传后在列表里找不到 %s", name)
	}
	if err := c.Delete(ctx, id); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	t.Logf("删除成功，清理完成")
}
