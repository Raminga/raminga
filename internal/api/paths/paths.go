// Package paths centralizes the local API file names so the server and the CLI
// client agree without the client importing the server package (which would
// pull node internals into the thin client).
package paths

import (
	"fmt"
	"path/filepath"
	"runtime"
)

const (
	// SocketFileName is the UDS path inside the data directory.
	SocketFileName = "api.sock"
	// TokenFileName is the bearer token path inside the data directory.
	TokenFileName = "api.token"
	// EndpointFileName is the optional loopback-TCP discovery document.
	EndpointFileName = "api.endpoint.json"

	// DarwinSocketPathLimit is the longest usable sockaddr_un.sun_path value on
	// macOS: the 104-byte field includes the terminating NUL.
	DarwinSocketPathLimit = 103
	// LinuxSocketPathLimit is the longest usable sockaddr_un.sun_path value on
	// Linux: the 108-byte field includes the terminating NUL.
	LinuxSocketPathLimit = 107
)

// SocketPath returns <dataDir>/api.sock.
func SocketPath(dataDir string) string { return filepath.Join(dataDir, SocketFileName) }

// TokenPath returns <dataDir>/api.token.
func TokenPath(dataDir string) string { return filepath.Join(dataDir, TokenFileName) }

// EndpointPath returns <dataDir>/api.endpoint.json.
func EndpointPath(dataDir string) string { return filepath.Join(dataDir, EndpointFileName) }

// SocketPathLimit returns the platform's sockaddr_un.sun_path limit.
func SocketPathLimit() int {
	if runtime.GOOS == "darwin" {
		return DarwinSocketPathLimit
	}
	return LinuxSocketPathLimit
}

// ValidateSocketPath rejects a UDS path the kernel cannot represent. The error
// names the path, its byte length, the platform limit and the fix so callers do
// not surface the opaque "connect: invalid argument" failure.
func ValidateSocketPath(sockPath string) error {
	limit := SocketPathLimit()
	if len(sockPath) <= limit {
		return nil
	}
	return fmt.Errorf("unix socket path is too long: %q is %d bytes; this platform's limit is %d bytes (sockaddr_un.sun_path includes a terminating NUL); use a shorter --data-dir (for example /tmp/raminga-a)", sockPath, len(sockPath), limit)
}
