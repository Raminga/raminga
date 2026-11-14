//go:build !windows

package endpoint

import (
	"fmt"
	"os"
	"syscall"
)

func platformSupported() error { return nil }

func checkPlatformProtection(info os.FileInfo) error {
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
