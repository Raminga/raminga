package node_test

import (
	"context"
	"crypto/rand"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/identity"
	"github.com/Raminga/raminga/internal/network"
	"github.com/Raminga/raminga/internal/node"
	"github.com/Raminga/raminga/internal/p2phttp"
	"github.com/Raminga/raminga/internal/storage"
)

type testNode struct {
	node *node.Node
	id   *identity.Identity
	dir  string
}

func newTestNode(t *testing.T, dir string) *testNode {
	t.Helper()
	return newTestNodeWithConfig(t, dir, nil)
}

func newTestNodeWithConfig(t *testing.T, dir string, mutate func(*config.Config)) *testNode {
	t.Helper()
	ctx := context.Background()
	id, err := identity.Open(dir)
	if err != nil {
		t.Fatalf("identity.Open: %v", err)
	}
	cfg := config.Default()
	if mutate != nil {
		mutate(&cfg)
	}
	cfg.Network.ListenAddrs = []string{
		"/ip4/127.0.0.1/tcp/0",
		"/ip4/127.0.0.1/udp/0/quic-v1",
	}
	cfg.Log.Level = "error"
	store, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	netw, err := network.New(network.Config{
		PrivateKey:  id.PrivateKey(),
		ListenAddrs: cfg.Network.ListenAddrs,
		Logger:      slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})),
	})
	if err != nil {
		t.Fatalf("network.New: %v", err)
	}
	n, err := node.New(node.Options{
		DataDir:  dir,
		Version:  "test",
		Config:   cfg,
		Identity: id,
		Store:    store,
		Network:  netw,
		Logger:   slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})),
	})
	if err != nil {
		t.Fatalf("node.New: %v", err)
	}
	if err := n.Start(ctx); err != nil {
		t.Fatalf("node.Start: %v", err)
	}
	tn := &testNode{node: n, id: id, dir: dir}
	t.Cleanup(func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = n.Stop(shutdownCtx)
		_ = id.Close()
	})
	return tn
}

func (tn *testNode) status(t *testing.T) node.Status {
	t.Helper()
	st, err := tn.node.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	return st
}

func tcpMultiaddr(t *testing.T, st node.Status) string {
	t.Helper()
	for _, a := range st.ListenAddrs {
		if strings.Contains(a, "/tcp/") {
			return a + "/p2p/" + st.PeerID
		}
	}
	t.Fatalf("no TCP listen addr in %v", st.ListenAddrs)
	return ""
}

func TestTwoNodesDirectChatAckAndRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	dirA := t.TempDir()
	dirB := t.TempDir()
	a := newTestNode(t, dirA)
	b := newTestNode(t, dirB)

	addrB := tcpMultiaddr(t, b.status(t))
	res, err := a.node.Connect(ctx, "", addrB)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if res.PeerID != b.status(t).PeerID || !res.Direct || res.Limited {
		t.Fatalf("connect result = %+v", res)
	}
	if res.Transport != "tcp" && res.Transport != "quic" {
		t.Fatalf("transport = %q", res.Transport)
	}

	events, unsubscribe, err := a.node.Subscribe(ctx)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer unsubscribe()

	sendA, err := a.node.SendChat(ctx, b.status(t).PeerID, "", "hello from a")
	if err != nil {
		t.Fatalf("A SendChat: %v", err)
	}
	if !sendA.Acked || sendA.AckMessageID != sendA.MessageID || sendA.ACKID == "" {
		t.Fatalf("A send result = %+v", sendA)
	}

	msgsB, err := b.node.RecentMessages(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgsB) != 1 || msgsB[0].Text != "hello from a" || msgsB[0].Direction != "in" || !msgsB[0].Acked {
		t.Fatalf("B messages = %+v", msgsB)
	}

	sendB, err := b.node.SendChat(ctx, a.status(t).PeerID, "", "hello from b")
	if err != nil {
		t.Fatalf("B SendChat: %v", err)
	}
	if !sendB.Acked {
		t.Fatalf("B send result = %+v", sendB)
	}
	var sawChat bool
	deadline := time.After(5 * time.Second)
	for !sawChat {
		select {
		case ev := <-events:
			if ev.Chat != nil && ev.Chat.Text == "hello from b" && ev.Chat.FromPeerID == b.status(t).PeerID {
				sawChat = true
			}
		case <-deadline:
			t.Fatal("A did not receive chat event from B")
		}
	}

	// An undeliverable message is persisted as unacked, never as ACKed.
	unknownKey, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatalf("generate unknown peer: %v", err)
	}
	unknownPeer, err := peer.IDFromPrivateKey(unknownKey)
	if err != nil {
		t.Fatalf("derive unknown peer ID: %v", err)
	}
	unacked, err := a.node.SendChat(ctx, unknownPeer.String(), "", "nobody home")
	if err != nil {
		t.Fatalf("unacked SendChat: %v", err)
	}
	if unacked.Acked || unacked.Error == "" {
		t.Fatalf("unacked send result = %+v", unacked)
	}

	// Restart A on the same data dir: same Peer ID, unacked stays unacked.
	aPeer := a.status(t).PeerID
	if err := a.node.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := a.id.Close(); err != nil {
		t.Fatal(err)
	}

	a2 := newTestNode(t, dirA)
	if got := a2.status(t).PeerID; got != aPeer {
		t.Fatalf("Peer ID changed after restart: %s -> %s", aPeer, got)
	}
	msgsA, err := a2.node.RecentMessages(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, m := range msgsA {
		if m.MessageID == unacked.MessageID {
			found = true
			if m.Acked {
				t.Fatalf("unacked message reported as ACKed after restart: %+v", m)
			}
		}
	}
	if !found {
		t.Fatalf("unacked message missing after restart: %+v", msgsA)
	}

	// After restart, explicit redial restores chat (PeerStore is in memory).
	addrB = tcpMultiaddr(t, b.status(t))
	if _, err := a2.node.Connect(ctx, "", addrB); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	again, err := a2.node.SendChat(ctx, b.status(t).PeerID, "", "after restart")
	if err != nil || !again.Acked {
		t.Fatalf("post-restart SendChat = %+v, err=%v", again, err)
	}
}

