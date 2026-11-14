//go:build !windows

package endpoint

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

func platformSupported() error { return nil }

// readProtectedFile opens the pathname without following a final symlink and
// validates the opened descriptor, not just the pathname inspected before
// Open. A concurrent replace must not let a different file or target be read.
func readProtectedFile(path string) ([]byte, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("local API endpoint: inspect %q: %w", path, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, false, fmt.Errorf("local API endpoint: %q is not a regular file", path)
	}
	if info.Size() > maxFileSize {
		return nil, false, fmt.Errorf("local API endpoint: %q is too large", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, false, fmt.Errorf("local API endpoint: open %q: %w", path, err)
	}
	defer func() { _ = f.Close() }()
	current, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	if !os.SameFile(info, current) || !current.Mode().IsRegular() || current.Size() > maxFileSize {
		return nil, false, fmt.Errorf("local API endpoint: %q changed while opening", path)
	}
	if err := checkUnixProtection(current); err != nil {
		return nil, false, err
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxFileSize+1))
	if err != nil {
		return nil, false, fmt.Errorf("local API endpoint: read %q: %w", path, err)
	}
	if len(raw) > maxFileSize {
		return nil, false, fmt.Errorf("local API endpoint: %q is too large", path)
	}
	return raw, true, nil
}

func checkUnixProtection(info os.FileInfo) error {
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("local API endpoint: file permissions %o expose secrets; want 0600", perm)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	if int(st.Uid) != os.Getuid() {
		return fmt.Errorf("local API endpoint: file owner uid %d does not match current uid %d", st.Uid, os.Getuid())
	}
	return nil
}

// writeProtectedFile uses a same-directory temporary file and rename. The
// token is written only after the temporary file has mode 0600; the final
// chmod covers implementations where rename preserves a less restrictive mode
// from a previous file at the destination.
func writeProtectedFile(path string, raw []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".api.endpoint-*")
	if err != nil {
		return fmt.Errorf("local API endpoint: create temporary file: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return fmt.Errorf("local API endpoint: protect temporary file: %w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		cleanup()
		return fmt.Errorf("local API endpoint: write temporary file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("local API endpoint: sync temporary file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("local API endpoint: close temporary file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("local API endpoint: publish discovery file: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("local API endpoint: protect discovery file: %w", err)
	}
	return nil
}
