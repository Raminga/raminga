package tui

import (
	"io"
	"os"

	osc52 "github.com/aymanbagabas/go-osc52/v2"
	tea "github.com/charmbracelet/bubbletea"
)

// clipboardCmd writes one complete OSC52 sequence with a single Write call.
// Bubble Tea's renderer writes each flush in one call too, so the escape
// sequence cannot be split by a repaint; no Exec/full-screen handoff is
// needed. The writer is injectable for tests and defaults to stdout, which is
// also Bubble Tea's default output.
func clipboardCmd(value string, out io.Writer) tea.Cmd {
	seq := []byte(osc52.New(value).String())
	return func() tea.Msg {
		if out == nil {
			out = os.Stdout
		}
		_, _ = out.Write(seq)
		return nil
	}
}
