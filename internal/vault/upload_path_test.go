package vault

import (
	"context"
	"strings"
	"testing"

	_ "github.com/rclone/rclone/backend/memory"
	"github.com/rclone/rclone/fs"
)

// 回归：之前 Upload 只把 path.Base(remote) 交给 Fs.Put，子目录被吃掉，
// 所有上传其实都落在根目录。这里保证子目录里的文件真的在子目录里。
func TestUploadKeepsDir(t *testing.T) {
	ctx := context.Background()
	f, err := fs.NewFs(ctx, ":memory:")
	if err != nil {
		t.Fatalf("new fs: %v", err)
	}
	v := &Vault{f: f}

	if err := v.Mkdir(ctx, "sub"); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := "hello-dir"
	if err := v.Upload(ctx, "sub/a.txt", strings.NewReader(body), int64(len(body))); err != nil {
		t.Fatalf("upload: %v", err)
	}

	list, err := v.List(ctx, "sub")
	if err != nil {
		t.Fatalf("list sub: %v", err)
	}
	if len(list) != 1 || list[0].Name != "a.txt" || list[0].Size != int64(len(body)) {
		t.Fatalf("子目录内容不对: %+v", list)
	}

	root, err := v.List(ctx, "")
	if err != nil {
		t.Fatalf("list root: %v", err)
	}
	for _, e := range root {
		if e.Name == "a.txt" {
			t.Fatalf("文件跑到了根目录: %+v", root)
		}
	}

	// 顺手把目录删掉：文件夹格子上的 × 按钮走的就是 Delete。
	if err := v.Delete(ctx, "sub"); err != nil {
		t.Fatalf("delete dir: %v", err)
	}
	root, err = v.List(ctx, "")
	if err != nil {
		t.Fatalf("list root again: %v", err)
	}
	for _, e := range root {
		if e.Name == "sub" {
			t.Fatalf("目录没删掉: %+v", root)
		}
	}
}
