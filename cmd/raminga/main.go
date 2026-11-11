package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"syscall"

	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/tui"
	"github.com/Raminga/raminga/internal/tuiinit"
)

const defaultVersion = "0.1.0-g451"

// version is overridden by -ldflags "-X main.version=...".
var version = defaultVersion

// buildVersion adds the VCS revision for a plain `go build` that did not pass
// an ldflags version. Release builds keep their template version verbatim.
func buildVersion() string {
	if version != defaultVersion {
		return version
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return version
	}
	return versionWithBuildInfo(version, info)
}

func versionWithBuildInfo(base string, info *debug.BuildInfo) string {
	if info == nil {
		return base
	}
	revision := ""
	modified := false
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.modified":
			modified = setting.Value == "true"
		}
	}
	if revision == "" {
		return base
	}
	short := revision
	if len(short) > 7 {
		short = short[:7]
	}
	out := base + "-g" + short
	if modified {
		out += "-dirty"
	}
	return out
}

func main() {
	// Bubble Tea v1 probes the terminal from its package init. tuiinit makes
	// that probe bounded; restore the real TERM and a fresh renderer before
	// any command runs so interactive colors still work.
	tuiinit.Restore()
	lipgloss.SetDefaultRenderer(lipgloss.NewRenderer(os.Stdout))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := newRootCmd().ExecuteContext(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "raminga: %s\n", cliErrText(err))
		os.Exit(1)
	}
}

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "raminga",
		Short:         "Raminga node daemon and local CLI",
		Long:          "With a terminal on stdin and stdout, bare `raminga` ensures the node is running and opens the TUI. In a pipe it prints this help.",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !isInteractiveTerminal() {
				return cmd.Help()
			}
			dataDir, err := filepath.Abs(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			// Bare `raminga` auto-starts a daemon, so it must apply the same
			// foreign/other-node safety checks as `raminga mcp`.
			warning, err := autoStartWarning(dataDir)
			if err != nil {
				return err
			}
			if warning != "" {
				return fmt.Errorf("%s", warning)
			}
			if err := ensureDaemon(cmd.Context(), cmd, dataDir); err != nil {
				return err
			}
			return runTUI(cmd, dataDir, tui.Options{
				Version: buildVersion(),
				DataDir: dataDir,
			}, false, false)
		},
	}
	root.PersistentFlags().String("data-dir", defaultDataDir(), "node data directory (default: $RAMINGA_DATA_DIR, else ~/.raminga)")
	root.AddCommand(
		newInitCmd(),
		newDaemonCmd(),
		newStopCmd(),
		newRestartCmd(),
		newStatusCmd(),
		newConnectCmd(),
		newDisconnectCmd(),
		newChatCmd(),
		newPeersCmd(),
		newFriendsCmd(),
		newContentCmd(),
		newRelayCmd(),
		newDHTCmd(),
		newNetworkCmd(),
		newVersionCmd(),
		newTestCmd(),
		newTUICmd(),
		newReportCmd(),
		newMCPCmd(),
	)
	return root
}

func dataDirFrom(cmd *cobra.Command) string {
	dir, _ := cmd.Flags().GetString("data-dir")
	if dir == "" {
		return defaultDataDir()
	}
	return dir
}

func defaultDataDir() string {
	if dir := os.Getenv("RAMINGA_DATA_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".raminga"
	}
	return home + string(os.PathSeparator) + ".raminga"
}
