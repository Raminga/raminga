// Package peerarg normalizes user-supplied Peer IDs and multiaddrs.
//
// Terminal wraps long addresses at arbitrary visual breakpoints without adding
// a marker, and a pasted value can contain newlines, tabs or spaces. The only
// safe interpretation is to treat all whitespace as line wrapping noise and
// remove it before handing the value to a multiaddr or Peer ID parser.
package peerarg

import (
	"strings"
	"unicode"
)

// Normalize removes every whitespace rune, including CR, LF, TAB and spaces.
func Normalize(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, value)
}

// WrappedHint is appended to parse errors so users know to re-check the whole
// value they copied.
const WrappedHint = "请检查地址是否完整"
