package storage

import (
	"context"
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
