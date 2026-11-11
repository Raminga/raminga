package network

import (
	"sync"

	"github.com/libp2p/go-libp2p/core/connmgr"
	"github.com/libp2p/go-libp2p/core/control"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

// pausedSet is the network's in-memory pause source of truth. SQLite is only
// the persisted copy; this set is never backed by a database query on a hot
// path.
type pausedSet struct {
	mu  sync.RWMutex
	ids map[peer.ID]struct{}
}

func newPausedSet(ids []string) *pausedSet {
	s := &pausedSet{ids: make(map[peer.ID]struct{}, len(ids))}
	for _, raw := range ids {
		if pid, err := peer.Decode(raw); err == nil {
			s.ids[pid] = struct{}{}
		}
	}
	return s
}

func (s *pausedSet) IsPaused(pid peer.ID) bool {
	if s == nil || pid == "" {
		return false
	}
	s.mu.RLock()
	_, ok := s.ids[pid]
	s.mu.RUnlock()
	return ok
}

func (s *pausedSet) Set(pid peer.ID, paused bool) {
	if s == nil || pid == "" {
		return
	}
	s.mu.Lock()
	if paused {
		s.ids[pid] = struct{}{}
	} else {
		delete(s.ids, pid)
	}
	s.mu.Unlock()
}

// pauseGater only blocks outbound peer dials to paused peers. Inbound
// connections and all other checks are allowed: disconnect is not a block.
type pauseGater struct {
	paused *pausedSet
}

var _ connmgr.ConnectionGater = (*pauseGater)(nil)

func (g *pauseGater) InterceptPeerDial(p peer.ID) bool {
	return !g.paused.IsPaused(p)
}

func (g *pauseGater) InterceptAddrDial(peer.ID, ma.Multiaddr) bool { return true }
func (g *pauseGater) InterceptAccept(network.ConnMultiaddrs) bool  { return true }
func (g *pauseGater) InterceptSecured(network.Direction, peer.ID, network.ConnMultiaddrs) bool {
	return true
}
func (g *pauseGater) InterceptUpgraded(network.Conn) (bool, control.DisconnectReason) {
	return true, 0
}
