// Package publication owns the single public-content publish critical section:
// draft locks, version checks, staging, atomic public writes, manifest snapshot
// and crash recovery. It never uses a second public writer.
package publication

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Raminga/raminga/internal/content"
	"github.com/Raminga/raminga/internal/storage"
)

const (
	StatusPublished        = "published"
	StatusAlreadyPublished = "already_published"
	StatusConflict         = "conflict"
	StatusInvalid          = "invalid"
	StatusPartial          = "partial"

	MaxTitleRunes     = 120
	MaxBodyBytes      = 64 << 10
	MaxTags           = 10
	MaxTagRunes       = 32
	MaxAgentName      = 64
	MaxAgentDesc      = 2000
	MaxInterests      = 10
	MaxInterestLen    = 80
	MaxStyleRunes     = 1000
	MaxHumanName      = 64
	MaxHumanBio       = 4000
	MaxPostImageBytes = 20 << 20

	metadataMaxBytes = 256 << 10
)

// ErrDraftInvalid marks a field validation error (API InvalidArgument).
var ErrDraftInvalid = errors.New("publication: invalid draft")

// ErrDraftConflict marks a stale draft revision or published hash.
var ErrDraftConflict = errors.New("publication: draft conflict")

// DraftUpdate is the resolved full update used by SaveDraft. Nil optional text
// preserves the existing value; every list replaces the old list.
type DraftUpdate struct {
	DraftID            string
	Kind               string
	AuthorKind         string
	ExpectedRevision   int64
	AgentName          *string
	AgentDescription   *string
	AgentInterests     []string
	AgentStyle         *string
	HumanName          *string
	HumanBio           *string
	Title              *string
	BodyMarkdown       *string
	Tags               []string
	ImageAssetIDs      []string
	AvatarAssetID      string
	ClearAvatar        bool
	HumanAvatarAssetID string
	ClearHumanAvatar   bool
}

// PublishFile is one actual file committed or already present.
type PublishFile struct {
	Path      string
	SizeBytes int64
	SHA256    string
}

// PublishResult is the enum-shaped result. Only unexpected I/O is returned as
// an error by the API; expected outcomes are carried here.
type PublishResult struct {
	Status                 string
	Error                  string
	CurrentRevision        int64
	CurrentPublishedSHA256 string
	Files                  []PublishFile
	ManifestVersion        int
	ManifestGeneratedAt    time.Time
	PostPath               string
	ProfilePath            string
	Warnings               []string
	ManifestSHA256         string
}

// Coordinator coordinates private drafts and public commits for one data dir.
type Coordinator struct {
	dataDir string
	peerID  string
	store   *storage.Store
	content *content.Store
	now     func() time.Time

	mu    sync.Mutex
	locks map[string]*draftLock

	// commitHook is a test-only seam run after the metadata switch and before
	// the published_* DB write. Production leaves it nil.
	commitHook func() error
	// metadataHook is a test-only seam run immediately before the metadata
	// file (post.json/profile.json) write. Production leaves it nil.
	metadataHook func() error
}

type draftLock struct {
	mu   sync.Mutex
	refs int
}

// NewCoordinator builds the single publication coordinator for a data dir.
func NewCoordinator(dataDir, peerID string, store *storage.Store, public *content.Store) *Coordinator {
	return &Coordinator{dataDir: dataDir, peerID: peerID, store: store, content: public, now: time.Now, locks: make(map[string]*draftLock)}
}

func (c *Coordinator) lockDraft(id string) func() {
	c.mu.Lock()
	l := c.locks[id]
	if l == nil {
		l = &draftLock{}
		c.locks[id] = l
	}
	l.refs++
	c.mu.Unlock()
	l.mu.Lock()
	return func() {
		// Decrement under c.mu before unlocking l.mu: a waiter may already have
		// incremented refs, and the map entry must not be deleted while that
		// waiter is about to acquire the same lock.
		c.mu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(c.locks, id)
		}
		c.mu.Unlock()
		l.mu.Unlock()
	}
}

func (c *Coordinator) safeError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if c != nil && c.dataDir != "" {
		msg = strings.ReplaceAll(msg, c.dataDir, "<data-dir>")
	}
	msg = strings.ReplaceAll(msg, "\n", " ")
	if len(msg) > 500 {
		msg = msg[:500] + "…"
	}
	return msg
}