func TestEmptyListenAddrs(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	id, err := identity.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = id.Close() }()
	cfg := config.Default()
	cfg.Network.ListenAddrs = nil
	store, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	netw, err := network.New(network.Config{PrivateKey: id.PrivateKey(), ListenAddrs: nil})
	if err != nil {
		t.Fatal(err)
	}
	n, err := node.New(node.Options{DataDir: dir, Version: "test", Config: cfg, Identity: id, Store: store, Network: netw})
	if err != nil {
		t.Fatal(err)
	}
	if err := n.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = n.Stop(context.Background()) }()
	st := awaitStatus(t, n)
	if len(st.ListenAddrs) != 0 {
		t.Fatalf("listen addrs = %v, want none", st.ListenAddrs)
	}
}

func awaitStatus(t *testing.T, n *node.Node) node.Status {
	t.Helper()
	st, err := n.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func TestInboundPeerPolicyDenyAndAllowList(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNodeWithConfig(t, t.TempDir(), func(cfg *config.Config) {
		cfg.Chat.AllowUnknownPeers = false
	})
	addrB := tcpMultiaddr(t, b.status(t))
	if _, err := a.node.Connect(ctx, "", addrB); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	res, err := a.node.SendChat(ctx, b.status(t).PeerID, "", "unknown should be rejected")
	if err != nil {
		t.Fatalf("SendChat: %v", err)
	}
	if res.Acked {
		t.Fatalf("unknown peer was accepted despite allow_unknown_peers=false: %+v", res)
	}
	if !strings.Contains(res.Error, "unknown peer") {
		t.Fatalf("rejection reason = %q", res.Error)
	}
	msgs, err := b.node.RecentMessages(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 0 {
		t.Fatalf("rejected message was stored: %+v", msgs)
	}

	// A node with an explicit allow list accepts the same authenticated peer.
	aID := a.status(t).PeerID
	c := newTestNodeWithConfig(t, t.TempDir(), func(cfg *config.Config) {
		cfg.Chat.AllowUnknownPeers = false
		cfg.Chat.AllowedPeerIDs = []string{aID}
	})
	addrC := tcpMultiaddr(t, c.status(t))
	if _, err := a.node.Connect(ctx, "", addrC); err != nil {
		t.Fatalf("Connect C: %v", err)
	}
	resC, err := a.node.SendChat(ctx, c.status(t).PeerID, "", "allowed contact")
	if err != nil {
		t.Fatalf("SendChat C: %v", err)
	}
	if !resC.Acked || resC.Error != "" {
		t.Fatalf("allow-listed peer was not accepted: %+v", resC)
	}
}

func TestFriendWriteRules(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	// Outbound connect records A->B as manual; the follow-up /hello records B's
	// row as non-manual.
	addrB := tcpMultiaddr(t, b.status(t))
	if _, err := a.node.Connect(ctx, "", addrB); err != nil {
		t.Fatal(err)
	}
	af, err := a.node.Friends(ctx)
	if err != nil || len(af) != 1 || af[0].PeerID != b.status(t).PeerID || !af[0].ManuallyConnected {
		t.Fatalf("A friends=%+v err=%v", af, err)
	}
	_ = waitFriend(t, b.node, a.status(t).PeerID, false)
	// An accepted chat on both sides keeps/writes both rows.
	if _, err := a.node.SendChat(ctx, b.status(t).PeerID, "", "hello friends"); err != nil {
		t.Fatal(err)
	}
	if bf, err := b.node.Friends(ctx); err != nil || len(bf) != 1 || bf[0].PeerID != a.status(t).PeerID {
		t.Fatalf("B after chat friends=%+v err=%v", bf, err)
	}
}

func TestPausePeerPersistsAndExplicitConnectResumes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	addrB := tcpMultiaddr(t, b.status(t))
	if _, err := a.node.Connect(ctx, "", addrB); err != nil {
		t.Fatal(err)
	}
	if err := a.node.PausePeer(ctx, b.status(t).PeerID); err != nil {
		t.Fatal(err)
	}
	af, err := a.node.Friends(ctx)
	if err != nil || len(af) != 1 || !af[0].Paused {
		t.Fatalf("after pause friends=%+v err=%v", af, err)
	}
	if _, err := a.node.Connect(ctx, "", addrB); err != nil {
		t.Fatal(err)
	}
	af, err = a.node.Friends(ctx)
	if err != nil || len(af) != 1 || af[0].Paused {
		t.Fatalf("after reconnect friends=%+v err=%v", af, err)
	}
}

func localNonLoopbackIPv4(t *testing.T) string {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipnet.IP.To4()
		if ip != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
			return ip.String()
		}
	}
	t.Skip("no non-loopback IPv4 for restart integration test")
	return ""
}

