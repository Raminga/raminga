package node_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/node"
)

// TestBootstrapAddRemoveIsSerializedAndKeepsRoleOnly verifies that overlapping
// add/remove calls cannot leave SQLite and the live DHT candidate map in
// different states, and that removing the role does not disturb an established
// connection or create/clear pause state.
func TestBootstrapAddRemoveIsSerializedAndKeepsRoleOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	a := newTestNodeWithDHT(t, t.TempDir(), func(cfg *config.Config) {
		cfg.DHT.Mode = "client"
		cfg.DHT.RefreshInterval = "1s"
		cfg.DHT.QueryTimeout = "2s"
	})
	b := newTestNodeWithDHT(t, t.TempDir(), func(cfg *config.Config) {
		cfg.Network.ListenAddrs = []string{"/ip4/127.0.0.1/tcp/0"}
		cfg.DHT.Mode = "server"
		cfg.DHT.RefreshInterval = "1s"
		cfg.DHT.QueryTimeout = "2s"
	})
	addrB := tcpMultiaddr(t, b.status(t))
	pid, err := peer.Decode(b.status(t).PeerID)
	if err != nil {
		t.Fatal(err)
	}

	const rounds = 8
	var wg sync.WaitGroup
	errs := make(chan error, rounds*2)
	for i := 0; i < rounds; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if _, _, err := a.node.AddBootstrapPeer(ctx, addrB); err != nil {
				errs <- err
			}
		}()
		go func() {
			defer wg.Done()
			if _, err := a.node.RemoveBootstrapPeer(ctx, pid.String()); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("overlapping bootstrap update: %v", err)
		}
	}

	// Make the intended final state explicit and compare persisted roles with
	// the live DHT candidates after every earlier operation has returned.
	if _, _, err := a.node.AddBootstrapPeer(ctx, addrB); err != nil {
		t.Fatalf("final add: %v", err)
	}
	assertBootstrapRoleAndCandidates(t, a, addrB)
	waitUntilTest(t, 20*time.Second, "bootstrap connection", func() bool {
		peers, err := a.node.BootstrapPeers(ctx)
		return err == nil && len(peers) == 1 && peers[0].Online
	})
	peers, err := a.node.Peers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !peerOnline(peers, pid.String()) {
		t.Fatal("bootstrap peer is not connected after final add")
	}

	if _, err := a.node.RemoveBootstrapPeer(ctx, pid.String()); err != nil {
		t.Fatalf("final remove: %v", err)
	}
	rows, err := a.node.BootstrapPeers(ctx)
	if err != nil || len(rows) != 0 {
		t.Fatalf("stored roles after remove = %+v err=%v", rows, err)
	}
	if dht := a.node.DHTStatus(); len(dht.BootstrapPeers) != 0 {
		t.Fatalf("live DHT candidates after remove = %v", dht.BootstrapPeers)
	}
	peers, err = a.node.Peers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !peerOnline(peers, pid.String()) {
		t.Fatal("removing the bootstrap role disturbed an established connection")
	}
	// Removing a role is not an explicit disconnect and must not invent one.
	friends, err := a.node.Friends(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, friend := range friends {
		if friend.PeerID == pid.String() && friend.Paused {
			t.Fatal("removing the bootstrap role set a pause")
		}
	}
}

func assertBootstrapRoleAndCandidates(t *testing.T, tn *testNode, addr string) {
	t.Helper()
	rows, err := tn.node.BootstrapPeers(context.Background())
	if err != nil || len(rows) != 1 {
		t.Fatalf("stored roles = %+v err=%v", rows, err)
	}
	hasAddr := false
	for _, value := range rows[0].Addrs {
		if value == addr {
			hasAddr = true
		}
	}
	if !hasAddr {
		t.Fatalf("stored role lacks %s: %v", addr, rows[0].Addrs)
	}
	dht := tn.node.DHTStatus()
	if len(dht.BootstrapPeers) != len(rows[0].Addrs) {
		t.Fatalf("live candidates %v != stored roles %v", dht.BootstrapPeers, rows[0].Addrs)
	}
	for _, value := range rows[0].Addrs {
		found := false
		for _, candidate := range dht.BootstrapPeers {
			if candidate == value {
				found = true
			}
		}
		if !found {
			t.Fatalf("live candidates %v lack stored role %s", dht.BootstrapPeers, value)
		}
	}
}

func peerOnline(peers []node.PeerStatus, peerID string) bool {
	for _, value := range peers {
		if value.PeerID == peerID && value.Online {
			return true
		}
	}
	return false
}
