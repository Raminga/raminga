package storage

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// pageThroughMessages reads every currently retained page with a fixed limit.
func pageThroughMessages(t *testing.T, s *Store, peerID string, limit int) []Message {
	t.Helper()
	var all []Message
	cursor := MessageCursor{}
	for page := 0; page < 100; page++ {
		msgs, more, err := s.ListMessages(context.Background(), peerID, cursor, limit)
		if err != nil {
			t.Fatalf("ListMessages page %d: %v", page, err)
		}
		all = append(all, msgs...)
		if !more {
			return all
		}
		if len(msgs) == 0 {
			t.Fatalf("has_more with empty page at %d", page)
		}
		oldest := msgs[len(msgs)-1]
		cursor = MessageCursor{CreatedAtMS: oldest.CreatedAtMS, MessageID: oldest.MessageID}
	}
	t.Fatal("pagination did not terminate")
	return nil
}

func TestStage5PerPeerPaginationStableWithEqualTimesInsertAndMoreThan500(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	s.SetMaxMessages(5000)

	base := time.UnixMilli(1_700_000_000_000)
	// 620 retained rows for peer-a, deliberately using only 40 distinct
	// timestamps so the message_id tie-breaker is exercised across page edges.
	const total = 620
	for i := 0; i < total; i++ {
		id := fmt.Sprintf("a-%04d", i)
		stamp := base.Add(time.Duration(i/16) * time.Second)
		if _, err := s.SaveInbound(ctx, id, "peer-a", "body-"+id, stamp); err != nil {
			t.Fatalf("insert %s: %v", id, err)
		}
		if i%3 == 0 {
			if _, err := s.SaveInbound(ctx, fmt.Sprintf("b-%04d", i), "peer-b", "other", stamp); err != nil {
				t.Fatal(err)
			}
		}
	}

	cursor := MessageCursor{}
	seen := make(map[string]int)
	pages := 0
	for {
		msgs, more, err := s.ListMessages(ctx, "peer-a", cursor, 73)
		if err != nil {
			t.Fatalf("page %d: %v", pages, err)
		}
		pages++
		for _, m := range msgs {
			if m.PeerID != "peer-a" {
				t.Fatalf("page leaked peer %q", m.PeerID)
			}
			seen[m.MessageID]++
		}
		if pages == 1 {
			// Insert new messages while paging: one newer, one with exactly the
			// oldest page timestamp, and one older than the cursor. Existing
			// rows must never be skipped or duplicated by these inserts.
			oldest := msgs[len(msgs)-1]
			if _, err := s.SaveInbound(ctx, "inserted-new", "peer-a", "new", base.Add(100*time.Second)); err != nil {
				t.Fatal(err)
			}
			if _, err := s.SaveInbound(ctx, "inserted-same", "peer-a", "same", time.UnixMilli(oldest.CreatedAtMS)); err != nil {
				t.Fatal(err)
			}
			if _, err := s.SaveInbound(ctx, "inserted-old", "peer-a", "old", base.Add(-time.Second)); err != nil {
				t.Fatal(err)
			}
		}
		if !more {
			break
		}
		oldest := msgs[len(msgs)-1]
		cursor = MessageCursor{CreatedAtMS: oldest.CreatedAtMS, MessageID: oldest.MessageID}
		if pages > 50 {
			t.Fatal("pagination did not terminate")
		}
	}
	for i := 0; i < total; i++ {
		id := fmt.Sprintf("a-%04d", i)
		if seen[id] != 1 {
			t.Fatalf("original %s seen %d times", id, seen[id])
		}
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("%s seen %d times", id, count)
		}
	}
	for id := range seen {
		if id != "inserted-new" && id != "inserted-same" && id != "inserted-old" && len(id) > 0 && id[0] != 'a' {
			t.Fatalf("unexpected row %q in paged result", id)
		}
	}
}

