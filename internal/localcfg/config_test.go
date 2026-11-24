package localcfg

import "testing"

func TestValidKeyHex(t *testing.T) {
	good := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if !ValidKeyHex(good) {
		t.Fatal("64 位 hex 应该通过")
	}
	for _, bad := range []string{"", "abc", good + "0", "zz" + good[2:]} {
		if ValidKeyHex(bad) {
			t.Fatalf("应该拒绝: %q", bad)
		}
	}
}

func TestValidRemotePath(t *testing.T) {
	for _, ok := range []string{"vault", "a/b", "/vault/"} {
		if err := ValidRemotePath(ok); err != nil {
			t.Fatalf("%q 应该通过: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "/", "..", "vault/../x", `a\b`, "a//b"} {
		if err := ValidRemotePath(bad); err == nil {
			t.Fatalf("%q 应该被拒绝", bad)
		}
	}
}

func TestValidChunkSize(t *testing.T) {
	for _, ok := range []string{"500Mi", "32M", "1Gi", "1048576"} {
		if err := ValidChunkSize(ok); err != nil {
			t.Fatalf("%q 应该通过: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "Mi", "500mi", "500 MB", "-5Mi"} {
		if err := ValidChunkSize(bad); err == nil {
			t.Fatalf("%q 应该被拒绝", bad)
		}
	}
}
