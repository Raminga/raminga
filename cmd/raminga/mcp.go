package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	internalmcp "github.com/Raminga/raminga/internal/mcp"
)

// newMCPCmd builds the `raminga mcp` stdio MCP server subcommand. It is
// launched by host plugin shells on demand; stdout is reserved for MCP
// protocol frames, so every status line here goes to stderr.
func newMCPCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "mcp",
		Short: "Run the local Raminga API as a stdio MCP server",
		Long: `Serve the Raminga node tools over stdio (Model Context Protocol).

stdout carries JSON-RPC frames; all diagnostics go to stderr. The daemon is
started on demand if it is not already running, but a non-empty data directory
that looks foreign (no identity/ or config.toml) is never silently initialized.`,
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			dataDir, err := filepath.Abs(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			warning, err := autoStartWarning(dataDir)
			if err != nil {
				return err
			}
			if warning != "" {
				fmt.Fprintln(os.Stderr, warning)
				return internalmcp.Run(cmd.Context(), dataDir, buildVersion(), nil)
			}
			// Start the daemon lazily on the first tool call. The host's MCP
			// handshake timeout is short; a first node start must not make the
			// server look disconnected.
			return internalmcp.Run(cmd.Context(), dataDir, buildVersion(), nil,
				internalmcp.WithDaemonStarter(func(ctx context.Context) error {
					return ensureDaemonQuiet(ctx, dataDir)
				}))
		},
	}
}

// ensureDaemonQuiet is ensureDaemon without the cobra output writer: the
// daemon-start notice must go to stderr so stdout stays protocol-clean.
func ensureDaemonQuiet(ctx context.Context, dataDir string) error {
	if _, err := localStatus(dataDir, time.Second); err == nil {
		return nil
	}
	apiTCP, err := localAPITCPMode(dataDir)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, startingNodeMsg)
	done, err := spawnDaemon(dataDir, apiTCP)
	if err != nil {
		return fmt.Errorf("无法启动节点：%w", err)
	}
	return waitForDaemon(ctx, dataDir, done, autoStartTimeout)
}
