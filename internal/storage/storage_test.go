package storage

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func open(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, dir
}

func TestWALAndMessageLifecycle(t *testing.T) {
	store, _ := open(t)
	var mode string
	if err := store.DB().QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatalf("journal_mode: %v", err)
	}
	if mode != "wal" {
		t.Fatalf("journal_mode = %q, want wal", mode)
	}

	ctx := context.Background()
	now := time.Now().Truncate(time.Millisecond)
	if err := store.SaveOutbound(ctx, "m1", "peer-b", "hello", now); err != nil {
		t.Fatal(err)
	}
	msgs, err := store.RecentMessages(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Acked || msgs[0].Direction != "out" {
		t.Fatalf("messages = %+v", msgs)
	}
	if err := store.MarkAcked(ctx, "m1", now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	msgs, err = store.RecentMessages(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !msgs[0].Acked || msgs[0].AckedAtMS == 0 {
		t.Fatalf("message not acked: %+v", msgs[0])
	}

	inserted, err := store.SaveInbound(ctx, "m2", "peer-a", "hi", now)
	if err != nil || !inserted {
		t.Fatalf("SaveInbound = %t, %v", inserted, err)
	}
	inserted, err = store.SaveInbound(ctx, "m2", "peer-a", "hi", now)
	if err != nil || inserted {
		t.Fatalf("duplicate SaveInbound = %t, %v", inserted, err)
	}
}

func TestPersistsAcrossReopen(t *testing.T) {
	store, dir := open(t)
	ctx := context.Background()
	if err := store.SaveOutbound(ctx, "m1", "peer-b", "hello", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store2, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store2.Close() }()
	msgs, err := store2.RecentMessages(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Acked {
		t.Fatalf("messages after reopen = %+v", msgs)
	}
}

func TestConcurrentWrites(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	errCh := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := "m" + time.Now().Format("150405.000000000") + string(rune('a'+i%20))
			if err := store.SaveOutbound(ctx, id, "peer", "text", time.Now()); err != nil {
				errCh <- err
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatalf("concurrent write: %v", err)
	}
	msgs, err := store.RecentMessages(ctx, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 20 {
		t.Fatalf("got %d messages, want 20", len(msgs))
	}
}

func TestKnownPeers(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	if err := store.UpsertKnownPeer(ctx, "peer-a", []string{"/ip4/127.0.0.1/tcp/1"}, "manual"); err != nil {
		t.Fatal(err)
	}
	peers, err := store.ListKnownPeers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].PeerID != "peer-a" || len(peers[0].Addrs) != 1 {
		t.Fatalf("peers = %+v", peers)
	}
}

func TestPeerCacheMergeExpiryAndBound(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	if err := store.UpsertPeerCache(ctx, "peer-a", []string{"/ip4/127.0.0.1/tcp/1"}, PeerSourceKnown, time.Hour, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertPeerCache(ctx, "peer-a", []string{"/ip4/127.0.0.1/tcp/2"}, PeerSourceKnown, time.Hour, 2); err != nil {
		t.Fatal(err)
	}
	peers, err := store.ListKnownPeers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || len(peers[0].Addrs) != 2 {
		t.Fatalf("cache did not merge valid addrs: %+v", peers)
	}
	if err := store.UpsertPeerCache(ctx, "peer-a", []string{"/ip4/127.0.0.1/tcp/3"}, PeerSourceBootstrap, time.Hour, 2); err != nil {
		t.Fatal(err)
	}
	peers, _ = store.ListKnownPeers(ctx)
	if peers[0].Source != PeerSourceBootstrap {
		t.Fatalf("source = %q, want bootstrap priority", peers[0].Source)
	}
	if err := store.UpsertPeerCache(ctx, "peer-b", []string{"/ip4/127.0.0.1/tcp/4"}, PeerSourceKnown, time.Millisecond, 2); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if err := store.UpsertPeerCache(ctx, "peer-c", []string{"/ip4/127.0.0.1/tcp/5"}, PeerSourceManual, time.Hour, 2); err != nil {
		t.Fatal(err)
	}
	peers, _ = store.ListKnownPeers(ctx)
	if len(peers) != 2 {
		t.Fatalf("bounded cache has %d rows, want 2: %+v", len(peers), peers)
	}
	for _, p := range peers {
		if p.PeerID == "peer-b" {
			t.Fatalf("expired row survived prune: %+v", peers)
		}
	}
}

func TestMessageCapPrunesOldestAndBoundsGrowth(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()
	s.SetMaxMessages(10)
	base := time.Now().Add(-time.Hour)
	for i := 0; i < 40; i++ {
		id := fmt.Sprintf("cap-%03d", i)
		if _, err := s.SaveInbound(ctx, id, "peer", "text", base.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatalf("SaveInbound %d: %v", i, err)
		}
		if n, err := s.CountMessages(ctx); err != nil || n > 10 {
			t.Fatalf("after insert %d: count=%d err=%v", i, n, err)
		}
	}
	msgs, err := s.RecentMessages(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 10 || msgs[0].MessageID != "cap-039" || msgs[9].MessageID != "cap-030" {
		t.Fatalf("pruned set = %+v", msgs)
	}
}

func TestOutboxBoundsCancelExpiryAndDelivery(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()
	now := time.Now()
	if err := s.SaveOutboundWithOutbox(ctx, "o1", "peer", "one", "/ip4/127.0.0.1/tcp/4001", now, now.Add(time.Hour), 1, 1024); err != nil {
		t.Fatalf("enqueue o1: %v", err)
	}
	if err := s.SaveOutboundWithOutbox(ctx, "o2", "peer", "two", "/ip4/127.0.0.1/tcp/4001", now, now.Add(time.Hour), 1, 1024); !errors.Is(err, ErrOutboxFull) {
		t.Fatalf("second enqueue error = %v, want ErrOutboxFull", err)
	}
	if _, err := s.CancelOutbox(ctx, "o1"); err != nil {
		t.Fatalf("CancelOutbox: %v", err)
	}
	if err := s.SaveOutboundWithOutbox(ctx, "o2", "peer", "two", "/ip4/127.0.0.1/tcp/4001", now, now.Add(time.Hour), 1, 1024); err != nil {
		t.Fatalf("enqueue after cancel: %v", err)
	}
	if err := s.MarkOutboxDelivered(ctx, "o2", now.Add(time.Second)); err != nil {
		t.Fatalf("MarkOutboxDelivered: %v", err)
	}
	if err := s.MarkOutboxDelivered(ctx, "o2", now.Add(time.Second)); err != nil {
		t.Fatalf("idempotent MarkOutboxDelivered: %v", err)
	}
	entries, err := s.ListOutbox(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].MessageID != "o2" || entries[0].Status != "acked" || entries[1].Status != "cancelled" {
		t.Fatalf("entries = %+v", entries)
	}
	msgs, err := s.RecentMessages(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range msgs {
		if m.MessageID == "o2" && !m.Acked {
			t.Fatal("delivered outbox history row is not acked")
		}
	}
}

func TestOutboxExpiryIsFailedNeverAcked(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()
	past := time.Now().Add(-time.Second)
	if err := s.SaveOutboundWithOutbox(ctx, "exp1", "peer", "expires", "", past, past, 10, 1024); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	n, err := s.ExpireOutbox(ctx, time.Now())
	if err != nil || n != 1 {
		t.Fatalf("ExpireOutbox = %d, %v", n, err)
	}
	entries, err := s.ListOutbox(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Status != "failed" || !strings.Contains(entries[0].LastError, "expired") {
		t.Fatalf("expired entry = %+v", entries)
	}
	msgs, err := s.RecentMessages(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Acked {
		t.Fatalf("expired message must stay unacked: %+v", msgs)
	}
}

func TestDuplicateInboundStoresOneRow(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()
	first, err := s.SaveInbound(ctx, "dedup-1", "peer", "once", time.Now())
	if err != nil || !first {
		t.Fatalf("first SaveInbound = %t, %v", first, err)
	}
	second, err := s.SaveInbound(ctx, "dedup-1", "peer", "once", time.Now())
	if err != nil || second {
		t.Fatalf("second SaveInbound = %t, %v", second, err)
	}
	if n, err := s.CountMessages(ctx); err != nil || n != 1 {
		t.Fatalf("CountMessages = %d, %v", n, err)
	}
}

func TestFriendsUpsertNameDescriptionRemove(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	f, created, err := s.UpsertFriend(ctx, "peer-b", []string{"/ip4/127.0.0.1/tcp/1", "/ip4/10.0.0.2/tcp/2", "/ip6/fe80::1/tcp/3", "/ip4/10.0.0.2/tcp/2"}, false, true)
	if err != nil || !created {
		t.Fatalf("upsert: %+v created=%v err=%v", f, created, err)
	}
	if len(f.Addrs) != 1 || f.Addrs[0] != "/ip4/10.0.0.2/tcp/2" {
		t.Fatalf("filtered addrs = %v", f.Addrs)
	}
	if _, err := s.SetFriendName(ctx, "peer-b", "b-quic"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetFriendName(ctx, "peer-b", "other"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetFriendDescription(ctx, "peer-b", "hello"); err != nil {
		t.Fatal(err)
	}
	byName, found, err := s.GetFriendByName(ctx, "other")
	if err != nil || !found || byName.PeerID != "peer-b" || byName.Description != "hello" {
		t.Fatalf("by name: %+v found=%v err=%v", byName, found, err)
	}
	if err := s.PausePeer(ctx, "peer-b"); err != nil {
		t.Fatal(err)
	}
	removed, pending, err := s.RemoveFriend(ctx, "peer-b", false)
	if err != nil || !removed || pending != 0 {
		t.Fatalf("remove: removed=%v pending=%d err=%v", removed, pending, err)
	}
	if _, found, _ := s.GetFriend(ctx, "peer-b"); found {
		t.Fatal("friend still present")
	}
	if !s.IsPaused(ctx, "peer-b") {
		t.Fatal("removing friend cleared pause")
	}
}

func TestFriendsNameRulesAndUnknown(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if _, err := s.SetFriendName(ctx, "missing", "x"); !errors.Is(err, ErrFriendNotFound) {
		t.Fatalf("unknown name err = %v", err)
	}
	if _, err := s.SetFriendDescription(ctx, "missing", "x"); !errors.Is(err, ErrFriendNotFound) {
		t.Fatalf("unknown description err = %v", err)
	}
	_, _, _ = s.UpsertFriend(ctx, "p1", nil, false, true)
	_, _, _ = s.UpsertFriend(ctx, "p2", nil, false, true)
	if _, err := s.SetFriendName(ctx, "p1", "same"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetFriendName(ctx, "p2", "same"); !errors.Is(err, ErrFriendNameTaken) {
		t.Fatalf("duplicate name err = %v", err)
	}
	if _, err := s.SetFriendName(ctx, "p1", "Bad Name"); err == nil {
		t.Fatal("invalid name accepted")
	}
	// Cleared fields are valid and independent; only non-empty names must stay
	// unique and valid.
	if _, err := s.SetFriendName(ctx, "p1", ""); err != nil {
		t.Fatalf("clear name: %v", err)
	}
	if _, err := s.SetFriendDescription(ctx, "p1", "kept note"); err != nil {
		t.Fatalf("set note after clearing name: %v", err)
	}
	cleared, found, err := s.GetFriend(ctx, "p1")
	if err != nil || !found || cleared.Name != "" || cleared.Description != "kept note" {
		t.Fatalf("cleared friend: %+v found=%v err=%v", cleared, found, err)
	}
	if _, err := s.SetFriendDescription(ctx, "p1", ""); err != nil {
		t.Fatalf("clear description: %v", err)
	}
	if _, err := s.SetFriendName(ctx, "p2", "same"); err != nil {
		t.Fatalf("empty name on p1 must not block a later unique name: %v", err)
	}
	if _, err := s.SetFriendDescription(ctx, "p1", strings.Repeat("界", 281)); err == nil {
		t.Fatal("long description accepted")
	}
	if _, err := s.SetFriendDescription(ctx, "p1", "bad\x00"); err == nil {
		t.Fatal("control description accepted")
	}
}

func TestFriendsThrottleCapProtectedAndPendingRemove(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	now := time.Unix(1000, 0)
	s.now = func() time.Time { return now }
	f, _, err := s.UpsertFriend(ctx, "p1", nil, false, true)
	if err != nil {
		t.Fatal(err)
	}
	firstLast := f.LastInteractionMS
	now = now.Add(5 * time.Minute)
	f, _, _ = s.UpsertFriend(ctx, "p1", nil, false, true)
	if f.LastInteractionMS != firstLast {
		t.Fatalf("5m touch rewrote last: %d -> %d", firstLast, f.LastInteractionMS)
	}
	now = now.Add(6 * time.Minute)
	f, _, _ = s.UpsertFriend(ctx, "p1", nil, false, true)
	if f.LastInteractionMS <= firstLast {
		t.Fatalf("10m touch did not rewrite last: %d -> %d", firstLast, f.LastInteractionMS)
	}
	now = now.Add(time.Minute)
	f, _, _ = s.UpsertFriend(ctx, "p1", []string{"/ip4/10.0.0.2/tcp/4001"}, false, false)
	if len(f.Addrs) != 1 {
		t.Fatalf("address change not written: %+v", f)
	}
	// p1 was manual, so it survives a small cap; non-manual p2 is oldest.
	_, _, _ = s.UpsertFriend(ctx, "p1", nil, true, true)
	_, _, _ = s.UpsertFriend(ctx, "p2", nil, false, true)
	s.SetMaxFriends(2)
	now = now.Add(time.Minute)
	_, _, _ = s.UpsertFriend(ctx, "p3", nil, false, true)
	if _, found, _ := s.GetFriend(ctx, "p1"); !found {
		t.Fatal("manual friend was pruned")
	}
	if _, found, _ := s.GetFriend(ctx, "p2"); found {
		t.Fatal("oldest non-manual friend was not pruned")
	}
	if err := s.SaveOutboundWithOutbox(ctx, "m1", "p3", "hi", "", now, now.Add(time.Hour), 10, 1<<20); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.RemoveFriend(ctx, "p3", false); !errors.Is(err, ErrFriendPendingOutbox) {
		t.Fatalf("remove without cancel = %v", err)
	}
	if _, found, _ := s.GetFriend(ctx, "p3"); !found {
		t.Fatal("friend removed despite pending refusal")
	}
	if _, _, err := s.RemoveFriend(ctx, "p3", true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.UpsertFriend(ctx, "p3", nil, false, true); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := s.GetFriend(ctx, "p3"); !found {
		t.Fatal("friend not re-added after removal")
	}
}

func TestPausePersistsAndRestartSelection(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	s, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PausePeer(ctx, "paused-only"); err != nil {
		t.Fatal(err)
	}
	if !s.IsPaused(ctx, "paused-only") {
		t.Fatal("pause not visible")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if !s.IsPaused(ctx, "paused-only") {
		t.Fatal("pause did not survive reopen")
	}
	for i, id := range []string{"p1", "p2", "p3", "p4"} {
		if _, _, err := s.UpsertFriend(ctx, id, nil, true, true); err != nil {
			t.Fatal(err)
		}
		if err := s.SetFriendCapabilities(ctx, id, true, false); err != nil {
			t.Fatal(err)
		}
		_ = i
	}
	if _, _, err := s.UpsertFriend(ctx, "nonmanual", nil, false, true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetFriendCapabilities(ctx, "nonmanual", true, false); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.UpsertFriend(ctx, "nocap", nil, true, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PausePeer(ctx, "p4"); err != nil {
		t.Fatal(err)
	}
	rows, err := s.FriendsForRestart(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("restart rows = %+v, want 3", rows)
	}
	for _, row := range rows {
		if row.PeerID == "p4" || row.PeerID == "nonmanual" || row.PeerID == "nocap" {
			t.Fatalf("bad restart row %+v", row)
		}
	}
}
