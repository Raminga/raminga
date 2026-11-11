// Package textsafe renders untrusted remote text for a terminal.
//
// Raminga treats every remote chat message, peer ID, address, error and
// diagnostic string as untrusted. Nothing in this package interprets a remote
// string as an instruction, and the output never contains a raw ESC/BEL or
// other control byte. ANSI escape sequences are stripped, C0/C1 controls are
// rendered as visible \xNN / \u{...} escapes, and bidirectional formatting
// controls are escaped so they cannot reorder trusted text.
package textsafe

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Sanitize returns a terminal-safe rendering of s. ANSI escape sequences are
// removed; every remaining control or format character is escaped. Printable
// UTF-8 (including non-ASCII text) is preserved.
func Sanitize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] == 0x1b {
			i = skipEscape(s, i)
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			fmt.Fprintf(&b, `\x%02x`, s[i])
			i++
			continue
		}
		i += size
		switch {
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\x%02x`, r)
		case r >= 0x80 && r <= 0x9f:
			fmt.Fprintf(&b, `\u{%x}`, r)
		case isBidiControl(r):
			fmt.Fprintf(&b, `\u{%x}`, r)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// Quote sanitizes s and wraps it in double quotes, matching the CLI's use of
// strconv.Quote for untrusted chat/event text.
func Quote(s string) string {
	return `"` + Sanitize(s) + `"`
}

// skipEscape consumes one ANSI escape sequence starting at s[i] (which must be
// ESC). It recognises CSI, OSC, DCS and the common two-byte escapes. A
// truncated sequence consumes the rest of the string.
func skipEscape(s string, i int) int {
	i++ // ESC
	if i >= len(s) {
		return i
	}
	switch s[i] {
	case '[': // CSI: parameter/intermediate bytes then a final byte.
		i++
		for i < len(s) {
			c := s[i]
			i++
			if c >= 0x40 && c <= 0x7e {
				break
			}
		}
		return i
	case ']', 'P', 'X', '^', '_': // OSC/DCS/SOS/PM/APC: terminated by BEL or ST.
		i++
		for i < len(s) {
			if s[i] == 0x07 {
				return i + 1
			}
			if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\' {
				return i + 2
			}
			i++
		}
		return i
	default:
		// Two-byte escape (for example ESC c or ESC 7).
		return i + 1
	}
}

func isBidiControl(r rune) bool {
	switch r {
	case 0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
		0x2066, 0x2067, 0x2068, 0x2069, 0x2060, 0xfeff:
		return true
	default:
		return false
	}
}
