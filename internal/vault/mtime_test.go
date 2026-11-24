package vault

import (
	"context"
	"strings"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/memory"
	"github.com/rclone/rclone/fs"
)

// 云盘只会记上传时间，原始时间存在密文索引里；这里验证
// 「上传时给的时间能读回来」「索引文件不出现在列表里」「换实例还能读到」。
func TestMTimeRoundTrip(t *testing.T) {
	ctx := context.Background()
	f, err := fs.NewFs(ctx, ":memory:")
	if err != nil {
		t.Fatalf("new fs: %v", err)
	}
	v := &Vault{f: f}

	want := time.Date(2019, 5, 6, 7, 8, 9, 0, time.UTC)
	body := "photo-bytes"
	if err := v.UploadAt(ctx, "dcim/a.jpg", strings.NewReader(body), int64(len(body)), want); err != nil {
		t.Fatalf("upload: %v", err)
	}
	if err := v.FlushMeta(ctx); err != nil {
		t.Fatalf("flush: %v", err)
	}

	list, err := v.List(ctx, "dcim")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || !list[0].ModTime.Equal(want) {
		t.Fatalf("时间没保留: %+v", list)
	}

	root, err := v.List(ctx, "")
	if err != nil {
		t.Fatalf("list root: %v", err)
	}
	for _, e := range root {
		if e.Name == metaName {
			t.Fatalf("索引文件泄漏到列表: %+v", root)
		}
	}

	// 换一个实例（模拟另一台设备/进程重启）应当能读到同一份记录
	v2 := &Vault{f: f}
	list2, err := v2.List(ctx, "dcim")
	if err != nil {
		t.Fatalf("list v2: %v", err)
	}
	if len(list2) != 1 || !list2[0].ModTime.Equal(want) {
		t.Fatalf("索引没持久化: %+v", list2)
	}

	// 删除后记录也要清掉
	if err := v2.Delete(ctx, "dcim/a.jpg"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := v2.FlushMeta(ctx); err != nil {
		t.Fatalf("flush2: %v", err)
	}
	v3 := &Vault{f: f}
	list3, err := v3.List(ctx, "dcim")
	if err != nil {
		t.Fatalf("list v3: %v", err)
	}
	if len(list3) != 0 {
		t.Fatalf("删完还有条目: %+v", list3)
	}
	v3.idxMu.Lock()
	_, still := v3.idx["/dcim/a.jpg"]
	v3.idxMu.Unlock()
	if still {
		t.Fatal("删除后索引里还留着这条时间记录")
	}
}
