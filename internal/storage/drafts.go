package storage

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Public draft kinds. A profile draft is private until the user publishes it;
// a post draft similarly never enters public/ before publish.
const (
	DraftKindProfile = "profile"
	DraftKindPost    = "post"

	DraftAuthorUser  = "user"
	DraftAuthorAgent = "agent"

	MaxPublicDraftsPerKind = 100
	MaxDraftImageBytes     = 64 << 20
	MaxDraftImageCount     = 4
)

var (
	ErrDraftNotFound = errors.New("storage: public draft not found")
	ErrDraftConflict = errors.New("storage: public draft revision conflict")
	ErrDraftLimit    = errors.New("storage: public draft limit reached")
	ErrDraftAsset    = errors.New("storage: public draft asset limit reached")
)

// PublicDraft is one private SQLite draft. Published* is metadata about the
// last successful public commit; the bytes themselves live in public/.
type PublicDraft struct {
	DraftID                string
	Kind                   string
	AuthorKind             string
	Revision               int64
	AgentName              string
	AgentDescription       string
	AgentInterests         []string
	AgentConversationStyle string
	HumanName              string
	HumanBioMarkdown       string
	HumanAvatarAssetID     string
	AvatarAssetID          string
	Title                  string
	BodyMarkdown           string
	Tags                   []string
	ImageAssetIDs          []string
	PublishedPath          string
	PublishedSHA256        string
	PublishedRevision      int64
	CreatedAt              time.Time
	UpdatedAt              time.Time
}

// PublicDraftAsset is one image/avatar blob stored privately in SQLite.
type PublicDraftAsset struct {
	AssetID   string
	DraftID   string
	Role      string
	SHA256    string
	Mime      string
	Width     int
	Height    int
	SizeBytes int64
	Bytes     []byte
	CreatedAt time.Time
}

// ValidateDraftID constrains the opaque id used by local RPCs. The fixed
// profile draft id is the only non-generated id.
func ValidateDraftID(id string) bool {
	if id == "profile" {
		return true
	}
	if len(id) < 8 || len(id) > 64 || !strings.HasPrefix(id, "draft-") {
		return false
	}
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			continue
		}
		return false
	}
	return true
}

func validateDraftKind(kind string) error {
	if kind != DraftKindProfile && kind != DraftKindPost {
		return fmt.Errorf("storage: invalid draft kind %q", kind)
	}
	return nil
}

func validateAuthorKind(kind string) error {
	if kind != DraftAuthorUser && kind != DraftAuthorAgent {
		return fmt.Errorf("storage: invalid draft author kind %q", kind)
	}
	return nil
}

