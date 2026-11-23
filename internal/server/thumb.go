package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/gif"
	_ "image/png"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"vaultd/internal/vault"
)

const (
	// 超过这个大小的图片不做缩略图（解码要整包进内存，手机上不划算）
	maxThumbSrc = 24 << 20
	thumbMaxAge = 5 * time.Minute
	thumbMaxMem = 48 << 20
	thumbMaxNum = 200
)

var errThumbUnsupported = errors.New("这个格式暂不支持生成缩略图")

type thumbEntry struct {
	data []byte
	at   time.Time
}

type thumbCall struct {
	done chan struct{}
	data []byte
	err  error
}

// 缩略图是纯派生数据：丢了能重新算，所以只放内存，不落盘。
var thumbStore = struct {
	sync.Mutex
	items    map[string]*thumbEntry
	inflight map[string]*thumbCall
	bytes    int
}{
	items:    map[string]*thumbEntry{},
	inflight: map[string]*thumbCall{},
}

func thumbExtOK(p string) bool {
	switch strings.ToLower(path.Ext(p)) {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp":
		return true
	}
	return false
}

func (s *Server) handleThumb(w http.ResponseWriter, r *http.Request) {
	remote := r.URL.Query().Get("path")
	if remote == "" {
		writeErr(w, errors.New("缺少 path"))
		return
	}
	if !thumbExtOK(remote) {
		writeErr(w, errThumbUnsupported)
		return
	}
	want := 360
	if v := r.URL.Query().Get("w"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			want = n
		}
	}
	if want < 64 {
		want = 64
	}
	if want > 1024 {
		want = 1024
	}

	v, err := s.needVault()
	if err != nil {
		writeErr(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	obj, err := v.Stat(ctx, remote)
	if err != nil {
		writeErr(w, fmt.Errorf("对象不存在: %w", err))
		return
	}
	if obj.Size() > maxThumbSrc {
		writeErr(w, errors.New("图片太大，不生成缩略图"))
		return
	}
	key := fmt.Sprintf("%s|%d|%d|%d", strings.Trim(remote, "/"), obj.Size(), obj.ModTime(ctx).Unix(), want)

	if data, ok := thumbGet(key); ok {
		serveThumb(w, data)
		return
	}

	// 同一张图被网格里多次请求时，只解码一次
	thumbStore.Lock()
	if c, ok := thumbStore.inflight[key]; ok {
		thumbStore.Unlock()
		select {
		case <-c.done:
			if c.err != nil {
				writeErr(w, c.err)
				return
			}
			serveThumb(w, c.data)
		case <-ctx.Done():
			writeErr(w, ctx.Err())
		}
		return
	}
	c := &thumbCall{done: make(chan struct{})}
	thumbStore.inflight[key] = c
	thumbStore.Unlock()

	c.data, c.err = buildThumb(ctx, v, remote, want)
	close(c.done)

	thumbStore.Lock()
	delete(thumbStore.inflight, key)
	if c.err == nil {
		thumbPutLocked(key, c.data)
	}
	thumbStore.Unlock()

	if c.err != nil {
		writeErr(w, c.err)
		return
	}
	serveThumb(w, c.data)
}

func buildThumb(ctx context.Context, v *vault.Vault, remote string, want int) ([]byte, error) {
	rc, err := v.OpenFull(ctx, remote)
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	src, _, err := image.Decode(io.LimitReader(rc, maxThumbSrc+1))
	if err != nil {
		return nil, errThumbUnsupported
	}
	b := src.Bounds()
	if b.Dx() <= 0 || b.Dy() <= 0 {
		return nil, errThumbUnsupported
	}
	if b.Dx() > want {
		h := int(float64(b.Dy())*float64(want)/float64(b.Dx()) + 0.5)
		if h < 1 {
			h = 1
		}
		dst := image.NewRGBA(image.Rect(0, 0, want, h))
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
		src = dst
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, src, &jpeg.Options{Quality: 82}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func serveThumb(w http.ResponseWriter, data []byte) {
	h := w.Header()
	h.Set("Content-Type", "image/jpeg")
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set("Cache-Control", fmt.Sprintf("private, max-age=%d", int(thumbMaxAge.Seconds())))
	_, _ = w.Write(data)
}

func thumbGet(key string) ([]byte, bool) {
	thumbStore.Lock()
	defer thumbStore.Unlock()
	e, ok := thumbStore.items[key]
	if !ok {
		return nil, false
	}
	if time.Since(e.at) > thumbMaxAge {
		thumbStore.bytes -= len(e.data)
		delete(thumbStore.items, key)
		return nil, false
	}
	return e.data, true
}

// thumbPutLocked 需要调用方持锁：按 FIFO 淘汰，兜住内存上限。
func thumbPutLocked(key string, data []byte) {
	if _, ok := thumbStore.items[key]; ok {
		return
	}
	for len(thumbStore.items) >= thumbMaxNum || (thumbStore.bytes+len(data) > thumbMaxMem && len(thumbStore.items) > 0) {
		var oldestKey string
		var oldest time.Time
		for k, e := range thumbStore.items {
			if oldest.IsZero() || e.at.Before(oldest) {
				oldestKey, oldest = k, e.at
			}
		}
		if oldestKey == "" {
			break
		}
		thumbStore.bytes -= len(thumbStore.items[oldestKey].data)
		delete(thumbStore.items, oldestKey)
	}
	thumbStore.items[key] = &thumbEntry{data: data, at: time.Now()}
	thumbStore.bytes += len(data)
}