func TestStage5PaginationDoesNotResurrectPrunedRowsAndReportsRetention(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	s.SetMaxMessages(30)
	base := time.Now().Add(-time.Hour)
	for i := 0; i < 100; i++ {
		if _, err := s.SaveInbound(ctx, fmt.Sprintf("m-%03d", i), "peer", fmt.Sprintf("text-%d", i), base.Add(time.Duration(i)*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
	}
	ret, err := s.MessageRetention(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if ret.RetainedMessages != 30 || ret.MaxMessages != 30 || ret.OldestAtMS == 0 {
		t.Fatalf("retention = %+v", ret)
	}
	msgs := pageThroughMessages(t, s, "peer", 7)
	if len(msgs) != 30 {
		t.Fatalf("paged %d retained rows, want 30", len(msgs))
	}
	if msgs[0].MessageID != "m-099" || msgs[len(msgs)-1].MessageID != "m-070" {
		t.Fatalf("retained set = first %s last %s", msgs[0].MessageID, msgs[len(msgs)-1].MessageID)
	}
}

func TestStage5ConversationSummariesAndCursor(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	base := time.UnixMilli(1_700_000_000_000)
	peers := []string{"peer-a", "peer-b", "peer-c", "peer-d"}
	for i := 0; i < 20; i++ {
		peer := peers[i%len(peers)]
		// Two messages share the same timestamp within each peer.
		stamp := base.Add(time.Duration(i/2) * time.Second)
		if _, err := s.SaveInbound(ctx, fmt.Sprintf("%s-%02d", peer, i), peer, fmt.Sprintf("%s message %d", peer, i), stamp); err != nil {
			t.Fatal(err)
		}
	}
	cursor := ConversationCursor{}
	seen := map[string]int{}
	pages := 0
	for {
		rows, more, snapshot, err := s.ListConversations(ctx, cursor, 1)
		if err != nil {
			t.Fatalf("ListConversations: %v", err)
		}
		pages++
		for _, row := range rows {
			seen[row.PeerID]++
			if row.MessageCount != 5 {
				t.Fatalf("%s message_count = %d, want 5", row.PeerID, row.MessageCount)
			}
			if row.LastMessageID == "" || row.Preview == "" || row.DeliveryStatus != DeliveryReceived {
				t.Fatalf("incomplete summary: %+v", row)
			}
		}
		if pages == 1 {
			// New inserts after the first page must not change the snapshot's
			// ordering or appear twice across pages.
			if _, err := s.SaveInbound(ctx, "late-summary-peer", "peer-late", "late", base.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			if _, err := s.SaveInbound(ctx, "late-summary-a", "peer-a", "late in existing peer", base.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
		if !more {
			break
		}
		last := rows[len(rows)-1]
		cursor = ConversationCursor{LastAtMS: last.LastAtMS, PeerID: last.PeerID, SnapshotRowID: snapshot}
		if pages > 10 {
			t.Fatal("conversation pagination did not terminate")
		}
	}
	if len(seen) != len(peers) {
		t.Fatalf("seen peers = %v", seen)
	}
	for peer, count := range seen {
		if count != 1 {
			t.Fatalf("%s appeared %d times", peer, count)
		}
	}
}

func TestStage5ProvenanceAndHumanRelationNotPruned(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	s.SetMaxMessages(8)
	now := time.Now()
	expires := now.Add(time.Hour)

	if err := s.SaveOutboundWithOutboxOrigin(ctx, "human-1", "peer-human", "hello", "", now, expires, 100, 4096, OriginHuman, "req-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveOutboundWithOutboxOrigin(ctx, "agent-1", "peer-agent", "hello", "", now, expires, 100, 4096, OriginAgent, "req-2"); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveOutboundWithOutboxOrigin(ctx, "unknown-1", "peer-unknown", "hello", "", now, expires, 100, 4096, OriginUnknown, "req-3"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveInbound(ctx, "in-1", "peer-inbound", "hi", now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveInbound(ctx, "contact-only", "peer-contact", "no", now); err != nil {
		t.Fatal(err)
	}

	msg, found, err := s.GetMessage(ctx, "human-1")
	if err != nil || !found {
		t.Fatalf("human message = %+v found=%t err=%v", msg, found, err)
	}
	if msg.Origin != OriginHuman || msg.DeliveryStatus != DeliveryPending || msg.ClientRequestID != "req-1" {
		t.Fatalf("human message provenance = %+v", msg)
	}
	agent, _, _ := s.GetMessage(ctx, "agent-1")
	if agent.Origin != OriginAgent {
		t.Fatalf("agent origin = %q", agent.Origin)
	}
	inbound, _, _ := s.GetMessage(ctx, "in-1")
	if inbound.Origin != OriginUnknown || inbound.DeliveryStatus != DeliveryReceived {
		t.Fatalf("inbound provenance = %+v", inbound)
	}

	peers, more, err := s.ListHumanOutboundPeers(ctx, ConversationCursor{}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if more || len(peers) != 1 || peers[0].PeerID != "peer-human" {
		t.Fatalf("human outbound peers = %+v more=%t", peers, more)
	}

	// Same-timestamp human retry (idempotent request) must not create duplicates
	// and must still keep one relation row.
	if _, found, err := s.GetMessageByRequest(ctx, "peer-human", "req-1"); err != nil || !found {
		t.Fatalf("request lookup found=%t err=%v", found, err)
	}

	// Push the original message rows out of the bounded window. The relation is
	// deliberately independent.
	for i := 0; i < 20; i++ {
		if _, err := s.SaveInbound(ctx, fmt.Sprintf("fill-%02d", i), "peer-fill", "fill", now.Add(time.Duration(i)*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.GetMessage(ctx, "human-1"); err != nil {
		t.Fatal(err)
	}
	peers, _, err = s.ListHumanOutboundPeers(ctx, ConversationCursor{}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].PeerID != "peer-human" {
		t.Fatalf("relation lost after message pruning: %+v", peers)
	}
}

func TestStage5DeliveryTerminalStatesPersistAfterOutboxCleanup(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	s.SetMaxMessages(100)
	now := time.Now()
	expires := now.Add(time.Hour)
	enqueue := func(id string) {
		t.Helper()
		if err := s.SaveOutboundWithOutboxOrigin(ctx, id, "peer", "body", "", now, expires, 100, 1<<20, OriginHuman, "req-"+id); err != nil {
			t.Fatal(err)
		}
	}
	enqueue("acked")
	if err := s.MarkOutboxDelivered(ctx, "acked", now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	enqueue("cancelled")
	if _, err := s.CancelOutbox(ctx, "cancelled"); err != nil {
		t.Fatal(err)
	}
	enqueue("failed")
	if err := s.FailOutbox(ctx, "failed", "policy"); err != nil {
		t.Fatal(err)
	}
	enqueue("expired")
	if n, err := s.ExpireOutbox(ctx, now.Add(2*time.Hour)); err != nil || n != 1 {
		t.Fatalf("ExpireOutbox = %d, %v", n, err)
	}

	want := map[string]string{
		"acked":     DeliveryAcked,
		"cancelled": DeliveryCancelled,
		"failed":    DeliveryFailed,
		"expired":   DeliveryFailed,
	}
	for id, status := range want {
		m, found, err := s.GetMessage(ctx, id)
		if err != nil || !found {
			t.Fatalf("%s found=%t err=%v", id, found, err)
		}
		if m.DeliveryStatus != status {
			t.Fatalf("%s delivery_status = %q, want %q", id, m.DeliveryStatus, status)
		}
	}

	// Enqueueing more terminal outbox rows invokes terminal pruning; the
	// message delivery state must survive it.
	for i := 0; i < 5; i++ {
		enqueue(fmt.Sprintf("more-%d", i))
	}
	for i := 0; i < 5; i++ {
		if err := s.FailOutbox(ctx, fmt.Sprintf("more-%d", i), "x"); err != nil {
			t.Fatal(err)
		}
	}
	enqueue("trigger-prune")
	if err := s.FailOutbox(ctx, "trigger-prune", "x"); err != nil {
		t.Fatal(err)
	}
	m, found, err := s.GetMessage(ctx, "acked")
	if err != nil || !found || m.DeliveryStatus != DeliveryAcked {
		t.Fatalf("acked history after outbox cleanup = %+v found=%t err=%v", m, found, err)
	}
}

func TestStage5MigrationBackfillsOldProvenanceAndDelivery(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
		CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL);
		INSERT INTO schema_migrations VALUES (6, 1);
		CREATE TABLE messages (
			message_id TEXT PRIMARY KEY,
			peer_id TEXT NOT NULL,
			direction TEXT NOT NULL CHECK (direction IN ('in','out')),
			text TEXT NOT NULL,
			acked INTEGER NOT NULL DEFAULT 0 CHECK (acked IN (0,1)),
			created_at_ms INTEGER NOT NULL,
			acked_at_ms INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE outbox (
			message_id TEXT PRIMARY KEY,
			peer_id TEXT NOT NULL,
			text TEXT NOT NULL,
			bytes INTEGER NOT NULL,
			multiaddr TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			created_at_ms INTEGER NOT NULL,
			expires_at_ms INTEGER NOT NULL,
			next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
			last_error TEXT NOT NULL DEFAULT '',
			updated_at_ms INTEGER NOT NULL
		);
		INSERT INTO messages VALUES ('in-old','peer','in','hello',1,1000,0);
		INSERT INTO messages VALUES ('out-acked-old','peer','out','ok',1,1001,1500);
		INSERT INTO messages VALUES ('out-pending-old','peer','out','queued',0,1002,0);
		INSERT INTO messages VALUES ('out-failed-old','peer','out','bad',0,1003,0);
		INSERT INTO messages VALUES ('out-unknown-old','peer','out','legacy',0,1004,0);
		INSERT INTO outbox VALUES ('out-pending-old','peer','queued',6,'', 'pending',1,1002,999999,0,'dial failed',2000);
		INSERT INTO outbox VALUES ('out-failed-old','peer','bad',3,'', 'failed',2,1003,999999,0,'rejected',2100);
	`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := Open(ctx, dir)
	if err != nil {
		t.Fatalf("Open migrated db: %v", err)
	}
	defer func() { _ = s.Close() }()
	cases := []struct {
		id          string
		origin      string
		delivery    string
		deliveryErr string
	}{
		{"in-old", OriginUnknown, DeliveryReceived, ""},
		{"out-acked-old", OriginUnknown, DeliveryAcked, ""},
		{"out-pending-old", OriginUnknown, DeliveryPending, "dial failed"},
		{"out-failed-old", OriginUnknown, DeliveryFailed, "rejected"},
		// acked=0 and no surviving outbox row must not be claimed as pending.
		{"out-unknown-old", OriginUnknown, DeliveryUnknown, ""},
	}
	for _, tc := range cases {
		m, found, err := s.GetMessage(ctx, tc.id)
		if err != nil || !found {
			t.Fatalf("%s found=%t err=%v", tc.id, found, err)
		}
		if m.Origin != tc.origin || m.DeliveryStatus != tc.delivery {
			t.Fatalf("%s = origin %q delivery %q, want %q/%q", tc.id, m.Origin, m.DeliveryStatus, tc.origin, tc.delivery)
		}
		if tc.deliveryErr != "" && m.DeliveryError != tc.deliveryErr {
			t.Fatalf("%s delivery_error = %q, want %q", tc.id, m.DeliveryError, tc.deliveryErr)
		}
	}
	var version int
	if err := s.DB().QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("schema version = %d, %v", version, err)
	}
	peers, _, err := s.ListHumanOutboundPeers(ctx, ConversationCursor{}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 0 {
		t.Fatalf("old outbound rows must not become human relations: %+v", peers)
	}
	if _, err := s.DB().ExecContext(ctx, `SELECT origin, delivery_status FROM messages LIMIT 1`); err != nil {
		t.Fatalf("migrated columns unreadable: %v", err)
	}
	// Reopening must not rewrite terminal state or fail on the now-existing
	// request index.
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, dir)
	if err != nil {
		t.Fatalf("reopen migrated db: %v", err)
	}
}

func TestStage5RequestKeyScopeEndsWhenMessageIsTrimmed(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	// The idempotency lookup is a normal messages query, so the key is only
	// recognized while its row remains inside the retained history window.
	s.SetMaxMessages(2)
	now := time.Now()
	if err := s.SaveOutboundWithOutboxOrigin(ctx, "trimmed-key", "peer-a", "hello", "", now, now.Add(time.Hour), 100, 4096, OriginHuman, "req-trim"); err != nil {
		t.Fatal(err)
	}
	if _, found, err := s.GetMessageByRequest(ctx, "peer-a", "req-trim"); err != nil || !found {
		t.Fatalf("request lookup before trim found=%t err=%v", found, err)
	}
	for i := 0; i < 2; i++ {
		if _, err := s.SaveInbound(ctx, fmt.Sprintf("fill-%d", i), "peer-b", "fill", now.Add(time.Duration(i+1)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	if _, found, err := s.GetMessage(ctx, "trimmed-key"); err != nil || found {
		t.Fatalf("trimmed message found=%t err=%v", found, err)
	}
	if _, found, err := s.GetMessageByRequest(ctx, "peer-a", "req-trim"); err != nil || found {
		t.Fatalf("trimmed request key unexpectedly resolved found=%t err=%v", found, err)
	}
	// The human relation is independent of message retention; only the
	// request-key lookup is limited to retained rows.
	peers, _, err := s.ListHumanOutboundPeers(ctx, ConversationCursor{}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].PeerID != "peer-a" {
		t.Fatalf("human relation after trim = %+v", peers)
	}
}