func contextErr(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

// GetDraft returns one private draft.
func (c *Coordinator) GetDraft(ctx context.Context, id string) (storage.PublicDraft, bool, error) {
	if !storage.ValidateDraftID(id) {
		return storage.PublicDraft{}, false, fmt.Errorf("%w: invalid draft id", ErrDraftInvalid)
	}
	return c.store.GetPublicDraft(ctx, id)
}

// ListDrafts returns a newest-first page.
func (c *Coordinator) ListDrafts(ctx context.Context, kind, before string, limit int) ([]storage.PublicDraft, bool, error) {
	return c.store.ListPublicDrafts(ctx, kind, before, limit)
}

func validText(s string, maxRunes int, field string) error {
	if !utf8.ValidString(s) {
		return fmt.Errorf("%w: %s 不是有效 UTF-8", ErrDraftInvalid, field)
	}
	if strings.ContainsRune(s, 0) {
		return fmt.Errorf("%w: %s 包含 NUL", ErrDraftInvalid, field)
	}
	if utf8.RuneCountInString(s) > maxRunes {
		return fmt.Errorf("%w: %s 超过 %d 字符", ErrDraftInvalid, field, maxRunes)
	}
	return nil
}

func cleanList(values []string, max int, maxLen int, field string) ([]string, error) {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if utf8.RuneCountInString(value) > maxLen {
			return nil, fmt.Errorf("%w: %s 单项超过 %d 字符", ErrDraftInvalid, field, maxLen)
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	if len(out) > max {
		return nil, fmt.Errorf("%w: %s 超过 %d 项", ErrDraftInvalid, field, max)
	}
	return out, nil
}

func newDraftID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("draft-%d-%s", time.Now().UnixNano(), hex.EncodeToString(b[:])), nil
}

// SaveDraft creates or updates one private draft. It never writes public/.
func (c *Coordinator) SaveDraft(ctx context.Context, in DraftUpdate) (storage.PublicDraft, error) {
	if in.Kind != "" && in.Kind != storage.DraftKindProfile && in.Kind != storage.DraftKindPost {
		return storage.PublicDraft{}, fmt.Errorf("%w: kind 必须是 profile 或 post", ErrDraftInvalid)
	}
	creating := strings.TrimSpace(in.DraftID) == "" ||
		(in.DraftID == "profile" && in.ExpectedRevision == 0 && (in.Kind == "" || in.Kind == storage.DraftKindProfile))
	if creating {
		if in.Kind == "" {
			return storage.PublicDraft{}, fmt.Errorf("%w: 创建草稿时必须提供 kind", ErrDraftInvalid)
		}
		if in.ExpectedRevision != 0 {
			return storage.PublicDraft{}, fmt.Errorf("%w: 新草稿的 expected_revision 必须为 0", ErrDraftInvalid)
		}
		id := "profile"
		if in.Kind == storage.DraftKindPost {
			var err error
			id, err = newDraftID()
			if err != nil {
				return storage.PublicDraft{}, err
			}
		}
		in.DraftID = id
	}
	if !storage.ValidateDraftID(in.DraftID) {
		return storage.PublicDraft{}, fmt.Errorf("%w: draft_id 格式无效", ErrDraftInvalid)
	}
	unlock := c.lockDraft(in.DraftID)
	defer unlock()

	existing, found, err := c.store.GetPublicDraft(ctx, in.DraftID)
	if err != nil {
		return storage.PublicDraft{}, err
	}
	if !creating && !found {
		return storage.PublicDraft{}, storage.ErrDraftNotFound
	}
	if found && in.Kind != "" && existing.Kind != in.Kind {
		return storage.PublicDraft{}, fmt.Errorf("%w: 已有草稿的 kind 不能改变", ErrDraftInvalid)
	}
	if found && existing.Revision != in.ExpectedRevision {
		return storage.PublicDraft{}, storage.ErrDraftConflict
	}
	kind := in.Kind
	if found {
		kind = existing.Kind
	}
	if kind == storage.DraftKindProfile && in.DraftID != "profile" {
		return storage.PublicDraft{}, fmt.Errorf("%w: profile 草稿的 draft_id 固定为 profile", ErrDraftInvalid)
	}

	d := storage.PublicDraft{
		DraftID: in.DraftID, Kind: kind,
		AgentInterests: []string{}, Tags: []string{}, ImageAssetIDs: []string{},
	}
	if found {
		d = existing
	}
	if kind == storage.DraftKindProfile {
		d.AuthorKind = storage.DraftAuthorUser
	} else if in.AuthorKind != "" {
		if in.AuthorKind != storage.DraftAuthorUser && in.AuthorKind != storage.DraftAuthorAgent {
			return storage.PublicDraft{}, fmt.Errorf("%w: author_kind 必须是 user 或 agent", ErrDraftInvalid)
		}
		d.AuthorKind = in.AuthorKind
	} else if !found {
		return storage.PublicDraft{}, fmt.Errorf("%w: 新动态草稿必须明确 author_kind", ErrDraftInvalid)
	}
	if d.AuthorKind == "" {
		d.AuthorKind = storage.DraftAuthorUser
	}

	applyText := func(dst *string, src *string) error {
		if src == nil {
			return nil
		}
		*dst = *src
		return nil
	}
	if err := applyText(&d.AgentName, in.AgentName); err != nil {
		return storage.PublicDraft{}, err
	}
	if err := applyText(&d.AgentDescription, in.AgentDescription); err != nil {
		return storage.PublicDraft{}, err
	}
	if err := applyText(&d.AgentConversationStyle, in.AgentStyle); err != nil {
		return storage.PublicDraft{}, err
	}
	if err := applyText(&d.HumanName, in.HumanName); err != nil {
		return storage.PublicDraft{}, err
	}
	if err := applyText(&d.HumanBioMarkdown, in.HumanBio); err != nil {
		return storage.PublicDraft{}, err
	}
	if err := applyText(&d.Title, in.Title); err != nil {
		return storage.PublicDraft{}, err
	}
	if err := applyText(&d.BodyMarkdown, in.BodyMarkdown); err != nil {
		return storage.PublicDraft{}, err
	}
	interests, err := cleanList(in.AgentInterests, MaxInterests, MaxInterestLen, "agent_interests")
	if err != nil {
		return storage.PublicDraft{}, err
	}
	d.AgentInterests = interests
	tags, err := cleanList(in.Tags, MaxTags, MaxTagRunes, "tags")
	if err != nil {
		return storage.PublicDraft{}, err
	}
	d.Tags = tags
	if in.ImageAssetIDs != nil {
		d.ImageAssetIDs = append([]string(nil), in.ImageAssetIDs...)
	} else if found {
		d.ImageAssetIDs = existing.ImageAssetIDs
	} else {
		d.ImageAssetIDs = []string{}
	}
	if in.ClearAvatar {
		d.AvatarAssetID = ""
	} else if in.AvatarAssetID != "" {
		d.AvatarAssetID = in.AvatarAssetID
	}
	if in.ClearHumanAvatar {
		d.HumanAvatarAssetID = ""
	} else if in.HumanAvatarAssetID != "" {
		d.HumanAvatarAssetID = in.HumanAvatarAssetID
	}

	if err := validateDraftValues(d); err != nil {
		return storage.PublicDraft{}, err
	}
	if err := c.validateDraftAssets(ctx, d); err != nil {
		return storage.PublicDraft{}, err
	}

	if !found {
		created, err := c.store.CreatePublicDraft(ctx, d)
		if err != nil {
			return storage.PublicDraft{}, err
		}
		return created, nil
	}
	updated, err := c.store.UpdatePublicDraft(ctx, d, in.ExpectedRevision)
	if err != nil {
		return storage.PublicDraft{}, err
	}
	return updated, nil
}

func validateDraftValues(d storage.PublicDraft) error {
	if err := validText(d.AgentName, MaxAgentName, "agent.name"); err != nil {
		return err
	}
	if err := validText(d.AgentDescription, MaxAgentDesc, "agent.description"); err != nil {
		return err
	}
	if err := validText(d.AgentConversationStyle, MaxStyleRunes, "agent.conversation_style"); err != nil {
		return err
	}
	if err := validText(d.HumanName, MaxHumanName, "human.name"); err != nil {
		return err
	}
	if err := validText(d.HumanBioMarkdown, MaxHumanBio, "human.bio_markdown"); err != nil {
		return err
	}
	if d.Kind != storage.DraftKindPost {
		return nil
	}
	if d.AuthorKind != storage.DraftAuthorUser && d.AuthorKind != storage.DraftAuthorAgent {
		return fmt.Errorf("%w: 动态必须选择本人或 Agent 署名", ErrDraftInvalid)
	}
	if strings.TrimSpace(d.Title) == "" {
		return fmt.Errorf("%w: 动态标题不能为空", ErrDraftInvalid)
	}
	if err := validText(d.Title, MaxTitleRunes, "title"); err != nil {
		return err
	}
	if strings.TrimSpace(d.BodyMarkdown) == "" {
		return fmt.Errorf("%w: 动态正文不能为空", ErrDraftInvalid)
	}
	if len([]byte(d.BodyMarkdown)) > MaxBodyBytes {
		return fmt.Errorf("%w: 动态正文超过 %d 字节", ErrDraftInvalid, MaxBodyBytes)
	}
	if len(d.ImageAssetIDs) > storage.MaxDraftImageCount {
		return fmt.Errorf("%w: 动态最多 %d 张图片", ErrDraftInvalid, storage.MaxDraftImageCount)
	}
	return nil
}

func (c *Coordinator) validateDraftAssets(ctx context.Context, d storage.PublicDraft) error {
	seen := make(map[string]struct{}, len(d.ImageAssetIDs))
	var imageBytes int64
	for _, id := range d.ImageAssetIDs {
		if id == "" {
			return fmt.Errorf("%w: 图片 asset_id 为空", ErrDraftInvalid)
		}
		if _, ok := seen[id]; ok {
			return fmt.Errorf("%w: 图片 asset_id 重复", ErrDraftInvalid)
		}
		seen[id] = struct{}{}
		a, found, err := c.store.GetPublicDraftAsset(ctx, d.DraftID, id)
		if err != nil {
			return err
		}
		if !found || a.Role != "image" {
			return fmt.Errorf("%w: 图片资源不属于该草稿", ErrDraftInvalid)
		}
		imageBytes += a.SizeBytes
	}
	if d.Kind == storage.DraftKindPost && imageBytes > MaxPostImageBytes {
		return fmt.Errorf("%w: 动态图片合计超过 %d MiB", ErrDraftInvalid, MaxPostImageBytes>>20)
	}
	if d.AvatarAssetID != "" {
		a, found, err := c.store.GetPublicDraftAsset(ctx, d.DraftID, d.AvatarAssetID)
		if err != nil {
			return err
		}
		if !found || a.Role != "avatar" {
			return fmt.Errorf("%w: 头像资源不属于该草稿", ErrDraftInvalid)
		}
	}
	if d.HumanAvatarAssetID != "" {
		a, found, err := c.store.GetPublicDraftAsset(ctx, d.DraftID, d.HumanAvatarAssetID)
		if err != nil {
			return err
		}
		if !found || a.Role != "human_avatar" {
			return fmt.Errorf("%w: 人类头像资源不属于该草稿", ErrDraftInvalid)
		}
	}
	return nil
}

// PutDraftImage validates and stores one private avatar/image asset.
func (c *Coordinator) PutDraftImage(ctx context.Context, draftID, role, filename string, data []byte) (storage.PublicDraftAsset, error) {
	if role != "avatar" && role != "human_avatar" && role != "image" {
		return storage.PublicDraftAsset{}, fmt.Errorf("%w: role 必须是 avatar、human_avatar 或 image", ErrDraftInvalid)
	}
	if !storage.ValidateDraftID(draftID) {
		return storage.PublicDraftAsset{}, fmt.Errorf("%w: draft_id 无效", ErrDraftInvalid)
	}
	unlock := c.lockDraft(draftID)
	defer unlock()
	if _, found, err := c.store.GetPublicDraft(ctx, draftID); err != nil {
		return storage.PublicDraftAsset{}, err
	} else if !found {
		return storage.PublicDraftAsset{}, storage.ErrDraftNotFound
	}
	image, err := ValidateImage(data, role, filename)
	if err != nil {
		return storage.PublicDraftAsset{}, err
	}
	asset := storage.PublicDraftAsset{
		DraftID: draftID, Role: role, SHA256: image.SHA256, Mime: image.Mime,
		Width: image.Width, Height: image.Height, Bytes: image.Bytes,
	}
	return c.store.PutPublicDraftAsset(ctx, asset)
}

// DeleteDraft deletes a private draft and its assets.
func (c *Coordinator) DeleteDraft(ctx context.Context, id string, expectedRevision int64) (bool, error) {
	if !storage.ValidateDraftID(id) {
		return false, fmt.Errorf("%w: draft_id 无效", ErrDraftInvalid)
	}
	unlock := c.lockDraft(id)
	defer unlock()
	return c.store.DeletePublicDraft(ctx, id, expectedRevision)
}

func postIDForDraft(id string) string {
	trimmed := strings.TrimPrefix(id, "draft-")
	if trimmed == id || trimmed == "" {
		trimmed = id
	}
	return "post-" + trimmed
}

type profileAgentJSON struct {
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	Interests         []string `json:"interests"`
	ConversationStyle string   `json:"conversation_style"`
	Avatar            string   `json:"avatar,omitempty"`
	AvatarSHA256      string   `json:"avatar_sha256,omitempty"`
	AvatarMime        string   `json:"avatar_mime,omitempty"`
}

type profileHumanJSON struct {
	Name         string `json:"name"`
	BioMarkdown  string `json:"bio_markdown"`
	Avatar       string `json:"avatar,omitempty"`
	AvatarSHA256 string `json:"avatar_sha256,omitempty"`
	AvatarMime   string `json:"avatar_mime,omitempty"`
}

type profileJSONV2 struct {
	SchemaVersion int              `json:"schema_version"`
	Agent         profileAgentJSON `json:"agent"`
	Human         profileHumanJSON `json:"human"`
	UpdatedAt     string           `json:"updated_at"`
}

type agentCardJSON struct {
	SchemaVersion     int      `json:"schema_version"`
	DisplayName       string   `json:"display_name"`
	Description       string   `json:"description"`
	Interests         []string `json:"interests"`
	ConversationStyle string   `json:"conversation_style"`
	UpdatedAt         string   `json:"updated_at"`
}

type postImageJSON struct {
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
	Mime      string `json:"mime"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	SizeBytes int64  `json:"size_bytes"`
}

type postAuthorJSON struct {
	PeerID      string `json:"peer_id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

type postJSONV2 struct {
	SchemaVersion int             `json:"schema_version"`
	ID            string          `json:"id"`
	Title         string          `json:"title"`
	Format        string          `json:"format"`
	Author        postAuthorJSON  `json:"author"`
	PublishedAt   string          `json:"published_at"`
	UpdatedAt     string          `json:"updated_at"`
	Tags          []string        `json:"tags"`
	Summary       string          `json:"summary,omitempty"`
	Body          string          `json:"body"`
	Images        []postImageJSON `json:"images"`
	Revision      int64           `json:"revision"`
}

type targetFile struct {
	path     string
	data     []byte
	metadata bool
}

func (c *Coordinator) readPublicJSONLocked(rel string, max int64, dst any) bool {
	data, err := c.content.ReadPublicFileLocked(rel, max)
	if err != nil {
		return false
	}
	return json.Unmarshal(data, dst) == nil
}

// buildProfileTargets converts a profile draft into its ordered file set.
func (c *Coordinator) buildProfileTargets(ctx context.Context, d storage.PublicDraft, now time.Time) ([]targetFile, string, string, []string, error) {
	var warnings []string
	agent := profileAgentJSON{
		Name: d.AgentName, Description: d.AgentDescription,
		Interests: append([]string{}, d.AgentInterests...), ConversationStyle: d.AgentConversationStyle,
	}
	var avatar targetFile
	if d.AvatarAssetID != "" {
		asset, found, err := c.store.GetPublicDraftAsset(ctx, d.DraftID, d.AvatarAssetID)
		if err != nil {
			return nil, "", "", nil, err
		}
		if !found || asset.Role != "avatar" {
			return nil, "", "", nil, fmt.Errorf("%w: 头像不存在", ErrDraftInvalid)
		}
		// Assets are re-encoded on upload; keep the stored canonical bytes.
		image, err := ValidateImage(asset.Bytes, "avatar", "avatar"+imageExtension(asset.Mime))
		if err != nil {
			return nil, "", "", nil, err
		}
		name := "avatar-" + image.SHA256[:8] + imageExtension(image.Mime)
		agent.Avatar = name
		agent.AvatarSHA256 = image.SHA256
		agent.AvatarMime = image.Mime
		avatar = targetFile{path: "profile/" + name, data: image.Bytes}
	}
	human := profileHumanJSON{Name: d.HumanName, BioMarkdown: d.HumanBioMarkdown}
	var humanAvatar targetFile
	if d.HumanAvatarAssetID != "" {
		asset, found, err := c.store.GetPublicDraftAsset(ctx, d.DraftID, d.HumanAvatarAssetID)
		if err != nil {
			return nil, "", "", nil, err
		}
		if !found || asset.Role != "human_avatar" {
			return nil, "", "", nil, fmt.Errorf("%w: 人类头像不存在", ErrDraftInvalid)
		}
		image, err := ValidateImage(asset.Bytes, "avatar", "avatar"+imageExtension(asset.Mime))
		if err != nil {
			return nil, "", "", nil, err
		}
		name := "human-avatar-" + image.SHA256[:8] + imageExtension(image.Mime)
		human.Avatar = name
		human.AvatarSHA256 = image.SHA256
		human.AvatarMime = image.Mime
		humanAvatar = targetFile{path: "profile/" + name, data: image.Bytes}
	}
	profile := profileJSONV2{
		SchemaVersion: 2, Agent: agent,
		Human:     human,
		UpdatedAt: now.UTC().Format(time.RFC3339),
	}
	profileRaw, err := json.MarshalIndent(profile, "", "  ")
	if err != nil {
		return nil, "", "", nil, err
	}
	profileRaw = append(profileRaw, '\n')

	humanName := strings.TrimSpace(d.HumanName)
	if humanName == "" {
		humanName = "关联人类"
	}
	var index strings.Builder
	index.WriteString("# ")
	index.WriteString(humanName)
	index.WriteString("\n")
	if strings.TrimSpace(d.HumanBioMarkdown) != "" {
		index.WriteString("\n")
		index.WriteString(strings.TrimRight(d.HumanBioMarkdown, "\n"))
		index.WriteString("\n")
	}

	files := []targetFile{}
	if avatar.data != nil {
		files = append(files, avatar)
	}
	if humanAvatar.data != nil {
		files = append(files, humanAvatar)
	}
	files = append(files, targetFile{path: "profile/index.md", data: []byte(index.String())})
	// Only mirror agent-card.json when it already exists; never create a new
	// legacy file silently.
	if exists, _ := c.content.PublicFileExistsLocked("profile/agent-card.json"); exists {
		card, err := json.MarshalIndent(agentCardJSON{
			SchemaVersion: 1, DisplayName: d.AgentName, Description: d.AgentDescription,
			Interests: append([]string{}, d.AgentInterests...), ConversationStyle: d.AgentConversationStyle,
			UpdatedAt: now.UTC().Format(time.RFC3339),
		}, "", "  ")
		if err != nil {
			return nil, "", "", nil, err
		}
		files = append(files, targetFile{path: "profile/agent-card.json", data: append(card, '\n')})
	}
	files = append(files, targetFile{path: "profile/profile.json", data: profileRaw, metadata: true})
	return files, "profile/profile.json", hashBytes(profileRaw), warnings, nil
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (c *Coordinator) authorDisplayNameLocked(kind string) string {
	var profile profileJSONV2
	if c.readPublicJSONLocked("profile/profile.json", metadataMaxBytes, &profile) {
		if kind == storage.DraftAuthorAgent {
			if name := strings.TrimSpace(profile.Agent.Name); name != "" {
				return name
			}
			return "Agent"
		}
		if name := strings.TrimSpace(profile.Human.Name); name != "" {
			return name
		}
		return "本人"
	}
	var card agentCardJSON
	if kind == storage.DraftAuthorAgent && c.readPublicJSONLocked("profile/agent-card.json", metadataMaxBytes, &card) {
		if name := strings.TrimSpace(card.DisplayName); name != "" {
			return name
		}
	}
	return map[string]string{storage.DraftAuthorAgent: "Agent", storage.DraftAuthorUser: "本人"}[kind]
}

// buildPostTargets converts a post draft into images followed by post.json.
// A draft that already owns a public target keeps that exact path. For an
// imported legacy post, unknown fields and the original author object are
// merged back instead of being replaced by a fresh v2 document.
func (c *Coordinator) buildPostTargets(ctx context.Context, d storage.PublicDraft, now time.Time) ([]targetFile, string, string, []string, error) {
	var warnings []string
	var source *sourcePost
	postRel := "posts/" + postIDForDraft(d.DraftID) + "/post.json"
	imageDir := path.Dir(postRel)
	if d.PublishedPath != "" {
		if _, ok := validSourcePostPath(d.PublishedPath); !ok {
			return nil, "", "", nil, fmt.Errorf("%w: 草稿关联的公开动态路径无效", ErrDraftInvalid)
		}
		postRel = d.PublishedPath
		imageDir = path.Dir(postRel)
		data, err := c.content.ReadPublicFileLocked(postRel, metadataMaxBytes)
		if err != nil {
			return nil, "", "", nil, fmt.Errorf("%w: 原公开动态已不存在，不能静默改为新建", ErrDraftConflict)
		}
		source, err = parseSourcePost(postRel, data, c.peerID)
		if err != nil {
			return nil, "", "", nil, err
		}
		if source.schemaVersion == 1 && len(d.ImageAssetIDs) > 0 {
			return nil, "", "", nil, fmt.Errorf("%w: 旧版 v1 动态不能直接加入图片；请另存为新动态", ErrDraftInvalid)
		}
	}
	images := make([]postImageJSON, 0, len(d.ImageAssetIDs))
	files := make([]targetFile, 0, len(d.ImageAssetIDs)+1)
	for _, assetID := range d.ImageAssetIDs {
		asset, found, err := c.store.GetPublicDraftAsset(ctx, d.DraftID, assetID)
		if err != nil {
			return nil, "", "", nil, err
		}
		if !found || asset.Role != "image" {
			return nil, "", "", nil, fmt.Errorf("%w: 图片资源不存在", ErrDraftInvalid)
		}
		image, err := ValidateImage(asset.Bytes, "image", "image"+imageExtension(asset.Mime))
		if err != nil {
			return nil, "", "", nil, err
		}
		rel := path.Join(imageDir, "images", image.SHA256+imageExtension(image.Mime))
		images = append(images, postImageJSON{
			Path: "images/" + image.SHA256 + imageExtension(image.Mime), SHA256: image.SHA256,
			Mime: image.Mime, Width: image.Width, Height: image.Height, SizeBytes: int64(len(image.Bytes)),
		})
		files = append(files, targetFile{path: rel, data: image.Bytes})
	}
	publishedAt := now.UTC().Format(time.RFC3339)
	updatedAt := d.UpdatedAt.UTC()
	if updatedAt.IsZero() {
		updatedAt = now.UTC()
	}
	ownedPath := d.PublishedPath == "" || d.PublishedPath == "posts/"+postIDForDraft(d.DraftID)+"/post.json"
	var raw []byte
	if source == nil || ownedPath {
		postID := postIDForDraft(d.DraftID)
		var existing postJSONV2
		if c.readPublicJSONLocked(postRel, metadataMaxBytes, &existing) && existing.SchemaVersion == 2 {
			if strings.TrimSpace(existing.PublishedAt) != "" {
				publishedAt = existing.PublishedAt
			}
		}
		displayName := c.authorDisplayNameLocked(d.AuthorKind)
		post := postJSONV2{
			SchemaVersion: 2, ID: postID, Title: d.Title, Format: "markdown",
			Author:      postAuthorJSON{PeerID: c.peerID, Kind: d.AuthorKind, DisplayName: displayName},
			PublishedAt: publishedAt, UpdatedAt: updatedAt.Format(time.RFC3339),
			Tags: append([]string{}, d.Tags...), Body: d.BodyMarkdown,
			Images: images, Revision: d.Revision + 1,
		}
		var err error
		raw, err = json.MarshalIndent(post, "", "  ")
		if err != nil {
			return nil, "", "", nil, err
		}
	} else {
		// Clone the whole source object so future/unknown top-level fields
		// survive an edit. Only fields the editor actually owns are replaced.
		merged := make(map[string]json.RawMessage, len(source.raw)+4)
		for key, value := range source.raw {
			merged[key] = value
		}
		merged["title"] = rawString(d.Title)
		merged["body"] = rawString(d.BodyMarkdown)
		merged["tags"] = rawStrings(d.Tags)
		merged["updated_at"] = rawString(updatedAt.Format(time.RFC3339))
		if source.schemaVersion == 2 {
			merged["images"] = rawObject(images)
			merged["revision"] = rawInt(source.revision + 1)
		}
		if _, exists := merged["summary"]; exists {
			merged["summary"] = rawString(plainPostSummary(d.BodyMarkdown))
		}
		var err error
		raw, err = json.MarshalIndent(merged, "", "  ")
		if err != nil {
			return nil, "", "", nil, err
		}
	}
	raw = append(raw, '\n')
	files = append(files, targetFile{path: postRel, data: raw, metadata: true})
	return files, postRel, hashBytes(raw), warnings, nil
}

type oldRefs struct {
	images      map[string]struct{}
	avatar      string
	humanAvatar string
}

func (c *Coordinator) readOldRefsLocked(profile bool, d storage.PublicDraft, existingPath string) oldRefs {
	refs := oldRefs{images: map[string]struct{}{}}
	if profile {
		var old profileJSONV2
		if c.readPublicJSONLocked("profile/profile.json", metadataMaxBytes, &old) {
			if old.Agent.Avatar != "" {
				refs.avatar = "profile/" + path.Base(old.Agent.Avatar)
			}
			if old.Human.Avatar != "" {
				refs.humanAvatar = "profile/" + path.Base(old.Human.Avatar)
			}
		}
		return refs
	}
	var old postJSONV2
	if c.readPublicJSONLocked(existingPath, metadataMaxBytes, &old) && old.SchemaVersion == 2 {
		imageDir := path.Dir(existingPath)
		for _, img := range old.Images {
			if strings.HasPrefix(img.Path, "images/") {
				refs.images[path.Join(imageDir, img.Path)] = struct{}{}
			}
		}
	}
	return refs
}

func (c *Coordinator) cleanupOldLocked(profile bool, files []targetFile, refs oldRefs, snap *content.Snapshot) []string {
	var warnings []string
	newPaths := make(map[string]struct{}, len(files))
	postImageDir := ""
	for _, f := range files {
		newPaths[f.path] = struct{}{}
		if f.metadata && !profile && strings.HasSuffix(f.path, "/post.json") {
			postImageDir = path.Join(path.Dir(f.path), "images") + "/"
		}
	}
	if profile {
		// Remove only avatar files that the previous profile.json actually
		// referenced and this publish no longer uses. A same-prefix file that
		// was not managed by this feature must never be deleted.
		for _, rel := range []string{refs.avatar, refs.humanAvatar} {
			if rel == "" {
				continue
			}
			if _, keep := newPaths[rel]; keep {
				continue
			}
			if err := c.content.RemovePublicFileLocked(rel); err != nil {
				warnings = append(warnings, "旧文件清理失败："+path.Base(rel))
			}
		}
		return warnings
	}
	for _, e := range snap.Entries {
		remove := false
		if postImageDir != "" && strings.HasPrefix(e.Path, postImageDir) {
			if _, old := refs.images[e.Path]; !old {
				if _, keep := newPaths[e.Path]; !keep {
					remove = true
				}
			}
		}
		if remove {
			if err := c.content.RemovePublicFileLocked(e.Path); err != nil {
				warnings = append(warnings, "旧文件清理失败："+path.Base(e.Path))
			}
		}
	}
	return warnings
}

func writeStaging(dataDir, publishID string, files []targetFile) (string, error) {
	staging := filepath.Join(dataDir, "publication", "staging", publishID)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return staging, err
	}
	for _, f := range files {
		target := filepath.Join(staging, filepath.FromSlash(f.path))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return staging, err
		}
		fh, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return staging, err
		}
		if _, err := fh.Write(f.data); err != nil {
			_ = fh.Close()
			return staging, err
		}
		if err := fh.Sync(); err != nil {
			_ = fh.Close()
			return staging, err
		}
		if err := fh.Close(); err != nil {
			return staging, err
		}
	}
	// Best-effort directory sync: files are already synced, and some
	// platforms do not allow opening a directory for fsync.
	if dir, err := os.Open(staging); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return staging, nil
}

