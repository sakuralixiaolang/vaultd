package vault

import (
	"context"
	"strings"
	"testing"

	_ "github.com/rclone/rclone/backend/memory"
	"github.com/rclone/rclone/fs"
)

// 回归：删除「非空目录」时，crypt/WebDAV 后端里目录也能 NewObject 成功，
// 直接 Remove 会报 directory not empty，必须递归进子目录再删。
func TestDeleteNestedDir(t *testing.T) {
	ctx := context.Background()
	f, err := fs.NewFs(ctx, ":memory:")
	if err != nil {
		t.Fatalf("new fs: %v", err)
	}
	v := &Vault{f: f}

	for _, d := range []string{"a", "a/b", "a/b/c"} {
		if err := v.Mkdir(ctx, d); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}
	for _, p := range []string{"a/1.txt", "a/b/2.txt", "a/b/c/3.txt"} {
		body := "x" + p
		if err := v.Upload(ctx, p, strings.NewReader(body), int64(len(body))); err != nil {
			t.Fatalf("upload %s: %v", p, err)
		}
	}

	if err := v.Delete(ctx, "a"); err != nil {
		t.Fatalf("delete tree: %v", err)
	}
	root, err := v.List(ctx, "")
	if err != nil {
		t.Fatalf("list root: %v", err)
	}
	for _, e := range root {
		if e.Name == "a" {
			t.Fatalf("非空目录没删干净: %+v", root)
		}
	}
}
