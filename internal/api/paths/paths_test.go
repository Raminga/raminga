package paths

import (
	"strings"
	"testing"
)

func TestValidateSocketPathAcceptsShortPath(t *testing.T) {
	path := SocketPath("/tmp/raminga-a")
	if err := ValidateSocketPath(path); err != nil {
		t.Fatalf("short path rejected: %v", err)
	}
}

func TestValidateSocketPathNamesPathLengthLimitAndFix(t *testing.T) {
	longDir := "/tmp/" + strings.Repeat("x", SocketPathLimit()+10)
	path := SocketPath(longDir)
	err := ValidateSocketPath(path)
	if err == nil {
		t.Fatal("long socket path unexpectedly accepted")
	}
	msg := err.Error()
	for _, want := range []string{
		path,
		"is " + itoa(len(path)) + " bytes",
		"limit is " + itoa(SocketPathLimit()) + " bytes",
		"shorter --data-dir",
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q does not contain %q", msg, want)
		}
	}
}

func TestValidateSocketPathBoundary(t *testing.T) {
	exact := strings.Repeat("a", SocketPathLimit())
	if err := ValidateSocketPath(exact); err != nil {
		t.Fatalf("exactly-limit path rejected: %v", err)
	}
	if err := ValidateSocketPath(exact + "a"); err == nil {
		t.Fatal("limit+1 path unexpectedly accepted")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
