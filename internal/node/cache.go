package node

import (
	"context"
	"time"

	"github.com/Raminga/raminga/internal/network"
	"github.com/Raminga/raminga/internal/storage"
)

// NewPeerCache adapts the SQLite store to the network package's small hint
// cache interface. It is not a second runtime address source.
func NewPeerCache(store *storage.Store) network.PeerCache {
	return storePeerCache{store: store}
}

type storePeerCache struct {
	store *storage.Store
}

func (c storePeerCache) LoadPeerCache(ctx context.Context) ([]network.CachedPeer, error) {
	rows, err := c.store.ListKnownPeers(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]network.CachedPeer, 0, len(rows))
	for _, row := range rows {
		cached := network.CachedPeer{
			PeerID:    row.PeerID,
			Addrs:     row.Addrs,
			Source:    row.Source,
			UpdatedAt: time.UnixMilli(row.UpdatedAtMS),
		}
		if row.ExpiresAtMS > 0 {
			cached.ExpiresAt = time.UnixMilli(row.ExpiresAtMS)
		}
		out = append(out, cached)
	}
	return out, nil
}

func (c storePeerCache) UpsertPeerCache(ctx context.Context, peerID string, addrs []string, source string, ttl time.Duration, maxEntries int) error {
	return c.store.UpsertPeerCache(ctx, peerID, addrs, source, ttl, maxEntries)
}

func (c storePeerCache) CountPeerCache(ctx context.Context) (int, error) {
	return c.store.CountPeerCache(ctx)
}
