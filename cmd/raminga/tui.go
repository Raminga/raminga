package main

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/tui"
)

func newTUICmd() *cobra.Command {
	var (
		includeText bool
		reportDir   string
		scriptPath  string
		plain       bool
		pipe        bool
	)
	cmd := &cobra.Command{
		Use:   "tui",
		Short: "Chat-style test panel (thin client of the local API)",
		Long: "Open the single-screen Raminga test panel. It only talks to the existing " +
			"local Connect API over the selected Unix-socket default or explicit loopback-TCP " +
			"transport; it does not start a node, open a network listener or enable the test API.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			dataDir := dataDirFrom(cmd)
			opts := tui.Options{
				Version:     buildVersion(),
				DataDir:     dataDir,
				ReportDir:   reportDir,
				IncludeText: includeText,
				Plain:       plain,
			}
			if scriptPath != "" {
				lines, err := readTUIScript(scriptPath)
				if err != nil {
					return err
				}
				opts.Script = lines
			}
			if pipe && scriptPath == "" {
				return fmt.Errorf("--pipe requires --script (it is the non-TTY automation path)")
			}
			return runTUI(cmd, dataDir, opts, pipe, scriptPath != "")
		},
	}
	cmd.Flags().BoolVar(&includeText, "include-text", false, "include chat message text in exported reports (explicit opt-in)")
	cmd.Flags().StringVar(&reportDir, "report-dir", "", "report output directory (default: <data-dir>/reports)")
	cmd.Flags().StringVar(&scriptPath, "script", "", "non-interactive smoke script; each line is submitted as TUI input (tests only)")
	cmd.Flags().BoolVar(&plain, "plain", false, "disable colors/styles (plain terminals and snapshots)")
	cmd.Flags().BoolVar(&pipe, "pipe", false, "run the scripted TUI without a pty (restricted CI; requires --script)")
	return cmd
}

// runTUI is shared by `raminga tui` and bare `raminga`; the caller decides
// whether a node must already be running.
func runTUI(cmd *cobra.Command, dataDir string, opts tui.Options, pipe, scripted bool) error {
	if opts.Version == "" {
		opts.Version = buildVersion()
	}
	if opts.DataDir == "" {
		opts.DataDir = dataDir
	}
	if opts.ReportDir == "" {
		opts.ReportDir = strings.TrimRight(dataDir, "/") + "/reports"
	}
	c, err := client.New(dataDir)
	if err != nil {
		return err
	}
	defer c.Close()
	model := tui.NewModel(tui.NewAPIClientFromClient(c), opts)
	defer model.Close()
	programOpts := []tea.ProgramOption{tea.WithContext(cmd.Context())}
	if pipe {
		programOpts = append(programOpts, tea.WithInput(bytes.NewReader(nil)), tea.WithOutput(cmd.OutOrStdout()), tea.WithoutSignals())
	}
	p := tea.NewProgram(model, programOpts...)
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("TUI: %w", err)
	}
	if err := model.AutoErr(); err != nil {
		return fmt.Errorf("TUI automation failed: %w", err)
	}
	if !scripted {
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), "TUI closed; the daemon is still running.")
	}
	return nil
}

func readTUIScript(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open TUI script: %w", err)
	}
	defer func() { _ = f.Close() }()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 4096), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lines = append(lines, line)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}
