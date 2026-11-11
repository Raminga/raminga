package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/api/paths"
)

const (
	notRunningMsg     = "节点未运行"
	stoppedMsg        = "已停止节点"
	systemdStopMsg    = "节点由 systemd 管理；请用 sudo systemctl stop raminga"
	systemdRestartMsg = "节点由 systemd 管理；请用 sudo systemctl restart raminga"
)

func newStopCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "stop",
		Short: "Stop the running node for this data directory",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runStop(cmd, dataDirFrom(cmd))
		},
	}
}

func newRestartCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "restart",
		Short: "Stop the running node (if any) and start the current binary",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runRestart(cmd, dataDirFrom(cmd))
		},
	}
}

func printNotRunning(cmd *cobra.Command) {
	_, _ = fmt.Fprintln(cmd.OutOrStdout(), notRunningMsg)
}

func runStop(cmd *cobra.Command, dataDir string) error {
	st, err := localStatus(dataDir, 5*time.Second)
	if err != nil {
		printNotRunning(cmd)
		return nil
	}
	if st.GetSupervised() {
		return errors.New(systemdStopMsg)
	}
	if err := requestShutdown(cmd.Context(), dataDir); err != nil {
		return err
	}
	if err := waitForStop(cmd.Context(), dataDir, autoStartTimeout); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(cmd.OutOrStdout(), stoppedMsg)
	return nil
}

func runRestart(cmd *cobra.Command, dataDir string) error {
	st, err := localStatus(dataDir, 5*time.Second)
	if err == nil {
		if st.GetSupervised() {
			return errors.New(systemdRestartMsg)
		}
		if err := requestShutdown(cmd.Context(), dataDir); err != nil {
			return err
		}
		if err := waitForStop(cmd.Context(), dataDir, autoStartTimeout); err != nil {
			return err
		}
	}
	if err := ensureDaemon(cmd.Context(), cmd, dataDir); err != nil {
		return err
	}
	st, err = localStatus(dataDir, 5*time.Second)
	if err != nil {
		return fmt.Errorf("节点已启动，但读取版本失败：%w", err)
	}
	_, _ = fmt.Fprintf(cmd.OutOrStdout(), "已重启节点：raminga %s\n", st.GetVersion())
	return nil
}

func requestShutdown(ctx context.Context, dataDir string) error {
	c, err := client.New(dataDir)
	if err != nil {
		return err
	}
	defer c.Close()
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	res, err := c.Shutdown(callCtx)
	if err != nil {
		return fmt.Errorf("停止节点失败：%w", err)
	}
	if !res.GetAccepted() {
		return errors.New("停止节点失败：daemon 未接受请求")
	}
	return nil
}

// waitForStop waits until the daemon removes its API socket. The daemon stops
// the node before closing the API, so the socket disappearing also means the
// data-dir lock has been released and a restart can claim it.
func waitForStop(ctx context.Context, dataDir string, timeout time.Duration) error {
	sock := paths.SocketPath(dataDir)
	deadline := time.Now().Add(timeout)
	for {
		if _, err := os.Lstat(sock); errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("等待节点停止超时（%s）", timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
