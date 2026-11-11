package network

import (
	"context"
	"errors"
	"testing"

	ds "github.com/ipfs/go-datastore"
	dssync "github.com/ipfs/go-datastore/sync"
)

func TestBoundedDatastoreFullAndUpdates(t *testing.T) {
	ctx := context.Background()
	store := newBoundedDatastore(dssync.MutexWrap(ds.NewMapDatastore()), 2)
	if err := store.Put(ctx, ds.NewKey("/a"), []byte("1")); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, ds.NewKey("/b"), []byte("2")); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, ds.NewKey("/c"), []byte("3")); !errors.Is(err, errRecordStoreFull) {
		t.Fatalf("full put err = %v", err)
	}
	if err := store.Put(ctx, ds.NewKey("/a"), []byte("updated")); err != nil {
		t.Fatalf("update existing: %v", err)
	}
	if err := store.Delete(ctx, ds.NewKey("/b")); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, ds.NewKey("/c"), []byte("3")); err != nil {
		t.Fatalf("put after delete: %v", err)
	}
}

func TestBoundedDatastoreBatchRejectsWhenFull(t *testing.T) {
	ctx := context.Background()
	store := newBoundedDatastore(dssync.MutexWrap(ds.NewMapDatastore()), 1)
	if err := store.Put(ctx, ds.NewKey("/a"), []byte("1")); err != nil {
		t.Fatal(err)
	}
	batch, err := store.Batch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := batch.Put(ctx, ds.NewKey("/b"), []byte("2")); !errors.Is(err, errRecordStoreFull) {
		t.Fatalf("batch full err = %v", err)
	}
}