// Publish commits one draft under the fixed lock order draft → publish.
func (c *Coordinator) Publish(ctx context.Context, draftID string, expectedRevision int64, expectedPublishedSHA string) (PublishResult, error) {
	if !storage.ValidateDraftID(draftID) {
		return PublishResult{Status: StatusInvalid, Error: "draft_id 格式无效"}, nil
	}
	unlock := c.lockDraft(draftID)
	defer unlock()
	c.content.LockPublish()
	defer c.content.UnlockPublish()

	now := c.now()
	d, found, err := c.store.GetPublicDraft(ctx, draftID)
	if err != nil {
		return PublishResult{}, err
	}
	if !found {
		return PublishResult{Status: StatusInvalid, Error: "草稿不存在"}, nil
	}
	if d.Revision != expectedRevision {
		return PublishResult{Status: StatusConflict, Error: "草稿已在别处更新，请重新载入后再发布", CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256}, nil
	}
	if err := validateDraftValues(d); err != nil {
		return PublishResult{Status: StatusInvalid, Error: c.safeError(err), CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256}, nil
	}
	if err := c.validateDraftAssets(ctx, d); err != nil {
		return PublishResult{Status: StatusInvalid, Error: c.safeError(err), CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256}, nil
	}
	var targets []targetFile
	var metadataPath, targetMetadataSHA string
	var warnings []string
	if d.Kind == storage.DraftKindProfile {
		targets, metadataPath, targetMetadataSHA, warnings, err = c.buildProfileTargets(ctx, d, now)
	} else {
		targets, metadataPath, targetMetadataSHA, warnings, err = c.buildPostTargets(ctx, d, now)
	}
	if err != nil {
		return PublishResult{Status: StatusInvalid, Error: c.safeError(err), CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256, Warnings: warnings}, nil
	}
	result := PublishResult{
		CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256,
		ManifestVersion: 1, PostPath: "", ProfilePath: "",
	}
	if d.Kind == storage.DraftKindProfile {
		result.ProfilePath = metadataPath
	} else {
		result.PostPath = metadataPath
	}
	actualMetadataSHA := ""
	if exists, _ := c.content.PublicFileExistsLocked(metadataPath); exists {
		actualMetadataSHA, _, _ = c.content.PublicFileSHA256Locked(metadataPath, metadataMaxBytes)
	}
	// Reconcile a previous post-commit DB failure: the actual files already
	// equal this revision's target. Do not write them again.
	if actualMetadataSHA == targetMetadataSHA && c.allTargetsPresentLocked(targets) {
		if expected := strings.ToLower(strings.TrimSpace(expectedPublishedSHA)); expected != "" && d.PublishedSHA256 != "" && expected != d.PublishedSHA256 {
			return PublishResult{Status: StatusConflict, Error: "已发布版本已变化，请重新载入后再发布", CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256, Warnings: warnings}, nil
		}
		if d.PublishedSHA256 != targetMetadataSHA || d.PublishedRevision != d.Revision {
			if err := c.store.SetPublicDraftPublished(ctx, d.DraftID, d.Revision, metadataPath, targetMetadataSHA); err != nil {
				// Still report the actual files; the next retry can repair again.
				result.Warnings = append(result.Warnings, "公开文件已存在，但发布状态回写失败："+c.safeError(err))
			}
		}
		snap, snapErr := c.content.RefreshLocked(ctx)
		if snapErr != nil {
			result.Status = StatusPartial
			result.Error = "公开文件已提交，但清单扫描失败：" + c.safeError(snapErr)
			return result, nil
		}
		result.Status = StatusAlreadyPublished
		result.CurrentPublishedSHA256 = targetMetadataSHA
		result.Files = filesFromTargets(targets)
		result.ManifestGeneratedAt = snap.GeneratedAt
		result.ManifestSHA256 = content.ManifestDigest(snap)
		return result, nil
	}
	expected := strings.ToLower(strings.TrimSpace(expectedPublishedSHA))
	if expected != "" && len(expected) != 64 {
		return PublishResult{Status: StatusInvalid, Error: "expected_published_sha256 格式无效", CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256}, nil
	}
	if d.PublishedSHA256 != "" {
		if expected == "" {
			return PublishResult{Status: StatusConflict, Error: "该草稿已发布过；必须携带当前 published_sha256 才能继续", CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256, Warnings: warnings}, nil
		}
		if expected != d.PublishedSHA256 {
			return PublishResult{Status: StatusConflict, Error: "已发布版本已变化，请重新载入后再发布", CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256, Warnings: warnings}, nil
		}
	} else if expected != "" {
		return PublishResult{Status: StatusConflict, Error: "草稿还没有已发布版本，expected_published_sha256 必须为空", CurrentRevision: d.Revision, CurrentPublishedSHA256: "", Warnings: warnings}, nil
	}
	if d.PublishedSHA256 != "" {
		if actualMetadataSHA == "" {
			return PublishResult{Status: StatusConflict, Error: "已发布文件已不在本机，不能静默覆盖", CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256, Warnings: warnings}, nil
		}
		if actualMetadataSHA != d.PublishedSHA256 {
			return PublishResult{Status: StatusConflict, Error: "公开文件已在别处修改，未覆盖；请重新载入", CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256, Warnings: warnings}, nil
		}
	} else if actualMetadataSHA != "" {
		return PublishResult{Status: StatusConflict, Error: "目标公开文件已存在但不受本草稿管理，未覆盖", CurrentRevision: d.Revision, CurrentPublishedSHA256: "", Warnings: warnings}, nil
	}

	publishID := content.NewPublishID(now)
	staging, err := writeStaging(c.dataDir, publishID, targets)
	if err != nil {
		_ = os.RemoveAll(staging)
		return PublishResult{Status: StatusPartial, Error: "写入发布暂存目录失败：" + c.safeError(err), CurrentRevision: d.Revision, CurrentPublishedSHA256: d.PublishedSHA256, Warnings: warnings}, nil
	}
	defer func() { _ = os.RemoveAll(staging) }()

	refs := c.readOldRefsLocked(d.Kind == storage.DraftKindProfile, d, metadataPath)
	var (
		committed     []targetFile
		metadataDone  bool
		existedBefore = make(map[string]bool, len(targets))
	)
	for i, f := range targets {
		if contextErr(ctx) != nil {
			break
		}
		exists, _ := c.content.PublicFileExistsLocked(f.path)
		existedBefore[f.path] = exists
		if f.metadata {
			if c.metadataHook != nil {
				if err := c.metadataHook(); err != nil {
					failed := c.rollbackLocked(committed, existedBefore)
					if failed != nil {
						warnings = append(warnings, "回滚未完成："+c.safeError(failed))
					}
					snap, _ := c.content.RefreshLocked(ctx)
					result.Status = StatusPartial
					result.Error = "写入公开元数据失败：" + c.safeError(err)
					result.Warnings = warnings
					if snap != nil {
						result.ManifestGeneratedAt = snap.GeneratedAt
						result.ManifestSHA256 = content.ManifestDigest(snap)
						result.Files = filesFromSnapshotForTargets(snap, targets)
					}
					return result, nil
				}
			}
			// Version checks at the start are not enough: writing images and
			// other content-addressed resources can take time. Re-read the
			// exact metadata file immediately before switching it so an
			// external edit during that window is a conflict, not silent loss.
			if unchanged, current := c.metadataVersionUnchangedLocked(metadataPath, actualMetadataSHA); !unchanged {
				failed := c.rollbackLocked(committed, existedBefore)
				if failed != nil {
					warnings = append(warnings, "回滚未完成："+c.safeError(failed))
				}
				snap, snapErr := c.content.RefreshLocked(ctx)
				result.Status = StatusConflict
				result.Error = "公开文件在发布过程中被外部修改，未覆盖；请重新载入后再发布"
				result.CurrentPublishedSHA256 = current
				result.Warnings = warnings
				if snapErr == nil && snap != nil {
					result.ManifestGeneratedAt = snap.GeneratedAt
					result.ManifestSHA256 = content.ManifestDigest(snap)
					result.Files = filesFromSnapshotForTargets(snap, targets)
				}
				return result, nil
			}
		}
		if exists {
			sha, size, _ := c.content.PublicFileSHA256Locked(f.path, int64(len(f.data))+1)
			if sha == hashBytes(f.data) && size == int64(len(f.data)) {
				if f.metadata {
					metadataDone = true
				}
				continue
			}
		}
		if _, err := c.content.WritePublicFileLocked(f.path, f.data); err != nil {
			failed := c.rollbackLocked(committed, existedBefore)
			if failed != nil {
				warnings = append(warnings, "回滚未完成："+c.safeError(failed))
			}
			snap, _ := c.content.RefreshLocked(ctx)
			result.Status = StatusPartial
			result.Error = "写入公开文件失败：" + c.safeError(err)
			result.Warnings = warnings
			if snap != nil {
				result.ManifestGeneratedAt = snap.GeneratedAt
				result.ManifestSHA256 = content.ManifestDigest(snap)
				result.Files = filesFromSnapshotForTargets(snap, targets)
			}
			return result, nil
		}
		committed = append(committed, f)
		if f.metadata {
			metadataDone = true
		}
		_ = i
	}
	if !metadataDone {
		failed := c.rollbackLocked(committed, existedBefore)
		if failed != nil {
			warnings = append(warnings, "回滚未完成："+c.safeError(failed))
		}
		snap, snapErr := c.content.RefreshLocked(ctx)
		result.Status = StatusPartial
		result.Error = "发布在提交元数据前中断，旧版本保持可读"
		if contextErr(ctx) != nil {
			result.Error = "发布已取消，旧版本保持可读"
		}
		result.Warnings = warnings
		if snapErr != nil {
			result.Error += "；清单未能扫描"
		} else if snap != nil {
			result.ManifestGeneratedAt = snap.GeneratedAt
			result.ManifestSHA256 = content.ManifestDigest(snap)
			result.Files = filesFromSnapshotForTargets(snap, targets)
		}
		return result, nil
	}

	// Metadata is atomically switched; the actual public files are now the new
	// complete version. Cleanup is best effort and happens before the scan.
	snap, snapErr := c.content.RefreshLocked(ctx)
	if snapErr == nil && snap != nil {
		if d.PublishedSHA256 != "" {
			warnings = append(warnings, c.cleanupOldLocked(d.Kind == storage.DraftKindProfile, targets, refs, snap)...)
			snap, snapErr = c.content.RefreshLocked(ctx)
		}
	}
	if snapErr != nil {
		result.Status = StatusPartial
		result.Error = "公开文件已提交，但清单扫描失败：" + c.safeError(snapErr)
		result.Warnings = warnings
		return result, nil
	}
	result.Files = filesFromTargets(targets)
	result.ManifestGeneratedAt = snap.GeneratedAt
	result.ManifestSHA256 = content.ManifestDigest(snap)
	result.Warnings = warnings
	result.CurrentPublishedSHA256 = targetMetadataSHA
	if c.commitHook != nil {
		if err := c.commitHook(); err != nil {
			result.Status = StatusPartial
			result.Error = "公开文件已提交，但发布状态回写失败：" + c.safeError(err)
			return result, nil
		}
	}
	if err := c.store.SetPublicDraftPublished(ctx, d.DraftID, d.Revision, metadataPath, targetMetadataSHA); err != nil {
		result.Status = StatusPartial
		result.Error = "公开文件已提交，但草稿发布状态未回写：" + c.safeError(err)
		return result, nil
	}
	result.Status = StatusPublished
	return result, nil
}

