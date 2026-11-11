package network

import (
	"context"
	"sort"
	"sync"

	"github.com/libp2p/go-libp2p/core/peer"
)

// RelayCandidateSource is the bounded AutoRelay peer source. It is seeded from
// explicit config relays and later from Raminga DHT-discovered relay peers.
// AutoRelay calls PeerSource when it needs candidates.
type RelayCandidateSource struct {
	mu         sync.Mutex
	max        int
	order      []peer.ID
	byID       map[peer.ID]peer.AddrInfo
	discovered map[peer.ID]string
}

// NewRelayCandidateSource creates a bounded candidate set.
func NewRelayCandidateSource(max int) *RelayCandidateSource {
	if max <= 0 {
		max = 16
	}
	return &RelayCandidateSource{
		max:        max,
		byID:       make(map[peer.ID]peer.AddrInfo),
		discovered: make(map[peer.ID]string),
	}
}

// Add inserts or refreshes one candidate. source is "config", "dht" or "connect" for
// diagnostics. Existing order is preserved; new candidates append.
func (s *RelayCandidateSource) Add(info peer.AddrInfo, source string) bool {
	if info.ID == "" || len(info.Addrs) == 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.byID[info.ID]; !exists {
		if len(s.order) >= s.max {
			return false
		}
		s.order = append(s.order, info.ID)
	}
	s.byID[info.ID] = info
	s.discovered[info.ID] = source
	return true
}

// Remove drops a candidate (used when a peer is paused).
func (s *RelayCandidateSource) Remove(pid peer.ID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.byID, pid)
	delete(s.discovered, pid)
	for i, id := range s.order {
		if id == pid {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

// Snapshot returns candidates in stable order.
func (s *RelayCandidateSource) Snapshot() []peer.AddrInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]peer.AddrInfo, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, s.byID[id])
	}
	return out
}

// Sources returns peer ID -> source for diagnostics.
func (s *RelayCandidateSource) Sources() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.discovered))
	for id, source := range s.discovered {
		out[id.String()] = source
	}
	return out
}

// PeerSource implements autorelay.PeerSource.
func (s *RelayCandidateSource) PeerSource(ctx context.Context, num int) <-chan peer.AddrInfo {
	out := make(chan peer.AddrInfo, num)
	go func() {
		defer close(out)
		candidates := s.Snapshot()
		// Prefer config relays, then DHT/connect-discovered relays.
		sort.SliceStable(candidates, func(i, j int) bool {
			return s.sourceOf(candidates[i].ID) == "config" && s.sourceOf(candidates[j].ID) != "config"
		})
		for i, candidate := range candidates {
			if i >= num {
				return
			}
			select {
			case <-ctx.Done():
				return
			case out <- candidate:
			}
		}
	}()
	return out
}

func (s *RelayCandidateSource) sourceOf(id peer.ID) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.discovered[id]
}
