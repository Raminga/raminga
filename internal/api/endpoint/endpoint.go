// Package endpoint reads and writes the protected local-TCP API discovery
// document. The TCP listener is opt-in; the default Unix socket never writes
// this file. The document is written only by a daemon that holds the data
// directory lock, is atomically replaced, and carries a per-run bearer token
// plus the pinned self-signed certificate for that run.
package endpoint

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Raminga/raminga/internal/api/paths"
)

const (
	// Version is the only accepted discovery document version.
	Version = 1
	// NetworkTCP is the only accepted transport.
	NetworkTCP = "tcp"
	// maxFileSize bounds a hostile or corrupt endpoint file.
	maxFileSize = 64 << 10
)

// Supported reports whether this platform can protect the endpoint secret with
// a verifiable owner-only ACL. The TCP transport is explicitly unsupported
// where that check is unavailable; the default Unix socket stays untouched.
func Supported() error {
	return platformSupported()
}

// Document is the atomic discovery record for one daemon run. Token is a
// secret; callers must keep it host-side and out of renderer output and logs.
type Document struct {
	Version         int    `json:"version"`
	Network         string `json:"network"`
	Address         string `json:"address"`
	Token           string `json:"token"`
	CertPEM         string `json:"cert_pem"`
	CertSHA256      string `json:"cert_sha256"`
	PID             int    `json:"pid"`
	StartedAtUnixMS int64  `json:"started_at_unix_ms"`
}

// Path returns <dataDir>/api.endpoint.json.
func Path(dataDir string) string { return paths.EndpointPath(dataDir) }

// Validate enforces the loopback-only contract and fails closed on a stale,
// malformed or mismatched discovery document.
func (d Document) Validate() error {
	if d.Version != Version {
		return fmt.Errorf("local API endpoint: unsupported version %d", d.Version)
	}
	if d.Network != NetworkTCP {
		return fmt.Errorf("local API endpoint: unsupported network %q", d.Network)
	}
	host, port, err := net.SplitHostPort(d.Address)
	if err != nil {
		return fmt.Errorf("local API endpoint: invalid address: %w", err)
	}
	if host != "127.0.0.1" {
		return fmt.Errorf("local API endpoint: address host must be literal 127.0.0.1, got %q", host)
	}
	numericPort, err := strconv.Atoi(port)
	if err != nil || numericPort <= 0 || numericPort > 65535 {
		return fmt.Errorf("local API endpoint: invalid TCP port %q", port)
	}
	if len(d.Token) < 32 || len(d.Token) > 256 {
		return errors.New("local API endpoint: invalid bearer token length")
	}
	for _, r := range d.Token {
		if r <= ' ' || r == 0x7f {
			return errors.New("local API endpoint: bearer token contains whitespace or control characters")
		}
	}
	if d.PID <= 0 {
		return errors.New("local API endpoint: missing daemon pid")
	}
	if d.CertSHA256 == "" {
		return errors.New("local API endpoint: missing certificate pin")
	}
	cert, err := parseCertificate(d.CertPEM)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(cert.Raw)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), d.CertSHA256) {
		return errors.New("local API endpoint: certificate pin does not match the certificate")
	}
	if !hasLoopbackIP(cert) {
		return errors.New("local API endpoint: certificate does not cover 127.0.0.1")
	}
	now := time.Now()
	if now.Before(cert.NotBefore.Add(-5*time.Minute)) || now.After(cert.NotAfter.Add(5*time.Minute)) {
		return errors.New("local API endpoint: certificate is not currently valid")
	}
	return nil
}

func parseCertificate(pemText string) (*x509.Certificate, error) {
	block, rest := pem.Decode([]byte(pemText))
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("local API endpoint: invalid certificate PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("local API endpoint: parse certificate: %w", err)
	}
	return cert, nil
}

func hasLoopbackIP(cert *x509.Certificate) bool {
	for _, ip := range cert.IPAddresses {
		if ip.Equal(net.IPv4(127, 0, 0, 1)) {
			return true
		}
	}
	return false
}

// TLSConfig returns a standard-library TLS configuration that trusts only the
// certificate named by this run's endpoint and additionally pins its SHA-256
// fingerprint. It never disables normal certificate verification.
func (d Document) TLSConfig() (*tls.Config, error) {
	if err := d.Validate(); err != nil {
		return nil, err
	}
	cert, err := parseCertificate(d.CertPEM)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	pin := strings.ToLower(d.CertSHA256)
	cfg := &tls.Config{
		RootCAs:    pool,
		ServerName: "127.0.0.1",
		MinVersion: tls.VersionTLS12,
	}
	cfg.VerifyConnection = func(state tls.ConnectionState) error {
		if len(state.PeerCertificates) == 0 {
			return errors.New("local API endpoint: peer did not present a certificate")
		}
		sum := sha256.Sum256(state.PeerCertificates[0].Raw)
		if hex.EncodeToString(sum[:]) != pin {
			return errors.New("local API endpoint: TLS certificate pin mismatch")
		}
		return nil
	}
	return cfg, nil
}

// ReadIfPresent reads and validates the endpoint when it exists. A missing file
// is not an error. A stale or malformed file is an error so callers fail closed
// instead of silently falling back to the Unix socket.
//
// The platform-specific readProtectedFile implementation must validate the
// object it actually reads. On Windows that means one opened handle used for
// the type/owner/DACL checks and the bytes, never a path reopen.
func ReadIfPresent(dataDir string) (Document, bool, error) {
	if err := platformSupported(); err != nil {
		return Document{}, false, err
	}
	path := Path(dataDir)
	raw, found, err := readProtectedFile(path)
	if err != nil {
		return Document{}, false, err
	}
	if !found {
		return Document{}, false, nil
	}
	return parseDocument(path, raw)
}

func parseDocument(path string, raw []byte) (Document, bool, error) {
	if len(raw) > maxFileSize {
		return Document{}, false, fmt.Errorf("local API endpoint: %q is too large", path)
	}
	var doc Document
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		return Document{}, false, fmt.Errorf("local API endpoint: decode %q: %w", path, err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return Document{}, false, fmt.Errorf("local API endpoint: %q has trailing data", path)
	}
	if err := doc.Validate(); err != nil {
		return Document{}, false, err
	}
	return doc, true, nil
}

// Read is ReadIfPresent with a stale/missing error suitable for a client that
// explicitly expects the TCP endpoint.
func Read(dataDir string) (Document, error) {
	doc, found, err := ReadIfPresent(dataDir)
	if err != nil {
		return Document{}, err
	}
	if !found {
		return Document{}, errors.New("local API endpoint: TCP discovery file is missing; no Unix fallback is attempted")
	}
	return doc, nil
}

// WriteAtomic writes a validated document to the endpoint path, using a
// same-directory temporary file and an atomic publish. The caller must hold
// the existing data-directory lock (the daemon does via identity.Open).
//
// writeProtectedFile owns the platform-specific creation policy: on Unix the
// temporary and final files are 0600; on Windows the temporary file is created
// with a protected DACL containing only the current user SID, verified through
// the same handle that is later renamed, and no unprotected byte ever contains
// the token.
func WriteAtomic(dataDir string, doc Document) error {
	if err := platformSupported(); err != nil {
		return err
	}
	if err := doc.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("local API endpoint: create data directory: %w", err)
	}
	return writeProtectedFile(Path(dataDir), raw)
}

// Remove deletes a stale/current discovery file. A missing file is not an
// error. It never follows a symlink.
func Remove(dataDir string) error {
	err := os.Remove(Path(dataDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("local API endpoint: remove discovery file: %w", err)
	}
	return nil
}
