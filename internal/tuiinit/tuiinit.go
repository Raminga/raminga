// Package tuiinit bounds Bubble Tea v1's terminal-status probe.
//
// Bubble Tea v1.3 calls lipgloss.HasDarkBackground() from its package init.
// That writes an OSC 11 query plus a cursor-position query and waits up to
// five seconds for a terminal reply. A pty used by expect, CI, or some
// SSH/plain terminals does not answer, so the TUI would drop keys sent during
// startup. There is no public timeout option (termenv.OSCTimeout is a const),
// so this package temporarily makes the terminal look non-interactive during
// dependency initialization. Restore is called from main before any command
// runs, and the lipgloss renderer is recreated with the real TERM.
package tuiinit

import (
	"os"
	"strings"
)

var savedTerm string

func init() {
	savedTerm = os.Getenv("TERM")
	if strings.HasPrefix(savedTerm, "dumb") || strings.HasPrefix(savedTerm, "screen") || strings.HasPrefix(savedTerm, "tmux") {
		return
	}
	_ = os.Setenv("TERM", "dumb")
}

// Restore puts the original TERM back after package initialization. It is
// idempotent and safe to call from main.
func Restore() {
	if savedTerm == "" {
		_ = os.Unsetenv("TERM")
		return
	}
	_ = os.Setenv("TERM", savedTerm)
}
