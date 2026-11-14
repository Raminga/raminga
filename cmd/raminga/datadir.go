package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/Raminga/raminga/internal/api/paths"
	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/identity"
)

// launcherCacheDir is the shared binary cache written by the plugin launchers
// (plugins/shared/launcher). On a fresh machine ~/.raminga can contain only
// this directory before the first node ever starts.
const launcherCacheDir = "bin"

// isRamingaOwnedDataDirEntry reports whether an entry is created by Raminga
// itself around startup rather than by some other program. Such entries do not
// prove that the directory is a foreign data directory. The list is
// deliberately narrow: state-bearing files such as raminga.db, public/ or
// agent/ still make a directory without identity/ or config.toml suspicious.
func isRamingaOwnedDataDirEntry(e fs.DirEntry) bool {
	switch e.Name() {
	case launcherCacheDir:
		return e.IsDir()
	case identity.LockFileName, daemonLogName, daemonLogName + ".1",
		paths.SocketFileName, paths.TokenFileName, paths.EndpointFileName:
		return !e.IsDir()
	}
	return false
}

// detectForeignDataDir reports whether dataDir looks like an existing,
// non-empty directory that does not belong to a Raminga node (neither
// identity/ nor config.toml is present). Fresh directories, directories that
// only hold Raminga-owned runtime entries (launcher binary cache, lock file,
// daemon logs, local API socket/token), and directories with identity/ or
// config.toml are safe; a foreign one must not be silently re-initialized, or
// the daemon would mint a second identity next to unrelated files.
func detectForeignDataDir(dataDir string) (bool, error) {
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if len(entries) == 0 {
		return false, nil
	}
	hasIdentity, hasConfig, hasOther := false, false, false
	for _, e := range entries {
		switch {
		case e.Name() == identity.IdentityDirName && e.IsDir():
			hasIdentity = true
		case e.Name() == config.FileName && !e.IsDir():
			hasConfig = true
		case isRamingaOwnedDataDirEntry(e):
			// Raminga runtime entry; it does not make the directory foreign.
		default:
			hasOther = true
		}
	}
	if hasIdentity || hasConfig {
		return false, nil
	}
	return hasOther, nil
}

// nodeIdentityPresent reports whether dir is an initialized Raminga node. It
// checks for the identity key, not just an empty identity/ directory.
func nodeIdentityPresent(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, identity.IdentityDirName, identity.KeyFileName))
	return err == nil && !info.IsDir()
}

// otherNodeDataDirs returns known node locations (other than the target) that
// already hold an identity. It covers the two locations this CLI can select
// ($RAMINGA_DATA_DIR and ~/.raminga) plus the legacy paths documented in
// docs/install.md, where an old node can end up nested after a mistaken `mv`.
func otherNodeDataDirs(dataDir string) ([]string, error) {
	target, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, err
	}
	var candidates []string
	if env := os.Getenv("RAMINGA_DATA_DIR"); env != "" {
		candidates = append(candidates, env)
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".raminga"),
			filepath.Join(home, ".raminga", "raminga-test"),
			filepath.Join(home, ".raminga-before-migrate"),
			filepath.Join(home, ".raminga-new"),
			filepath.Join(home, ".raminga-new", "raminga-test"),
		)
	}

	seen := map[string]bool{target: true}
	var found []string
	for _, candidate := range candidates {
		abs, err := filepath.Abs(candidate)
		if err != nil {
			return nil, err
		}
		if seen[abs] || !nodeIdentityPresent(abs) {
			continue
		}
		seen[abs] = true
		found = append(found, abs)
	}
	return found, nil
}

// autoStartWarning returns the same pre-start safety message for every path
// that may auto-start a daemon: bare `raminga` (TUI) and `raminga mcp`. An
// empty string means startup is allowed. Warning (rather than an error) keeps
// the MCP server available to report the condition per call; callers decide
// whether to continue.
func autoStartWarning(dataDir string) (string, error) {
	foreign, err := detectForeignDataDir(dataDir)
	if err != nil {
		return "", err
	}
	if foreign {
		return fmt.Sprintf("警告：%s 已存在且非空，但既无 identity/ 也无 config.toml，疑似旧版或非 Raminga 数据目录。为避免误建新身份，未自动初始化。请确认后显式迁移或沿用（raminga init --data-dir %s）。", dataDir, dataDir), nil
	}
	if nodeIdentityPresent(dataDir) {
		return "", nil
	}
	otherNodes, err := otherNodeDataDirs(dataDir)
	if err != nil {
		return "", err
	}
	if len(otherNodes) == 0 {
		return "", nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "警告：目标数据目录 %s 尚无身份，但检测到其他位置已有 Raminga 节点：\n", dataDir)
	for _, path := range otherNodes {
		fmt.Fprintf(&b, "  - %s\n", path)
	}
	b.WriteString("为避免误建新身份，未自动初始化。请确认要复用哪个节点：用 RAMINGA_DATA_DIR 或 --data-dir 指向该目录，或把该目录的 identity/ 与数据迁移到目标目录后再启动。")
	return b.String(), nil
}