func TestRestartRecoveryReconnectsManualRelay(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	hostIP := localNonLoopbackIPv4(t)
	keyR, _, _ := crypto.GenerateEd25519Key(rand.Reader)
	R, err := network.New(network.Config{
		PrivateKey:  keyR,
		ListenAddrs: []string{"/ip4/" + hostIP + "/tcp/0"},
		Relay: network.RelayConfig{Provider: true, MaxReservations: 8, ReservationTTL: time.Hour,
			MaxReservationsPerIP: 8, MaxReservationsPerPeer: 1, MaxCircuits: 8,
			ReservationDataLimit: 1 << 20, ReservationDurationLimit: 2 * time.Minute},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = R.Close() }()
	if err := R.Start(ctx); err != nil {
		t.Fatal(err)
	}
	raddr := R.Host().Addrs()[0].Encapsulate(ma.StringCast("/p2p/" + R.Host().ID().String())).String()

	dir := t.TempDir()
	newA := func() (*node.Node, *identity.Identity) {
		id, err := identity.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		store, err := storage.Open(ctx, dir)
		if err != nil {
			t.Fatal(err)
		}
		cfg := config.Default()
		cfg.Network.ListenAddrs = []string{"/ip4/127.0.0.1/tcp/0"}
		netw, err := network.New(network.Config{PrivateKey: id.PrivateKey(), ListenAddrs: cfg.Network.ListenAddrs,
			EnableRelay: true, EnableAutoRelay: true})
		if err != nil {
			t.Fatal(err)
		}
		n, err := node.New(node.Options{DataDir: dir, Version: "test", Config: cfg, Identity: id, Store: store, Network: netw})
		if err != nil {
			t.Fatal(err)
		}
		if err := n.Start(ctx); err != nil {
			t.Fatal(err)
		}
		return n, id
	}
	n1, id1 := newA()
	res, err := n1.Connect(ctx, "", raddr)
	if err != nil {
		t.Fatal(err)
	}
	fr, _ := n1.Friends(ctx)
	t.Logf("connect=%+v friends=%+v", res, fr)
	if err := n1.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	_ = id1.Close()

	n2, id2 := newA()
	defer func() { _ = n2.Stop(context.Background()); _ = id2.Close() }()
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		for _, r := range n2.RelayReservations() {
			if r.RelayPeerID == R.Host().ID().String() && r.Status == "active" {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("restart recovery did not restore relay reservation: %+v", n2.RelayReservations())
}

func TestChatOverRelayLimited(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	hostIP := localNonLoopbackIPv4(t)
	keyR, _, _ := crypto.GenerateEd25519Key(rand.Reader)
	R, err := network.New(network.Config{
		PrivateKey: keyR, ListenAddrs: []string{"/ip4/" + hostIP + "/tcp/0"},
		Relay: network.RelayConfig{Provider: true, MaxReservations: 8, ReservationTTL: time.Hour,
			MaxReservationsPerIP: 8, MaxReservationsPerPeer: 1, MaxCircuits: 8,
			ReservationDataLimit: 1 << 20, ReservationDurationLimit: 2 * time.Minute},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = R.Close() }()
	if err := R.Start(ctx); err != nil {
		t.Fatal(err)
	}
	raddr := R.Host().Addrs()[0].Encapsulate(ma.StringCast("/p2p/" + R.Host().ID().String())).String()
	mk := func() *testNode {
		dir := t.TempDir()
		id, err := identity.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		store, err := storage.Open(ctx, dir)
		if err != nil {
			t.Fatal(err)
		}
		cfg := config.Default()
		cfg.Network.ListenAddrs = []string{"/ip4/127.0.0.1/tcp/0"}
		netw, err := network.New(network.Config{PrivateKey: id.PrivateKey(), ListenAddrs: cfg.Network.ListenAddrs, EnableRelay: true, EnableAutoRelay: true})
		if err != nil {
			t.Fatal(err)
		}
		n, err := node.New(node.Options{DataDir: dir, Version: "test", Config: cfg, Identity: id, Store: store, Network: netw})
		if err != nil {
			t.Fatal(err)
		}
		if err := n.Start(ctx); err != nil {
			t.Fatal(err)
		}
		return &testNode{node: n, id: id, dir: dir}
	}
	a, b := mk(), mk()
	defer func() { _ = a.node.Stop(context.Background()); _ = a.id.Close() }()
	defer func() { _ = b.node.Stop(context.Background()); _ = b.id.Close() }()
	if _, err := b.node.Connect(ctx, "", raddr); err != nil {
		t.Fatal(err)
	}
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
	if _, err := a.node.Connect(ctx, "", circuit); err != nil {
		t.Fatalf("A circuit connect: %v", err)
	}
	res, err := a.node.SendChat(ctx, b.status(t).PeerID, "", "relayed HTTP chat")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Acked || res.Route != "relay" || res.Transport == "" {
		t.Fatalf("relayed send = %+v", res)
	}
}

func waitFriend(t *testing.T, n *node.Node, pid string, wantManual bool) node.Friend {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last []node.Friend
	for time.Now().Before(deadline) {
		friends, err := n.Friends(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		last = friends
		for _, f := range friends {
			if f.PeerID == pid {
				if f.ManuallyConnected != wantManual {
					t.Fatalf("friend %s manual=%t want %t", pid, f.ManuallyConnected, wantManual)
				}
				return f
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("friend %s not recorded; friends=%+v", pid, last)
	return node.Friend{}
}

func TestHelloRecordsBothSidesAndManualFlagsStay(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	addrB := tcpMultiaddr(t, b.status(t))
	res, err := a.node.Connect(ctx, "", addrB)
	if err != nil {
		t.Fatal(err)
	}
	if res.PeerID != b.status(t).PeerID || res.Note != "" {
		t.Fatalf("connect=%+v", res)
	}
	_ = waitFriend(t, a.node, b.status(t).PeerID, true)
	_ = waitFriend(t, b.node, a.status(t).PeerID, false)

	// B now explicitly connects back; its row becomes manual. A later inbound
	// hello/chat must not clear it.
	addrA := tcpMultiaddr(t, a.status(t))
	if _, err := b.node.Connect(ctx, "", addrA); err != nil {
		t.Fatal(err)
	}
	waitFriend(t, b.node, a.status(t).PeerID, true)
	if _, err := a.node.SendChat(ctx, b.status(t).PeerID, "", "after manual"); err != nil {
		t.Fatal(err)
	}
	waitFriend(t, b.node, a.status(t).PeerID, true)
}

func TestHelloDeniedNoRowButConnectSucceeds(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNodeWithConfig(t, t.TempDir(), func(cfg *config.Config) { cfg.Chat.AllowUnknownPeers = false })
	res, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t)))
	if err != nil {
		t.Fatal(err)
	}
	if res.PeerID != b.status(t).PeerID || !strings.Contains(res.Note, "hello failed") {
		t.Fatalf("connect=%+v", res)
	}
	waitFriend(t, a.node, b.status(t).PeerID, true)
	time.Sleep(200 * time.Millisecond)
	friends, err := b.node.Friends(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(friends) != 0 {
		t.Fatalf("denied hello created row: %+v", friends)
	}
}

func TestIdleInboundConnectionDoesNotRecord(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	b := newTestNode(t, t.TempDir())
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	h, err := libp2p.New(libp2p.Identity(key), libp2p.NoListenAddrs)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = h.Close() }()
	bpid, err := peer.Decode(b.status(t).PeerID)
	if err != nil {
		t.Fatal(err)
	}
	var baddrs []ma.Multiaddr
	for _, raw := range b.status(t).ListenAddrs {
		if a, aerr := ma.NewMultiaddr(raw); aerr == nil {
			baddrs = append(baddrs, a)
		}
	}
	if err := h.Connect(ctx, peer.AddrInfo{ID: bpid, Addrs: baddrs}); err != nil {
		t.Fatal(err)
	}
	cl, err := p2phttp.NewClient(h, p2phttp.DefaultClientOptions())
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, "http://"+b.status(t).PeerID+"/healthz", nil)
	res, err := cl.Do(ctx, bpid, req, 1024)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, res.Response.Body)
	_ = res.Response.Body.Close()
	time.Sleep(300 * time.Millisecond)
	friends, err := b.node.Friends(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(friends) != 0 {
		t.Fatalf("idle connection recorded a friend: %+v", friends)
	}
}

func TestForgetThenChatReads(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatal(err)
	}
	waitFriend(t, a.node, b.status(t).PeerID, true)
	if _, _, err := a.node.RemoveFriend(ctx, b.status(t).PeerID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := a.node.SendChat(ctx, b.status(t).PeerID, "", "readd after forget"); err != nil {
		t.Fatal(err)
	}
	waitFriend(t, a.node, b.status(t).PeerID, false)
}

func TestHelloRouteRateLimited(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	b := newTestNode(t, t.TempDir())
	key, _, _ := crypto.GenerateEd25519Key(rand.Reader)
	h, err := libp2p.New(libp2p.Identity(key), libp2p.NoListenAddrs)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = h.Close() }()
	bpid, err := peer.Decode(b.status(t).PeerID)
	if err != nil {
		t.Fatal(err)
	}
	var baddrs []ma.Multiaddr
	for _, raw := range b.status(t).ListenAddrs {
		if a, aerr := ma.NewMultiaddr(raw); aerr == nil {
			baddrs = append(baddrs, a)
		}
	}
	if err := h.Connect(ctx, peer.AddrInfo{ID: bpid, Addrs: baddrs}); err != nil {
		t.Fatal(err)
	}
	cl, err := p2phttp.NewClient(h, p2phttp.DefaultClientOptions())
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	statuses := make(map[int]int)
	for i := 0; i < 11; i++ {
		req, _ := http.NewRequest(http.MethodPost, "http://"+b.status(t).PeerID+"/hello", nil)
		res, err := cl.Do(ctx, bpid, req, 1024)
		if err != nil {
			t.Fatal(err)
		}
		statuses[res.Response.StatusCode]++
		_ = res.Response.Body.Close()
	}
	if statuses[http.StatusOK] != 10 || statuses[http.StatusTooManyRequests] != 1 {
		t.Fatalf("hello statuses=%v", statuses)
	}
}

func TestProtocolMismatchMessagesForChatAndContent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	// A real second libp2p host that intentionally never registers the Raminga
	// HTTP protocol.
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	b, err := libp2p.New(libp2p.Identity(key), libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = b.Close() }()
	addrB := b.Addrs()[0].String() + "/p2p/" + b.ID().String()
	if _, err := a.node.Connect(ctx, "", addrB); err != nil {
		t.Fatalf("connect to protocol-less host: %v", err)
	}
	sent, err := a.node.SendChat(ctx, b.ID().String(), "", "hello")
	if err != nil {
		t.Fatalf("SendChat local error: %v", err)
	}
	for _, want := range []string{"对方不支持协议 /raminga/http/1.0.0", "双方需升级到同一版本"} {
		if !strings.Contains(sent.Error, want) {
			t.Fatalf("chat error %q missing %q", sent.Error, want)
		}
	}
	_, err = a.node.FetchManifest(ctx, b.ID().String(), 0, 10)
	if err == nil {
		t.Fatal("manifest fetch from protocol-less host unexpectedly succeeded")
	}
	for _, want := range []string{"对方不支持协议 /raminga/http/1.0.0", "双方需升级到同一版本"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("content error %q missing %q", err, want)
		}
	}
}
