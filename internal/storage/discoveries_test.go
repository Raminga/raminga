package storage

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// TestPostCandidatePagesAreNotConsumedByOrdinaryFiles is the storage-level
// proof for the Feed cursor contract: more than five mixed pages of newer
// ordinary files must not hide older posts, and a caller that does not opt in
// still receives every file page exactly as before.
func TestPostCandidatePagesAreNotConsumedByOrdinaryFiles(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()

	base := time.Now().UnixMilli()
	// Ordinary files are newer than every post, exactly the shape that made the
	// old bridge slice the first 500 mixed rows and never reach the posts.
	for index := 0; index < 620; index++ {
		if _, err := store.DB().ExecContext(ctx, `
			INSERT INTO public_discoveries
			(peer_id, path, sha256, size_bytes, fetched_at_ms, source, sources_json)
			VALUES (?, ?, ?, ?, ?, 'raminga_content_get', ?)`,
			"peer-b", fmt.Sprintf("notes/bulk/%04d.txt", index), "e", 20, base+int64(index)+1000,
			`["raminga_content_get"]`); err != nil {
			t.Fatal(err)
		}
	}
	posts := []struct {
		peerID string
		path   string
		at     int64
	}{
		{"peer-a", "posts/legacy.json", base + 7},
		{"peer-a", "posts/image/post.json", base + 6},
		{"peer-b", "posts/agent/post.json", base + 5},
		{"peer-b", "posts/older.json", base + 4},
		{"peer-a", "posts/oldest.json", base + 3},
	}
	for _, post := range posts {
		if _, err := store.DB().ExecContext(ctx, `
			INSERT INTO public_discoveries
			(peer_id, path, sha256, size_bytes, fetched_at_ms, source, sources_json)
			VALUES (?, ?, ?, ?, ?, 'raminga_content_get', ?)`,
			post.peerID, post.path, "a", 10, post.at, `["raminga_content_get"]`); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.DB().ExecContext(ctx,
		`INSERT INTO human_outbound_peers (peer_id, first_at_ms, last_at_ms) VALUES (?, ?, ?)`,
		"peer-b", base, base); err != nil {
		t.Fatal(err)
	}

	// Candidate cursor pages contain only post-shaped paths and reach every
	// post even though 620 newer file rows precede them.
	seen := map[string]bool{}
	before := ""
	for pages := 0; pages < 20; pages++ {
		page, err := store.ListPublicDiscoveries(ctx, before, 2, false, "", true)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) > 2 {
			t.Fatalf("page exceeded limit: %+v", page.Items)
		}
		for _, row := range page.Items {
			if seen[row.Path] {
				t.Fatalf("duplicate candidate %q", row.Path)
			}
			seen[row.Path] = true
		}
		if !page.HasMore {
			if page.NextBefore != "" {
				t.Fatalf("terminal page should not carry a cursor: %+v", page)
			}
			break
		}
		if page.NextBefore == "" || page.NextBefore == before {
			t.Fatalf("cursor did not advance: %q", page.NextBefore)
		}
		before = page.NextBefore
	}
	if len(seen) != len(posts) {
		t.Fatalf("candidate posts = %d, want %d: %v", len(seen), len(posts), seen)
	}
	for _, post := range posts {
		if !seen[post.path] {
			t.Fatalf("missing post %q behind ordinary files", post.path)
		}
	}

	familiar, err := store.ListPublicDiscoveries(ctx, "", 100, true, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(familiar.Items) != 2 {
		t.Fatalf("familiar candidate posts = %d: %+v", len(familiar.Items), familiar.Items)
	}
	for _, row := range familiar.Items {
		if row.PeerID != "peer-b" {
			t.Fatalf("familiar candidate leaked %+v", row)
		}
	}

	// Legacy callers (the RPC field omitted / false) still page the complete
	// mixed index, so the fix is additive rather than a new files-only client.
	all := map[string]bool{}
	before = ""
	for pages := 0; pages < 20; pages++ {
		page, err := store.ListPublicDiscoveries(ctx, before, 100, false, "", false)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range page.Items {
			all[row.Path] = true
		}
		if !page.HasMore {
			break
		}
		before = page.NextBefore
	}
	if len(all) != 625 {
		t.Fatalf("legacy mixed rows = %d, want 625", len(all))
	}
	if !all["notes/bulk/0000.txt"] || !all["posts/oldest.json"] {
		t.Fatalf("legacy page lost files or posts: %v", all)
	}
}

func TestDiscoveryRefreshPeersUseVersionedPostsAndRealOutboundFacts(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	base := time.Now().UnixMilli()
	if _, err := store.DB().ExecContext(ctx, `
		INSERT INTO public_discoveries
		(peer_id, path, sha256, size_bytes, fetched_at_ms, source, sources_json)
		VALUES
		('peer-discovery', 'posts/a/post.json', 'a', 10, ?, 'raminga_content_get', '["raminga_content_get"]'),
		('peer-human', 'posts/b.json', 'b', 10, ?, 'raminga_content_get', '["raminga_content_get"]'),
		('peer-profile', 'profile/index.md', 'c', 10, ?, 'raminga_content_get', '["raminga_content_get"]'),
		('peer-profile', 'notes/ordinary.txt', 'd', 10, ?, 'raminga_content_get', '["raminga_content_get"]')`,
		base+10, base+30, base+90, base+91); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DB().ExecContext(ctx,
		`INSERT INTO human_outbound_peers (peer_id, first_at_ms, last_at_ms) VALUES ('peer-human', ?, ?)`,
		base, base+30); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DB().ExecContext(ctx, `
		INSERT INTO messages
		(message_id, peer_id, direction, text, acked, created_at_ms, acked_at_ms, origin, delivery_status, delivery_error, delivery_updated_at_ms, client_request_id)
		VALUES
		('m-agent', 'peer-agent', 'out', 'agent', 0, ?, 0, 'agent', 'pending', '', 0, ''),
		('m-inbound', 'peer-inbound', 'in', 'inbound', 1, ?, 0, 'unknown', 'received', '', 0, ''),
		('m-out-human', 'peer-human', 'out', 'human', 0, ?, 0, 'human', 'pending', '', 0, '')`,
		base+20, base+80, base+30); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DB().ExecContext(ctx, `
		INSERT INTO friends
		(peer_id, name, addrs_json, description, manually_connected, first_seen_ms, last_interaction_ms, relay_capable, dht_capable)
		VALUES ('peer-contact', 'contact', '[]', '', 1, ?, ?, 0, 0)`, base, base+100); err != nil {
		t.Fatal(err)
	}

	page, err := store.ListDiscoveryRefreshPeers(ctx, false, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || page.Truncated || len(page.Peers) != 3 {
		t.Fatalf("all refresh peers = %+v", page)
	}
	byPeer := map[string]DiscoveryRefreshPeer{}
	for _, peer := range page.Peers {
		byPeer[peer.PeerID] = peer
	}
	if !byPeer["peer-discovery"].FromDiscovery || byPeer["peer-discovery"].FromOutbound {
		t.Fatalf("discovery-only peer = %+v", byPeer["peer-discovery"])
	}
	if !byPeer["peer-human"].FromDiscovery || !byPeer["peer-human"].FromOutbound {
		t.Fatalf("both-source peer = %+v", byPeer["peer-human"])
	}
	if byPeer["peer-agent"].FromDiscovery || !byPeer["peer-agent"].FromOutbound {
		t.Fatalf("agent-outbound peer = %+v", byPeer["peer-agent"])
	}
	for _, leaked := range []string{"peer-profile", "peer-inbound", "peer-contact"} {
		if _, ok := byPeer[leaked]; ok {
			t.Fatalf("refresh candidates leaked %s: %+v", leaked, page.Peers)
		}
	}

	familiar, err := store.ListDiscoveryRefreshPeers(ctx, true, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	if familiar.Total != 2 || len(familiar.Peers) != 2 {
		t.Fatalf("familiar refresh peers = %+v", familiar)
	}
	for _, peer := range familiar.Peers {
		if !peer.FromOutbound || peer.PeerID == "peer-discovery" {
			t.Fatalf("familiar refresh leaked a non-exchange peer: %+v", peer)
		}
	}

	limited, err := store.ListDiscoveryRefreshPeers(ctx, false, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	if !limited.Truncated || limited.Total != 3 || len(limited.Peers) != 1 {
		t.Fatalf("bounded refresh peers = %+v", limited)
	}
	if limited.Peers[0].PeerID != "peer-human" {
		t.Fatalf("refresh order must be newest local activity first: %+v", limited.Peers)
	}
	if !limited.HasMore || limited.NextAfter == "" {
		t.Fatalf("bounded page must expose its next cursor: %+v", limited)
	}

	// A repeat refresh resumes after the last returned candidate instead of
	// slicing the same top peer forever. The familiar filter has its own page.
	second, err := store.ListDiscoveryRefreshPeers(ctx, false, 1, limited.NextAfter)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Peers) != 1 || second.Peers[0].PeerID != "peer-agent" {
		t.Fatalf("second refresh page = %+v", second)
	}
	third, err := store.ListDiscoveryRefreshPeers(ctx, false, 1, second.NextAfter)
	if err != nil {
		t.Fatal(err)
	}
	if len(third.Peers) != 1 || third.Peers[0].PeerID != "peer-discovery" || third.HasMore {
		t.Fatalf("last refresh page = %+v", third)
	}
	if _, err := store.ListDiscoveryRefreshPeers(ctx, false, 1, "not-a-cursor"); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("invalid refresh cursor error = %v", err)
	}
}
