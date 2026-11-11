package mcp

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/Raminga/raminga/agent"
	"github.com/Raminga/raminga/internal/identity"
)

// agentOnboardingFiles are the private root templates copied by
// raminga_agent_init. Session/host templates are intentionally excluded: a
// session is created only when a journey starts, and the persistent host
// config stays disabled until the user separately opts in.
var agentOnboardingFiles = []string{"persona.md", "growth.md", "contact-notes.json"}

// agentInitResult is the JSON returned by raminga_agent_init. Created and
// Existing hold paths relative to the node data directory and never expose
// file contents.
type agentInitResult struct {
	DataDir            string   `json:"data_dir"`
	AgentDir           string   `json:"agent_dir"`
	Created            []string `json:"created"`
	Existing           []string `json:"existing"`
	DirectoriesCreated []string `json:"directories_created"`
}

// requireNodeIdentity rejects Agent initialization before the node itself has
// an identity. Creating agent/ first would make the data directory look like a
// foreign non-empty directory to the daemon's first-run safety check.
func requireNodeIdentity(dataDir string) error {
	notInitialized := fmt.Errorf("节点尚未初始化：%s 中缺少 identity/key。请先调用 raminga_status 确认节点状态并完成节点初始化，再创建私有 Agent 数据；未创建任何文件或目录。", dataDir)

	rootInfo, err := os.Stat(dataDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return notInitialized
		}
		return fmt.Errorf("检查数据目录失败：%w；未创建任何文件或目录。", err)
	}
	if !rootInfo.IsDir() {
		return notInitialized
	}

	keyPath := filepath.Join(dataDir, identity.IdentityDirName, identity.KeyFileName)
	info, err := os.Lstat(keyPath)
	if err == nil {
		if info.Mode().IsRegular() {
			return nil
		}
		return fmt.Errorf("节点身份文件不是普通文件：%s。请先确认节点状态，未创建任何文件或目录。", keyPath)
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("检查节点身份失败：%w；未创建任何文件或目录。", err)
	}
	return notInitialized
}

// initAgentData creates the missing private Agent onboarding layout under
// <dataDir>/agent/. It never overwrites, truncates, or follows a symlinked
// agent/sessions directory, and it never touches public/. It refuses to run
// before the node has an identity key and creates nothing in that case.
func initAgentData(dataDir string) (agentInitResult, error) {
	result := agentInitResult{
		DataDir:            dataDir,
		AgentDir:           filepath.Join(dataDir, "agent"),
		Created:            []string{},
		Existing:           []string{},
		DirectoriesCreated: []string{},
	}

	if err := requireNodeIdentity(dataDir); err != nil {
		return result, err
	}

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return result, fmt.Errorf("create data directory: %w", err)
	}
	info, err := os.Stat(dataDir)
	if err != nil {
		return result, fmt.Errorf("stat data directory: %w", err)
	}
	if !info.IsDir() {
		return result, fmt.Errorf("data directory is not a directory: %s", dataDir)
	}

	agentDir, err := safeAgentPath(dataDir, "agent")
	if err != nil {
		return result, err
	}
	created, err := ensurePrivateDir(agentDir)
	if err != nil {
		return result, err
	}
	if created {
		result.DirectoriesCreated = append(result.DirectoriesCreated, "agent/")
	}

	templates, err := agent.TemplateFS()
	if err != nil {
		return result, err
	}
	for _, name := range agentOnboardingFiles {
		content, err := fs.ReadFile(templates, "private/"+name)
		if err != nil {
			return result, fmt.Errorf("read embedded template private/%s: %w", name, err)
		}
		dest, err := safeAgentPath(dataDir, filepath.Join("agent", name))
		if err != nil {
			return result, err
		}
		existed, err := writeNewFile(dest, content)
		if err != nil {
			return result, fmt.Errorf("initialize agent/%s: %w", name, err)
		}
		rel := filepath.ToSlash(filepath.Join("agent", name))
		if existed {
			result.Existing = append(result.Existing, rel)
		} else {
			result.Created = append(result.Created, rel)
		}
	}

	sessionsDir, err := safeAgentPath(dataDir, filepath.Join("agent", "sessions"))
	if err != nil {
		return result, err
	}
	created, err = ensurePrivateDir(sessionsDir)
	if err != nil {
		return result, err
	}
	if created {
		result.DirectoriesCreated = append(result.DirectoriesCreated, "agent/sessions/")
	}

	return result, nil
}

// safeAgentPath joins a fixed relative path inside dataDir and rejects absolute
// paths, parent traversal, and anything that resolves outside the data
// directory. The embedded templates are trusted, but this keeps the file I/O
// boundary explicit and testable.
func safeAgentPath(dataDir, rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) || filepath.VolumeName(rel) != "" {
		return "", fmt.Errorf("invalid Agent path %q", rel)
	}
	clean := filepath.Clean(rel)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("agent path escapes the data directory: %q", rel)
	}
	root, err := filepath.Abs(dataDir)
	if err != nil {
		return "", fmt.Errorf("resolve data directory: %w", err)
	}
	dest := filepath.Join(root, clean)
	back, err := filepath.Rel(root, dest)
	if err != nil || back == ".." || strings.HasPrefix(back, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("agent path escapes the data directory: %q", rel)
	}
	return dest, nil
}

// ensurePrivateDir creates a directory with 0700 or validates an existing one.
// A symlink is rejected rather than followed, so init cannot be redirected
// outside <data-dir>/agent/.
func ensurePrivateDir(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return false, fmt.Errorf("refusing to follow symlinked Agent directory: %s", path)
		}
		if !info.IsDir() {
			return false, fmt.Errorf("agent path is not a directory: %s", path)
		}
		return false, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return false, fmt.Errorf("create Agent directory %s: %w", path, err)
	}
	// MkdirAll applies the process umask; make the privacy mode explicit.
	if err := os.Chmod(path, 0o700); err != nil {
		return false, fmt.Errorf("restrict Agent directory %s: %w", path, err)
	}
	return true, nil
}

// writeNewFile creates path with O_EXCL and reports whether it already existed.
// Existing files of any type are left untouched; a partially written new file
// is removed before returning the error.
func writeNewFile(path string, content []byte) (bool, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := f.Write(content); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return false, err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return false, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return false, err
	}
	return false, nil
}