func encodeStringList(values []string) (string, error) {
	if values == nil {
		values = []string{}
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func decodeStringList(raw string) []string {
	if raw == "" {
		return []string{}
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil || out == nil {
		return []string{}
	}
	return out
}

func (s *Store) draftTx(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string) (PublicDraft, bool, error) {
	row := q.QueryRowContext(ctx, `SELECT draft_id, kind, author_kind, revision,
		agent_name, agent_description, agent_interests_json, agent_conversation_style,
		human_name, human_bio_markdown, human_avatar_asset_id, avatar_asset_id, title, body_markdown,
		tags_json, image_asset_ids_json, published_path, published_sha256,
		published_revision, created_at_ms, updated_at_ms
		FROM public_drafts WHERE draft_id=?`, id)
	var d PublicDraft
	var interests, tags, images string
	var created, updated int64
	err := row.Scan(&d.DraftID, &d.Kind, &d.AuthorKind, &d.Revision,
		&d.AgentName, &d.AgentDescription, &interests, &d.AgentConversationStyle,
		&d.HumanName, &d.HumanBioMarkdown, &d.HumanAvatarAssetID, &d.AvatarAssetID, &d.Title, &d.BodyMarkdown,
		&tags, &images, &d.PublishedPath, &d.PublishedSHA256,
		&d.PublishedRevision, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return PublicDraft{}, false, nil
	}
	if err != nil {
		return PublicDraft{}, false, fmt.Errorf("read public draft: %w", err)
	}
	d.AgentInterests = decodeStringList(interests)
	d.Tags = decodeStringList(tags)
	d.ImageAssetIDs = decodeStringList(images)
	d.CreatedAt = time.UnixMilli(created)
	d.UpdatedAt = time.UnixMilli(updated)
	return d, true, nil
}

// GetPublicDraft returns one draft.
func (s *Store) GetPublicDraft(ctx context.Context, id string) (PublicDraft, bool, error) {
	return s.draftTx(ctx, s.db, id)
}

// FindPublicDraftByPublishedPath returns the newest private draft whose last
// public target is exactly rel. Import uses this to reopen the same edit draft
// instead of creating a second copy for an already published post.
func (s *Store) FindPublicDraftByPublishedPath(ctx context.Context, rel string) (PublicDraft, bool, error) {
	row := s.db.QueryRowContext(ctx, `SELECT draft_id, kind, author_kind, revision,
		agent_name, agent_description, agent_interests_json, agent_conversation_style,
		human_name, human_bio_markdown, human_avatar_asset_id, avatar_asset_id, title, body_markdown,
		tags_json, image_asset_ids_json, published_path, published_sha256,
		published_revision, created_at_ms, updated_at_ms
		FROM public_drafts WHERE published_path=? AND kind=?
		ORDER BY updated_at_ms DESC, draft_id DESC LIMIT 1`, rel, DraftKindPost)
	var d PublicDraft
	var interests, tags, images string
	var created, updated int64
	err := row.Scan(&d.DraftID, &d.Kind, &d.AuthorKind, &d.Revision,
		&d.AgentName, &d.AgentDescription, &interests, &d.AgentConversationStyle,
		&d.HumanName, &d.HumanBioMarkdown, &d.HumanAvatarAssetID, &d.AvatarAssetID, &d.Title, &d.BodyMarkdown,
		&tags, &images, &d.PublishedPath, &d.PublishedSHA256,
		&d.PublishedRevision, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return PublicDraft{}, false, nil
	}
	if err != nil {
		return PublicDraft{}, false, fmt.Errorf("find public draft by published path: %w", err)
	}
	d.AgentInterests = decodeStringList(interests)
	d.Tags = decodeStringList(tags)
	d.ImageAssetIDs = decodeStringList(images)
	d.CreatedAt = time.UnixMilli(created)
	d.UpdatedAt = time.UnixMilli(updated)
	return d, true, nil
}

// ListPublicDrafts returns newest-first private drafts and whether more exist.
func (s *Store) ListPublicDrafts(ctx context.Context, kind, before string, limit int) ([]PublicDraft, bool, error) {
	if kind != "" {
		if err := validateDraftKind(kind); err != nil {
			return nil, false, err
		}
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	query := `SELECT draft_id, kind, author_kind, revision,
		agent_name, agent_description, agent_interests_json, agent_conversation_style,
		human_name, human_bio_markdown, human_avatar_asset_id, avatar_asset_id, title, body_markdown,
		tags_json, image_asset_ids_json, published_path, published_sha256,
		published_revision, created_at_ms, updated_at_ms FROM public_drafts`
	var args []any
	var where []string
	if kind != "" {
		where = append(where, "kind=?")
		args = append(args, kind)
	}
	if strings.TrimSpace(before) != "" {
		at, id, err := decodeDraftCursor(before)
		if err != nil {
			return nil, false, err
		}
		where = append(where, "(updated_at_ms < ? OR (updated_at_ms = ? AND draft_id < ?))")
		args = append(args, at, at, id)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY updated_at_ms DESC, draft_id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, fmt.Errorf("list public drafts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]PublicDraft, 0, limit)
	for rows.Next() {
		var d PublicDraft
		var interests, tags, images string
		var created, updated int64
		if err := rows.Scan(&d.DraftID, &d.Kind, &d.AuthorKind, &d.Revision,
			&d.AgentName, &d.AgentDescription, &interests, &d.AgentConversationStyle,
			&d.HumanName, &d.HumanBioMarkdown, &d.HumanAvatarAssetID, &d.AvatarAssetID, &d.Title, &d.BodyMarkdown,
			&tags, &images, &d.PublishedPath, &d.PublishedSHA256,
			&d.PublishedRevision, &created, &updated); err != nil {
			return nil, false, fmt.Errorf("scan public draft: %w", err)
		}
		d.AgentInterests = decodeStringList(interests)
		d.Tags = decodeStringList(tags)
		d.ImageAssetIDs = decodeStringList(images)
		d.CreatedAt = time.UnixMilli(created)
		d.UpdatedAt = time.UnixMilli(updated)
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate public drafts: %w", err)
	}
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	return out, hasMore, nil
}

// EncodeDraftCursor returns an opaque cursor for ListPublicDrafts.
func EncodeDraftCursor(d PublicDraft) string {
	raw, _ := json.Marshal(struct {
		At int64  `json:"at"`
		ID string `json:"id"`
	}{d.UpdatedAt.UnixMilli(), d.DraftID})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeDraftCursor(raw string) (int64, string, error) {
	if len(raw) > 512 {
		return 0, "", ErrInvalidCursor
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return 0, "", ErrInvalidCursor
	}
	var env struct {
		At int64  `json:"at"`
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &env); err != nil || env.At < 0 || env.ID == "" || len(env.ID) > 64 {
		return 0, "", ErrInvalidCursor
	}
	return env.At, env.ID, nil
}

// CreatePublicDraft inserts a new private draft. Creation of a second profile
// draft is rejected; the fixed id "profile" is the only profile draft.
func (s *Store) CreatePublicDraft(ctx context.Context, d PublicDraft) (PublicDraft, error) {
	if !ValidateDraftID(d.DraftID) {
		return PublicDraft{}, fmt.Errorf("storage: invalid draft id")
	}
	if err := validateDraftKind(d.Kind); err != nil {
		return PublicDraft{}, err
	}
	if d.Kind == DraftKindProfile && d.DraftID != "profile" {
		return PublicDraft{}, fmt.Errorf("storage: profile draft id must be %q", "profile")
	}
	if d.Kind == DraftKindPost && d.DraftID == "profile" {
		return PublicDraft{}, fmt.Errorf("storage: post draft id must not be profile")
	}
	if err := validateAuthorKind(d.AuthorKind); err != nil {
		return PublicDraft{}, err
	}
	if d.Revision != 0 {
		return PublicDraft{}, fmt.Errorf("storage: new draft must have revision 0")
	}
	if d.PublishedPath == "" && (d.PublishedSHA256 != "" || d.PublishedRevision != 0) {
		return PublicDraft{}, fmt.Errorf("storage: unpublished draft cannot carry published metadata")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PublicDraft{}, fmt.Errorf("begin create draft: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM public_drafts WHERE kind=?`, d.Kind).Scan(&count); err != nil {
		return PublicDraft{}, fmt.Errorf("count drafts: %w", err)
	}
	if count >= MaxPublicDraftsPerKind {
		return PublicDraft{}, ErrDraftLimit
	}
	now := time.Now()
	if d.CreatedAt.IsZero() {
		d.CreatedAt = now
	}
	d.UpdatedAt = now
	interests, err := encodeStringList(d.AgentInterests)
	if err != nil {
		return PublicDraft{}, err
	}
	tags, err := encodeStringList(d.Tags)
	if err != nil {
		return PublicDraft{}, err
	}
	images, err := encodeStringList(d.ImageAssetIDs)
	if err != nil {
		return PublicDraft{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO public_drafts
		(draft_id, kind, author_kind, revision, agent_name, agent_description,
		 agent_interests_json, agent_conversation_style, human_name, human_bio_markdown,
		 human_avatar_asset_id, avatar_asset_id, title, body_markdown, tags_json, image_asset_ids_json,
		 published_path, published_sha256, published_revision, created_at_ms, updated_at_ms)
		VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.DraftID, d.Kind, d.AuthorKind, d.AgentName, d.AgentDescription,
		interests, d.AgentConversationStyle, d.HumanName, d.HumanBioMarkdown, d.HumanAvatarAssetID,
		d.AvatarAssetID, d.Title, d.BodyMarkdown, tags, images,
		d.PublishedPath, d.PublishedSHA256, d.PublishedRevision,
		d.CreatedAt.UnixMilli(), d.UpdatedAt.UnixMilli())
	if err != nil {
		return PublicDraft{}, fmt.Errorf("insert draft: %w", err)
	}
	d.Revision = 0
	if err := tx.Commit(); err != nil {
		return PublicDraft{}, fmt.Errorf("commit create draft: %w", err)
	}
	return d, nil
}

// UpdatePublicDraft replaces editable fields and increments revision only when
// expectedRevision matches. It never changes kind or published_* metadata.
func (s *Store) UpdatePublicDraft(ctx context.Context, d PublicDraft, expectedRevision int64) (PublicDraft, error) {
	if !ValidateDraftID(d.DraftID) {
		return PublicDraft{}, fmt.Errorf("storage: invalid draft id")
	}
	if err := validateAuthorKind(d.AuthorKind); err != nil {
		return PublicDraft{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PublicDraft{}, fmt.Errorf("begin update draft: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	existing, found, err := s.draftTx(ctx, tx, d.DraftID)
	if err != nil {
		return PublicDraft{}, err
	}
	if !found {
		return PublicDraft{}, ErrDraftNotFound
	}
	if existing.Revision != expectedRevision {
		return PublicDraft{}, ErrDraftConflict
	}
	if existing.Kind != d.Kind {
		return PublicDraft{}, fmt.Errorf("storage: draft kind cannot change")
	}
	interests, err := encodeStringList(d.AgentInterests)
	if err != nil {
		return PublicDraft{}, err
	}
	tags, err := encodeStringList(d.Tags)
	if err != nil {
		return PublicDraft{}, err
	}
	images, err := encodeStringList(d.ImageAssetIDs)
	if err != nil {
		return PublicDraft{}, err
	}
	now := time.Now()
	res, err := tx.ExecContext(ctx, `UPDATE public_drafts SET
		author_kind=?, revision=revision+1, agent_name=?, agent_description=?,
		agent_interests_json=?, agent_conversation_style=?, human_name=?,
		human_bio_markdown=?, human_avatar_asset_id=?, avatar_asset_id=?, title=?, body_markdown=?,
		tags_json=?, image_asset_ids_json=?, updated_at_ms=?
		WHERE draft_id=? AND revision=?`,
		d.AuthorKind, d.AgentName, d.AgentDescription, interests, d.AgentConversationStyle,
		d.HumanName, d.HumanBioMarkdown, d.HumanAvatarAssetID, d.AvatarAssetID, d.Title, d.BodyMarkdown,
		tags, images, now.UnixMilli(), d.DraftID, expectedRevision)
	if err != nil {
		return PublicDraft{}, fmt.Errorf("update draft: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return PublicDraft{}, err
	}
	if n == 0 {
		return PublicDraft{}, ErrDraftConflict
	}
	// Remove assets that are no longer referenced by this draft. Only this
	// draft owns its asset rows.
	keep := append([]string{d.HumanAvatarAssetID, d.AvatarAssetID}, d.ImageAssetIDs...)
	if err := deleteUnreferencedAssetsTx(ctx, tx, d.DraftID, keep); err != nil {
		return PublicDraft{}, err
	}
	updated, _, err := s.draftTx(ctx, tx, d.DraftID)
	if err != nil {
		return PublicDraft{}, err
	}
	if err := tx.Commit(); err != nil {
		return PublicDraft{}, fmt.Errorf("commit update draft: %w", err)
	}
	return updated, nil
}

// DeletePublicDraft removes one draft and its private assets when the revision
// matches. A stale caller must reload instead of deleting a newer draft.
func (s *Store) DeletePublicDraft(ctx context.Context, id string, expectedRevision int64) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin delete draft: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `DELETE FROM public_drafts WHERE draft_id=? AND revision=?`, id, expectedRevision)
	if err != nil {
		return false, fmt.Errorf("delete draft: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		if _, found, getErr := s.draftTx(ctx, tx, id); getErr != nil {
			return false, getErr
		} else if !found {
			return false, ErrDraftNotFound
		}
		return false, ErrDraftConflict
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM public_draft_assets WHERE draft_id=?`, id); err != nil {
		return false, fmt.Errorf("delete draft assets: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit delete draft: %w", err)
	}
	return true, nil
}

// SetPublicDraftPublished records the committed public metadata. It is called
// only inside the publication critical section after the public files exist.
func (s *Store) SetPublicDraftPublished(ctx context.Context, id string, revision int64, publishedPath, publishedSHA string) error {
	// Do not change updated_at_ms here: it is one input to the deterministic
	// target bytes. Rewriting it after commit would make a same-revision retry
	// produce a different post.json/profile.json instead of ALREADY_PUBLISHED.
	res, err := s.db.ExecContext(ctx, `UPDATE public_drafts SET
		published_path=?, published_sha256=?, published_revision=?
		WHERE draft_id=? AND revision=?`,
		publishedPath, publishedSHA, revision, id, revision)
	if err != nil {
		return fmt.Errorf("record draft publication: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrDraftConflict
	}
	return nil
}

// PutPublicDraftAsset stores one role asset and enforces the private quota.
// Bytes are copied into SQLite; no public file is created.
func (s *Store) PutPublicDraftAsset(ctx context.Context, a PublicDraftAsset) (PublicDraftAsset, error) {
	if !ValidateDraftID(a.DraftID) {
		return PublicDraftAsset{}, fmt.Errorf("storage: invalid draft id")
	}
	if a.Role != "avatar" && a.Role != "human_avatar" && a.Role != "image" {
		return PublicDraftAsset{}, fmt.Errorf("storage: invalid asset role")
	}
	if len(a.SHA256) != 64 {
		return PublicDraftAsset{}, fmt.Errorf("storage: invalid asset sha256")
	}
	if a.Mime != "image/png" && a.Mime != "image/jpeg" {
		return PublicDraftAsset{}, fmt.Errorf("storage: invalid asset mime")
	}
	if len(a.Bytes) == 0 {
		return PublicDraftAsset{}, fmt.Errorf("storage: empty asset bytes")
	}
	// Asset ids are scoped to the draft: two drafts may hold identical image
	// bytes without one row moving to the other draft.
	if a.AssetID == "" {
		prefix := strings.TrimPrefix(a.DraftID, "draft-")
		if len(prefix) > 16 {
			prefix = prefix[len(prefix)-16:]
		}
		a.AssetID = "asset-" + prefix + "-" + a.Role + "-" + a.SHA256[:16]
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PublicDraftAsset{}, fmt.Errorf("begin put asset: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM public_drafts WHERE draft_id=?`, a.DraftID).Scan(&exists); err != nil {
		return PublicDraftAsset{}, fmt.Errorf("check draft: %w", err)
	}
	if exists == 0 {
		return PublicDraftAsset{}, ErrDraftNotFound
	}
	var total int64
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(size_bytes),0), COUNT(*) FROM public_draft_assets WHERE draft_id=?`, a.DraftID).Scan(&total, &count); err != nil {
		return PublicDraftAsset{}, fmt.Errorf("measure draft assets: %w", err)
	}
	if total+int64(len(a.Bytes)) > MaxDraftImageBytes {
		return PublicDraftAsset{}, ErrDraftAsset
	}
	if a.Role == "image" && count >= MaxDraftImageCount+2 {
		// One Agent avatar, one human avatar and four images are the allowed
		// shape. Replacing either avatar must not count as an extra image.
		return PublicDraftAsset{}, ErrDraftAsset
	}
	if a.Role == "avatar" || a.Role == "human_avatar" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM public_draft_assets WHERE draft_id=? AND role=?`, a.DraftID, a.Role); err != nil {
			return PublicDraftAsset{}, fmt.Errorf("replace draft %s: %w", a.Role, err)
		}
	}
	now := time.Now()
	if a.CreatedAt.IsZero() {
		a.CreatedAt = now
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO public_draft_assets
		(asset_id, draft_id, role, sha256, mime, width, height, size_bytes, bytes, created_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(asset_id) DO UPDATE SET draft_id=excluded.draft_id, role=excluded.role,
		 sha256=excluded.sha256, mime=excluded.mime, width=excluded.width, height=excluded.height,
		 size_bytes=excluded.size_bytes, bytes=excluded.bytes, created_at_ms=excluded.created_at_ms`,
		a.AssetID, a.DraftID, a.Role, a.SHA256, a.Mime, a.Width, a.Height, len(a.Bytes), a.Bytes, a.CreatedAt.UnixMilli()); err != nil {
		return PublicDraftAsset{}, fmt.Errorf("insert draft asset: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return PublicDraftAsset{}, fmt.Errorf("commit draft asset: %w", err)
	}
	a.SizeBytes = int64(len(a.Bytes))
	return a, nil
}

// GetPublicDraftAsset returns one private asset for publication.
func (s *Store) GetPublicDraftAsset(ctx context.Context, draftID, assetID string) (PublicDraftAsset, bool, error) {
	row := s.db.QueryRowContext(ctx, `SELECT asset_id, draft_id, role, sha256, mime,
		width, height, size_bytes, bytes, created_at_ms FROM public_draft_assets
		WHERE draft_id=? AND asset_id=?`, draftID, assetID)
	var a PublicDraftAsset
	var created int64
	err := row.Scan(&a.AssetID, &a.DraftID, &a.Role, &a.SHA256, &a.Mime, &a.Width, &a.Height, &a.SizeBytes, &a.Bytes, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return PublicDraftAsset{}, false, nil
	}
	if err != nil {
		return PublicDraftAsset{}, false, fmt.Errorf("read draft asset: %w", err)
	}
	a.CreatedAt = time.UnixMilli(created)
	return a, true, nil
}

func deleteUnreferencedAssetsTx(ctx context.Context, tx *sql.Tx, draftID string, keep []string) error {
	keepSet := make(map[string]struct{}, len(keep))
	for _, id := range keep {
		if id != "" {
			keepSet[id] = struct{}{}
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT asset_id FROM public_draft_assets WHERE draft_id=?`, draftID)
	if err != nil {
		return fmt.Errorf("list draft assets for cleanup: %w", err)
	}
	var remove []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan draft asset for cleanup: %w", err)
		}
		if _, ok := keepSet[id]; !ok {
			remove = append(remove, id)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range remove {
		if _, err := tx.ExecContext(ctx, `DELETE FROM public_draft_assets WHERE asset_id=? AND draft_id=?`, id, draftID); err != nil {
			return fmt.Errorf("delete unreferenced draft asset: %w", err)
		}
	}
	return nil
}
