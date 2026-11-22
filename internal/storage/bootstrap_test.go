package storage

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const bootstrapPeerA = "12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6"
const bootstrapPeerB = "12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR"
const bootstrapPeerC = "12D3KooWLaHQeWmPbiVnVe7Bgu2HbXcCQPBV8ioP5XgpQFPJPSEq"

func bootstrapAddr(port int, id string) string {
	return "/ip4/127.0.0.1/tcp/" + itoa(port) + "/p2p/" + id
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 8)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

func TestBootstrapImportConsumesLegacyListExactlyOnceAndPreservesClear(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	seed := bootstrapAddr(44001, bootstrapPeerA)
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.UpsertFriend(ctx, bootstrapPeerA, []string{seed}, true, true); err != nil {
		t.Fatal(err)
	}
	if err := store.PausePeer(ctx, bootstrapPeerA); err != nil {
		t.Fatal(err)
	}
	added, imported, err := store.ImportBootstrapPeersOnce(ctx, []string{seed, seed})
	if err != nil || !imported || added != 1 {
		t.Fatalf("first import = added=%d imported=%t err=%v", added, imported, err)
	}
	list, err := store.ListBootstrapPeers(ctx)
	if err != nil || len(list) != 1 || list[0].PeerID != bootstrapPeerA || len(list[0].Addrs) != 1 || !list[0].Paused {
		t.Fatalf("imported list = %+v err=%v", list, err)
	}
	// A changed legacy TOML list must not be consumed again.
	added, imported, err = store.ImportBootstrapPeersOnce(ctx, []string{bootstrapAddr(44002, bootstrapPeerB)})
	if err != nil || imported || added != 0 {
		t.Fatalf("second import = added=%d imported=%t err=%v", added, imported, err)
	}
	if list, _ := store.ListBootstrapPeers(ctx); len(list) != 1 || list[0].PeerID != bootstrapPeerA {
		t.Fatalf("second import changed list: %+v", list)
	}
	// Removal drops only the role. The peer address, contact row and explicit
	// pause remain for ordinary peer semantics.
	if removed, err := store.RemoveBootstrapPeer(ctx, bootstrapPeerA); err != nil || !removed {
		t.Fatalf("remove = %v, %v", removed, err)
	}
	if list, _ := store.ListBootstrapPeers(ctx); len(list) != 0 {
		t.Fatalf("list after remove = %+v", list)
	}
	rows, err := store.ListKnownPeers(ctx)
	if err != nil || len(rows) != 1 || len(rows[0].Addrs) != 1 {
		t.Fatalf("peer address was deleted: %+v err=%v", rows, err)
	}
	if _, found, err := store.GetFriend(ctx, bootstrapPeerA); err != nil || !found {
		t.Fatalf("contact was deleted: found=%t err=%v", found, err)
	}
	if !store.IsPaused(ctx, bootstrapPeerA) {
		t.Fatal("remove cleared the explicit-disconnect pause")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	// A restart must not re-import the legacy TOML entry after an explicit clear.
	store, err = Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	added, imported, err = store.ImportBootstrapPeersOnce(ctx, []string{seed})
	if err != nil || imported || added != 0 {
		t.Fatalf("restart import = added=%d imported=%t err=%v", added, imported, err)
	}
	if list, _ := store.ListBootstrapPeers(ctx); len(list) != 0 {
		t.Fatalf("restart resurrected bootstrap roles: %+v", list)
	}
}

func TestBootstrapAddDuplicateMultiAddressAndErrors(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	first := bootstrapAddr(44011, bootstrapPeerA)
	second := "/ip6/::1/tcp/44012/p2p/" + bootstrapPeerA
	peer, added, err := store.AddBootstrapPeer(ctx, first)
	if err != nil || !added || peer.PeerID != bootstrapPeerA {
		t.Fatalf("add = %+v added=%t err=%v", peer, added, err)
	}
	peer, added, err = store.AddBootstrapPeer(ctx, first)
	if err != nil || added || len(peer.Addrs) != 1 {
		t.Fatalf("duplicate add = %+v added=%t err=%v", peer, added, err)
	}
	// The network's background PeerStore hint cache stores transport-only
	// addresses. A permanent bootstrap row must not lose its /p2p suffix, and
	// the role listing must still show one usable canonical address.
	if err := store.UpsertPeerCache(ctx, bootstrapPeerA, []string{"/ip4/127.0.0.1/tcp/44011"}, PeerSourceKnown, 0, 100); err != nil {
		t.Fatal(err)
	}
	peer, _, err = store.AddBootstrapPeer(ctx, first)
	if err != nil || len(peer.Addrs) != 1 || peer.Addrs[0] != first {
		t.Fatalf("cache merge corrupted bootstrap address = %+v err=%v", peer, err)
	}
	peer, added, err = store.AddBootstrapPeer(ctx, second)
	if err != nil || !added || len(peer.Addrs) != 2 {
		t.Fatalf("same peer second address = %+v added=%t err=%v", peer, added, err)
	}
	if peer.Addrs[0] != first || peer.Addrs[1] != second {
		t.Fatalf("addresses are not deterministically sorted: %v", peer.Addrs)
	}
	for _, raw := range []string{
		"",
		"/ip4/127.0.0.1/tcp/4001",
		"/dnsaddr/bootstrap.libp2p.io/p2p/" + bootstrapPeerA,
		" /ip4/127.0.0.1/tcp/4001/p2p/" + bootstrapPeerA,
	} {
		if _, _, err := store.AddBootstrapPeer(ctx, raw); err == nil {
			t.Fatalf("AddBootstrapPeer(%q) unexpectedly succeeded", raw)
		}
	}
	if _, _, err := store.AddBootstrapPeer(ctx, "/ip4/127.0.0.1/tcp/4001/p2p/not-a-peer"); err == nil {
		t.Fatal("invalid peer ID accepted")
	}
	list, err := store.ListBootstrapPeers(ctx)
	if err != nil || len(list) != 1 || len(list[0].Addrs) != 2 {
		t.Fatalf("list after errors = %+v err=%v", list, err)
	}
	// Removing idempotently preserves the two addresses.
	if removed, err := store.RemoveBootstrapPeer(ctx, bootstrapPeerA); err != nil || !removed {
		t.Fatalf("remove = %v, %v", removed, err)
	}
	if removed, err := store.RemoveBootstrapPeer(ctx, bootstrapPeerA); err != nil || removed {
		t.Fatalf("second remove = %v, %v", removed, err)
	}
	rows, err := store.ListKnownPeers(ctx)
	if err != nil || len(rows) != 1 || len(rows[0].Addrs) < 2 {
		t.Fatalf("addresses lost on remove: %+v err=%v", rows, err)
	}
	joined := strings.Join(rows[0].Addrs, " ")
	if !strings.Contains(joined, first) || !strings.Contains(joined, second) {
		t.Fatalf("complete addresses lost on remove: %v", rows[0].Addrs)
	}
}

func TestMigrateV12ToV13PreservesOldDatabaseAndImportsLegacy(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	stmts := []string{
		`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)`,
		`INSERT INTO schema_migrations (version, applied_at_ms) VALUES (12, 1)`,
		`CREATE TABLE messages (
			message_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL,
			direction TEXT NOT NULL, text TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0,
			created_at_ms INTEGER NOT NULL, acked_at_ms INTEGER NOT NULL DEFAULT 0,
			origin TEXT NOT NULL DEFAULT 'unknown', delivery_status TEXT NOT NULL DEFAULT 'unknown',
			delivery_error TEXT NOT NULL DEFAULT '', delivery_updated_at_ms INTEGER NOT NULL DEFAULT 0,
			client_request_id TEXT NOT NULL DEFAULT '')`,
		`CREATE TABLE known_peers (
			peer_id TEXT PRIMARY KEY, addrs_json TEXT NOT NULL, source TEXT NOT NULL,
			updated_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE friends (
			peer_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', addrs_json TEXT NOT NULL DEFAULT '[]',
			description TEXT NOT NULL DEFAULT '', manually_connected INTEGER NOT NULL DEFAULT 0,
			first_seen_ms INTEGER NOT NULL, last_interaction_ms INTEGER NOT NULL,
			relay_capable INTEGER NOT NULL DEFAULT 0, dht_capable INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE paused_peers (peer_id TEXT PRIMARY KEY, paused_at_ms INTEGER NOT NULL)`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("prepare v12: %v", err)
		}
	}
	if _, err := db.Exec(`INSERT INTO messages (message_id, peer_id, direction, text, acked, created_at_ms) VALUES ('old-message', ?, 'in', 'old', 0, ?)`, bootstrapPeerA, now); err != nil {
		t.Fatalf("old message: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO friends (peer_id, name, addrs_json, first_seen_ms, last_interaction_ms) VALUES (?, 'old-contact', '[]', ?, ?)`, bootstrapPeerA, now, now); err != nil {
		t.Fatalf("old friend: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO paused_peers (peer_id, paused_at_ms) VALUES (?, ?)`, bootstrapPeerA, now); err != nil {
		t.Fatalf("old pause: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO known_peers (peer_id, addrs_json, source, updated_at_ms, expires_at_ms) VALUES (?, '["/ip4/127.0.0.1/tcp/44021"]', 'manual', ?, 0)`, bootstrapPeerA, now); err != nil {
		t.Fatalf("old cache: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatalf("Open v12: %v", err)
	}
	defer func() { _ = store.Close() }()
	if _, err := os.Stat(path + ".bak-12"); err != nil {
		t.Fatalf("pre-migration backup missing: %v", err)
	}
	var version int
	if err := store.DB().QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("schema version = %d err=%v", version, err)
	}
	messages, err := store.RecentMessages(ctx, 10)
	if err != nil || len(messages) != 1 || messages[0].MessageID != "old-message" {
		t.Fatalf("old message after migration = %+v err=%v", messages, err)
	}
	if friend, found, err := store.GetFriend(ctx, bootstrapPeerA); err != nil || !found || friend.Name != "old-contact" {
		t.Fatalf("old friend after migration = %+v found=%t err=%v", friend, found, err)
	}
	if !store.IsPaused(ctx, bootstrapPeerA) {
		t.Fatal("old pause lost during migration")
	}
	legacy := bootstrapAddr(44022, bootstrapPeerB)
	added, imported, err := store.ImportBootstrapPeersOnce(ctx, []string{legacy})
	if err != nil || !imported || added != 1 {
		t.Fatalf("v12 legacy import = added=%d imported=%t err=%v", added, imported, err)
	}
	list, err := store.ListBootstrapPeers(ctx)
	if err != nil || len(list) != 1 || list[0].PeerID != bootstrapPeerB {
		t.Fatalf("v13 bootstrap list = %+v err=%v", list, err)
	}
	if _, _, err := store.ImportBootstrapPeersOnce(ctx, []string{legacy}); err != nil {
		t.Fatal(err)
	}
	if list, _ := store.ListBootstrapPeers(ctx); len(list) != 1 {
		t.Fatalf("versioned import repeated: %+v", list)
	}
}

func TestBootstrapImportEmptyListStillWritesMarker(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	added, imported, err := store.ImportBootstrapPeersOnce(ctx, nil)
	if err != nil || !imported || added != 0 {
		t.Fatalf("empty import = %d/%t/%v", added, imported, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	added, imported, err = store.ImportBootstrapPeersOnce(ctx, []string{bootstrapAddr(44031, bootstrapPeerA)})
	if err != nil || imported || added != 0 {
		t.Fatalf("empty import marker was not durable: %d/%t/%v", added, imported, err)
	}
	if list, _ := store.ListBootstrapPeers(ctx); len(list) != 0 {
		t.Fatalf("empty opt-out gained peers: %+v", list)
	}
}

func TestBootstrapInvalidLegacySeedDoesNotWriteMarker(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	if _, imported, err := store.ImportBootstrapPeersOnce(ctx, []string{"not-a-multiaddr"}); err == nil || imported {
		t.Fatalf("invalid seed = imported=%t err=%v", imported, err)
	}
	if yes, err := store.BootstrapImported(ctx); err != nil || yes {
		t.Fatalf("invalid first import wrote marker = %t, %v", yes, err)
	}
	if _, imported, err := store.ImportBootstrapPeersOnce(ctx, []string{bootstrapAddr(44041, bootstrapPeerA)}); err != nil || !imported {
		t.Fatalf("valid retry after invalid seed = imported=%t err=%v", imported, err)
	}
}

func TestBootstrapAddSnapshotFailureRollsBackRole(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	// Force the in-transaction receipt read to fail after the role and cache
	// row were written but before Commit. The failure must roll both back.
	if _, err := store.db.Exec(`ALTER TABLE paused_peers RENAME TO paused_peers_unavailable`); err != nil {
		t.Fatal(err)
	}
	address := bootstrapAddr(44051, bootstrapPeerA)
	if _, _, err := store.AddBootstrapPeer(ctx, address); err == nil ||
		!strings.Contains(err.Error(), "read bootstrap peer") {
		t.Fatalf("bad pre-commit snapshot error = %v", err)
	}
	if _, err := store.db.Exec(`ALTER TABLE paused_peers_unavailable RENAME TO paused_peers`); err != nil {
		t.Fatal(err)
	}
	if list, err := store.ListBootstrapPeers(ctx); err != nil || len(list) != 0 {
		t.Fatalf("failed snapshot persisted a role = %+v, %v", list, err)
	}
	if rows, err := store.ListKnownPeers(ctx); err != nil || len(rows) != 0 {
		t.Fatalf("failed snapshot persisted a cache row = %+v, %v", rows, err)
	}
	// The rollback leaves the store usable for the corrected retry.
	peer, added, err := store.AddBootstrapPeer(ctx, address)
	if err != nil || !added || peer.PeerID != bootstrapPeerA || len(peer.Addrs) != 1 {
		t.Fatalf("retry add = %+v added=%t err=%v", peer, added, err)
	}
}

func TestBootstrapErrorTextsAreActionable(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	_, _, err = store.AddBootstrapPeer(ctx, "/ip4/127.0.0.1/tcp/4001")
	if err == nil || !strings.Contains(err.Error(), "/p2p") {
		t.Fatalf("missing /p2p error = %v", err)
	}
	_, _, err = store.AddBootstrapPeer(ctx, "/dnsaddr/bootstrap.libp2p.io/p2p/"+bootstrapPeerA)
	if err == nil || !strings.Contains(err.Error(), "公") {
		t.Fatalf("public address error = %v", err)
	}
	_, err = store.RemoveBootstrapPeer(ctx, "not-a-peer")
	if err == nil || !errors.Is(err, sql.ErrNoRows) && !strings.Contains(err.Error(), "invalid") {
		t.Fatalf("invalid remove error = %v", err)
	}
}

func TestBootstrapImportMarkerIsReadBeforeDormantSeedValidation(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	// The first import is empty and commits the marker.
	added, imported, err := store.ImportBootstrapPeersOnce(ctx, nil)
	if err != nil || !imported || added != 0 {
		t.Fatalf("first empty import = %d/%t/%v", added, imported, err)
	}
	if yes, err := store.BootstrapImported(ctx); err != nil || !yes {
		t.Fatalf("BootstrapImported after empty import = %t, %v", yes, err)
	}
	// A later invalid legacy TOML string is dormant: the marker is inspected
	// inside the transaction before the seed is parsed.
	added, imported, err = store.ImportBootstrapPeersOnce(ctx, []string{"not-a-multiaddr"})
	if err != nil || imported || added != 0 {
		t.Fatalf("dormant invalid seed = %d/%t/%v", added, imported, err)
	}
}

func TestBootstrapFullAddrsStructuralCacheAndReopen(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	target := bootstrapPeerA
	relay := bootstrapPeerB
	other := bootstrapPeerC
	good := bootstrapAddr(45103, target)
	cacheAddrs := []string{
		"/ip4/127.0.0.1/tcp/45101",
		"/ip4/127.0.0.1/tcp/45102/p2p/" + relay + "/p2p-circuit",
		good,
		good,
		"not-a-multiaddr",
		// Syntactically valid but no transport: not a dial candidate.
		"/p2p/" + target,
		"/ip4/127.0.0.1/tcp/45104/p2p/" + other,
		"/ip4/127.0.0.1/tcp/45105/p2p/" + relay + "/p2p-circuit/p2p/" + target,
	}
	if err := store.UpsertPeerCache(ctx, target, cacheAddrs, PeerSourceKnown, 0, 1000); err != nil {
		t.Fatal(err)
	}
	otherAddr := "/ip4/127.0.0.1/tcp/45200"
	if err := store.UpsertPeerCache(ctx, other, []string{otherAddr}, PeerSourceKnown, 0, 1000); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.AddBootstrapPeer(ctx, good); err != nil {
		t.Fatal(err)
	}
	before, err := store.ListKnownPeers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/ip4/127.0.0.1/tcp/45101/p2p/" + target,
		"/ip4/127.0.0.1/tcp/45102/p2p/" + relay + "/p2p-circuit/p2p/" + target,
		good,
		"/ip4/127.0.0.1/tcp/45105/p2p/" + relay + "/p2p-circuit/p2p/" + target,
	}
	assertBootstrapAddrs := func(list []BootstrapPeer) {
		t.Helper()
		if len(list) != 1 {
			t.Fatalf("bootstrap list = %+v", list)
		}
		if len(list[0].Addrs) != len(want) {
			t.Fatalf("bootstrap addrs = %v, want %v", list[0].Addrs, want)
		}
		for index := range want {
			if list[0].Addrs[index] != want[index] {
				t.Fatalf("bootstrap addrs = %v, want %v", list[0].Addrs, want)
			}
		}
	}
	list, err := store.ListBootstrapPeers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertBootstrapAddrs(list)
	// Listing only derives full addresses; it must not rewrite cache rows.
	after, err := store.ListKnownPeers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("cache row count changed: %d -> %d", len(before), len(after))
	}
	for index := range before {
		if before[index].PeerID != after[index].PeerID || strings.Join(before[index].Addrs, "\x00") != strings.Join(after[index].Addrs, "\x00") {
			t.Fatalf("cache row rewritten by listing: before=%+v after=%+v", before[index], after[index])
		}
	}
	// The unrelated peer keeps its exact transport-only address.
	var sawOther bool
	for _, row := range after {
		if row.PeerID != other {
			continue
		}
		sawOther = true
		if len(row.Addrs) != 1 || row.Addrs[0] != otherAddr {
			t.Fatalf("unrelated peer mutated: %+v", row)
		}
	}
	if !sawOther {
		t.Fatal("unrelated peer cache row disappeared")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	list, err = store.ListBootstrapPeers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertBootstrapAddrs(list)
	afterReopen, err := store.ListKnownPeers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range afterReopen {
		if row.PeerID == other && (len(row.Addrs) != 1 || row.Addrs[0] != otherAddr) {
			t.Fatalf("unrelated peer mutated after reopen: %+v", row)
		}
	}
}
