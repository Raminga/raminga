package api_test

import (
	"context"
	"crypto/tls"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Raminga/raminga/gen/raminga/api/v1/apiv1connect"
	"github.com/Raminga/raminga/internal/api"
	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/api/endpoint"
	"github.com/Raminga/raminga/internal/api/paths"
	"github.com/Raminga/raminga/internal/node"
)

func newFakeBackend() *fakeBackend {
	return &fakeBackend{chatCh: make(chan node.Event, 8)}
}

func startTCPTestServer(t *testing.T) *testServer {
	t.Helper()
	dir, err := os.MkdirTemp("", "rgapi-tcp-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	backend := newFakeBackend()
	srv, err := api.NewServerWithOptions(backend, dir, false, slog.New(slog.NewTextHandler(io.Discard, nil)), api.Options{EnableTCP: true})
	if err != nil {
		t.Fatalf("NewServerWithOptions: %v", err)
	}
	if err := srv.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Close(ctx)
	})
	return &testServer{dir: dir, srv: srv, backend: backend}
}

// rawTCPClient trusts only the run certificate and dials the published
// loopback address; tests use it for wire-shape checks without the typed client.
func rawTCPClient(t *testing.T, doc endpoint.Document) *http.Client {
	t.Helper()
	cfg, err := doc.TLSConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.NextProtos = []string{"http/1.1"}
	tr := &http.Transport{
		Proxy: nil,
		DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&tls.Dialer{Config: cfg, NetDialer: &net.Dialer{Timeout: 3 * time.Second}}).DialContext(ctx, "tcp4", doc.Address)
		},
	}
	t.Cleanup(tr.CloseIdleConnections)
	return &http.Client{Transport: tr}
}

func rawTCPPost(t *testing.T, doc endpoint.Document, procedure, contentType, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "https://"+doc.Address+procedure, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Authorization", "Bearer "+doc.Token)
	res, err := rawTCPClient(t, doc).Do(req)
	if err != nil {
		t.Fatalf("raw TCP call: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(raw)
}

func TestTCPLoopbackDiscoveryAndAuthentication(t *testing.T) {
	ts := startTCPTestServer(t)
	for _, path := range []string{paths.SocketPath(ts.dir), paths.TokenPath(ts.dir)} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("TCP mode must not create %s (err=%v)", path, err)
		}
	}
	epPath := endpoint.Path(ts.dir)
	info, err := os.Stat(epPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("endpoint permissions = %o, want 600", info.Mode().Perm())
	}
	doc, found, err := endpoint.ReadIfPresent(ts.dir)
	if err != nil || !found {
		t.Fatalf("read endpoint found=%v err=%v", found, err)
	}
	host, port, err := net.SplitHostPort(doc.Address)
	if err != nil || host != "127.0.0.1" || port == "" || port == "0" {
		t.Fatalf("endpoint address = %q (%v)", doc.Address, err)
	}
	if doc.Token == "" || strings.Contains(doc.Token, "\n") {
		t.Fatal("endpoint token missing or malformed")
	}
	if doc.CertSHA256 == "" || !strings.Contains(doc.CertPEM, "BEGIN CERTIFICATE") {
		t.Fatal("endpoint certificate material missing")
	}

	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatalf("client.New over endpoint: %v", err)
	}
	defer c.Close()
	st, err := c.Status(context.Background())
	if err != nil {
		t.Fatalf("Status over TCP: %v", err)
	}
	if st.GetPeerId() != "12D3KooWFake" {
		t.Fatalf("status peer = %q", st.GetPeerId())
	}

	// Local friend editing is available over the same authenticated transport;
	// blank explicitly clears one field and leaves the other intact.
	ts.backend.friends = []node.Friend{{PeerID: "peer-b", Name: "alice", Description: "note"}}
	if _, err := c.SetFriendName(context.Background(), "peer-b", ""); err != nil {
		t.Fatalf("clear name over TCP: %v", err)
	}
	if _, err := c.SetFriendDescription(context.Background(), "peer-b", ""); err != nil {
		t.Fatalf("clear description over TCP: %v", err)
	}
	friends, err := c.ListFriends(context.Background())
	if err != nil || len(friends.GetFriends()) != 1 {
		t.Fatalf("friends=%v err=%v", friends, err)
	}
	if friends.GetFriends()[0].GetName() != "" || friends.GetFriends()[0].GetDescription() != "" {
		t.Fatalf("friend not cleared: %+v", friends.GetFriends()[0])
	}

	tlsCfg, err := doc.TLSConfig()
	if err != nil {
		t.Fatal(err)
	}
	tlsCfg.NextProtos = []string{"http/1.1"}
	tr := &http.Transport{
		Proxy: nil,
		DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&tls.Dialer{Config: tlsCfg, NetDialer: &net.Dialer{Timeout: 3 * time.Second}}).DialContext(ctx, "tcp4", doc.Address)
		},
	}
	raw := &http.Client{Transport: tr}
	callStatus := func(token string) int {
		req, err := http.NewRequest(http.MethodPost, "https://"+doc.Address+apiv1connect.RamingaServiceStatusProcedure, strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := raw.Do(req)
		if err != nil {
			t.Fatalf("raw TLS call: %v", err)
		}
		defer func() { _ = res.Body.Close() }()
		_, _ = io.Copy(io.Discard, res.Body)
		return res.StatusCode
	}
	if code := callStatus(""); code != http.StatusUnauthorized {
		t.Fatalf("missing TCP token status = %d, want 401", code)
	}
	if code := callStatus(doc.Token); code != http.StatusOK {
		t.Fatalf("correct TCP token status = %d, want 200", code)
	}
}