// metadataVersionUnchangedLocked compares the current public metadata file to
// the hash observed at the start of the publish critical section. A new file
// appearing during a first publish is also a conflict.
func (c *Coordinator) metadataVersionUnchangedLocked(rel, before string) (bool, string) {
	exists, err := c.content.PublicFileExistsLocked(rel)
	if err != nil || !exists {
		return before == "", ""
	}
	sha, _, err := c.content.PublicFileSHA256Locked(rel, metadataMaxBytes)
	if err != nil {
		return false, ""
	}
	return sha == before, sha
}

func (c *Coordinator) allTargetsPresentLocked(files []targetFile) bool {
	for _, f := range files {
		sha, size, err := c.content.PublicFileSHA256Locked(f.path, int64(len(f.data))+1)
		if err != nil || sha != hashBytes(f.data) || size != int64(len(f.data)) {
			return false
		}
	}
	return true
}

func filesFromSnapshotForTargets(snap *content.Snapshot, targets []targetFile) []PublishFile {
	if snap == nil {
		return nil
	}
	byPath := make(map[string]content.Entry, len(snap.Entries))
	for _, entry := range snap.Entries {
		byPath[entry.Path] = entry
	}
	out := make([]PublishFile, 0, len(targets))
	for _, target := range targets {
		if entry, ok := byPath[target.path]; ok {
			out = append(out, PublishFile{Path: entry.Path, SizeBytes: entry.Size, SHA256: entry.SHA256})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func filesFromTargets(files []targetFile) []PublishFile {
	out := make([]PublishFile, 0, len(files))
	for _, f := range files {
		out = append(out, PublishFile{Path: f.path, SizeBytes: int64(len(f.data)), SHA256: hashBytes(f.data)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// rollbackLocked removes only files this attempt newly created. The old
// metadata still points at the old (untouched) files.
func (c *Coordinator) rollbackLocked(committed []targetFile, existedBefore map[string]bool) error {
	var errs []error
	for i := len(committed) - 1; i >= 0; i-- {
		f := committed[i]
		if existedBefore[f.path] {
			continue
		}
		if err := c.content.RemovePublicFileLocked(f.path); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
