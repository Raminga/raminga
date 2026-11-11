package network

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/p2p/protocol/holepunch"
	ma "github.com/multiformats/go-multiaddr"
)

func TestSortCandidatesIPv6FirstRelayLast(t *testing.T) {
	mustAddr := func(raw string) ma.Multiaddr {
		addr, err := ma.NewMultiaddr(raw)
		if err != nil {
			t.Fatal(err)
		}
		return addr
	}
	candidates := []dialCandidate{
		{addr: mustAddr("/ip4/1.2.3.4/tcp/4001"), source: sourcePeerStore},
		{addr: mustAddr("/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6/p2p-circuit"), source: sourceCache},
		{addr: mustAddr("/ip6/fd00::1/tcp/4001"), source: sourceDHT},
	}
	sortCandidates(candidates)
	if got := candidateFamily(candidates[0].addr); got != "ipv6" {
		t.Fatalf("first family = %s, want ipv6: %v", got, candidates)
	}
	if got := candidateFamily(candidates[1].addr); got != "ipv4" {
		t.Fatalf("second family = %s, want ipv4: %v", got, candidates)
	}
	if got := candidateFamily(candidates[2].addr); got != "relay" {
		t.Fatalf("third family = %s, want relay: %v", got, candidates)
	}
}

func TestDialBackoffDetectionAndExplanation(t *testing.T) {
	if !isDialBackoff(errors.New("dial backoff")) || !isDialBackoff(errors.New("peer is backing off")) {
		t.Fatal("dial backoff errors were not detected")
	}
	if isDialBackoff(errors.New("i/o timeout")) {
		t.Fatal("timeout was misclassified as dial backoff")
	}
	note := dialBackoffNote()
	if !strings.Contains(note, "public API") || !strings.Contains(note, "remaining duration") {
		t.Fatalf("backoff note does not explain the public API limit: %q", note)
	}
}

func TestHolePunchTracerWatchdogMarksTerminalFailure(t *testing.T) {
	tracer := NewHolePunchTracer(50 * time.Millisecond)
	remote, err := peer.Decode("12D3KooWLaHQeWmPbiVnVe7Bgu2HbXcCQPBV8ioP5XgpQFPJPSEq")
	if err != nil {
		t.Fatal(err)
	}
	tracer.Trace(&holepunch.Event{
		Timestamp: time.Now().UnixNano(),
		Remote:    remote,
		Type:      holepunch.HolePunchAttemptEvtT,
		Evt:       &holepunch.HolePunchAttemptEvt{Attempt: 1},
	})
	tracer.Trace(&holepunch.Event{
		Timestamp: time.Now().UnixNano(),
		Remote:    remote,
		Type:      holepunch.StartHolePunchEvtT,
		Evt:       &holepunch.StartHolePunchEvt{},
	})
	time.Sleep(200 * time.Millisecond)
	status := tracer.Snapshot()
	if status.Attempts != 1 || status.Failures != 1 || status.Successes != 0 {
		t.Fatalf("watchdog status = %+v, want one terminal failure", status)
	}
	if len(status.Peers) != 1 {
		t.Fatalf("peers = %+v", status.Peers)
	}
	p := status.Peers[0]
	if p.Status != "failed" || p.Failures != 1 || p.Attempts != 1 || !strings.Contains(p.Error, "did not reach a terminal state") {
		t.Fatalf("peer state = %+v", p)
	}
	if len(status.Events) == 0 || status.Events[len(status.Events)-1].Type != "holepunch-timeout" {
		t.Fatalf("timeout event missing: %+v", status.Events)
	}
}

func TestHolePunchTracerTerminalEventStopsWatchdog(t *testing.T) {
	tracer := NewHolePunchTracer(50 * time.Millisecond)
	remote, err := peer.Decode("12D3KooWLaHQeWmPbiVnVe7Bgu2HbXcCQPBV8ioP5XgpQFPJPSEq")
	if err != nil {
		t.Fatal(err)
	}
	tracer.Trace(&holepunch.Event{
		Timestamp: time.Now().UnixNano(),
		Remote:    remote,
		Type:      holepunch.StartHolePunchEvtT,
		Evt:       &holepunch.StartHolePunchEvt{},
	})
	tracer.Trace(&holepunch.Event{
		Timestamp: time.Now().UnixNano(),
		Remote:    remote,
		Type:      holepunch.DirectDialEvtT,
		Evt:       &holepunch.DirectDialEvt{Success: true},
	})
	time.Sleep(150 * time.Millisecond)
	status := tracer.Snapshot()
	if status.Successes != 1 || status.Failures != 0 {
		t.Fatalf("terminal success status = %+v", status)
	}
}
