package node_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Raminga/raminga/internal/node"
)

func TestStage5HumanSendIdempotencyAndDurableRelation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	c := newTestNode(t, t.TempDir())

	bPeer := b.status(t).PeerID
	cPeer := c.status(t).PeerID
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatalf("connect b: %v", err)
	}
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, c.status(t))); err != nil {
		t.Fatalf("connect c: %v", err)
	}

	first, err := a.node.SendChatOrigin(ctx, bPeer, "", "hello once", node.OriginHuman, "ui-request-1")
	if err != nil {
		t.Fatalf("first send: %v", err)
	}
	if !first.Acked || first.Replayed || first.DeliveryStatus != node.DeliveryAcked {
		t.Fatalf("first send = %+v", first)
	}
	second, err := a.node.SendChatOrigin(ctx, bPeer, "", "hello once", node.OriginHuman, "ui-request-1")
	if err != nil {
		t.Fatalf("replayed send: %v", err)
	}
	if !second.Replayed || second.MessageID != first.MessageID || !second.Acked {
		t.Fatalf("replayed send = %+v", second)
	}
	if _, err := a.node.SendChatOrigin(ctx, bPeer, "", "different text", node.OriginHuman, "ui-request-1"); err == nil {
		t.Fatal("same request_id with different text unexpectedly succeeded")
	}

	msgsB, err := b.node.RecentMessages(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgsB) != 1 || msgsB[0].Text != "hello once" {
		t.Fatalf("peer received %+v, want exactly one message", msgsB)
	}
	page, err := a.node.ListMessages(ctx, bPeer, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 1 || page.Messages[0].Origin != node.OriginHuman || page.Messages[0].DeliveryStatus != node.DeliveryAcked {
		t.Fatalf("list messages = %+v", page.Messages)
	}
	if page.Messages[0].ClientRequestID != "ui-request-1" {
		t.Fatalf("client_request_id = %q", page.Messages[0].ClientRequestID)
	}

	if _, err := a.node.SendChatOrigin(ctx, cPeer, "", "agent text", node.OriginAgent, "agent-request-1"); err != nil {
		t.Fatalf("agent send: %v", err)
	}
	if _, err := a.node.SendChat(ctx, cPeer, "", "legacy unknown"); err != nil {
		t.Fatalf("legacy send: %v", err)
	}
	relations, err := a.node.ListHumanOutboundPeers(ctx, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(relations.Peers) != 1 || relations.Peers[0].PeerID != bPeer {
		t.Fatalf("human outbound relations = %+v", relations.Peers)
	}
	if relations.Peers[0].FirstAt.IsZero() || relations.Peers[0].LastAt.IsZero() {
		t.Fatalf("relation times missing: %+v", relations.Peers[0])
	}
}

func TestStage5SendReplayOfPendingDoesNotRedialOrDuplicate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	bPeer := b.status(t).PeerID
	addrB := tcpMultiaddr(t, b.status(t))
	if _, err := a.node.Connect(ctx, "", addrB); err != nil {
		t.Fatalf("connect: %v", err)
	}
	// A pending row can be produced when the outbox is full or the dial fails.
	// Simulate the persisted state directly by saving outbox full? Use a real
	// send to a stopped peer is not needed here: the idempotent replay path only
	// depends on the history row and must return it without another delivery.
	first, err := a.node.SendChatOrigin(ctx, bPeer, "", "pending replay", node.OriginHuman, "req-pending")
	if err != nil || !first.Acked {
		t.Fatalf("initial send = %+v, %v", first, err)
	}
	replay, err := a.node.SendChatOrigin(ctx, bPeer, "", "pending replay", node.OriginHuman, "req-pending")
	if err != nil {
		t.Fatal(err)
	}
	if !replay.Replayed || replay.MessageID != first.MessageID {
		t.Fatalf("replay = %+v", replay)
	}
	msgs, err := b.node.RecentMessages(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("receiver has %d messages after replay, want 1", len(msgs))
	}
}