func TestTCPPerRunIdentityRotatesAndCloseRemovesEndpoint(t *testing.T) {
	dir := t.TempDir()
	first := startTCPAt(t, dir)
	doc1, found, err := endpoint.ReadIfPresent(dir)
	if err != nil || !found {
		t.Fatalf("first endpoint found=%v err=%v", found, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	_ = first.Close(ctx)
	cancel()
	if _, err := os.Lstat(endpoint.Path(dir)); !os.IsNotExist(err) {
		t.Fatalf("endpoint survived Close: %v", err)
	}

	second := startTCPAt(t, dir)
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = second.Close(ctx)
	}()
	doc2, found, err := endpoint.ReadIfPresent(dir)
	if err != nil || !found {
		t.Fatalf("second endpoint found=%v err=%v", found, err)
	}
	if doc1.Token == doc2.Token {
		t.Fatal("per-run TCP token did not rotate")
	}
	if doc1.CertSHA256 == doc2.CertSHA256 {
		t.Fatal("per-run TCP certificate did not rotate")
	}

	// A copied stale document is still syntactically valid but points at the
	// closed first listener. The client must fail closed, not fall back to a
	// Unix socket (and TCP mode never created one).
	if err := endpoint.WriteAtomic(dir, doc1); err != nil {
		t.Fatal(err)
	}
	c, err := client.New(dir)
	if err == nil {
		_, err = c.Status(context.Background())
		c.Close()
	}
	if err == nil {
		t.Fatal("stale endpoint unexpectedly answered Status")
	}
}

func startTCPAt(t *testing.T, dir string) *api.Server {
	t.Helper()
	srv, err := api.NewServerWithOptions(newFakeBackend(), dir, false, slog.New(slog.NewTextHandler(io.Discard, nil)), api.Options{EnableTCP: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return srv
}

func TestTCPModeEnvironmentMissingEndpointFailsClosed(t *testing.T) {
	t.Setenv("RAMINGA_API_TCP", "1")
	_, err := client.New(t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "not falling back") {
		t.Fatalf("missing endpoint error = %v", err)
	}
}

func TestEndpointFileRejectsGroupReadableSecret(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits are not exposed on Windows")
	}
	dir := t.TempDir()
	ts := startTCPAt(t, dir)
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = ts.Close(ctx)
	}()
	path := filepath.Clean(endpoint.Path(dir))
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := client.New(dir); err == nil || !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("group-readable endpoint error = %v", err)
	}
}
