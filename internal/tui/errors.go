package tui

import (
	"errors"
	"net/netip"
	"regexp"
	"strings"

	"connectrpc.com/connect"

	"github.com/Raminga/raminga/internal/textsafe"
)

var (
	diagnosticMultiaddr = regexp.MustCompile(`/(?:ip4|ip6|dns|dns4|dns6|dnsaddr)/[^\s\[\]()<>"',;]+`)
	diagnosticIP        = regexp.MustCompile(`[0-9a-fA-F:.]+(?:%[a-zA-Z0-9_.-]+)?`)
)

func redactNetworkAddresses(text string) string {
	text = diagnosticMultiaddr.ReplaceAllString(text, "[地址已隐藏]")
	return diagnosticIP.ReplaceAllStringFunc(text, func(token string) string {
		value := strings.TrimRight(token, ".")
		_, addrErr := netip.ParseAddr(value)
		_, endpointErr := netip.ParseAddrPort(value)
		if addrErr == nil || endpointErr == nil {
			return "[地址已隐藏]" + token[len(value):]
		}
		return token
	})
}

// errText is the single formatter for API errors shown in the TUI. Connect
// wraps a server error as "unavailable: message"; the server message is the
// useful part, so strip the code prefix while keeping the underlying cause.
func errText(err error) string {
	return redactNetworkAddresses(rawErrorText(err))
}

func rawErrorText(err error) string {
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
	text := rawErrorText(err)
	if !strings.Contains(text, "dial") {
		m.appendLog("✗ %s", redactNetworkAddresses(text))
		return
	}
	summary, details := formatConnectFailure(text)
	m.appendLog("✗ 无法连接对方：%s", summary)
	for _, detail := range details {
		m.appendLog("  · %s", detail)
	}
}
