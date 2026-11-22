package storage

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMigrateV9ToV10CreatesDraftTablesAndKeepsMessages(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO schema_migrations (version, applied_at_ms) VALUES (9, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE messages (
		message_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, direction TEXT NOT NULL,
		text TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL,
		acked_at_ms INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT 'unknown',
		delivery_status TEXT NOT NULL DEFAULT 'unknown', delivery_error TEXT NOT NULL DEFAULT '',
		delivery_updated_at_ms INTEGER NOT NULL DEFAULT 0, client_request_id TEXT NOT NULL DEFAULT '')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO messages (message_id, peer_id, direction, text, created_at_ms, delivery_status)
		VALUES ('old-1', 'peer-old', 'in', '保留消息', 1234, 'received')`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	store, err := Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("Open migrated v9: %v", err)
	}
	defer func() { _ = store.Close() }()
	ctx := context.Background()
	msgs, err := store.RecentMessages(ctx, 10)
	if err != nil || len(msgs) != 1 || msgs[0].Text != "保留消息" {
		t.Fatalf("old message = %+v, err=%v", msgs, err)
	}
	var version int
	if err := store.DB().QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("schema version = %d, err=%v", version, err)
	}
	for _, table := range []string{"public_drafts", "public_draft_assets"} {
		var name string
		if err := store.DB().QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name); err != nil {
			t.Fatalf("missing table %s: %v", table, err)
		}
	}
	if _, _, err := store.GetPublicDraft(ctx, "profile"); err != nil {
		t.Fatalf("draft table unusable: %v", err)
	}
}

func TestPublicDraftCRUDRevisionAndAssets(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	draft := PublicDraft{
		DraftID: "draft-100-abcdef123456", Kind: DraftKindPost, AuthorKind: DraftAuthorUser,
		AgentInterests: []string{}, Tags: []string{"日常"}, ImageAssetIDs: []string{},
		Title: "第一条", BodyMarkdown: "正文", CreatedAt: time.Now(),
	}
	created, err := store.CreatePublicDraft(ctx, draft)
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 0 || created.UpdatedAt.IsZero() {
		t.Fatalf("created = %+v", created)
	}
	got, found, err := store.GetPublicDraft(ctx, draft.DraftID)
	if err != nil || !found || got.Title != "第一条" || len(got.Tags) != 1 {
		t.Fatalf("get = %+v found=%t err=%v", got, found, err)
	}
	if _, err := store.CreatePublicDraft(ctx, draft); err == nil {
		t.Fatal("duplicate draft id was accepted")
	}

	updated := got
	updated.Title = "第二条"
	if _, err := store.UpdatePublicDraft(ctx, updated, 99); !errors.Is(err, ErrDraftConflict) {
		t.Fatalf("stale update error = %v, want conflict", err)
	}
	updated, err = store.UpdatePublicDraft(ctx, updated, 0)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 1 || updated.Title != "第二条" {
		t.Fatalf("updated = %+v", updated)
	}

	asset, err := store.PutPublicDraftAsset(ctx, PublicDraftAsset{
		DraftID: draft.DraftID, Role: "image", SHA256: "a" + strings.Repeat("0", 63), Mime: "image/png",
		Width: 10, Height: 10, Bytes: []byte("png-bytes"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if asset.AssetID == "" || asset.SizeBytes == 0 {
		t.Fatalf("asset = %+v", asset)
	}
	read, found, err := store.GetPublicDraftAsset(ctx, draft.DraftID, asset.AssetID)
	if err != nil || !found || string(read.Bytes) != "png-bytes" {
		t.Fatalf("asset read = %+v found=%t err=%v", read, found, err)
	}

	updated.ImageAssetIDs = []string{asset.AssetID}
	updated, err = store.UpdatePublicDraft(ctx, updated, updated.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.ImageAssetIDs) != 1 {
		t.Fatalf("image ids = %+v", updated.ImageAssetIDs)
	}
	// Removing the reference deletes the private asset row.
	updated.ImageAssetIDs = []string{}
	updated, err = store.UpdatePublicDraft(ctx, updated, updated.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, found, _ := store.GetPublicDraftAsset(ctx, draft.DraftID, asset.AssetID); found {
		t.Fatal("unreferenced asset was not cleaned")
	}

	rows, more, err := store.ListPublicDrafts(ctx, DraftKindPost, "", 10)
	if err != nil || len(rows) != 1 || more {
		t.Fatalf("list = %+v more=%t err=%v", rows, more, err)
	}
	if cursor := EncodeDraftCursor(rows[0]); cursor == "" {
		t.Fatal("empty cursor")
	}
	if deleted, err := store.DeletePublicDraft(ctx, draft.DraftID, 0); !errors.Is(err, ErrDraftConflict) || deleted {
		t.Fatalf("stale delete = %t, %v", deleted, err)
	}
	if deleted, err := store.DeletePublicDraft(ctx, draft.DraftID, updated.Revision); err != nil || !deleted {
		t.Fatalf("delete = %t, %v", deleted, err)
	}
}

func TestPublicDraftAssetQuotaAndProfileID(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	if _, err := store.CreatePublicDraft(ctx, PublicDraft{
		DraftID: "draft-200-abcdef123456", Kind: DraftKindPost, AuthorKind: DraftAuthorUser,
	}); err != nil {
		t.Fatal(err)
	}
	big := make([]byte, MaxDraftImageBytes+1)
	if _, err := store.PutPublicDraftAsset(ctx, PublicDraftAsset{
		DraftID: "draft-200-abcdef123456", Role: "image", SHA256: "b" + strings.Repeat("0", 63), Mime: "image/png", Bytes: big,
	}); !errors.Is(err, ErrDraftAsset) {
		t.Fatalf("oversized asset error = %v, want ErrDraftAsset", err)
	}
	profile, err := store.CreatePublicDraft(ctx, PublicDraft{DraftID: "profile", Kind: DraftKindProfile, AuthorKind: DraftAuthorUser})
	if err != nil || profile.Kind != DraftKindProfile {
		t.Fatalf("profile draft = %+v, %v", profile, err)
	}
	if _, err := store.CreatePublicDraft(ctx, PublicDraft{
		DraftID: "draft-300-abcdef123456", Kind: DraftKindProfile, AuthorKind: DraftAuthorUser,
	}); err == nil {
		t.Fatal("profile draft with non-fixed id was accepted")
	}
}

func TestDraftAssetLookupIsScopedToOwningDraft(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	first, err := store.CreatePublicDraft(ctx, PublicDraft{
		DraftID: "draft-a-abcdef123456", Kind: DraftKindPost, AuthorKind: DraftAuthorUser,
		Title: "a", BodyMarkdown: "a", Tags: []string{}, ImageAssetIDs: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreatePublicDraft(ctx, PublicDraft{
		DraftID: "draft-b-abcdef123456", Kind: DraftKindPost, AuthorKind: DraftAuthorUser,
		Title: "b", BodyMarkdown: "b", Tags: []string{}, ImageAssetIDs: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	asset, err := store.PutPublicDraftAsset(ctx, PublicDraftAsset{
		DraftID: first.DraftID, Role: "image", SHA256: strings.Repeat("a", 64),
		Mime: "image/png", Width: 1, Height: 1, Bytes: []byte("private-bytes"),
	})
	if err != nil {
		t.Fatal(err)
	}
	got, found, err := store.GetPublicDraftAsset(ctx, first.DraftID, asset.AssetID)
	if err != nil || !found || string(got.Bytes) != "private-bytes" {
		t.Fatalf("own asset = %+v, %v, %v", got, found, err)
	}
	if _, found, err := store.GetPublicDraftAsset(ctx, second.DraftID, asset.AssetID); err != nil || found {
		t.Fatalf("asset leaked across drafts: found=%v err=%v", found, err)
	}
	if _, found, err := store.GetPublicDraftAsset(ctx, first.DraftID, "asset-missing"); err != nil || found {
		t.Fatalf("missing asset reported found=%v err=%v", found, err)
	}
}

func TestMigrateV11DraftAssetsToV12AddsHumanAvatarAndKeepsOldRows(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)`,
		`INSERT INTO schema_migrations (version, applied_at_ms) VALUES (11, 1)`,
		`CREATE TABLE public_drafts (
			draft_id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('profile','post')),
			author_kind TEXT NOT NULL DEFAULT 'agent' CHECK (author_kind IN ('user','agent')),
			revision INTEGER NOT NULL DEFAULT 0,
			agent_name TEXT NOT NULL DEFAULT '',
			agent_description TEXT NOT NULL DEFAULT '',
			agent_interests_json TEXT NOT NULL DEFAULT '[]',
			agent_conversation_style TEXT NOT NULL DEFAULT '',
			human_name TEXT NOT NULL DEFAULT '',
			human_bio_markdown TEXT NOT NULL DEFAULT '',
			avatar_asset_id TEXT NOT NULL DEFAULT '',
			title TEXT NOT NULL DEFAULT '',
			body_markdown TEXT NOT NULL DEFAULT '',
			tags_json TEXT NOT NULL DEFAULT '[]',
			image_asset_ids_json TEXT NOT NULL DEFAULT '[]',
			published_path TEXT NOT NULL DEFAULT '',
			published_sha256 TEXT NOT NULL DEFAULT '',
			published_revision INTEGER NOT NULL DEFAULT 0,
			created_at_ms INTEGER NOT NULL,
			updated_at_ms INTEGER NOT NULL
		)`,
		`CREATE TABLE public_draft_assets (
			asset_id TEXT PRIMARY KEY,
			draft_id TEXT NOT NULL,
			role TEXT NOT NULL CHECK (role IN ('avatar','image')),
			sha256 TEXT NOT NULL,
			mime TEXT NOT NULL,
			width INTEGER NOT NULL,
			height INTEGER NOT NULL,
			size_bytes INTEGER NOT NULL,
			bytes BLOB NOT NULL,
			created_at_ms INTEGER NOT NULL
		)`,
		`INSERT INTO public_drafts (draft_id, kind, author_kind, revision, human_name, created_at_ms, updated_at_ms)
			VALUES ('profile', 'profile', 'user', 4, '旧人类', 1000, 2000)`,
		`INSERT INTO public_draft_assets (asset_id, draft_id, role, sha256, mime, width, height, size_bytes, bytes, created_at_ms)
			VALUES ('asset-old-avatar', 'profile', 'avatar', '` + strings.Repeat("a", 64) + `', 'image/png', 10, 10, 4, x'89504e47', 1000)`,
	}
	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("prepare v11 database: %v", err)
		}
	}
	_ = db.Close()

	store, err := Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("Open migrated v11: %v", err)
	}
	defer func() { _ = store.Close() }()
	ctx := context.Background()
	draft, found, err := store.GetPublicDraft(ctx, "profile")
	if err != nil || !found || draft.HumanName != "旧人类" || draft.Revision != 4 {
		t.Fatalf("old draft = %+v found=%t err=%v", draft, found, err)
	}
	if draft.HumanAvatarAssetID != "" {
		t.Fatalf("old draft human avatar = %q, want empty", draft.HumanAvatarAssetID)
	}
	old, found, err := store.GetPublicDraftAsset(ctx, "profile", "asset-old-avatar")
	if err != nil || !found || old.Role != "avatar" || len(old.Bytes) != 4 {
		t.Fatalf("old avatar = %+v found=%t err=%v", old, found, err)
	}
	human, err := store.PutPublicDraftAsset(ctx, PublicDraftAsset{
		DraftID: "profile", Role: "human_avatar", SHA256: strings.Repeat("b", 64),
		Mime: "image/png", Width: 12, Height: 12, Bytes: []byte("human-avatar"),
	})
	if err != nil {
		t.Fatalf("insert human avatar after migration: %v", err)
	}
	draft.HumanAvatarAssetID = human.AssetID
	updated, err := store.UpdatePublicDraft(ctx, draft, draft.Revision)
	if err != nil || updated.HumanAvatarAssetID != human.AssetID || updated.AvatarAssetID != "" {
		t.Fatalf("updated = %+v err=%v", updated, err)
	}
	var tableSQL string
	if err := store.DB().QueryRow(`SELECT sql FROM sqlite_master WHERE type='table' AND name='public_draft_assets'`).Scan(&tableSQL); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tableSQL, "human_avatar") {
		t.Fatalf("migrated asset table does not allow human_avatar: %s", tableSQL)
	}
	var version int
	if err := store.DB().QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("schema version = %d, err=%v", version, err)
	}
}

