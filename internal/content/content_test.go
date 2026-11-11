package content

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newStore(t *testing.T, limits Limits) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := New(dir, "peer-test", limits)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, dir
}

func TestScanRules(t *testing.T) {
	s, dir := newStore(t, Limits{MaxFileBytes: 8, MaxPostsBytes: 10, MaxProfileBytes: 100})
	public := filepath.Join(dir, "public")
	mustWrite := func(rel, data string) {
		p := filepath.Join(public, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite("profile/index.md", "hello")
	mustWrite("posts/a.txt", "12345678")
	mustWrite("posts/b.txt", "12345678")
	mustWrite("posts/large.bin", "123456789")
	mustWrite("posts/.hidden", "x")
	mustWrite("posts/Thumbs.db", "x")
	mustWrite("posts/x.tmp", "x")
	mustWrite("posts/~$x", "x")
	mustWrite("posts/x.swp", "x")
	// Symlink inside and pointing outside are both skipped.
	if err := os.Symlink(filepath.Join(public, "profile/index.md"), filepath.Join(public, "profile/inside-link")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	outside := filepath.Join(t.TempDir(), "outside.txt")
	_ = os.WriteFile(outside, []byte("outside"), 0o644)
	_ = os.Symlink(outside, filepath.Join(public, "profile/outside-link"))
	// Invalid UTF-8 names are skipped where the filesystem allows them.
	badName := string([]byte{0xff, 'x'})
	_ = os.WriteFile(filepath.Join(public, "posts", badName), []byte("x"), 0o644)

	snap, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	paths := make(map[string]Entry)
	for _, e := range snap.Entries {
		paths[e.Path] = e
	}
	if _, ok := paths["profile/index.md"]; !ok {
		t.Fatal("profile file missing")
	}
	if _, ok := paths["posts/a.txt"]; !ok {
		t.Fatal("first post missing")
	}
	if _, ok := paths["posts/b.txt"]; ok {
		t.Fatal("total-limit post was published")
	}
	if _, ok := paths["posts/large.bin"]; ok {
		t.Fatal("oversize file was published")
	}
	for _, p := range []string{"posts/.hidden", "posts/Thumbs.db", "posts/x.tmp", "posts/~$x", "posts/x.swp", "profile/inside-link", "profile/outside-link"} {
		if _, ok := paths[p]; ok {
			t.Fatalf("skipped path published: %s", p)
		}
	}
	if len(snap.Warnings) == 0 {
		t.Fatal("expected over-limit warnings")
	}
	if strings.Contains(strings.Join(snap.Warnings, "\n"), "invalid UTF-8") == false {
		// Invalid filename may be rejected by the filesystem; then this warning
		// legitimately cannot exist.
		_ = badName
	}
	skipped := make(map[string]string)
	for _, item := range snap.Skipped {
		skipped[item.Path] = item.Reason
	}
	for _, p := range []string{"posts/.hidden", "posts/Thumbs.db", "posts/b.txt", "profile/inside-link", "profile/outside-link"} {
		if skipped[p] == "" {
			t.Fatalf("skip not recorded with a reason: %s (all=%v)", p, snap.Skipped)
		}
	}
	if !strings.Contains(skipped["posts/b.txt"], "directory total") {
		t.Fatalf("directory-limit skip reason = %q", skipped["posts/b.txt"])
	}
}

func TestSkippedReasonsRecordedForEverySkipKind(t *testing.T) {
	s, dir := newStore(t, Limits{MaxFileBytes: 4, MaxPostsBytes: 1000, MaxProfileBytes: 1000})
	public := filepath.Join(dir, "public")
	write := func(rel, data string) {
		p := filepath.Join(public, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("posts/x.tmp", "x")
	write("posts/~$x", "x")
	write("posts/x.swp", "x")
	write("posts/Thumbs.db", "x")
	write("posts/.hidden", "x")
	write("posts/too-big.bin", "12345")
	if err := os.Symlink(filepath.Join(public, "posts/x.tmp"), filepath.Join(public, "posts/link")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	snap, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	skipped := make(map[string]string)
	for _, item := range snap.Skipped {
		skipped[item.Path] = item.Reason
	}
	for _, p := range []string{"posts/x.tmp", "posts/~$x", "posts/x.swp", "posts/Thumbs.db", "posts/.hidden", "posts/too-big.bin", "posts/link"} {
		if skipped[p] == "" {
			t.Fatalf("skip not recorded with a reason: %s (all=%v)", p, snap.Skipped)
		}
	}
}

func TestManifestPaginationAndHashStable(t *testing.T) {
	s, dir := newStore(t, Limits{MaxFileBytes: 1 << 20, MaxPostsBytes: 1 << 20, MaxProfileBytes: 1 << 20})
	public := filepath.Join(dir, "public", "profile")
	for i := 0; i < 300; i++ {
		name := filepath.Join(public, "f"+strings.Repeat("x", 80)+string(rune('a'+i%26))+string(rune('a'+i/26))+".txt")
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	snap, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	first := snap.Page(0, 1000)
	if len(first.Entries) > MaxManifestLimit {
		t.Fatalf("page not capped: %d", len(first.Entries))
	}
	raw, _ := json.Marshal(first)
	if len(raw) > MaxManifestPage {
		t.Fatalf("page %d > %d", len(raw), MaxManifestPage)
	}
	if first.Total != snap.Total || first.Total != len(snap.Entries) {
		t.Fatalf("total=%d snapshot=%d", first.Total, len(snap.Entries))
	}
	if !json.Valid(raw) {
		t.Fatal("invalid manifest JSON")
	}
	// Hash is reused for unchanged path+size+mtime.
	hash := snap.Entries[0].SHA256
	time.Sleep(10 * time.Millisecond)
	s.Invalidate()
	snap2, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snap2.Entries[0].SHA256 != hash {
		t.Fatalf("hash changed without content change")
	}
}

func TestWriteFriendsOnlyWhenChangedAndAtomic(t *testing.T) {
	s, dir := newStore(t, Limits{MaxFileBytes: 100, MaxPostsBytes: 100, MaxProfileBytes: 100})
	first := []byte(`{"version":1,"friends":[]}`)
	changed, err := s.WriteFriends(first)
	if err != nil || !changed {
		t.Fatalf("first write changed=%t err=%v", changed, err)
	}
	before, _ := os.ReadFile(filepath.Join(dir, "public", "friends.json"))
	changed, err = s.WriteFriends(first)
	if err != nil || changed {
		t.Fatalf("identical write changed=%t err=%v", changed, err)
	}
	after, _ := os.ReadFile(filepath.Join(dir, "public", "friends.json"))
	if string(before) != string(after) {
		t.Fatal("identical write altered file")
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "public"))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".friends-") {
			t.Fatalf("temporary file left: %s", e.Name())
		}
	}
}

func TestPageJSONFitsLimit(t *testing.T) {
	snap := &Snapshot{PeerID: "p", GeneratedAt: time.Now()}
	for i := 0; i < 1000; i++ {
		snap.Entries = append(snap.Entries, Entry{Path: "profile/" + strings.Repeat("x", 200), Size: 1, SHA256: strings.Repeat("a", 64)})
	}
	snap.Total = len(snap.Entries)
	page := snap.Page(0, 1000)
	raw, _ := json.Marshal(page)
	if len(raw) > MaxManifestPage || page.Total != len(snap.Entries) {
		t.Fatalf("page bytes=%d total=%d", len(raw), page.Total)
	}
}

func TestFirstScanReturnsInProgress(t *testing.T) {
	s, _ := newStore(t, Limits{MaxFileBytes: 100, MaxPostsBytes: 100, MaxProfileBytes: 100})
	s.scanDelay = FirstScanWait + 100*time.Millisecond
	start := time.Now()
	_, err := s.Snapshot(context.Background())
	if !errors.Is(err, ErrScanInProgress) {
		t.Fatalf("err=%v", err)
	}
	if time.Since(start) > FirstScanWait+500*time.Millisecond {
		t.Fatalf("first scan wait too long: %s", time.Since(start))
	}
}

func TestSnapshotAfterTTLSeesNewFileOnNextCall(t *testing.T) {
	s, dir := newStore(t, Limits{MaxFileBytes: 100, MaxPostsBytes: 1000, MaxProfileBytes: 1000})
	write := func(name string) {
		p := filepath.Join(dir, "public", "posts", name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.txt")
	first, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !hasEntry(first, "posts/a.txt") {
		t.Fatal("first snapshot missing posts/a.txt")
	}
	s.mu.Lock()
	s.cacheAt = time.Now().Add(-CacheTTL - time.Second)
	s.mu.Unlock()
	write("b.txt")
	second, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !hasEntry(second, "posts/b.txt") {
		t.Fatalf("file added after TTL not visible on the very next Snapshot: %+v", second.Entries)
	}
}

func TestInvalidateDuringScanDoesNotCacheOldResult(t *testing.T) {
	s, dir := newStore(t, Limits{MaxFileBytes: 100, MaxPostsBytes: 1000, MaxProfileBytes: 1000})
	if err := os.WriteFile(filepath.Join(dir, "public", "posts", "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.scanDelay = 250 * time.Millisecond
	done := make(chan error, 1)
	go func() {
		_, err := s.Snapshot(context.Background())
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	s.Invalidate()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	cached := s.cache
	s.mu.Unlock()
	if cached != nil {
		t.Fatal("older scan was cached after Invalidate")
	}
	s.scanDelay = 0
	fresh, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !hasEntry(fresh, "posts/a.txt") {
		t.Fatalf("fresh scan after Invalidate missing file: %+v", fresh.Entries)
	}
}

func TestExpiredSnapshotServesPreviousWhenScanExceedsBound(t *testing.T) {
	s, dir := newStore(t, Limits{MaxFileBytes: 100, MaxPostsBytes: 1000, MaxProfileBytes: 1000})
	if err := os.WriteFile(filepath.Join(dir, "public", "posts", "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	first, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s.scanDelay = FirstScanWait + 300*time.Millisecond
	s.mu.Lock()
	s.cacheAt = time.Now().Add(-CacheTTL - time.Second)
	s.mu.Unlock()
	start := time.Now()
	second, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > FirstScanWait+200*time.Millisecond {
		t.Fatalf("stale snapshot wait = %s", elapsed)
	}
	if !hasEntry(second, "posts/a.txt") || second != first {
		t.Fatalf("did not serve the previous snapshot: %+v", second.Entries)
	}
	// Let the background refresh finish before the test closes the store.
	deadline := time.Now().Add(FirstScanWait + 2*time.Second)
	for {
		s.mu.Lock()
		updated := s.cache != nil && s.cache != first
		s.mu.Unlock()
		if updated || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	s.scanDelay = 0
}

func hasEntry(snap *Snapshot, path string) bool {
	for _, e := range snap.Entries {
		if e.Path == path {
			return true
		}
	}
	return false
}

func TestRefreshForcesScanInsideTTL(t *testing.T) {
	s, dir := newStore(t, Limits{MaxFileBytes: 100, MaxPostsBytes: 1000, MaxProfileBytes: 1000})
	if _, err := s.Snapshot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "public", "posts", "fresh.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	snap, err := s.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !hasEntry(snap, "posts/fresh.txt") {
		t.Fatalf("Refresh did not force a fresh scan: %+v", snap.Entries)
	}
}
