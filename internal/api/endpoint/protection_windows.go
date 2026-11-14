//go:build windows

package endpoint

import (
	"errors"
	"os"
)

// Windows does not expose a verifiable owner-only ACL through os.FileInfo, so
// the loopback TCP discovery document cannot be trusted there. Fail explicitly
// instead of reading a bearer token from a file whose protection is unverified.
// The default local API transport remains available.
func platformSupported() error {
	return errors.New("local API endpoint: the loopback TCP transport requires verified owner-only file ACLs, which are unavailable here; use the default local API transport")
}

func checkPlatformProtection(os.FileInfo) error { return platformSupported() }
