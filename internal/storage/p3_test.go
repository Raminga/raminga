package storage

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func openSchema10WithHistory(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	stmts := []string{
		`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)`,
		`INSERT INTO schema_migrations (version, applied_at_ms) VALUES (10, 1)`,
		`CREATE TABLE messages (
			message_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, direction TEXT NOT NULL,
			text TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL,
			acked_at_ms INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT 'unknown',
			delivery_status TEXT NOT NULL DEFAULT 'unknown', delivery_error TEXT NOT NULL DEFAULT '',
			delivery_updated_at_ms INTEGER NOT NULL DEFAULT 0, client_request_id TEXT NOT NULL DEFAULT '')`,
		`INSERT INTO messages (message_id, peer_id, direction, text, created_at_ms, delivery_status)
			VALUES ('old-in', 'peer-a', 'in', '历史一', 100, 'received')`,
		`INSERT INTO messages (message_id, peer_id, direction, text, created_at_ms, delivery_status)
			VALUES ('old-out', 'peer-a', 'out', '历史二', 200, 'acked')`,
		`CREATE TABLE friends (
			peer_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', addrs_json TEXT NOT NULL DEFAULT '[]',
			description TEXT NOT NULL DEFAULT '', manually_connected INTEGER NOT NULL DEFAULT 0,
			first_seen_ms INTEGER NOT NULL, last_interaction_ms INTEGER NOT NULL,
			relay_capable INTEGER NOT NULL DEFAULT 0, dht_capable INTEGER NOT NULL DEFAULT 0)`,
		`INSERT INTO friends (peer_id, first_seen_ms, last_interaction_ms) VALUES ('peer-a', 1, 2)`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("prepare v10: %v", err)
		}
	}
	_ = db.Close()
	return dir
}

func TestP3MigrationV10ToV11BackfillsReadBaseline(t *testing.T) {
	dir := openSchema10WithHistory(t)
	ctx := context.Background()
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	state, err := store.GetReadState(ctx, "peer-a")
	if err != nil {
		t.Fatal(err)
	}
	if state.LastReadAtMS != 200 || state.LastReadMessageID != "" {
		t.Fatalf("backfilled state = %+v", state)
	}
	conv, hasMore, _, err := store.ListConversations(ctx, ConversationCursor{}, 10)
	if err != nil || hasMore || len(conv) != 1 {
		t.Fatalf("conversations = %+v hasMore=%v err=%v", conv, hasMore, err)
	}
	if conv[0].UnreadCount != 0 {
		t.Fatalf("migrated conversation unread = %d, want 0", conv[0].UnreadCount)
	}
	friends, err := store.ListFriends(ctx)
	if err != nil || len(friends) != 1 || friends[0].UnreadCount != 0 {
		t.Fatalf("friends = %+v err=%v", friends, err)
	}
	// New inbound counts; outbound never does.
	if _, err := store.SaveInbound(ctx, "new-in", "peer-a", "新消息", time.UnixMilli(300)); err != nil {
		t.Fatalf("store incoming: %v", err)
	}
	if err := store.SaveOutboundOrigin(ctx, "new-out", "peer-a", "回复", time.UnixMilli(400), OriginHuman, ""); err != nil {
		t.Fatalf("store outgoing: %v", err)
	}
	total, err := store.TotalUnread(ctx)
	if err != nil || total != 1 {
		t.Fatalf("total unread = %d err=%v", total, err)
	}
	result, err := store.MarkConversationRead(ctx, "peer-a", "new-in", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if result.UnreadCount != 0 || result.State.LastReadAtMS != 300 || result.State.LastReadMessageID != "new-in" {
		t.Fatalf("mark result = %+v", result)
	}
	// Backwards target never moves the cursor.
	again, err := store.MarkConversationRead(ctx, "peer-a", "old-in", 2000)
	if err != nil {
		t.Fatal(err)
	}
	if again.State.LastReadAtMS != 300 || again.State.LastReadMessageID != "new-in" {
		t.Fatalf("backwards mark = %+v", again)
	}
	if _, err := store.MarkConversationRead(ctx, "peer-a", "missing", 2000); !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("missing message err = %v", err)
	}
	// Concurrent idempotent marks end at one cursor.
	if _, err := store.SaveInbound(ctx, "new-in-2", "peer-a", "并发", time.UnixMilli(500)); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := store.MarkConversationRead(ctx, "peer-a", "new-in-2", 3000); err != nil {
				t.Errorf("concurrent mark: %v", err)
			}
		}()
	}
	wg.Wait()
	assertUnread := func() {
		t.Helper()
		total, err := store.TotalUnread(ctx)
		if err != nil || total != 0 {
			t.Fatalf("unread after concurrent marks = %d err=%v", total, err)
		}
	}
	assertUnread()
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	// Restart preserves the cursor.
	store, err = Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	state, err = store.GetReadState(ctx, "peer-a")
	if err != nil || state.LastReadAtMS != 500 || state.LastReadMessageID != "new-in-2" {
		t.Fatalf("restarted state = %+v err=%v", state, err)
	}
}