func TestPublicDraftAgentAndHumanAvatarsAreIndependent(t *testing.T) {
	store, _ := open(t)
	ctx := context.Background()
	draft, err := store.CreatePublicDraft(ctx, PublicDraft{
		DraftID: "profile", Kind: DraftKindProfile, AuthorKind: DraftAuthorUser,
		AgentInterests: []string{}, Tags: []string{}, ImageAssetIDs: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	put := func(role, seed string) PublicDraftAsset {
		t.Helper()
		asset, err := store.PutPublicDraftAsset(ctx, PublicDraftAsset{
			DraftID: draft.DraftID, Role: role, SHA256: seed + strings.Repeat("0", 63),
			Mime: "image/png", Width: 10, Height: 10, Bytes: []byte(role + "-bytes"),
		})
		if err != nil {
			t.Fatalf("put %s: %v", role, err)
		}
		return asset
	}
	agent := put("avatar", "a")
	human := put("human_avatar", "b")
	draft.AvatarAssetID = agent.AssetID
	draft.HumanAvatarAssetID = human.AssetID
	draft, err = store.UpdatePublicDraft(ctx, draft, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if draft.AvatarAssetID != agent.AssetID || draft.HumanAvatarAssetID != human.AssetID {
		t.Fatalf("both avatars = %+v", draft)
	}

	// Clearing only the human avatar keeps the Agent image and removes only
	// the now-unreferenced human asset row.
	draft.HumanAvatarAssetID = ""
	draft, err = store.UpdatePublicDraft(ctx, draft, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if draft.HumanAvatarAssetID != "" || draft.AvatarAssetID != agent.AssetID {
		t.Fatalf("after human clear = %+v", draft)
	}
	if _, found, _ := store.GetPublicDraftAsset(ctx, draft.DraftID, human.AssetID); found {
		t.Fatal("cleared human avatar asset was not removed")
	}
	if _, found, _ := store.GetPublicDraftAsset(ctx, draft.DraftID, agent.AssetID); !found {
		t.Fatal("clearing human avatar removed the Agent avatar")
	}

	// Replace the human avatar with a second asset, then clear only the Agent
	// image; the human replacement must survive.
	human2 := put("human_avatar", "c")
	draft.HumanAvatarAssetID = human2.AssetID
	draft, err = store.UpdatePublicDraft(ctx, draft, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	draft.AvatarAssetID = ""
	draft, err = store.UpdatePublicDraft(ctx, draft, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if draft.AvatarAssetID != "" || draft.HumanAvatarAssetID != human2.AssetID {
		t.Fatalf("after agent clear = %+v", draft)
	}
	if _, found, _ := store.GetPublicDraftAsset(ctx, draft.DraftID, agent.AssetID); found {
		t.Fatal("cleared Agent avatar asset was not removed")
	}
	if _, found, _ := store.GetPublicDraftAsset(ctx, draft.DraftID, human2.AssetID); !found {
		t.Fatal("clearing Agent avatar removed the human avatar")
	}
}
