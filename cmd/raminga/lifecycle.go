package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/api/client"
)

const (
	autoStartTimeout = 15 * time.Second
	daemonLogName    = "daemon.log"
	daemonLogMaxSize = 10 << 20
	startingNodeMsg  = "正在启动节点…"
)

// isInteractiveTerminal is true only when both stdin and stdout are terminals,
// so pipes and CI never accidentally start a daemon.
func isInteractiveTerminal() bool {
	return term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}

func daemonLogPath(dataDir string) string {
	return filepath.Join(dataDir, daemonLogName)
}

// localStatus reads the local API status. It never starts a daemon.
func localStatus(dataDir string, timeout time.Duration) (*apiv1.StatusResponse, error) {
	c, err := client.New(dataDir)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return c.Status(ctx)
}

// ensureDaemon connects to the data-dir daemon, starting a detached one first
// if the local API is not reachable.
func ensureDaemon(ctx context.Context, cmd *cobra.Command, dataDir string) error {
	if _, err := localStatus(dataDir, time.Second); err == nil {
		return nil
	}
	_, _ = fmt.Fprintln(cmd.OutOrStdout(), startingNodeMsg)
	done, err := spawnDaemon(dataDir)
	if err != nil {
		return fmt.Errorf("无法启动节点：%w", err)
	}
	if err := waitForDaemon(ctx, dataDir, done, autoStartTimeout); err != nil {
		return err
	}
	return nil
}

// spawnDaemon starts `raminga daemon` detached from the current terminal.
func spawnDaemon(dataDir string) (<-chan error, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("locate executable: %w", err)
	}
	logFile, err := openDaemonLog(dataDir)
	if err != nil {
		return nil, err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDONLY, 0)
	if err != nil {
		_ = logFile.Close()
		return nil, fmt.Errorf("open null device: %w", err)
	}
	child := exec.Command(exe, "daemon", "--data-dir", dataDir)
	child.Stdin = null
	child.Stdout = logFile
	child.Stderr = logFile
	configureDetached(child)
	if err := child.Start(); err != nil {
		_ = null.Close()
		_ = logFile.Close()
		return nil, fmt.Errorf("start daemon: %w", err)
	}
	// The child owns the log and null handles after Start; the parent can close
	// its copies. Wait is reaped in the background so a fast exit is observable
	// without leaving a zombie.
	_ = null.Close()
	_ = logFile.Close()
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	return done, nil
}

// openDaemonLog rotates an oversized daemon.log to daemon.log.1, then opens the
// log for append with 0600.
func openDaemonLog(dataDir string) (*os.File, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	path := daemonLogPath(dataDir)
	if info, err := os.Stat(path); err == nil && info.Size() > daemonLogMaxSize {
		_ = os.Remove(path + ".1")
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open daemon log %q: %w", path, err)
	}
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("restrict daemon log %q: %w", path, err)
	}
	return f, nil
}

// waitForDaemon polls the local API. A detached child may lose the data-dir
// lock race and exit while the winner is still becoming ready, so an exited
// child is not a failure by itself when its log reports the lock.
func waitForDaemon(ctx context.Context, dataDir string, done <-chan error, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	childExited := false
	var childExitAt time.Time
	for {
		if _, err := localStatus(dataDir, time.Second); err == nil {
			return nil
		}
		if done != nil {
			select {
			case childErr := <-done:
				_ = childErr
				done = nil
				childExited = true
				childExitAt = time.Now()
			default:
			}
		}
		if childExited {
			// A lock loser keeps waiting for the winner's API. Any other early
			// exit gets a short grace window so a concurrent restart can hand
			// over to a new daemon before this invocation reports failure.
			grace := 3 * time.Second
			if logHasLockWait(dataDir) {
				grace = timeout
			}
			if time.Since(childExitAt) > grace {
				return startupFailure(dataDir, timeout)
			}
		}
		if time.Now().After(deadline) {
			return startupFailure(dataDir, timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func logHasLockWait(dataDir string) bool {
	tail := tailFile(daemonLogPath(dataDir), 20)
	return strings.Contains(tail, "data directory is locked by another raminga daemon")
}

// startupFailure reports the log path and its tail instead of the opaque Go
// process error.
func startupFailure(dataDir string, timeout time.Duration) error {
	path := daemonLogPath(dataDir)
	tail := tailFile(path, 20)
	if strings.TrimSpace(tail) == "" {
		tail = "(日志为空)"
	}
	return fmt.Errorf("节点启动失败（%s 内本地 API 不可用）\n日志：%s\n%s", timeout, path, tail)
}

func tailFile(path string, lines int) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	parts := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	return strings.Join(parts, "\n")
}
