package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/Raminga/raminga/internal/api/endpoint"
)

const tcpCertValidity = 365 * 24 * time.Hour

// startTCP serves the authenticated API on an ephemeral loopback TCP listener.
// It is reachable only at literal 127.0.0.1, uses a per-run bearer token and a
// per-run self-signed certificate, and publishes the discovery document only
// after the listener is accepting connections.
func (s *Server) startTCP() error {
	cert, certPEM, pin, err := newRunCertificate()
	if err != nil {
		return err
	}
	token, err := newRunToken()
	if err != nil {
		return err
	}
	// tcp4 + the literal address prevents a hostname, wildcard or IPv6 bind
	// from widening the local API surface.
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("api: listen on 127.0.0.1: %w", err)
	}
	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok || !tcpAddr.IP.Equal(net.IPv4(127, 0, 0, 1)) || tcpAddr.Port <= 0 {
		_ = ln.Close()
		return fmt.Errorf("api: refused non-loopback TCP address %q", ln.Addr())
	}
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
		NextProtos:   []string{"h2", "http/1.1"},
	}
	srv := &http.Server{
		Handler:           tcpOnlyGuard(s.withAuth(s.newMux(), token), tcpAddr.String()),
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: 5 * time.Second,
	}
	s.tcpSrv = srv
	s.tcpLn = ln
	s.tcpAddr = tcpAddr.String()
	go func() {
		if err := srv.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			select {
			case s.errCh <- fmt.Errorf("api: serve loopback TCP: %w", err):
			default:
			}
		}
	}()

	doc := endpoint.Document{
		Version:         endpoint.Version,
		Network:         endpoint.NetworkTCP,
		Address:         s.tcpAddr,
		Token:           token,
		CertPEM:         string(certPEM),
		CertSHA256:      pin,
		PID:             os.Getpid(),
		StartedAtUnixMS: time.Now().UnixMilli(),
	}
	if err := endpoint.WriteAtomic(s.dataDir, doc); err != nil {
		_ = srv.Close()
		return fmt.Errorf("api: publish loopback TCP discovery: %w", err)
	}
	// Never log the token or the document contents.
	s.logger.Info("local API listening", "tcp_addr", s.tcpAddr, "tls", true, "test_api", s.testAPI)
	return nil
}

// tcpOnlyGuard rejects browser-originated requests and requests whose Host is
// not this generation's real loopback host:port. The UDS handler is unchanged.
func tcpOnlyGuard(next http.Handler, expectedHost string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Host != expectedHost {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func newRunToken() (string, error) {
	var raw [tokenBytes]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("api: generate per-run TCP token: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

func newRunCertificate() (tls.Certificate, []byte, string, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, "", fmt.Errorf("api: generate TCP certificate key: %w", err)
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return tls.Certificate{}, nil, "", fmt.Errorf("api: generate TCP certificate serial: %w", err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "raminga-local-api"},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.Add(tcpCertValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, nil, "", fmt.Errorf("api: create TCP certificate: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	sum := sha256.Sum256(der)
	pin := hex.EncodeToString(sum[:])
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, certPEM, pin, nil
}
