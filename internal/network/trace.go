package network

import (
	"fmt"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/p2p/protocol/holepunch"
)

// HolePunchEvent is a JSON-safe copy of a go-libp2p holepunch.Event.
type HolePunchEvent struct {
	Timestamp   string
	Type        string
	PeerID      string
	Success     *bool
	Error       string
	RemoteAddrs []string
	Attempt     int
	RTTMs       float64
	ElapsedMs   float64
}

// DCUtRPeer is per-peer DCUtR state. Attempts are never reported as success.
type DCUtRPeer struct {
	PeerID             string
	Status             string
	Attempts           int
	Successes          int
	Failures           int
	CandidateAddresses []string
	DirectAddress      string
	DirectTransport    string
	RelayAddress       string
	Error              string
	UpdatedAt          time.Time
}

// DCUtRStatus is a snapshot of the public hole-punch tracer.
type DCUtRStatus struct {
	Enabled   bool
	Attempts  int
	Successes int
	Failures  int
	Peers     []DCUtRPeer
	Events    []HolePunchEvent
}

// HolePunchTracer implements holepunch.EventTracer and records only the events
// exposed by go-libp2p's public tracer API. A watchdog turns an attempt that
// never receives a terminal event into a bounded failure with a reason, so a
// relay-only peer cannot linger at attempts=1 successes=0 failures=0.
type HolePunchTracer struct {
	mu       sync.Mutex
	events   []HolePunchEvent
	peers    map[string]*DCUtRPeer
	attempts int
	success  int
	failure  int
	watchdog time.Duration
	active   map[string]bool
	timers   map[string]*time.Timer
}

// NewHolePunchTracer creates a tracer. watchdog <= 0 defaults to 20 seconds.
func NewHolePunchTracer(watchdog time.Duration) *HolePunchTracer {
	if watchdog <= 0 {
		watchdog = 20 * time.Second
	}
	return &HolePunchTracer{
		peers:    make(map[string]*DCUtRPeer),
		watchdog: watchdog,
		active:   make(map[string]bool),
		timers:   make(map[string]*time.Timer),
	}
}

func (t *HolePunchTracer) Trace(event *holepunch.Event) {
	if event == nil {
		return
	}
	peerID := ""
	if event.Remote != "" {
		peerID = event.Remote.String()
	}
	now := time.Unix(0, event.Timestamp).UTC()
	record := HolePunchEvent{Timestamp: now.Format(time.RFC3339Nano), Type: event.Type, PeerID: peerID}

	t.mu.Lock()
	defer t.mu.Unlock()
	state := t.peers[peerID]
	if state == nil && peerID != "" {
		state = &DCUtRPeer{PeerID: peerID, Status: "attempting"}
		t.peers[peerID] = state
	}
	if state != nil {
		state.UpdatedAt = now
	}

	switch typed := event.Evt.(type) {
	case *holepunch.DirectDialEvt:
		record.Success = boolPtr(typed.Success)
		record.Error = typed.Error
		record.ElapsedMs = durationMillis(typed.EllapsedTime)
		t.finishAttemptLocked(peerID, state, typed.Success, typed.Error)
	case *holepunch.ProtocolErrorEvt:
		record.Error = typed.Error
		t.finishAttemptLocked(peerID, state, false, typed.Error)
	case *holepunch.StartHolePunchEvt:
		record.RemoteAddrs = append([]string(nil), typed.RemoteAddrs...)
		record.RTTMs = durationMillis(typed.RTT)
		if state != nil {
			state.Attempts++
			state.Status = "attempting"
			state.CandidateAddresses = append([]string(nil), typed.RemoteAddrs...)
		}
		t.startAttemptLocked(peerID)
	case *holepunch.EndHolePunchEvt:
		record.Success = boolPtr(typed.Success)
		record.Error = typed.Error
		record.ElapsedMs = durationMillis(typed.EllapsedTime)
		t.finishAttemptLocked(peerID, state, typed.Success, typed.Error)
	case *holepunch.HolePunchAttemptEvt:
		record.Attempt = typed.Attempt
		t.attempts++
		if state != nil {
			state.Status = "attempting"
		}
		t.startAttemptLocked(peerID)
	default:
		record.Error = fmt.Sprintf("unhandled holepunch event %T", event.Evt)
	}

	t.events = append(t.events, record)
	if len(t.events) > 200 {
		t.events = append([]HolePunchEvent(nil), t.events[len(t.events)-200:]...)
	}
}

// startAttemptLocked returns true when this event starts a new active attempt.
func (t *HolePunchTracer) startAttemptLocked(peerID string) bool {
	if peerID == "" || t.active[peerID] {
		return false
	}
	t.active[peerID] = true
	if timer := t.timers[peerID]; timer != nil {
		timer.Stop()
	}
	t.timers[peerID] = time.AfterFunc(t.watchdog, func() { t.timeoutAttempt(peerID) })
	return true
}

// finishAttemptLocked records at most one terminal result per attempt. Some
// go-libp2p event sequences start with a DirectDial event and never deliver a
// Start event, so a terminal event is accepted when the peer is still marked
// "attempting" even if the watchdog was never armed.
func (t *HolePunchTracer) finishAttemptLocked(peerID string, state *DCUtRPeer, ok bool, errorText string) {
	if peerID == "" {
		return
	}
	if t.active[peerID] {
		t.active[peerID] = false
		if timer := t.timers[peerID]; timer != nil {
			timer.Stop()
			delete(t.timers, peerID)
		}
	} else if state == nil || state.Status != "attempting" {
		return
	}
	if state == nil {
		return
	}
	if ok {
		t.success++
		state.Successes++
		state.Status = "direct"
		state.Error = ""
		return
	}
	t.failure++
	state.Failures++
	state.Status = "failed"
	if errorText == "" {
		errorText = "hole punch failed without a reported reason"
	}
	state.Error = errorText
}

func (t *HolePunchTracer) timeoutAttempt(peerID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.active[peerID] {
		return
	}
	t.active[peerID] = false
	delete(t.timers, peerID)
	state := t.peers[peerID]
	if state == nil {
		return
	}
	t.failure++
	state.Failures++
	state.Status = "failed"
	state.Error = fmt.Sprintf("hole punch did not reach a terminal state within %s", t.watchdog)
	now := time.Now().UTC()
	state.UpdatedAt = now
	t.events = append(t.events, HolePunchEvent{
		Timestamp: now.Format(time.RFC3339Nano),
		Type:      "holepunch-timeout",
		PeerID:    peerID,
		Success:   boolPtr(false),
		Error:     state.Error,
	})
	if len(t.events) > 200 {
		t.events = append([]HolePunchEvent(nil), t.events[len(t.events)-200:]...)
	}
}

// Snapshot returns a copy for status/evidence.
func (t *HolePunchTracer) Snapshot() DCUtRStatus {
	if t == nil {
		return DCUtRStatus{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	events := append([]HolePunchEvent(nil), t.events...)
	peers := make([]DCUtRPeer, 0, len(t.peers))
	for _, state := range t.peers {
		copied := *state
		copied.CandidateAddresses = append([]string(nil), state.CandidateAddresses...)
		peers = append(peers, copied)
	}
	return DCUtRStatus{
		Enabled:   true,
		Attempts:  t.attempts,
		Successes: t.success,
		Failures:  t.failure,
		Peers:     peers,
		Events:    events,
	}
}

func boolPtr(value bool) *bool { return &value }

func durationMillis(value time.Duration) float64 {
	return float64(value.Microseconds()) / 1000.0
}
