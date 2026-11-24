package cloud139

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 安卓上 os.TempDir() 落在 /data/local/tmp，App 无写权限，
// 上传中转文件必须能由宿主指定到私有目录。
func TestCreateTempFileHonorsOverride(t *testing.T) {
	dir := t.TempDir()
	old := TempDirOverride
	TempDirOverride = dir
	defer func() { TempDirOverride = old }()

	f, err := createTempFile("cloud139-*.part")
	if err != nil {
		t.Fatalf("指定目录应可创建: %v", err)
	}
	defer func() { f.Close(); os.Remove(f.Name()) }()
	if !strings.HasPrefix(f.Name(), dir) {
		t.Fatalf("中转文件没落在指定目录: %s", f.Name())
	}
}

func TestCreateTempFileReportsBadDir(t *testing.T) {
	old := TempDirOverride
	TempDirOverride = filepath.Join(t.TempDir(), "nope")
	defer func() { TempDirOverride = old }()

	if _, err := createTempFile("cloud139-*.part"); err == nil {
		t.Fatal("不存在的目录应当报错")
	}
}
