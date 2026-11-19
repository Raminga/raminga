package node_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Raminga/raminga/internal/node"
)

func TestP3FavoriteRejectsNonPostAndBadDigest(t *testing.T) {
	tn := newTestNode(t, t.TempDir())
	ctx := context.Background()
	self := tn.status(t).PeerID
	for _, publicPath := range []string{"notes/a.json", "messages/m1", "contacts/peer.json", "posts/../a.json", "posts/a/post.json.bak"} {
		if _, _, err := tn.node.SetFavorite(ctx, self, publicPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "x", true); !errors.Is(err, node.ErrFavoriteTarget) {
			t.Fatalf("path %q err = %v, want ErrFavoriteTarget", publicPath, err)
		}
	}
	if _, _, err := tn.node.SetFavorite(ctx, self, "posts/a.json", "not-a-digest", "x", true); !errors.Is(err, node.ErrFavoriteTarget) {
		t.Fatalf("bad digest err = %v", err)
	}
}

func TestP3FavoriteLocalPublicVersionIsAvailableUntilRemoved(t *testing.T) {
	tn := newTestNode(t, t.TempDir())
	ctx := context.Background()
	self := tn.status(t).PeerID
	body := `{"schema_version":1,"format":"markdown","title":"A","body":"hello"}`
	writePublic(t, tn, "posts/a.json", body)
	sum := sha256.Sum256([]byte(body))
	digest := hex.EncodeToString(sum[:])
	item, saved, err := tn.node.SetFavorite(ctx, self, "posts/a.json", digest, "A", true)
	if err != nil || !saved || !item.Available {
		t.Fatalf("save favorite = %+v saved=%v err=%v", item, saved, err)
	}
	// Idempotent repeated save keeps one row and the same identity.
	again, saved, err := tn.node.SetFavorite(ctx, self, "posts/a.json", digest, "A", true)
	if err != nil || !saved || again.ID != item.ID {
		t.Fatalf("repeat = %+v saved=%v err=%v", again, saved, err)
	}
	page, err := tn.node.ListFavorites(ctx, "", 10)
	if err != nil || len(page.Favorites) != 1 || !page.Favorites[0].Available {
		t.Fatalf("list = %+v err=%v", page, err)
	}
	// Removing the retained bytes must make the row unavailable, not silently
	// keep claiming a readable copy.
	if err := os.Remove(filepath.Join(tn.dir, "public", "posts", "a.json")); err != nil {
		t.Fatal(err)
	}
	page, err = tn.node.ListFavorites(ctx, "", 10)
	if err != nil || len(page.Favorites) != 1 || page.Favorites[0].Available {
		t.Fatalf("after delete = %+v err=%v", page, err)
	}
	if _, _, err := tn.node.SetFavorite(ctx, self, "posts/a.json", digest, "A", true); !errors.Is(err, node.ErrFavoriteTarget) {
		t.Fatalf("re-favorite missing bytes err = %v", err)
	}
	// A different digest is not the same verified version.
	if _, _, err := tn.node.SetFavorite(ctx, self, "posts/a.json", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "x", true); !errors.Is(err, node.ErrFavoriteTarget) {
		t.Fatalf("unverified version err = %v", err)
	}
	if _, saved, err := tn.node.SetFavorite(ctx, self, "posts/a.json", digest, "", false); err != nil || saved {
		t.Fatalf("remove saved=%v err=%v", saved, err)
	}
	page, err = tn.node.ListFavorites(ctx, "", 10)
	if err != nil || len(page.Favorites) != 0 {
		t.Fatalf("after remove = %+v err=%v", page, err)
	}
}

func TestP3PrivateContactNotesNeverEnterFriendsOrPublishedManifest(t *testing.T) {
	tn := newTestNode(t, t.TempDir())
	ctx := context.Background()
	secret := "P3-PRIVATE-IMPRESSION-9f43d1"
	writePublic(t, tn, "profile/index.md", "# public\n")
	notes := `{"schema_version":2,"contacts":[{"peer_id":"` + tn.status(t).PeerID + `","impressions":[{"id":"imp-1","summary":"` + secret + `","uncertainty":"low","created_at":"2026-11-18T10:00:00Z","updated_at":"2026-11-18T10:00:00Z","evidence_refs":{}}]}]}`
	file := filepath.Join(tn.dir, "agent", "contact-notes.json")
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(notes), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := tn.node.SyncFriends(ctx); err != nil {
		t.Fatal(err)
	}
	friendsBody, err := os.ReadFile(filepath.Join(tn.dir, "public", "friends.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(friendsBody), secret) || strings.Contains(string(friendsBody), "contact-notes") {
		t.Fatalf("friends.json leaked private memory: %s", friendsBody)
	}
	published, err := tn.node.Published(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range published.Files {
		if strings.HasPrefix(file.Path, "agent/") || strings.Contains(file.Path, "contact-notes") {
			t.Fatalf("published manifest contains private path %q", file.Path)
		}
	}
	publishedBody, err := os.ReadFile(filepath.Join(tn.dir, "public", "manifest.json"))
	if err == nil && (strings.Contains(string(publishedBody), secret) || strings.Contains(string(publishedBody), "agent/")) {
		t.Fatalf("public manifest leaked private memory: %s", publishedBody)
	}
}
