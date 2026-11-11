package textsafe_test

import (
	"strings"
	"testing"

	"github.com/Raminga/raminga/internal/textsafe"
)

func TestSanitizeStripsANSIAndEscapesControls(t *testing.T) {
	in := "hello\x1b[31mRED\x1b[0m\x1b]52;c;SGVsbG8=\x07\nnext\tcol\r\x00\x7f"
	got := textsafe.Sanitize(in)
	for _, raw := range []string{"\x1b", "\x07", "\x00", "\r"} {
		if strings.Contains(got, raw) {
			t.Fatalf("sanitized output contains raw byte %q: %q", raw, got)
		}
	}
	for _, want := range []string{"helloRED", `\n`, `\t`, `\r`, `\x00`, `\x7f`} {
		if !strings.Contains(got, want) {
			t.Fatalf("sanitized output %q missing %q", got, want)
		}
	}
}

func TestSanitizeKeepsPrintableUnicodeButEscapesBidiAndC1(t *testing.T) {
	in := "中文 café \u202eabc\u202c \u009b"
	got := textsafe.Sanitize(in)
	if !strings.Contains(got, "中文 café") {
		t.Fatalf("printable text lost: %q", got)
	}
	if strings.ContainsRune(got, 0x202e) || strings.ContainsRune(got, 0x202c) {
		t.Fatalf("bidi control survived: %q", got)
	}
	if !strings.Contains(got, `\u{202e}`) || !strings.Contains(got, `\u{9b}`) {
		t.Fatalf("controls not escaped: %q", got)
	}
}

func TestSanitizeHandlesTruncatedAndInvalidUTF8(t *testing.T) {
	for _, in := range []string{"\x1b", "\x1b[", "\x1b]53;", string([]byte{0xff, 0xfe})} {
		got := textsafe.Sanitize(in)
		if strings.Contains(got, "\x1b") {
			t.Fatalf("truncated sequence leaked ESC: %q -> %q", in, got)
		}
	}
}

func TestQuoteWrapsAndEscapes(t *testing.T) {
	got := textsafe.Quote("a\nb")
	if got != `"a\nb"` {
		t.Fatalf("Quote = %q", got)
	}
}
