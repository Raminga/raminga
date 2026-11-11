package network

import (
	"context"
	"errors"
	"sync"

	ds "github.com/ipfs/go-datastore"
)

var errRecordStoreFull = errors.New("raminga-addr: record store is full")

// boundedDatastore caps the number of keys while allowing updates to existing
// keys. It is intentionally the smallest interface wrapper needed by the DHT.
type boundedDatastore struct {
	ds.Batching
	mu   sync.Mutex
	max  int
	keys map[ds.Key]struct{}
}

func newBoundedDatastore(dsBatching ds.Batching, max int) *boundedDatastore {
	if max <= 0 {
		max = 10000
	}
	return &boundedDatastore{Batching: dsBatching, max: max, keys: make(map[ds.Key]struct{})}
}

func (s *boundedDatastore) Put(ctx context.Context, key ds.Key, value []byte) error {
	s.mu.Lock()
	if _, ok := s.keys[key]; !ok && len(s.keys) >= s.max {
		s.mu.Unlock()
		return errRecordStoreFull
	}
	s.mu.Unlock()
	if err := s.Batching.Put(ctx, key, value); err != nil {
		return err
	}
	s.mu.Lock()
	s.keys[key] = struct{}{}
	s.mu.Unlock()
	return nil
}

func (s *boundedDatastore) Delete(ctx context.Context, key ds.Key) error {
	if err := s.Batching.Delete(ctx, key); err != nil {
		return err
	}
	s.mu.Lock()
	delete(s.keys, key)
	s.mu.Unlock()
	return nil
}

func (s *boundedDatastore) Batch(ctx context.Context) (ds.Batch, error) {
	batch, err := s.Batching.Batch(ctx)
	if err != nil {
		return nil, err
	}
	return &boundedBatch{parent: s, batch: batch, added: make(map[ds.Key]struct{})}, nil
}

type boundedBatch struct {
	parent *boundedDatastore
	batch  ds.Batch
	added  map[ds.Key]struct{}
}

func (b *boundedBatch) Put(ctx context.Context, key ds.Key, value []byte) error {
	b.parent.mu.Lock()
	_, exists := b.parent.keys[key]
	if !exists {
		if _, pending := b.added[key]; !pending && len(b.parent.keys)+len(b.added) >= b.parent.max {
			b.parent.mu.Unlock()
			return errRecordStoreFull
		}
	}
	b.added[key] = struct{}{}
	b.parent.mu.Unlock()
	return b.batch.Put(ctx, key, value)
}

func (b *boundedBatch) Delete(ctx context.Context, key ds.Key) error {
	delete(b.added, key)
	return b.batch.Delete(ctx, key)
}

func (b *boundedBatch) Commit(ctx context.Context) error {
	if err := b.batch.Commit(ctx); err != nil {
		return err
	}
	b.parent.mu.Lock()
	for key := range b.added {
		b.parent.keys[key] = struct{}{}
	}
	b.parent.mu.Unlock()
	return nil
}

var _ ds.Batching = (*boundedDatastore)(nil)
var _ ds.Batch = (*boundedBatch)(nil)
