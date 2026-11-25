package publication

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Raminga/raminga/internal/content"
	"github.com/Raminga/raminga/internal/storage"
)

const peerA = "12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR"

func newCoordinator(t *testing.T) (*Coordinator, *storage.Store, *content.Store, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := storage.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	public, err := content.New(dir, peerA, content.Limits{MaxFileBytes: 16 << 20, MaxPostsBytes: 128 << 20, MaxProfileBytes: 32 << 20})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = public.Close() })
	return NewCoordinator(dir, peerA, store, public), store, public, dir
}

func pngBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.RGBA{R: 122, G: 92, B: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func jpegBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func strptr(s string) *string { return &s }

func TestValidateImageAcceptsReencodesAndRejects(t *testing.T) {
	pngData := pngBytes(t, 32, 24)
	got, err := ValidateImage(pngData, "avatar", "avatar.png")
	if err != nil || got.Mime != "image/png" || got.Width != 32 || got.Height != 24 || got.SHA256 == "" {
		t.Fatalf("png = %+v, %v", got, err)
	}
	if _, err := ValidateImage(pngData, "avatar", "avatar.jpg"); err == nil {
		t.Fatal("extension mismatch accepted")
	}
	if _, err := ValidateImage([]byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), "image", "x.svg"); err == nil {
		t.Fatal("SVG accepted")
	}
	if _, err := ValidateImage(pngData[:len(pngData)/2], "image", "broken.png"); err == nil {
		t.Fatal("truncated PNG accepted")
	}
	huge := pngBytes(t, avatarMaxSide+1, 1)
	if _, err := ValidateImage(huge, "avatar", "wide.png"); err == nil || !strings.Contains(err.Error(), "尺寸") {
		t.Fatalf("oversized dimension error = %v", err)
	}
	jpg := jpegBytes(t, 10, 10)
	reencoded, err := ValidateImage(jpg, "image", "photo.jpg")
	if err != nil || reencoded.Mime != "image/jpeg" || len(reencoded.SHA256) != 64 {
		t.Fatalf("jpeg = %+v, %v", reencoded, err)
	}
}

