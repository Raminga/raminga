package tui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/dustin/go-humanize"

	"github.com/Raminga/raminga/internal/textsafe"
)

// padDisplay right-pads s to width terminal cells. It uses display width so CJK
// names stay aligned with ASCII ones.
func displayWidth(s string) int { return ansi.StringWidth(s) }

// progressLabel adds the in-progress ellipsis once. A short Peer ID already
// ends with "…", which previously produced "12D3KooWKCqnDB……".
func progressLabel(s string) string {
	if strings.HasSuffix(s, "…") {
		return s
	}
	return s + "…"
}

func padDisplay(s string, width int) string {
	if w := displayWidth(s); w < width {
		return s + strings.Repeat(" ", width-w)
	}
	return s
}

// humanBytes formats a byte count for display. JSON and proto output keep the
// exact integer.
func humanBytes(n int64) string {
	if n < 0 {
		n = 0
	}
	return humanize.IBytes(uint64(n))
}

type sizedRow struct {
	Path string
	Size int64
}

// sizedLines renders path/size pairs as aligned columns, e.g.
// "posts/hello.md  16 B". indent is included before every row.
func sizedLines(rows []sizedRow, indent string) []string {
	width := 0
	for _, row := range rows {
		if w := displayWidth(row.Path); w > width {
			width = w
		}
	}
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		lines = append(lines, indent+padDisplay(row.Path, width)+"  "+humanBytes(row.Size))
	}
	return lines
}

// addrTypeLabel describes an address, such as "公网 IPv6/QUIC". It says what the
// address is, not whether it's reachable: a public IP can still sit behind a
// firewall. For a relay address, family and transport describe the path to the
// relay.
func addrTypeLabel(raw string) string {
	kind, _ := classifyAddr(raw, false)
	var parts []string
	switch {
	case strings.Contains(raw, "/ip4/"):
		parts = append(parts, "IPv4")
	case strings.Contains(raw, "/ip6/"):
		parts = append(parts, "IPv6")
	case strings.Contains(raw, "/dns"):
		parts = append(parts, "域名")
	}
	switch {
	case strings.Contains(raw, "/quic"):
		parts = append(parts, "QUIC")
	case strings.Contains(raw, "/tcp/"):
		parts = append(parts, "TCP")
	}
	if len(parts) == 0 {
		return kind
	}
	return kind + " " + strings.Join(parts, "/")
}

// labelledAddrLines renders addresses as "  type  address". The type column
// comes first so the address can still be selected whole.
func labelledAddrLines(addrs []string) []string {
	width := 0
	for _, addr := range addrs {
		if w := displayWidth(addrTypeLabel(addr)); w > width {
			width = w
		}
	}
	lines := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		lines = append(lines, "  "+padDisplay(addrTypeLabel(addr), width)+"  "+textsafe.Sanitize(addr))
	}
	return lines
}
