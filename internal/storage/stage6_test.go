package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func TestStage6DiscoveryIndexPersistsEvidenceAndFamiliarFilter(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	now := time.Now().UnixMilli()
	first, err := s.RecordPublicDiscovery(ctx, "peer-a", "posts/a.json", "aabb", 10, now, "raminga_content_get")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID <= 0 || first.Source != "raminga_content_get" {
		t.Fatalf("recorded discovery = %+v", first)
	}
	if _, err := s.RecordPublicDiscovery(ctx, "peer-b", "posts/b.json", "ccdd", 20, now+1, "raminga_content_get"); err != nil {
		t.Fatal(err)
	}
	// The same version re-fetched updates observation time and latest source
	// without creating a duplicate row. The acquisition history keeps both the
	// Agent and manual paths.
	again, err := s.RecordPublicDiscovery(ctx, "peer-a", "posts/a.json", "aabb", 10, now+2, "raminga_ui_manual")
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != first.ID || again.FetchedAtMS != now+2 || again.Source != "raminga_ui_manual" {
		t.Fatalf("re-fetch row = %+v, first = %+v", again, first)
	}
	if len(again.Sources) != 2 || again.Sources[0] != "raminga_content_get" || again.Sources[1] != "raminga_ui_manual" {
		t.Fatalf("acquisition sources = %v", again.Sources)
	}
	// A changed hash is a new content version.
	changed, err := s.RecordPublicDiscovery(ctx, "peer-a", "posts/a.json", "eeee", 12, now+3, "raminga_content_get")
	if err != nil {
		t.Fatal(err)
	}
	if changed.ID == first.ID {
		t.Fatalf("changed hash reused discovery id %d", changed.ID)
	}
	if _, err := s.RecordPublicDiscovery(ctx, "peer-a", "posts/../../etc", "ffff", 1, now+4, "raminga_content_get"); err != nil {
		// The tool validates path/traversal before recording; storage itself
		// treats the path as opaque evidence. This call is only checking the
		// index does not explode on odd values.
		t.Fatal(err)
	}

	page, err := s.ListPublicDiscoveries(ctx, "", 2, false, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || !page.HasMore || page.NextBefore == "" {
		t.Fatalf("page = %+v", page)
	}
	next, err := s.ListPublicDiscoveries(ctx, page.NextBefore, 2, false, "", false)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[int64]bool{}
	for _, row := range append(page.Items, next.Items...) {
		if seen[row.ID] {
			t.Fatalf("duplicate discovery id %d", row.ID)
		}
		seen[row.ID] = true
	}
	if len(seen) != 4 {
		t.Fatalf("all rows = %d", len(seen))
	}

	if _, err := s.DB().ExecContext(ctx,
		`INSERT INTO human_outbound_peers (peer_id, first_at_ms, last_at_ms) VALUES (?, ?, ?)`,
		"peer-b", now, now); err != nil {
		t.Fatal(err)
	}
	familiar, err := s.ListPublicDiscoveries(ctx, "", 10, true, "", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range familiar.Items {
		if row.PeerID != "peer-b" {
			t.Fatalf("familiar row from unrelated peer: %+v", row)
		}
	}
	if len(familiar.Items) != 1 {
		t.Fatalf("familiar rows = %+v", familiar.Items)
	}
	if _, err := s.ListPublicDiscoveries(ctx, "not-a-cursor", 10, false, "", false); err == nil {
		t.Fatal("malformed cursor must fail")
	}
}

func TestStage6HumanRelationSnapshotDoesNotSkipRowsWhenLastAtMoves(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	base := time.Now().UnixMilli()
	for i, peer := range []string{"peer-a", "peer-b", "peer-c", "peer-d", "peer-e"} {
		if _, err := s.DB().ExecContext(ctx,
			`INSERT INTO human_outbound_peers (peer_id, first_at_ms, last_at_ms) VALUES (?, ?, ?)`,
			peer, base+int64(i), base+int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	first, hasMore, err := s.ListHumanOutboundPeers(ctx, ConversationCursor{}, 2)
	if err != nil || !hasMore || len(first) != 2 {
		t.Fatalf("first page = %+v more=%t err=%v", first, hasMore, err)
	}
	cursor := ConversationCursor{
		LastAtMS:      first[len(first)-1].LastAtMS,
		PeerID:        first[len(first)-1].PeerID,
		SnapshotRowID: first[len(first)-1].SnapshotRowID,
		RowID:         first[len(first)-1].RowID,
	}
	// Concurrent human activity on an unseen row moves its last_at to the
	// newest boundary. The stable snapshot must still return it exactly once.
	if _, err := s.DB().ExecContext(ctx,
		`UPDATE human_outbound_peers SET last_at_ms = ? WHERE peer_id = ?`, base+1000, "peer-a"); err != nil {
		t.Fatal(err)
	}
	// A brand-new relation after the snapshot is deliberately excluded from
	// this point-in-time view; it must not silently appear in a partial page.
	if _, err := s.DB().ExecContext(ctx,
		`INSERT INTO human_outbound_peers (peer_id, first_at_ms, last_at_ms) VALUES (?, ?, ?)`,
		"peer-new", base+2000, base+2000); err != nil {
		t.Fatal(err)
	}
	second, more, err := s.ListHumanOutboundPeers(ctx, cursor, 2)
	if err != nil || !more || len(second) != 2 {
		t.Fatalf("second page = %+v more=%t err=%v", second, more, err)
	}
	cursor = ConversationCursor{
		LastAtMS:      second[len(second)-1].LastAtMS,
		PeerID:        second[len(second)-1].PeerID,
		SnapshotRowID: second[len(second)-1].SnapshotRowID,
		RowID:         second[len(second)-1].RowID,
	}
	third, more, err := s.ListHumanOutboundPeers(ctx, cursor, 2)
	if err != nil || more || len(third) != 1 {
		t.Fatalf("third page = %+v more=%t err=%v", third, more, err)
	}
	seen := map[string]bool{}
	for _, row := range append(append(first, second...), third...) {
		if seen[row.PeerID] {
			t.Fatalf("duplicate peer %s across pages", row.PeerID)
		}
		seen[row.PeerID] = true
	}
	for _, peer := range []string{"peer-a", "peer-b", "peer-c", "peer-d", "peer-e"} {
		if !seen[peer] {
			t.Fatalf("missing original relation %s after concurrent last_at update: %+v", peer, seen)
		}
	}
	if seen["peer-new"] {
		t.Fatal("a relation inserted after the snapshot must not appear in a partial snapshot")
	}
	// Reopening the database must retain the same stable semantics.
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	again, _, err := s.ListHumanOutboundPeers(ctx, ConversationCursor{}, 10)
	if err != nil || len(again) != 6 {
		t.Fatalf("reopened relations = %+v err=%v", again, err)
	}
}

func TestStage6DiscoveryTableIsInVersionedMigration(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	s, err := Open(ctx, dataDir)
	if err != nil {
		t.Fatal(err)
	}
	var version int
	if err := s.DB().QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 11 {
		t.Fatalf("schema version = %d, want 11", version)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if _, err := s.RecordPublicDiscovery(ctx, "peer", "posts/a.json", "aa", 1, time.Now().UnixMilli(), "raminga_content_get"); err != nil {
		t.Fatalf("discovery table after reopen: %v", err)
	}
	if _, err := filepath.Abs(dataDir); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoverySourcesMigrateFromOlderVersion(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	stmts := []string{
		`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)`,
		`INSERT INTO schema_migrations (version, applied_at_ms) VALUES (8, 1)`,
		`CREATE TABLE public_discoveries (
			id INTEGER PRIMARY KEY AUTOINCREMENT, peer_id TEXT NOT NULL, path TEXT NOT NULL,
			sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, fetched_at_ms INTEGER NOT NULL,
			source TEXT NOT NULL, UNIQUE(peer_id, path, sha256))`,
		`INSERT INTO public_discoveries (peer_id, path, sha256, size_bytes, fetched_at_ms, source)
		 VALUES ('peer-a', 'posts/a.json', 'aa', 1, 10, 'raminga_content_get')`,
	}
	for _, stmt := range stmts {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	page, err := store.ListPublicDiscoveries(ctx, "", 10, false, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || len(page.Items[0].Sources) != 1 || page.Items[0].Sources[0] != "raminga_content_get" {
		t.Fatalf("migrated sources = %+v", page.Items)
	}
}
