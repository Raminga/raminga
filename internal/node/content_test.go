package node_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/content"
	"github.com/Raminga/raminga/internal/identity"
	"github.com/Raminga/raminga/internal/network"
	"github.com/Raminga/raminga/internal/node"
	"github.com/Raminga/raminga/internal/p2phttp"
	"github.com/Raminga/raminga/internal/storage"
)

func rawClientToNode(t *testing.T, n *testNode) (*p2phttp.Client, peer.ID) {
	t.Helper()
	key, _, err := crypto.GenerateEd25519Key(nil)
	if err != nil {
		t.Fatal(err)
	}
	h, err := libp2p.New(libp2p.Identity(key), libp2p.NoListenAddrs)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	bpid, err := peer.Decode(n.status(t).PeerID)
	if err != nil {
		t.Fatal(err)
	}
	var addrs []ma.Multiaddr
	for _, raw := range n.status(t).ListenAddrs {
		if a, err := ma.NewMultiaddr(raw); err == nil {
			addrs = append(addrs, a)
		}
	}
	if err := h.Connect(context.Background(), peer.AddrInfo{ID: bpid, Addrs: addrs}); err != nil {
		t.Fatal(err)
	}
	cl, err := p2phttp.NewClient(h, p2phttp.DefaultClientOptions())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cl.Close)
	return cl, h.ID()
}

func doContent(t *testing.T, cl *p2phttp.Client, pid peer.ID, method, path string, headers map[string]string) (*p2phttp.Result, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, "http://"+pid.String()+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := cl.Do(context.Background(), pid, req, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Response.Body.Close() }()
	body, _ := io.ReadAll(res.Response.Body)
	return res, body
}

func TestContentRoutesAndVisitor(t *testing.T) {
	b := newTestNode(t, t.TempDir())
	public := filepath.Join(b.dir, "public")
	if err := os.MkdirAll(filepath.Join(public, "profile"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(public, "profile", "index.md"), []byte("# hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	cl, visitor := rawClientToNode(t, b)
	pid, _ := peer.Decode(b.status(t).PeerID)
	res, body := doContent(t, cl, pid, http.MethodGet, "/manifest", nil)
	if res.Response.StatusCode != 200 {
		t.Fatalf("manifest status=%d body=%s", res.Response.StatusCode, body)
	}
	if len(body) >= 64<<10 {
		t.Fatalf("manifest page too large: %d", len(body))
	}
	var manifest content.Manifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		t.Fatal(err)
	}
	foundProfile, foundFriends := false, false
	for _, e := range manifest.Entries {
		if e.Path == "profile/index.md" {
			foundProfile = true
		}
		if e.Path == "friends.json" {
			foundFriends = true
		}
	}
	if !foundProfile || !foundFriends {
		t.Fatalf("manifest entries=%+v", manifest.Entries)
	}
	// The visitor is recorded only after a successful content request.
	waitFriend(t, b.node, visitor.String(), false)
	// Small file, Range, ETag and no-sniff content type.
	res, body = doContent(t, cl, pid, http.MethodGet, "/files/profile/index.md", nil)
	if res.Response.StatusCode != 200 || string(body) != "# hello" {
		t.Fatalf("file status=%d body=%q", res.Response.StatusCode, body)
	}
	if res.Response.Header.Get("Content-Type") != "application/octet-stream" || res.Response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("file headers=%v", res.Response.Header)
	}
	etag := res.Response.Header.Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag")
	}
	res, body = doContent(t, cl, pid, http.MethodGet, "/files/profile/index.md", map[string]string{"Range": "bytes=0-1"})
	if res.Response.StatusCode != http.StatusPartialContent || string(body) != "# " {
		t.Fatalf("range status=%d body=%q", res.Response.StatusCode, body)
	}
	res, _ = doContent(t, cl, pid, http.MethodGet, "/files/profile/index.md", map[string]string{"If-None-Match": etag})
	if res.Response.StatusCode != http.StatusNotModified {
		t.Fatalf("etag status=%d", res.Response.StatusCode)
	}
	if res, _ := doContent(t, cl, pid, http.MethodGet, "/files/profile/nope", nil); res.Response.StatusCode != 404 {
		t.Fatalf("unknown status=%d", res.Response.StatusCode)
	}
	for _, p := range []string{"/files/../config.toml", "/files/%2e%2e/config.toml", "/files/a/../../config.toml", `/files/a\b`} {
		if res, _ := doContent(t, cl, pid, http.MethodGet, p, nil); res.Response.StatusCode == 200 {
			t.Fatalf("traversal %q status=%d", p, res.Response.StatusCode)
		}
	}
}

func TestContentPolicyDeniedNoRecord(t *testing.T) {
	b := newTestNodeWithConfig(t, t.TempDir(), func(cfg *config.Config) { cfg.Chat.AllowUnknownPeers = false })
	cl, visitor := rawClientToNode(t, b)
	pid, _ := peer.Decode(b.status(t).PeerID)
	if res, _ := doContent(t, cl, pid, http.MethodGet, "/manifest", nil); res.Response.StatusCode != http.StatusForbidden {
		t.Fatalf("status=%d", res.Response.StatusCode)
	}
	time.Sleep(100 * time.Millisecond)
	friends, _ := b.node.Friends(context.Background())
	if len(friends) != 0 {
		t.Fatalf("denied visitor recorded: %+v (visitor=%s)", friends, visitor)
	}
}