func TestProfileAndPostPublicationConflictAndIdempotency(t *testing.T) {
	ctx := context.Background()
	c, store, public, dir := newCoordinator(t)
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return clock }
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		DraftID: "profile", Kind: storage.DraftKindProfile, ExpectedRevision: 0,
		AgentName: strptr("Nebula"), AgentDescription: strptr("喜欢星空"),
		AgentInterests: []string{"天文", "地图"}, AgentStyle: strptr("好奇"),
		HumanName: strptr("JO JO"), HumanBio: strptr("喜欢创造"),
	})
	if err != nil {
		t.Fatal(err)
	}
	avatar, err := c.PutDraftImage(ctx, draft.DraftID, "avatar", "avatar.png", pngBytes(t, 32, 32))
	if err != nil {
		t.Fatal(err)
	}
	humanAvatar, err := c.PutDraftImage(ctx, draft.DraftID, "human_avatar", "human-avatar.png", pngBytes(t, 28, 28))
	if err != nil {
		t.Fatal(err)
	}
	draft, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: "profile", Kind: storage.DraftKindProfile, ExpectedRevision: draft.Revision,
		AvatarAssetID: avatar.AssetID, HumanAvatarAssetID: humanAvatar.AssetID,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Drafts never write public files.
	if entries, _ := os.ReadDir(filepath.Join(dir, "public", "profile")); len(entries) != 0 {
		t.Fatalf("draft wrote public files: %+v", entries)
	}
	res, err := c.Publish(ctx, draft.DraftID, draft.Revision, "")
	if err != nil || res.Status != StatusPublished || res.ManifestSHA256 == "" || res.ProfilePath != "profile/profile.json" {
		t.Fatalf("publish profile = %+v, %v", res, err)
	}
	var profile profileJSONV2
	raw, err := os.ReadFile(filepath.Join(dir, "public", "profile", "profile.json"))
	if err != nil || json.Unmarshal(raw, &profile) != nil {
		t.Fatalf("read profile: %v %s", err, raw)
	}
	if profile.Agent.Name != "Nebula" || profile.Human.Name != "JO JO" || profile.Agent.Avatar == "" || profile.Human.Avatar == "" {
		t.Fatalf("profile = %+v", profile)
	}
	if profile.Human.AvatarSHA256 == "" || profile.Human.AvatarMime != "image/png" || !strings.HasPrefix(profile.Human.Avatar, "human-avatar-") {
		t.Fatalf("human avatar = %+v", profile.Human)
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "profile", profile.Agent.Avatar)); err != nil {
		t.Fatalf("avatar missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "profile", profile.Human.Avatar)); err != nil {
		t.Fatalf("human avatar missing: %v", err)
	}
	index, _ := os.ReadFile(filepath.Join(dir, "public", "profile", "index.md"))
	if !strings.Contains(string(index), "# JO JO") || !strings.Contains(string(index), "喜欢创造") {
		t.Fatalf("index.md = %q", index)
	}

	// Publishing again with a stale expected hash is a conflict.
	if res, err := c.Publish(ctx, draft.DraftID, draft.Revision, strings.Repeat("0", 64)); err != nil || res.Status != StatusConflict {
		t.Fatalf("stale expected hash = %+v, %v", res, err)
	}
	// Same revision and hash is already published and returns the same digest.
	clock = clock.Add(time.Second)
	again, err := c.Publish(ctx, draft.DraftID, draft.Revision, res.CurrentPublishedSHA256)
	if err != nil || again.Status != StatusAlreadyPublished || again.ManifestSHA256 != res.ManifestSHA256 {
		t.Fatalf("already published = %+v, %v (first digest %s)", again, err, res.ManifestSHA256)
	}

	// External edit of the metadata file is detected before overwrite.
	metaPath := filepath.Join(dir, "public", "profile", "profile.json")
	validProfile := append([]byte(nil), raw...)
	if err := os.WriteFile(metaPath, []byte(`{"schema_version":2,"external":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if res, err := c.Publish(ctx, draft.DraftID, draft.Revision, res.ManifestSHA256); err != nil || res.Status != StatusConflict {
		t.Fatalf("external edit = %+v, %v", res, err)
	}
	if err := os.WriteFile(metaPath, validProfile, 0o644); err != nil {
		t.Fatal(err)
	}
	public.Invalidate()

	// Post with images, first as the human, then update to Agent after profile.
	post, err := c.SaveDraft(ctx, DraftUpdate{
		Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser, ExpectedRevision: 0,
		Title: strptr("第一次"), BodyMarkdown: strptr("正文"), Tags: []string{"日常"},
	})
	if err != nil {
		t.Fatal(err)
	}
	img, err := c.PutDraftImage(ctx, post.DraftID, "image", "photo.png", pngBytes(t, 20, 12))
	if err != nil {
		t.Fatal(err)
	}
	post, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: post.DraftID, Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser,
		ExpectedRevision: post.Revision, ImageAssetIDs: []string{img.AssetID},
	})
	if err != nil {
		t.Fatal(err)
	}
	res2, err := c.Publish(ctx, post.DraftID, post.Revision, "")
	if err != nil || res2.Status != StatusPublished || res2.PostPath == "" {
		t.Fatalf("publish post = %+v, %v", res2, err)
	}
	var saved postJSONV2
	if err := json.Unmarshal(mustRead(t, filepath.Join(dir, "public", filepath.FromSlash(res2.PostPath))), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Author.Kind != storage.DraftAuthorUser || saved.Author.DisplayName != "JO JO" || len(saved.Images) != 1 {
		t.Fatalf("post = %+v", saved)
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "posts", postIDForDraft(post.DraftID), "images", saved.Images[0].SHA256+".png")); err != nil {
		t.Fatalf("image missing: %v", err)
	}

	post, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: post.DraftID, Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorAgent,
		ExpectedRevision: post.Revision, Title: strptr("由 Agent 发布"),
	})
	if err != nil {
		t.Fatal(err)
	}
	res3, err := c.Publish(ctx, post.DraftID, post.Revision, res2.CurrentPublishedSHA256)
	if err != nil || res3.Status != StatusPublished {
		t.Fatalf("publish agent post = %+v, %v", res3, err)
	}
	if err := json.Unmarshal(mustRead(t, filepath.Join(dir, "public", filepath.FromSlash(res3.PostPath))), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Author.Kind != storage.DraftAuthorAgent || saved.Author.DisplayName != "Nebula" {
		t.Fatalf("agent author = %+v", saved.Author)
	}
	if res3.ManifestSHA256 == res2.ManifestSHA256 {
		t.Fatal("manifest digest did not change after post update")
	}
	_ = public
	_ = store
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestPostDraftRequiresExplicitAuthorAndStaysPrivate(t *testing.T) {
	ctx := context.Background()
	c, _, public, dir := newCoordinator(t)
	if _, err := c.SaveDraft(ctx, DraftUpdate{
		Kind: storage.DraftKindPost, ExpectedRevision: 0, Title: strptr("t"), BodyMarkdown: strptr("b"),
	}); err == nil {
		t.Fatal("post without author_kind accepted")
	}
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorAgent, ExpectedRevision: 0,
		Title: strptr("t"), BodyMarkdown: strptr("b"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if entries, err := os.ReadDir(filepath.Join(dir, "public", "posts")); err == nil && len(entries) != 0 {
		t.Fatalf("private draft created public posts: %+v", entries)
	}
	snap, _ := public.Refresh(ctx)
	if snap.Total != 0 {
		t.Fatalf("draft appeared in manifest: %+v", snap.Entries)
	}
	_ = draft
}

func TestConcurrentPublishProducesOneManifestAndOneFileSet(t *testing.T) {
	ctx := context.Background()
	c, _, _, dir := newCoordinator(t)
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser, ExpectedRevision: 0,
		Title: strptr("并发"), BodyMarkdown: strptr("只发布一次"),
	})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan PublishResult, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, _ := c.Publish(ctx, draft.DraftID, draft.Revision, "")
			results <- res
		}()
	}
	wg.Wait()
	close(results)
	var published, already int
	var digest string
	for res := range results {
		switch res.Status {
		case StatusPublished:
			published++
			digest = res.ManifestSHA256
		case StatusAlreadyPublished:
			already++
			if res.ManifestSHA256 != digest && digest != "" {
				t.Fatalf("different digests: %s != %s", res.ManifestSHA256, digest)
			}
		default:
			t.Fatalf("unexpected concurrent result: %+v", res)
		}
	}
	if published != 1 || already != 1 {
		t.Fatalf("published=%d already=%d", published, already)
	}
	postPath := filepath.Join(dir, "public", "posts", postIDForDraft(draft.DraftID), "post.json")
	if _, err := os.Stat(postPath); err != nil {
		t.Fatal(err)
	}
}

func TestMetadataFailureRollsBackAndPreservesOldDigest(t *testing.T) {
	ctx := context.Background()
	c, _, public, _ := newCoordinator(t)
	// Create an old version first.
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser, ExpectedRevision: 0,
		Title: strptr("旧标题"), BodyMarkdown: strptr("旧正文"),
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := c.Publish(ctx, draft.DraftID, draft.Revision, "")
	if err != nil || first.Status != StatusPublished {
		t.Fatalf("first publish = %+v, %v", first, err)
	}
	before, _ := public.Refresh(ctx)
	beforeDigest := content.ManifestDigest(before)

	draft, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser,
		ExpectedRevision: draft.Revision, Title: strptr("新标题"),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Fail the metadata write after any new content-addressed files were
	// committed; rollback must restore the old manifest digest.
	c.metadataHook = func() error { return context.DeadlineExceeded }
	res, err := c.Publish(ctx, draft.DraftID, draft.Revision, first.CurrentPublishedSHA256)
	c.metadataHook = nil
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusPartial || res.ManifestSHA256 == "" {
		t.Fatalf("expected partial, got %+v", res)
	}
	after, _ := public.Refresh(ctx)
	if got := content.ManifestDigest(after); got != beforeDigest {
		t.Fatalf("rolled-back manifest changed: %s != %s", got, beforeDigest)
	}
}

func TestCommitDBFailureReturnsPartialThenRetryRepairs(t *testing.T) {
	ctx := context.Background()
	c, store, _, dir := newCoordinator(t)
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser, ExpectedRevision: 0,
		Title: strptr("回写失败"), BodyMarkdown: strptr("文件已提交"),
	})
	if err != nil {
		t.Fatal(err)
	}
	c.commitHook = func() error { return context.DeadlineExceeded }
	res, err := c.Publish(ctx, draft.DraftID, draft.Revision, "")
	if err != nil || res.Status != StatusPartial || res.ManifestSHA256 == "" {
		t.Fatalf("commit failure = %+v, %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "posts", postIDForDraft(draft.DraftID), "post.json")); err != nil {
		t.Fatal("metadata was not committed")
	}
	c.commitHook = nil
	retry, err := c.Publish(ctx, draft.DraftID, draft.Revision, "")
	if err != nil || retry.Status != StatusAlreadyPublished || retry.ManifestSHA256 != res.ManifestSHA256 {
		t.Fatalf("retry = %+v, %v; first digest %s", retry, err, res.ManifestSHA256)
	}
	got, _, _ := store.GetPublicDraft(ctx, draft.DraftID)
	if got.PublishedSHA256 == "" || got.PublishedRevision != draft.Revision {
		t.Fatalf("published metadata not repaired: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "publication", "staging")); err != nil {
		t.Fatalf("staging root missing: %v", err)
	}
}

func TestRecoveryCleansStagingAndQuarantinesMissingImage(t *testing.T) {
	ctx := context.Background()
	c, _, public, dir := newCoordinator(t)
	staging := filepath.Join(dir, "publication", "staging", "old-run")
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "partial"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	postID := "post-broken"
	postDir := filepath.Join(dir, "public", "posts", postID)
	if err := os.MkdirAll(filepath.Join(postDir, "images"), 0o755); err != nil {
		t.Fatal(err)
	}
	post := postJSONV2{
		SchemaVersion: 2, ID: postID, Title: "t", Format: "markdown",
		Author:      postAuthorJSON{PeerID: peerA, Kind: "user", DisplayName: "A"},
		PublishedAt: time.Now().UTC().Format(time.RFC3339), UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		Tags: []string{}, Body: "b", Images: []postImageJSON{{
			Path: "images/" + strings.Repeat("a", 64) + ".png", SHA256: strings.Repeat("a", 64),
			Mime: "image/png", Width: 1, Height: 1, SizeBytes: 10,
		}},
	}
	raw, _ := json.Marshal(post)
	if err := os.WriteFile(filepath.Join(postDir, "post.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	warnings, err := c.Recover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) == 0 {
		t.Fatal("no recovery warning")
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("staging not cleaned: %v", err)
	}
	if _, err := os.Stat(filepath.Join(postDir, "post.json")); !os.IsNotExist(err) {
		t.Fatalf("broken post not quarantined: %v", err)
	}
	snap, _ := public.Refresh(ctx)
	for _, entry := range snap.Entries {
		if entry.Path == "posts/post-broken/post.json" {
			t.Fatal("quarantined post still in manifest")
		}
	}
}

func TestDraftValidationLimits(t *testing.T) {
	ctx := context.Background()
	c, _, _, _ := newCoordinator(t)
	if _, err := c.SaveDraft(ctx, DraftUpdate{
		Kind: storage.DraftKindPost, AuthorKind: "robot", ExpectedRevision: 0,
		Title: strptr("t"), BodyMarkdown: strptr("b"),
	}); err == nil {
		t.Fatal("invalid author kind accepted")
	}
	if _, err := c.SaveDraft(ctx, DraftUpdate{
		Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser, ExpectedRevision: 0,
		Title: strptr(strings.Repeat("t", MaxTitleRunes+1)), BodyMarkdown: strptr("b"),
	}); err == nil {
		t.Fatal("oversized title accepted")
	}
	if _, err := c.SaveDraft(ctx, DraftUpdate{
		Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser, ExpectedRevision: 0,
		Title: strptr("t"), BodyMarkdown: strptr(strings.Repeat("b", MaxBodyBytes+1)),
	}); err == nil {
		t.Fatal("oversized body accepted")
	}
	if _, err := c.SaveDraft(ctx, DraftUpdate{
		DraftID: "profile", Kind: storage.DraftKindProfile, ExpectedRevision: 0,
		AgentInterests: []string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"},
	}); err == nil {
		t.Fatal("too many interests accepted")
	}
}

func writeSourcePost(t *testing.T, dir, rel string, value map[string]any) []byte {
	t.Helper()
	target := filepath.Join(dir, "public", filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestImportExistingPostPreservesAuthorResourcesAndUnknownFields(t *testing.T) {
	ctx := context.Background()
	c, _, _, dir := newCoordinator(t)
	imageBytes := pngBytes(t, 24, 16)
	image, err := ValidateImage(imageBytes, "image", "photo.png")
	if err != nil {
		t.Fatal(err)
	}
	imageRel := "images/" + image.SHA256 + ".png"
	imagePath := filepath.Join(dir, "public", "posts", "post-agent-tool", "images", image.SHA256+".png")
	if err := os.MkdirAll(filepath.Dir(imagePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(imagePath, image.Bytes, 0o644); err != nil {
		t.Fatal(err)
	}
	source := map[string]any{
		"schema_version": 2,
		"id":             "post-agent-tool",
		"title":          "旧标题",
		"format":         "markdown",
		"author": map[string]any{
			"peer_id": peerA, "kind": "agent", "display_name": "Nebula", "origin": "agent-tool",
		},
		"published_at": "2026-11-01T10:00:00Z",
		"updated_at":   "2026-11-01T10:00:00Z",
		"tags":         []string{"旧标签"},
		"summary":      "旧摘要",
		"body":         "旧正文",
		"images": []map[string]any{{
			"path": imageRel, "sha256": image.SHA256, "mime": image.Mime,
			"width": image.Width, "height": image.Height, "size_bytes": len(image.Bytes),
		}},
		"revision":        3,
		"compat_extra":    map[string]any{"keep": true, "note": "unknown"},
		"agent_tool_hint": "preserve me",
	}
	writeSourcePost(t, dir, "posts/post-agent-tool/post.json", source)

	draft, err := c.ImportPost(ctx, "posts/post-agent-tool/post.json")
	if err != nil {
		t.Fatal(err)
	}
	if draft.AuthorKind != storage.DraftAuthorAgent || draft.PublishedPath != "posts/post-agent-tool/post.json" ||
		draft.PublishedSHA256 == "" || len(draft.ImageAssetIDs) != 1 || draft.Title != "旧标题" {
		t.Fatalf("imported draft = %+v", draft)
	}
	asset, found, err := c.store.GetPublicDraftAsset(ctx, draft.DraftID, draft.ImageAssetIDs[0])
	if err != nil || !found || asset.SHA256 != image.SHA256 {
		t.Fatalf("imported asset = %+v, %v, %v", asset, found, err)
	}
	same, err := c.ImportPost(ctx, "posts/post-agent-tool/post.json")
	if err != nil || same.DraftID != draft.DraftID {
		t.Fatalf("reimport = %+v, %v", same, err)
	}

	draft, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorAgent,
		ExpectedRevision: draft.Revision, Title: strptr("新标题"), BodyMarkdown: strptr("新正文"),
		Tags: []string{"新标签"}, ImageAssetIDs: draft.ImageAssetIDs,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := c.Publish(ctx, draft.DraftID, draft.Revision, draft.PublishedSHA256)
	if err != nil || result.Status != StatusPublished {
		t.Fatalf("publish imported = %+v, %v", result, err)
	}
	if result.PostPath != "posts/post-agent-tool/post.json" {
		t.Fatalf("imported post moved: %s", result.PostPath)
	}
	raw := mustRead(t, filepath.Join(dir, "public", "posts", "post-agent-tool", "post.json"))
	var saved map[string]json.RawMessage
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	var title string
	var compat map[string]any
	_ = json.Unmarshal(saved["title"], &title)
	_ = json.Unmarshal(saved["compat_extra"], &compat)
	if title != "新标题" || compat["keep"] != true {
		t.Fatalf("unknown fields not preserved: %s", raw)
	}
	var author postAuthorJSON
	if err := json.Unmarshal(saved["author"], &author); err != nil || author.Kind != "agent" || author.DisplayName != "Nebula" {
		t.Fatalf("author source changed: %+v %v", author, err)
	}
	var revision int64
	if err := json.Unmarshal(saved["revision"], &revision); err != nil || revision != 4 {
		t.Fatalf("revision = %d, %v", revision, err)
	}
	if _, err := os.Stat(imagePath); err != nil {
		t.Fatalf("image resource removed: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "public", "posts"))
	if len(entries) != 1 {
		t.Fatalf("edit created a second post: %+v", entries)
	}
}

func TestImportLegacyV1UpdatesOriginalAndRejectsUnowned(t *testing.T) {
	ctx := context.Background()
	c, _, _, dir := newCoordinator(t)
	writeSourcePost(t, dir, "posts/legacy.json", map[string]any{
		"schema_version": 1,
		"title":          "旧 v1",
		"format":         "markdown",
		"author":         map[string]any{"peer_id": peerA, "kind": "user", "display_name": "JO JO"},
		"published_at":   "2025-01-01T00:00:00Z",
		"tags":           []string{"legacy"},
		"body":           "旧正文",
		"legacy_extra":   "keep",
	})
	draft, err := c.ImportPost(ctx, "posts/legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	draft, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser,
		ExpectedRevision: draft.Revision, Title: strptr("新 v1"), BodyMarkdown: strptr("新正文"),
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := c.Publish(ctx, draft.DraftID, draft.Revision, draft.PublishedSHA256)
	if err != nil || result.Status != StatusPublished || result.PostPath != "posts/legacy.json" {
		t.Fatalf("publish v1 = %+v, %v", result, err)
	}
	raw := mustRead(t, filepath.Join(dir, "public", "posts", "legacy.json"))
	var saved map[string]json.RawMessage
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	var schema int
	var extra string
	_ = json.Unmarshal(saved["schema_version"], &schema)
	_ = json.Unmarshal(saved["legacy_extra"], &extra)
	if schema != 1 || extra != "keep" {
		t.Fatalf("v1 compatibility changed: %s", raw)
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "posts", "legacy", "post.json")); !os.IsNotExist(err) {
		t.Fatalf("v1 edit created a v2 duplicate: %v", err)
	}

	writeSourcePost(t, dir, "posts/post-remote/post.json", map[string]any{
		"schema_version": 2, "id": "post-remote", "title": "远端", "format": "markdown",
		"author":       map[string]any{"peer_id": "12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6", "kind": "user", "display_name": "Bob"},
		"published_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z",
		"tags": []string{}, "body": "远端正文", "images": []any{}, "revision": 1,
	})
	if _, err := c.ImportPost(ctx, "posts/post-remote/post.json"); err == nil {
		t.Fatal("remote-authored post was importable")
	}
}

func TestExternalMetadataChangeDuringResourceWriteConflicts(t *testing.T) {
	ctx := context.Background()
	c, _, _, dir := newCoordinator(t)
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser, ExpectedRevision: 0,
		Title: strptr("旧标题"), BodyMarkdown: strptr("旧正文"),
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := c.Publish(ctx, draft.DraftID, draft.Revision, "")
	if err != nil || first.Status != StatusPublished {
		t.Fatalf("first publish = %+v, %v", first, err)
	}
	oldImage, err := c.PutDraftImage(ctx, draft.DraftID, "image", "old.png", pngBytes(t, 10, 10))
	if err != nil {
		t.Fatal(err)
	}
	newImage, err := c.PutDraftImage(ctx, draft.DraftID, "image", "new.png", pngBytes(t, 12, 12))
	if err != nil {
		t.Fatal(err)
	}
	draft, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindPost, AuthorKind: storage.DraftAuthorUser,
		ExpectedRevision: draft.Revision, Title: strptr("新标题"), BodyMarkdown: strptr("新正文"),
		ImageAssetIDs: []string{oldImage.AssetID, newImage.AssetID},
	})
	if err != nil {
		t.Fatal(err)
	}
	metaPath := filepath.Join(dir, "public", "posts", postIDForDraft(draft.DraftID), "post.json")
	external := []byte("{\n  \"schema_version\": 2,\n  \"id\": \"external\",\n  \"title\": \"外部版本\",\n  \"format\": \"markdown\",\n  \"author\": {\"peer_id\": \"" + peerA + "\", \"kind\": \"user\", \"display_name\": \"JO JO\"},\n  \"published_at\": \"2026-11-01T00:00:00Z\",\n  \"updated_at\": \"2026-11-02T00:00:00Z\",\n  \"tags\": [],\n  \"body\": \"外部正文\",\n  \"images\": [],\n  \"revision\": 9\n}\n")
	c.metadataHook = func() error {
		return os.WriteFile(metaPath, external, 0o644)
	}
	result, err := c.Publish(ctx, draft.DraftID, draft.Revision, first.CurrentPublishedSHA256)
	c.metadataHook = nil
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StatusConflict || !strings.Contains(result.Error, "外部修改") {
		t.Fatalf("external change during resource write = %+v, %v", result, err)
	}
	if got := mustRead(t, metaPath); !bytes.Equal(got, external) {
		t.Fatalf("external metadata was overwritten: %s", got)
	}
	newPath := filepath.Join(dir, "public", "posts", postIDForDraft(draft.DraftID), "images", hashBytes(pngBytes(t, 12, 12))+".png")
	if _, err := os.Stat(newPath); !os.IsNotExist(err) {
		t.Fatalf("new image from failed publish remains: %v", err)
	}
}

func TestProfileAvatarCleanupKeepsIndependentImageAndUnmanagedFiles(t *testing.T) {
	ctx := context.Background()
	c, _, _, dir := newCoordinator(t)
	fixed := time.Date(2026, 11, 21, 8, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return fixed }
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		DraftID: "profile", Kind: storage.DraftKindProfile, ExpectedRevision: 0,
		AgentName: strptr("Agent A"), HumanName: strptr("Human A"),
	})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := c.PutDraftImage(ctx, draft.DraftID, "avatar", "avatar.png", pngBytes(t, 20, 20))
	if err != nil {
		t.Fatal(err)
	}
	human, err := c.PutDraftImage(ctx, draft.DraftID, "human_avatar", "human-avatar.png", pngBytes(t, 24, 24))
	if err != nil {
		t.Fatal(err)
	}
	draft, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindProfile, ExpectedRevision: draft.Revision,
		AvatarAssetID: agent.AssetID, HumanAvatarAssetID: human.AssetID,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := c.Publish(ctx, draft.DraftID, draft.Revision, "")
	if err != nil || first.Status != StatusPublished {
		t.Fatalf("first publish = %+v %v", first, err)
	}
	var firstProfile profileJSONV2
	raw, _ := os.ReadFile(filepath.Join(dir, "public", "profile", "profile.json"))
	if err := json.Unmarshal(raw, &firstProfile); err != nil {
		t.Fatal(err)
	}
	// Files with the same prefixes but not referenced by profile.json are not
	// managed by this feature and must survive cleanup.
	unmanaged := []string{"profile/avatar-deadbeef.png", "profile/human-avatar-deadbeef.png"}
	for _, rel := range unmanaged {
		if err := os.WriteFile(filepath.Join(dir, "public", rel), []byte("not-managed"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	human2, err := c.PutDraftImage(ctx, draft.DraftID, "human_avatar", "human-avatar-2.png", pngBytes(t, 30, 30))
	if err != nil {
		t.Fatal(err)
	}
	draft, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindProfile, ExpectedRevision: draft.Revision,
		ClearAvatar: true, HumanAvatarAssetID: human2.AssetID,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.Publish(ctx, draft.DraftID, draft.Revision, first.CurrentPublishedSHA256)
	if err != nil || second.Status != StatusPublished {
		t.Fatalf("second publish = %+v %v", second, err)
	}
	var secondProfile profileJSONV2
	raw, _ = os.ReadFile(filepath.Join(dir, "public", "profile", "profile.json"))
	if err := json.Unmarshal(raw, &secondProfile); err != nil {
		t.Fatal(err)
	}
	if secondProfile.Agent.Avatar != "" || secondProfile.Human.Avatar == "" {
		t.Fatalf("second profile avatars = %+v", secondProfile)
	}
	for _, gone := range []string{"profile/" + firstProfile.Agent.Avatar, "profile/" + firstProfile.Human.Avatar} {
		if _, err := os.Stat(filepath.Join(dir, "public", gone)); !os.IsNotExist(err) {
			t.Fatalf("old managed avatar %s still exists (err=%v)", gone, err)
		}
	}
	for _, keep := range append([]string{"profile/" + secondProfile.Human.Avatar}, unmanaged...) {
		if _, err := os.Stat(filepath.Join(dir, "public", keep)); err != nil {
			t.Fatalf("expected kept file %s: %v", keep, err)
		}
	}

	// Removing the human image must not remove the unmanaged same-prefix file.
	draft, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindProfile, ExpectedRevision: draft.Revision,
		ClearHumanAvatar: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	third, err := c.Publish(ctx, draft.DraftID, draft.Revision, second.CurrentPublishedSHA256)
	if err != nil || third.Status != StatusPublished {
		t.Fatalf("third publish = %+v %v", third, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "profile", secondProfile.Human.Avatar)); !os.IsNotExist(err) {
		t.Fatalf("removed human avatar still exists (err=%v)", err)
	}
	for _, keep := range unmanaged {
		if _, err := os.Stat(filepath.Join(dir, "public", keep)); err != nil {
			t.Fatalf("unmanaged file %s was removed: %v", keep, err)
		}
	}
}

func TestHumanAvatarOnlyProfilePublishesWithoutAgentAvatar(t *testing.T) {
	ctx := context.Background()
	c, _, _, dir := newCoordinator(t)
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		DraftID: "profile", Kind: storage.DraftKindProfile, ExpectedRevision: 0,
		HumanName: strptr("只发布人类头像"), HumanBio: strptr(""),
	})
	if err != nil {
		t.Fatal(err)
	}
	human, err := c.PutDraftImage(ctx, draft.DraftID, "human_avatar", "human.png", pngBytes(t, 26, 26))
	if err != nil {
		t.Fatal(err)
	}
	draft, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindProfile, ExpectedRevision: draft.Revision,
		HumanAvatarAssetID: human.AssetID,
	})
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Publish(ctx, draft.DraftID, draft.Revision, "")
	if err != nil || res.Status != StatusPublished {
		t.Fatalf("publish = %+v %v", res, err)
	}
	var profile profileJSONV2
	raw, _ := os.ReadFile(filepath.Join(dir, "public", "profile", "profile.json"))
	if err := json.Unmarshal(raw, &profile); err != nil {
		t.Fatal(err)
	}
	if profile.Agent.Avatar != "" || profile.Human.Avatar == "" || profile.Human.Name != "只发布人类头像" {
		t.Fatalf("profile = %+v", profile)
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "profile", profile.Human.Avatar)); err != nil {
		t.Fatalf("human avatar file: %v", err)
	}
	found := false
	for _, file := range res.Files {
		if file.Path == "profile/"+profile.Human.Avatar {
			found = true
		}
	}
	if !found {
		t.Fatalf("publish manifest does not include human avatar: %+v", res.Files)
	}
}

func TestOldClientSavingUnrelatedProfileFieldsKeepsHumanAvatar(t *testing.T) {
	ctx := context.Background()
	c, _, _, _ := newCoordinator(t)
	draft, err := c.SaveDraft(ctx, DraftUpdate{
		DraftID: "profile", Kind: storage.DraftKindProfile, ExpectedRevision: 0,
		AgentName: strptr("Nova"), HumanName: strptr("JO JO"),
	})
	if err != nil {
		t.Fatal(err)
	}
	human, err := c.PutDraftImage(ctx, draft.DraftID, "human_avatar", "human.png", pngBytes(t, 18, 18))
	if err != nil {
		t.Fatal(err)
	}
	draft, err = c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindProfile, ExpectedRevision: draft.Revision,
		HumanAvatarAssetID: human.AssetID,
	})
	if err != nil {
		t.Fatal(err)
	}
	// This is what an older client does: write a text field it knows about,
	// leaving the optional human-avatar field unset.
	updated, err := c.SaveDraft(ctx, DraftUpdate{
		DraftID: draft.DraftID, Kind: storage.DraftKindProfile, ExpectedRevision: draft.Revision,
		AgentDescription: strptr("新简介"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.HumanAvatarAssetID != human.AssetID || updated.AgentDescription != "新简介" {
		t.Fatalf("old-client update cleared human avatar: %+v", updated)
	}
	if _, found, _ := c.store.GetPublicDraftAsset(ctx, draft.DraftID, human.AssetID); !found {
		t.Fatal("old-client update deleted the human avatar asset")
	}
	cleared, err := c.SaveDraft(ctx, DraftUpdate{
		DraftID: updated.DraftID, Kind: storage.DraftKindProfile, ExpectedRevision: updated.Revision,
		ClearHumanAvatar: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cleared.HumanAvatarAssetID != "" {
		t.Fatalf("explicit clear kept human avatar: %+v", cleared)
	}
	if _, found, _ := c.store.GetPublicDraftAsset(ctx, draft.DraftID, human.AssetID); found {
		t.Fatal("explicit clear left unreferenced human avatar asset")
	}
}