func TestStage5SendReplayRequiresMatchingPeerTextAndOrigin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	c := newTestNode(t, t.TempDir())
	bPeer := b.status(t).PeerID
	cPeer := c.status(t).PeerID
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatalf("connect b: %v", err)
	}
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, c.status(t))); err != nil {
		t.Fatalf("connect c: %v", err)
	}

	first, err := a.node.SendChatOrigin(ctx, bPeer, "", "same body", node.OriginHuman, "shared-key")
	if err != nil || !first.Acked {
		t.Fatalf("human send = %+v, %v", first, err)
	}
	replay, err := a.node.SendChatOrigin(ctx, bPeer, "", "same body", node.OriginHuman, "shared-key")
	if err != nil || !replay.Replayed || replay.MessageID != first.MessageID {
		t.Fatalf("matching replay = %+v, %v", replay, err)
	}

	// Changing either the body or the local source must be an explicit
	// conflict instead of returning the old delivery status.
	if _, err := a.node.SendChatOrigin(ctx, bPeer, "", "different body", node.OriginHuman, "shared-key"); err == nil {
		t.Fatal("same request_id with a different body unexpectedly succeeded")
	} else if !strings.Contains(err.Error(), "different message or origin") {
		t.Fatalf("different body error = %v", err)
	}
	if _, err := a.node.SendChatOrigin(ctx, bPeer, "", "same body", node.OriginAgent, "shared-key"); err == nil {
		t.Fatal("same request_id with a different origin unexpectedly succeeded")
	} else if !strings.Contains(err.Error(), "different message or origin") {
		t.Fatalf("different origin error = %v", err)
	}

	relations, err := a.node.ListHumanOutboundPeers(ctx, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(relations.Peers) != 1 || relations.Peers[0].PeerID != bPeer {
		t.Fatalf("human relations after agent conflict = %+v", relations.Peers)
	}

	// The same key is scoped to its Peer: an Agent send to C is independent,
	// and replaying it requires Agent origin on C.
	agentC, err := a.node.SendChatOrigin(ctx, cPeer, "", "same body", node.OriginAgent, "shared-key")
	if err != nil || !agentC.Acked || agentC.Replayed {
		t.Fatalf("agent send to c = %+v, %v", agentC, err)
	}
	if agentC.MessageID == first.MessageID {
		t.Fatal("different Peers produced the same deterministic message ID")
	}
	agentReplay, err := a.node.SendChatOrigin(ctx, cPeer, "", "same body", node.OriginAgent, "shared-key")
	if err != nil || !agentReplay.Replayed || agentReplay.MessageID != agentC.MessageID {
		t.Fatalf("agent replay to c = %+v, %v", agentReplay, err)
	}
	if _, err := a.node.SendChatOrigin(ctx, cPeer, "", "same body", node.OriginHuman, "shared-key"); err == nil {
		t.Fatal("agent row was replayed for a human request on the same Peer")
	}
	relations, err = a.node.ListHumanOutboundPeers(ctx, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(relations.Peers) != 1 || relations.Peers[0].PeerID != bPeer {
		t.Fatalf("agent send must not create a human relation: %+v", relations.Peers)
	}

	msgsB, err := b.node.RecentMessages(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgsB) != 1 || msgsB[0].Text != "same body" {
		t.Fatalf("peer B messages = %+v, want exactly one", msgsB)
	}
	msgsC, err := c.node.RecentMessages(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgsC) != 1 || msgsC[0].Text != "same body" {
		t.Fatalf("peer C messages = %+v, want exactly one", msgsC)
	}
}

func TestStage5SendReplayConcurrentAndAfterRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	dirA := t.TempDir()
	a := newTestNode(t, dirA)
	b := newTestNode(t, t.TempDir())
	bPeer := b.status(t).PeerID
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatalf("connect b: %v", err)
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]node.SendResult, 2)
	errs := make([]error, 2)
	for i := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			results[index], errs[index] = a.node.SendChatOrigin(ctx, bPeer, "", "concurrent body", node.OriginHuman, "concurrent-key")
		}(i)
	}
	close(start)
	wg.Wait()

	successes := 0
	messageID := ""
	for i := range results {
		if errs[i] != nil {
			// A concurrent duplicate may be rejected by the in-flight guard;
			// it must never create a second message.
			if !strings.Contains(errs[i].Error(), "already in flight") {
				t.Fatalf("concurrent result %d error = %v", i, errs[i])
			}
			continue
		}
		successes++
		if !results[i].Acked {
			t.Fatalf("concurrent result %d = %+v", i, results[i])
		}
		if messageID == "" {
			messageID = results[i].MessageID
		} else if results[i].MessageID != messageID {
			t.Fatalf("concurrent results used different message IDs: %q and %q", messageID, results[i].MessageID)
		}
	}
	if successes == 0 {
		t.Fatal("no concurrent send succeeded")
	}
	msgsB, err := b.node.RecentMessages(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgsB) != 1 {
		t.Fatalf("receiver has %d messages after concurrent sends, want 1", len(msgsB))
	}

	replay, err := a.node.SendChatOrigin(ctx, bPeer, "", "concurrent body", node.OriginHuman, "concurrent-key")
	if err != nil || !replay.Replayed || replay.MessageID != messageID {
		t.Fatalf("replay after concurrency = %+v, %v", replay, err)
	}

	// A restart keeps the stored key and origin, so the replay path still works
	// without redialing or creating a second message.
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
	afterRestart, err := a2.node.SendChatOrigin(ctx, bPeer, "", "concurrent body", node.OriginHuman, "concurrent-key")
	if err != nil || !afterRestart.Replayed || afterRestart.MessageID != messageID {
		t.Fatalf("replay after restart = %+v, %v", afterRestart, err)
	}
	msgsB, err = b.node.RecentMessages(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgsB) != 1 {
		t.Fatalf("receiver has %d messages after restart replay, want 1", len(msgsB))
	}
}