func TestFriendsJSONSyncRules(t *testing.T) {
	ctx := context.Background()
	b := newTestNode(t, t.TempDir())
	file := filepath.Join(b.dir, "public", "friends.json")
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("friends.json not generated at start: %v", err)
	}
	// Add a row directly through the same SQLite business store, including a
	// private address and a circuit address.
	other, _, _ := crypto.GenerateEd25519Key(nil)
	otherID, _ := peer.Decode("12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6")
	_ = other
	store, err := storage.Open(ctx, b.dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.UpsertFriend(ctx, otherID.String(), []string{
		"/ip4/10.0.0.2/tcp/4001",
		"/ip4/1.1.1.1/tcp/4001",
		"/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6/p2p-circuit/p2p/12D3KooWLaHQeWmPbiVnVe7Bgu2HbXcCQPBV8ioP5XgpQFPJPSEq",
	}, false, true); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	_ = store.Close()
	written, err := b.node.SyncFriends(ctx)
	if err != nil || !written {
		t.Fatalf("sync written=%t err=%v", written, err)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, forbidden := range []string{"manually_connected", "first_seen", "last_interaction", "paused", "relay_capable", "dht_capable", "/ip4/10.0.0.2/tcp/4001"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("friends.json contains %q: %s", forbidden, text)
		}
	}
	if !strings.Contains(text, "/ip4/1.1.1.1/tcp/4001") || !strings.Contains(text, "p2p-circuit") {
		t.Fatalf("friends.json missing public/circuit addrs: %s", text)
	}
	var parsed struct {
		Version int `json:"version"`
		Friends []struct {
			PeerID string   `json:"peer_id"`
			Addrs  []string `json:"addrs"`
		} `json:"friends"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.Version != 1 {
		t.Fatalf("friends json=%+v err=%v", parsed, err)
	}
	written, err = b.node.SyncFriends(ctx)
	if err != nil || written {
		t.Fatalf("unchanged sync written=%t err=%v", written, err)
	}
	// RemoveFriend rewrites friends.json automatically; the next explicit sync
	// has nothing left to change.
	if _, _, err := b.node.RemoveFriend(ctx, otherID.String(), false); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(file)
	if strings.Contains(string(raw), otherID.String()) {
		t.Fatal("RemoveFriend did not rewrite friends.json")
	}
	written, err = b.node.SyncFriends(ctx)
	if err != nil || written {
		t.Fatalf("sync after remove written=%t err=%v", written, err)
	}
	entries, _ := os.ReadDir(filepath.Join(b.dir, "public"))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".friends-") {
			t.Fatalf("temp file left: %s", e.Name())
		}
	}
}

func newRelayTestNode(t *testing.T, relay string) *testNode {
	t.Helper()
	dir := t.TempDir()
	id, err := identity.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.Network.ListenAddrs = []string{"/ip4/127.0.0.1/tcp/0"}
	cfg.Relay.KnownRelays = []string{relay}
	netw, err := network.New(network.Config{PrivateKey: id.PrivateKey(), ListenAddrs: cfg.Network.ListenAddrs, EnableRelay: true, EnableAutoRelay: true, Relay: network.RelayConfig{KnownRelays: []string{relay}}})
	if err != nil {
		t.Fatal(err)
	}
	n, err := node.New(node.Options{DataDir: dir, Version: "test", Config: cfg, Identity: id, Store: store, Network: netw})
	if err != nil {
		t.Fatal(err)
	}
	if err := n.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	tn := &testNode{node: n, id: id, dir: dir}
	t.Cleanup(func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = n.Stop(shutdown)
		_ = id.Close()
	})
	return tn
}

func TestContentOverRelayLimited(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	hostIP := localNonLoopbackIPv4(t)
	keyR, _, _ := crypto.GenerateEd25519Key(nil)
	R, err := network.New(network.Config{PrivateKey: keyR, ListenAddrs: []string{"/ip4/" + hostIP + "/tcp/0"},
		Relay: network.RelayConfig{Provider: true, MaxReservations: 8, ReservationTTL: time.Hour, MaxReservationsPerIP: 8, MaxReservationsPerPeer: 1, MaxCircuits: 8, ReservationDataLimit: 1 << 20, ReservationDurationLimit: 2 * time.Minute}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = R.Close() }()
	if err := R.Start(ctx); err != nil {
		t.Fatal(err)
	}
	raddr := R.Host().Addrs()[0].Encapsulate(ma.StringCast("/p2p/" + R.Host().ID().String())).String()
	b := newRelayTestNode(t, raddr)
	if err := os.WriteFile(filepath.Join(b.dir, "public", "profile", "small.txt"), []byte("small"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	var circuit string
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		for _, rr := range b.node.RelayReservations() {
			if rr.Status == "active" && strings.Contains(rr.RelayedAddr, "/p2p-circuit") {
				circuit = rr.RelayedAddr
			}
		}
		if circuit != "" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if circuit == "" {
		t.Fatalf("B reservation missing: %+v", b.node.RelayReservations())
	}
	keyA, _, _ := crypto.GenerateEd25519Key(nil)
	a, err := libp2p.New(libp2p.Identity(keyA), libp2p.NoListenAddrs, libp2p.EnableRelay())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = a.Close() }()
	bpid, _ := peer.Decode(b.status(t).PeerID)
	cm, _ := ma.NewMultiaddr(circuit)
	if err := a.Connect(ctx, peer.AddrInfo{ID: bpid, Addrs: []ma.Multiaddr{cm}}); err != nil {
		t.Fatalf("A circuit connect: %v", err)
	}
	conns := a.Network().ConnsToPeer(bpid)
	if len(conns) == 0 || !conns[0].Stat().Limited {
		t.Fatalf("connection not limited: %+v", conns)
	}
	cl, err := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	if err != nil {
		t.Fatal(err)
	}
	res, body := doContent(t, cl, bpid, http.MethodGet, "/manifest", nil)
	if res.Response.StatusCode != 200 || len(body) >= 64<<10 || !res.Limited {
		t.Fatalf("limited manifest status=%d bytes=%d limited=%t", res.Response.StatusCode, len(body), res.Limited)
	}
	res, body = doContent(t, cl, bpid, http.MethodGet, "/files/profile/small.txt", nil)
	if res.Response.StatusCode != 200 || string(body) != "small" || !res.Limited {
		t.Fatalf("limited file status=%d body=%q limited=%t", res.Response.StatusCode, body, res.Limited)
	}
}

func TestFriendNameAndDescriptionSyncFriendsJSON(t *testing.T) {
	ctx := context.Background()
	b := newTestNode(t, t.TempDir())
	file := filepath.Join(b.dir, "public", "friends.json")
	otherID, err := peer.Decode("12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(ctx, b.dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.UpsertFriend(ctx, otherID.String(), nil, false, true); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	_ = store.Close()

	if _, err := b.node.SetFriendName(ctx, otherID.String(), "alice"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(file)
	if !strings.Contains(string(raw), `"name":"alice"`) {
		t.Fatalf("SetFriendName did not sync friends.json: %s", raw)
	}
	if _, err := b.node.SetFriendDescription(ctx, otherID.String(), "hello"); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(file)
	if !strings.Contains(string(raw), `"description":"hello"`) {
		t.Fatalf("SetFriendDescription did not sync friends.json: %s", raw)
	}
}

func TestFileClientDisconnectKeepsServing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	b := newTestNode(t, t.TempDir())
	if err := os.WriteFile(filepath.Join(b.dir, "public", "posts", "big.bin"), []byte(strings.Repeat("x", 1<<20)), 0o644); err != nil {
		t.Fatal(err)
	}
	cl, _ := rawClientToNode(t, b)
	pid, _ := peer.Decode(b.status(t).PeerID)
	req, err := http.NewRequest(http.MethodGet, "http://"+pid.String()+"/files/posts/big.bin", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := cl.Do(ctx, pid, req, 2<<20)
	if err != nil {
		t.Fatalf("start download: %v", err)
	}
	// Read only the first bytes, then hang up like a client that quits a
	// download. The server must return from ServeContent and keep serving.
	if _, err := io.ReadFull(res.Response.Body, make([]byte, 4096)); err != nil {
		t.Fatalf("read partial body: %v", err)
	}
	_ = res.Response.Body.Close()
	time.Sleep(100 * time.Millisecond)
	if got, body := doContent(t, cl, pid, http.MethodGet, "/manifest", nil); got.Response.StatusCode != http.StatusOK {
		t.Fatalf("manifest after disconnect status=%d body=%s", got.Response.StatusCode, body)
	}
}

func TestFileRangeAbuseStaysBounded(t *testing.T) {
	b := newTestNode(t, t.TempDir())
	payload := strings.Repeat("x", 1024)
	if err := os.WriteFile(filepath.Join(b.dir, "public", "posts", "range.txt"), []byte(payload), 0o644); err != nil {
		t.Fatal(err)
	}
	cl, _ := rawClientToNode(t, b)
	pid, _ := peer.Decode(b.status(t).PeerID)
	parts := make([]string, 200)
	for i := range parts {
		parts[i] = fmt.Sprintf("%d-%d", i, i)
	}
	res, body := doContent(t, cl, pid, http.MethodGet, "/files/posts/range.txt", map[string]string{"Range": "bytes=" + strings.Join(parts, ",")})
	if res.Response.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("range abuse status=%d body=%q", res.Response.StatusCode, body)
	}
	if len(body) > len(payload) {
		t.Fatalf("range abuse amplified body to %d bytes", len(body))
	}
	res, body = doContent(t, cl, pid, http.MethodGet, "/files/posts/range.txt", map[string]string{"Range": "bytes=0-3"})
	if res.Response.StatusCode != http.StatusPartialContent || string(body) != "xxxx" {
		t.Fatalf("single range status=%d body=%q", res.Response.StatusCode, body)
	}
}
