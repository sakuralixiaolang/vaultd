package vault

import (
	"context"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/operations"
)

// Move 把一个文件或整个目录移到 dst。同一目录内换名字就是重命名。
//
// 跨目录时 rclone 会优先用后端的 Mover（139 的 /file/update 只能改名，
// 跨目录会退化成「解密读出 → 重新加密上传 → 删源」），因此大文件会慢，
// 但语义和目录结构都是完整的。目录按深度优先逐个搬文件，全部成功后才删空源目录；
// 中途失败会停在半途，不会丢已搬走的内容。
func (v *Vault) Move(ctx context.Context, src, dst string) error {
	src = cleanRel(src)
	dst = cleanRel(dst)
	if src == "" || dst == "" {
		return errors.New("不能移动根目录")
	}
	if strings.Contains(src, "..") || strings.Contains(dst, "..") {
		return errors.New("路径不能包含 ..")
	}
	if src == dst {
		return nil
	}
	base := path.Base(dst)
	if base == "." || base == "/" || base == "" || base == metaName {
		return errors.New("目标名称不合法")
	}
	if src == dst || strings.HasPrefix(dst, src+"/") {
		return errors.New("不能把目录移动到它自己里面")
	}
	if !v.dirExists(ctx, path.Dir(dst)) {
		return errors.New("目标文件夹不存在")
	}
	if v.exists(ctx, dst) {
		return fmt.Errorf("目标已存在：%s", base)
	}

	isDir, err := v.isDir(ctx, src)
	if err != nil {
		return err
	}
	if isDir {
		return v.moveDir(ctx, src, dst, 0)
	}
	if err := v.moveFile(ctx, src, dst); err != nil {
		return err
	}
	v.renameMeta(ctx, src, dst)
	return nil
}

func (v *Vault) isDir(ctx context.Context, remote string) (bool, error) {
	// 先看对象本身：真实文件的 Size() >= 0；目录在 crypt 里可能也能
	// NewObject 成功，但 Size() 是 -1。不能只看 List —— 对文件调 List
	// 有些后端会返回空列表而不报错，会把文件误判成空目录。
	if o, err := v.f.NewObject(ctx, remote); err == nil {
		if _, ok := o.(fs.Directory); ok {
			return true, nil
		}
		if o.Size() >= 0 {
			return false, nil
		}
	}
	if _, err := v.f.List(ctx, remote); err == nil {
		return true, nil
	}
	return false, fmt.Errorf("源不存在：%s", remote)
}

func (v *Vault) dirExists(ctx context.Context, dir string) bool {
	dir = cleanRel(dir)
	if dir == "" {
		return true
	}
	_, err := v.f.List(ctx, dir)
	return err == nil
}

func (v *Vault) exists(ctx context.Context, remote string) bool {
	if o, err := v.f.NewObject(ctx, remote); err == nil {
		if _, ok := o.(fs.Directory); ok {
			return true
		}
		if o.Size() >= 0 {
			return true
		}
	}
	_, err := v.f.List(ctx, remote)
	return err == nil
}

func (v *Vault) moveFile(ctx context.Context, src, dst string) error {
	o, err := v.f.NewObject(ctx, src)
	if err != nil {
		return fmt.Errorf("读取源文件失败: %w", err)
	}
	if _, err := operations.Move(ctx, v.f, nil, dst, o); err != nil {
		return fmt.Errorf("移动失败: %w", err)
	}
	return nil
}

func (v *Vault) moveDir(ctx context.Context, src, dst string, depth int) error {
	if depth > 8 {
		return errors.New("目录层级过深，已停止移动")
	}
	entries, err := v.List(ctx, src)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		if err := v.Mkdir(ctx, dst); err != nil {
			return err
		}
		return v.Delete(ctx, src)
	}
	for _, e := range entries {
		s := path.Join(src, e.Name)
		d := path.Join(dst, e.Name)
		if e.Dir {
			if err := v.mkdirIfMissing(ctx, d); err != nil {
				return err
			}
			if err := v.moveDir(ctx, s, d, depth+1); err != nil {
				return fmt.Errorf("%s: %w", s, err)
			}
			continue
		}
		if v.exists(ctx, d) {
			return fmt.Errorf("目标已存在：%s", d)
		}
		if err := v.moveFile(ctx, s, d); err != nil {
			return fmt.Errorf("%s: %w", s, err)
		}
		v.renameMeta(ctx, s, d)
	}
	// 全部文件搬完后删空目录；139 的列表有秒级延迟，稍等再删。
	time.Sleep(150 * time.Millisecond)
	return v.Delete(ctx, src)
}

func (v *Vault) mkdirIfMissing(ctx context.Context, remote string) error {
	if v.dirExists(ctx, remote) {
		return nil
	}
	return v.Mkdir(ctx, remote)
}

// renameMeta 迁移原始时间索引，列表里移动后的照片仍显示拍摄时间。
func (v *Vault) renameMeta(ctx context.Context, src, dst string) {
	v.loadMeta(ctx)
	v.idxMu.Lock()
	defer v.idxMu.Unlock()
	if m, ok := v.idx[path.Join("/", src)]; ok {
		v.idx[path.Join("/", dst)] = m
		delete(v.idx, path.Join("/", src))
		v.idxDirty = true
	}
}
