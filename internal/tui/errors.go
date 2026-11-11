package tui

import (
	"errors"
	"strings"

	"connectrpc.com/connect"

	"github.com/Raminga/raminga/internal/textsafe"
)

// errText is the single formatter for API errors shown in the TUI. Connect
// wraps a server error as "unavailable: message"; the server message is the
// useful part, so strip the code prefix while keeping the underlying cause.
func errText(err error) string {
	if err == nil {
		return ""
	}
	var connectErr *connect.Error
	if errors.As(err, &connectErr) {
		if msg := connectErr.Message(); msg != "" {
			return textsafe.Sanitize(msg)
		}
	}
	return textsafe.Sanitize(err.Error())
}

// appendContentError reports a failed content request. Dial failures use the
// same short summary as /connect instead of the raw multi-line libp2p dump.
func (m *Model) appendContentError(err error) {
	text := errText(err)
	if !strings.Contains(text, "dial") {
		m.appendLog("✗ %s", text)
		return
	}
	summary, details := formatConnectFailure(text)
	m.appendLog("✗ 无法连接对方：%s", summary)
	for _, detail := range details {
		m.appendLog("  · %s", detail)
	}
}
