// Package tuipty drives the real Raminga TUI binary through a pty. It is used
// by the interactive host test and by the lab walkthrough; it never uses the
// non-interactive --script/--pipe automation path.
package tuipty

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/creack/pty"
)

// Session is one real TUI process attached to a pty.
type Session struct {
	cmd  *exec.Cmd
	ptmx *os.File

	mu  sync.Mutex
	buf bytes.Buffer

	done    chan struct{}
	waitErr error
}

// Start launches bin tui --plain --data-dir dir with an 80x30 pty and TERM
// set. The inline UI must not depend on a full-screen width.
func Start(bin, dir string, extra ...string) (*Session, error) {
	args := []string{"tui", "--plain", "--data-dir", dir}
	args = append(args, extra...)
	cmd := exec.Command(bin, args...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 30, Cols: 80})
	if err != nil {
		return nil, fmt.Errorf("start pty: %w", err)
	}
	s := &Session{cmd: cmd, ptmx: ptmx, done: make(chan struct{})}
	go func() {
		_, _ = io.Copy(&lockedWriter{s: s}, ptmx)
		s.waitErr = cmd.Wait()
		close(s.done)
	}()
	return s, nil
}

type lockedWriter struct{ s *Session }

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.s.mu.Lock()
	defer w.s.mu.Unlock()
	return w.s.buf.Write(p)
}

// Output returns the ANSI-stripped terminal output seen so far.
func (s *Session) Output() string {
	return ansi.Strip(s.RawOutput())
}

// RawOutput returns the unmodified pty bytes (used to assert no terminal probe).
func (s *Session) RawOutput() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// Mark returns a position in the raw output stream for WaitForSince.
func (s *Session) Mark() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Len()
}

// OutputSince returns ANSI-stripped output written after mark.
func (s *Session) OutputSince(mark int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw := s.buf.String()
	if mark < 0 || mark > len(raw) {
		mark = 0
	}
	return ansi.Strip(raw[mark:])
}

// WaitFor waits for a plain-text substring anywhere in the terminal output.
func (s *Session) WaitFor(sub string, timeout time.Duration) error {
	return s.WaitForSince(sub, 0, timeout)
}

// WaitForSince waits for a substring written after mark. This avoids matching
// a marker left in the terminal history by an earlier step.
func (s *Session) WaitForSince(sub string, mark int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(s.OutputSince(mark), sub) {
			return nil
		}
		select {
		case <-s.done:
			if strings.Contains(s.OutputSince(mark), sub) {
				return nil
			}
			return fmt.Errorf("TUI exited before %q; output:\n%s", sub, tail(s.OutputSince(mark), 4000))
		case <-time.After(40 * time.Millisecond):
		}
	}
	return fmt.Errorf("timeout waiting for %q after %s; output:\n%s", sub, timeout, tail(s.OutputSince(mark), 4000))
}

// Send writes literal keys to the pty.
func (s *Session) Send(keys string) error {
	_, err := s.ptmx.Write([]byte(keys))
	return err
}

// Type writes text one rune at a time, like a human typing, so popup state is
// exercised on every character rather than only on a pasted whole line.
func (s *Session) Type(text string) error {
	for _, r := range text {
		if _, err := s.ptmx.Write([]byte(string(r))); err != nil {
			return err
		}
		time.Sleep(12 * time.Millisecond)
	}
	return nil
}

// SendLine writes text followed by Enter.
func (s *Session) SendLine(text string) error { return s.Send(text + "\r") }

// WaitExit waits for the TUI process; on timeout it kills it.
func (s *Session) WaitExit(timeout time.Duration) error {
	select {
	case <-s.done:
		return s.waitErr
	case <-time.After(timeout):
		return fmt.Errorf("TUI did not exit within %s", timeout)
	}
}

// Close kills the process if still running and releases the pty.
func (s *Session) Close() {
	_ = s.ptmx.Close()
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