func TestP3SameMillisecondReadBatchAndOutboundDoesNotClear(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	for _, id := range []string{"m100-a", "m100-b"} {
		if _, err := store.SaveInbound(ctx, id, "peer-ms", id, time.UnixMilli(100)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.SaveInbound(ctx, "m101", "peer-ms", "later", time.UnixMilli(101)); err != nil {
		t.Fatal(err)
	}
	first, err := store.MarkConversationRead(ctx, "peer-ms", "m100-a", 10)
	if err != nil {
		t.Fatal(err)
	}
	if first.UnreadCount != 1 || first.State.LastReadAtMS != 100 {
		t.Fatalf("first = %+v", first)
	}
	second, err := store.MarkConversationRead(ctx, "peer-ms", "m100-b", 11)
	if err != nil {
		t.Fatal(err)
	}
	if second.UnreadCount != 1 || second.State.LastReadAtMS != 100 || second.State.LastReadMessageID != "m100-b" {
		t.Fatalf("same-ms update = %+v", second)
	}
	if err := store.SaveOutboundOrigin(ctx, "out", "peer-ms", "x", time.UnixMilli(200), OriginHuman, ""); err != nil {
		t.Fatal(err)
	}
	// Reading an outbound row advances through that time for what the human saw.
	third, err := store.MarkConversationRead(ctx, "peer-ms", "out", 12)
	if err != nil {
		t.Fatal(err)
	}
	if third.UnreadCount != 0 || third.State.LastReadAtMS != 200 {
		t.Fatalf("outbound mark = %+v", third)
	}
}

func TestP3FavoritesIdempotentPaginationAndExactKey(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	first, favorite, err := store.SetFavorite(ctx, "peer-a", "posts/a.json", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "第一条", 1000, true)
	if err != nil || !favorite || first.ID == "" {
		t.Fatalf("first favorite = %+v favorite=%v err=%v", first, favorite, err)
	}
	again, favorite, err := store.SetFavorite(ctx, "peer-a", "posts/a.json", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "新标题", 2000, true)
	if err != nil || !favorite || again.ID != first.ID || again.CreatedAtMS != 1000 || again.Title != "新标题" {
		t.Fatalf("idempotent favorite = %+v favorite=%v err=%v", again, favorite, err)
	}
	// A different hash is a different content version.
	if _, _, err := store.SetFavorite(ctx, "peer-a", "posts/a.json", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "新版本", 3000, true); err != nil {
		t.Fatal(err)
	}
	page, err := store.ListFavorites(ctx, "", 1)
	if err != nil || len(page.Items) != 1 || !page.HasMore || page.NextBefore == "" {
		t.Fatalf("page = %+v err=%v", page, err)
	}
	next, err := store.ListFavorites(ctx, page.NextBefore, 10)
	if err != nil || len(next.Items) != 1 || next.HasMore {
		t.Fatalf("next page = %+v err=%v", next, err)
	}
	if next.Items[0].ID == page.Items[0].ID {
		t.Fatal("favorite pagination repeated a row")
	}
	removed, favorite, err := store.SetFavorite(ctx, "peer-a", "posts/a.json", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "", 4000, false)
	if err != nil || favorite || removed.ID != "" {
		t.Fatalf("remove = %+v favorite=%v err=%v", removed, favorite, err)
	}
	// Clearing an absent key succeeds.
	if _, favorite, err := store.SetFavorite(ctx, "peer-a", "posts/a.json", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "", 5000, false); err != nil || favorite {
		t.Fatalf("absent clear favorite=%v err=%v", favorite, err)
	}
	remaining, err := store.ListFavorites(ctx, "", 10)
	if err != nil || len(remaining.Items) != 1 {
		t.Fatalf("remaining = %+v err=%v", remaining, err)
	}
	if _, err := store.ListFavorites(ctx, "not-a-cursor", 10); err == nil {
		t.Fatal("malformed favorites cursor must fail")
	}
}

func TestP3UnreadQueriesNeverWriteCursor(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	if _, err := store.SaveInbound(ctx, "m1", "peer-readonly", "hello", time.Now()); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		_, _, _, _ = store.ListConversations(ctx, ConversationCursor{}, 10)
		_, _, _ = store.ListMessages(ctx, "peer-readonly", MessageCursor{}, 10)
		_, _ = store.RecentMessages(ctx, 10)
		_, _ = store.ListFriends(ctx)
	}
	total, err := store.TotalUnread(ctx)
	if err != nil || total != 1 {
		t.Fatalf("read-only queries changed unread: total=%d err=%v", total, err)
	}
	state, err := store.GetReadState(ctx, "peer-readonly")
	if err != nil || state.LastReadAtMS != 0 {
		t.Fatalf("read-only queries wrote cursor: %+v err=%v", state, err)
	}
}

func TestP3FamiliarIncludesRealHumanOrAgentMessagesAndPeerFilter(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	for i, peerID := range []string{"peer-human", "peer-agent", "peer-inbound", "peer-unknown"} {
		if _, err := store.RecordPublicDiscovery(ctx, peerID, "posts/a.json",
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			10, int64(100+i), "raminga_content_get"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.DB().ExecContext(ctx,
		`INSERT INTO human_outbound_peers (peer_id, first_at_ms, last_at_ms) VALUES (?, ?, ?)`,
		"peer-human", 200, 200); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveOutboundOrigin(ctx, "agent-msg", "peer-agent", "hi", time.UnixMilli(201), OriginAgent, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveInbound(ctx, "in-msg", "peer-inbound", "hi", time.UnixMilli(202)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveOutboundOrigin(ctx, "unknown-msg", "peer-unknown", "hi", time.UnixMilli(203), OriginUnknown, ""); err != nil {
		t.Fatal(err)
	}

	familiar, err := store.ListPublicDiscoveries(ctx, "", 10, true, "", false)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, row := range familiar.Items {
		got[row.PeerID] = true
	}
	if !got["peer-human"] || !got["peer-agent"] {
		t.Fatalf("familiar missing real human/Agent message peer: %+v", familiar.Items)
	}
	if got["peer-inbound"] || got["peer-unknown"] {
		t.Fatalf("familiar invented a conversation: %+v", familiar.Items)
	}
	count, err := store.CountPublicDiscoveries(ctx, true)
	if err != nil || count != 2 {
		t.Fatalf("familiar count = %d err=%v", count, err)
	}
	filtered, err := store.ListPublicDiscoveries(ctx, "", 10, false, "peer-agent", false)
	if err != nil || len(filtered.Items) != 1 || filtered.Items[0].PeerID != "peer-agent" {
		t.Fatalf("peer filter = %+v err=%v", filtered.Items, err)
	}
}

func TestP3ConcurrentDifferentTargetsNeverMoveCursorBackwards(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	for _, item := range []struct {
		id string
		at int64
	}{{"older", 300}, {"newer", 500}} {
		if _, err := store.SaveInbound(ctx, item.id, "peer-race", item.id, time.UnixMilli(item.at)); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		target := "older"
		if i%2 == 0 {
			target = "newer"
		}
		go func(id string) {
			defer wg.Done()
			if _, err := store.MarkConversationRead(ctx, "peer-race", id, 1000); err != nil {
				t.Errorf("mark %s: %v", id, err)
			}
		}(target)
	}
	wg.Wait()
	state, err := store.GetReadState(ctx, "peer-race")
	if err != nil {
		t.Fatal(err)
	}
	if state.LastReadAtMS != 500 || state.LastReadMessageID != "newer" {
		t.Fatalf("cursor regressed under concurrency: %+v", state)
	}
	total, err := store.TotalUnread(ctx)
	if err != nil || total != 0 {
		t.Fatalf("unread = %d err=%v", total, err)
	}
}
