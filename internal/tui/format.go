package tui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/dustin/go-humanize"

	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"
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

// addressMode classifies a hint without treating it as proof of reachability.
func addressMode(raw string) string {
	addr, err := ma.NewMultiaddr(raw)
	if err != nil {
		return ""
	}
	switch {
	case manet.IsIPLoopback(addr), manet.IsIP6LinkLocal(addr), manet.IsIPUnspecified(addr):
		return ""
	case strings.Contains(raw, "/p2p-circuit"):
		return "中继连接"
	case manet.IsPublicAddr(addr):
		return "公网直连"
	case manet.IsPrivateAddr(addr):
		return "局域网直连"
	default:
		return ""
	}
}

func addressModes(addrs []string) string {
	seen := make(map[string]bool)
	for _, addr := range addrs {
		seen[addressMode(addr)] = true
	}
	var modes []string
	for _, mode := range []string{"公网直连", "中继连接", "局域网直连"} {
		if seen[mode] {
			modes = append(modes, mode)
		}
	}
	if len(modes) == 0 {
		return "暂无"
	}
	return strings.Join(modes, " · ")
}
