package node

import (
	"context"
	"errors"
	"testing"

	"github.com/Raminga/raminga/internal/identity"
	"github.com/Raminga/raminga/internal/storage"
)

func TestFriendNameDescriptionAndUnknown(t *testing.T) {
	dir := t.TempDir()
	id, err := identity.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = id.Close() }()
	st, err := storage.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	n := &Node{store: st}
	ctx := context.Background()
	pid := id.PeerID().String()
	if _, err := n.SetFriendName(ctx, pid, "b-quic"); !errors.Is(err, storage.ErrFriendNotFound) {
		t.Fatalf("unknown friend name err = %v", err)
	}
	if _, err := n.SetFriendDescription(ctx, pid, "x"); !errors.Is(err, storage.ErrFriendNotFound) {
		t.Fatalf("unknown friend description err = %v", err)
	}
	if _, _, err := st.UpsertFriend(ctx, pid, nil, false, true); err != nil {
		t.Fatal(err)
	}
	if _, err := n.SetFriendName(ctx, pid, "b-quic"); err != nil {
		t.Fatal(err)
	}
	if _, err := n.SetFriendName(ctx, pid, "Bad Name"); err == nil {
		t.Fatal("invalid name accepted")
	}
	if _, err := n.SetFriendDescription(ctx, pid, "hello"); err != nil {
		t.Fatal(err)
	}
	friends, err := n.Friends(ctx)
	if err != nil || len(friends) != 1 || friends[0].Name != "b-quic" || friends[0].Description != "hello" {
		t.Fatalf("friends=%+v err=%v", friends, err)
	}
	other, err := identity.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	if _, _, err := st.UpsertFriend(ctx, other.PeerID().String(), nil, false, true); err != nil {
		t.Fatal(err)
	}
	if _, err := n.SetFriendName(ctx, other.PeerID().String(), "b-quic"); err == nil {
		t.Fatal("duplicate name accepted")
	}
}
