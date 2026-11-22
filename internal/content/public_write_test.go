package content

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newWriteStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := New(dir, "peer-a", Limits{MaxFileBytes: 1 << 20, MaxPostsBytes: 10 << 20, MaxProfileBytes: 5 << 20})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, dir
}

func TestWritePublicFileIsAtomicAndManifestDigestStable(t *testing.T) {
	store, dir := newWriteStore(t)
	entry, err := store.WritePublicFile("posts/post-1/post.json", []byte(`{"schema_version":2}`))
	if err != nil {
		t.Fatal(err)
	}
	if entry.Path != "posts/post-1/post.json" || entry.Size != 20 || entry.SHA256 == "" {
		t.Fatalf("entry = %+v", entry)
	}
	if _, err := store.WritePublicFile("../escape.json", []byte("x")); err == nil {
		t.Fatal("traversal path accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "escape.json")); !os.IsNotExist(err) {
		t.Fatalf("traversal wrote outside public: %v", err)
	}
	snap, err := store.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	first := ManifestDigest(snap)
	if first == "" {
		t.Fatal("empty digest")
	}
	// The digest must not change with scan time or mtimes.
	time.Sleep(5 * time.Millisecond)
	if err := os.Chtimes(filepath.Join(dir, "public", "posts", "post-1", "post.json"), time.Now(), time.Now()); err != nil {
		t.Fatal(err)
	}
	snap2, err := store.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := ManifestDigest(snap2); got != first {
		t.Fatalf("digest changed without content change: %s != %s", got, first)
	}
	if _, err := store.WritePublicFile("posts/post-1/post.json", []byte(`{"schema_version":2,"changed":true}`)); err != nil {
		t.Fatal(err)
	}
	snap3, err := store.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := ManifestDigest(snap3); got == first {
		t.Fatal("digest did not change after content change")
	}
}

func TestWritePublicFileRejectsSymlinkComponents(t *testing.T) {
	store, dir := newWriteStore(t)
	outside := filepath.Join(dir, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "public", "profile", "linked")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WritePublicFile("profile/linked/avatar.png", []byte("png")); err == nil {
		t.Fatal("write through symlink directory succeeded")
	}
	if _, err := os.Stat(filepath.Join(outside, "avatar.png")); !os.IsNotExist(err) {
		t.Fatalf("write escaped through symlink: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "target.png"), filepath.Join(dir, "public", "profile", "avatar.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WritePublicFile("profile/avatar.png", []byte("png")); err == nil {
		t.Fatal("write over symlink target succeeded")
	}
	if _, err := os.Stat(filepath.Join(outside, "target.png")); !os.IsNotExist(err) {
		t.Fatalf("write followed symlink target: %v", err)
	}
	// No temp files are exposed by the scan.
	snap, err := store.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range snap.Entries {
		if filepath.Base(entry.Path) != "avatar.png" && filepath.Base(entry.Path) != "linked" && entry.Path != "profile/avatar.png" {
			continue
		}
		t.Fatalf("unexpected public entry %q", entry.Path)
	}
}

func TestRemovePublicFileRefusesSymlink(t *testing.T) {
	store, dir := newWriteStore(t)
	target := filepath.Join(dir, "outside.txt")
	if err := os.WriteFile(target, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "public", "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := store.RemovePublicFile("link.txt"); err == nil {
		t.Fatal("removed symlink")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("symlink target was touched: %v", err)
	}
}
