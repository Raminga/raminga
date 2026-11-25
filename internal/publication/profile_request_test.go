package publication

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Raminga/raminga/internal/storage"
)

func TestProfileRequestReplaysWithoutWriting(t *testing.T) {
	ctx := context.Background()
	c, store, public, dir := newCoordinator(t)
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return clock }
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		DraftID: "profile", Kind: storage.DraftKindProfile, AgentName: strptr("Nebula"),
	})
	if err != nil {
		t.Fatal(err)
	}
	var writes int
	c.metadataHook = func() error { writes++; return nil }
	var wg sync.WaitGroup
	results := make([]PublishResult, 2)
	for i := range results {
		wg.Go(func() {
			result, err := c.PublishWithRequestID(ctx, draft.DraftID, draft.Revision, "", "first")
			if err != nil {
				t.Error(err)
			}
			results[i] = result
		})
	}
	wg.Wait()
	first := results[0]
	if first.Status != StatusPublished || writes != 1 {
		t.Fatalf("first publish = %+v, writes = %d", first, writes)
	}
	assertSameReceipt(t, first, results[1])

	// A new confirmation of the same draft still publishes with a frozen clock.
	second, err := c.PublishWithRequestID(ctx, draft.DraftID, draft.Revision, first.CurrentPublishedSHA256, "second")
	if err != nil || second.Status != StatusPublished || first.CurrentPublishedSHA256 == second.CurrentPublishedSHA256 || writes != 2 {
		t.Fatalf("second publish = %+v, %v, writes = %d", second, err, writes)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	c = NewCoordinator(dir, peerA, reopened, public)
	c.now = func() time.Time { return clock.Add(time.Second) }
	if _, err := c.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	c.metadataHook = func() error {
		t.Fatal("replaying a completed request wrote public metadata")
		return nil
	}
	for id, prior := range map[string]struct {
		base    string
		receipt PublishResult
	}{
		"first":  {"", first},
		"second": {first.CurrentPublishedSHA256, second},
	} {
		got, err := c.PublishWithRequestID(ctx, draft.DraftID, draft.Revision, prior.base, id)
		if err != nil {
			t.Fatal(err)
		}
		assertSameReceipt(t, prior.receipt, got)
	}
	if got, err := c.PublishWithRequestID(ctx, draft.DraftID, draft.Revision, second.CurrentPublishedSHA256, "first"); err != nil || got.Status != StatusInvalid {
		t.Fatalf("same ID with other input = %+v, %v", got, err)
	}
	if got, err := c.PublishWithRequestID(ctx, draft.DraftID, draft.Revision+1, second.CurrentPublishedSHA256, "stale"); err != nil || got.Status != StatusConflict {
		t.Fatalf("stale revision = %+v, %v", got, err)
	}
	if got, err := c.Publish(ctx, draft.DraftID, draft.Revision, second.CurrentPublishedSHA256); err != nil || got.Status != StatusAlreadyPublished {
		t.Fatalf("legacy replay of keyed publication = %+v, %v", got, err)
	}
}

func TestProfileRequestRecoversLandedFilesAfterDraftEdit(t *testing.T) {
	ctx := context.Background()
	c, store, _, dir := newCoordinator(t)
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		DraftID: "profile", Kind: storage.DraftKindProfile, AgentName: strptr("Nebula"),
	})
	if err != nil {
		t.Fatal(err)
	}
	c.commitHook = func() error { return os.ErrPermission }
	partial, err := c.PublishWithRequestID(ctx, draft.DraftID, draft.Revision, "", "landed")
	if err != nil || partial.Status != StatusPartial || partial.CurrentPublishedSHA256 == "" {
		t.Fatalf("interrupted publish = %+v, %v", partial, err)
	}
	metaPath := filepath.Join(dir, "public", profileMetadataPath)
	before, err := os.Stat(metaPath)
	if err != nil {
		t.Fatal(err)
	}
	newDraft, err := c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindProfile, ExpectedRevision: draft.Revision, AgentName: strptr("New private draft"),
	})
	if err != nil {
		t.Fatal(err)
	}
	c.commitHook = nil
	c.metadataHook = func() error {
		t.Fatal("recovering the receipt rewrote public metadata")
		return nil
	}
	// A different confirmation must first account for the landed commit, so
	// its optimistic base is now stale.
	got, err := c.PublishWithRequestID(ctx, draft.DraftID, newDraft.Revision, "", "new")
	if err != nil || got.Status != StatusConflict || got.CurrentPublishedSHA256 != partial.CurrentPublishedSHA256 {
		t.Fatalf("publish over interrupted commit = %+v, %v", got, err)
	}
	recovered, err := c.PublishWithRequestID(ctx, draft.DraftID, draft.Revision, "", "landed")
	if err != nil || recovered.Status != StatusPublished || recovered.ManifestSHA256 != partial.ManifestSHA256 {
		t.Fatalf("recovered = %+v, %v", recovered, err)
	}
	after, err := os.Stat(metaPath)
	if err != nil || !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
		t.Fatalf("profile was rewritten during recovery: %v", err)
	}
	current, found, err := store.GetPublicDraft(ctx, draft.DraftID)
	if err != nil || !found || current.Revision != newDraft.Revision || current.PublishedRevision != draft.Revision ||
		current.PublishedSHA256 != partial.CurrentPublishedSHA256 || current.AgentName != "New private draft" {
		t.Fatalf("recovered draft = %+v, %v", current, err)
	}
}

func TestProfileRequestResumesBeforeMetadataOrReportsExternalChange(t *testing.T) {
	for _, external := range []bool{false, true} {
		name := "same targets"
		if external {
			name = "external change"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			c, _, _, dir := newCoordinator(t)
			clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			c.now = func() time.Time { return clock }
			draft, err := c.SaveDraft(ctx, DraftUpdate{
				DraftID: "profile", Kind: storage.DraftKindProfile, AgentName: strptr("Nebula"),
			})
			if err != nil {
				t.Fatal(err)
			}
			c.metadataHook = func() error { return os.ErrPermission }
			if result, err := c.PublishWithRequestID(ctx, draft.DraftID, draft.Revision, "", "pending"); err != nil || result.Status != StatusPartial {
				t.Fatalf("interrupted publish = %+v, %v", result, err)
			}
			c.metadataHook = nil
			clock = clock.Add(2 * time.Second)
			if external {
				if err := os.WriteFile(filepath.Join(dir, "public", "profile", "index.md"), []byte("External change"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			result, err := c.PublishWithRequestID(ctx, draft.DraftID, draft.Revision, "", "pending")
			if external {
				if err != nil || result.Status != StatusConflict {
					t.Fatalf("external change = %+v, %v", result, err)
				}
				return
			}
			if err != nil || result.Status != StatusPublished {
				t.Fatalf("resumed publish = %+v, %v", result, err)
			}
			raw, err := os.ReadFile(filepath.Join(dir, "public", profileMetadataPath))
			var p profileJSONV2
			if err != nil || json.Unmarshal(raw, &p) != nil || p.UpdatedAt != clock.Add(-2*time.Second).Format(time.RFC3339Nano) {
				t.Fatalf("resumed timestamp = %q, %v", p.UpdatedAt, err)
			}
		})
	}
}

func assertSameReceipt(t *testing.T, want, got PublishResult) {
	t.Helper()
	a, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if string(a) != string(b) {
		t.Fatalf("receipts differ:\nwant %s\n got %s", a, b)
	}
}
