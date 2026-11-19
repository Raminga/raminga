package node

import (
	"context"

	"github.com/Raminga/raminga/internal/publication"
	"github.com/Raminga/raminga/internal/storage"
)

// PublicProfile is the structured public profile view returned with
// GetPeerProfile. The legacy Name/Text fields remain populated separately.
type PublicProfile struct {
	AgentName              string
	AgentDescription       string
	AgentInterests         []string
	AgentConversationStyle string
	HumanName              string
	HumanBioMarkdown       string
	AvatarPath             string
	AvatarSHA256           string
	AvatarMime             string
	SourcePath             string
	LegacyFallback         bool
	Warning                string
}

// Public draft views are aliases so the local API does not duplicate storage
// or publication schemas.
type (
	PublicDraft      = storage.PublicDraft
	PublicDraftAsset = storage.PublicDraftAsset
	DraftUpdate      = publication.DraftUpdate
	PublishFile      = publication.PublishFile
	PublishResult    = publication.PublishResult
)

var (
	ErrDraftConflict = storage.ErrDraftConflict
	ErrDraftNotFound = storage.ErrDraftNotFound
	ErrDraftInvalid  = publication.ErrDraftInvalid
)

const (
	PublishStatusPublished        = publication.StatusPublished
	PublishStatusAlreadyPublished = publication.StatusAlreadyPublished
	PublishStatusConflict         = publication.StatusConflict
	PublishStatusInvalid          = publication.StatusInvalid
	PublishStatusPartial          = publication.StatusPartial
)

// GetPublicDraft returns one private draft.
func (n *Node) GetPublicDraft(ctx context.Context, id string) (PublicDraft, bool, error) {
	return n.publication.GetDraft(ctx, id)
}

// ListPublicDrafts returns a newest-first page of private drafts.
func (n *Node) ListPublicDrafts(ctx context.Context, kind, before string, limit int) ([]PublicDraft, bool, string, error) {
	rows, hasMore, err := n.publication.ListDrafts(ctx, kind, before, limit)
	if err != nil {
		return nil, false, "", err
	}
	next := ""
	if hasMore && len(rows) > 0 {
		next = storage.EncodeDraftCursor(rows[len(rows)-1])
	}
	return rows, hasMore, next, nil
}

// SavePublicDraft creates or updates a private SQLite draft only.
func (n *Node) SavePublicDraft(ctx context.Context, in DraftUpdate) (PublicDraft, error) {
	return n.publication.SaveDraft(ctx, in)
}

// GetPublicDraftAsset returns one private image/avatar descriptor.
func (n *Node) GetPublicDraftAsset(ctx context.Context, draftID, assetID string) (PublicDraftAsset, bool, error) {
	return n.store.GetPublicDraftAsset(ctx, draftID, assetID)
}

// PutPublicDraftImage validates and stores an avatar/image privately.
func (n *Node) PutPublicDraftImage(ctx context.Context, draftID, role, filename string, data []byte) (PublicDraftAsset, error) {
	return n.publication.PutDraftImage(ctx, draftID, role, filename, data)
}

// ImportPublicPost opens an existing local post as a private edit draft.
func (n *Node) ImportPublicPost(ctx context.Context, rel string) (PublicDraft, error) {
	return n.publication.ImportPost(ctx, rel)
}

// DeletePublicDraft removes one private draft and its assets.
func (n *Node) DeletePublicDraft(ctx context.Context, id string, expectedRevision int64) (bool, error) {
	return n.publication.DeleteDraft(ctx, id, expectedRevision)
}

// PublishPublicDraft atomically commits one draft under the publication lock.
func (n *Node) PublishPublicDraft(ctx context.Context, id string, expectedRevision int64, expectedPublishedSHA string) (PublishResult, error) {
	return n.publication.Publish(ctx, id, expectedRevision, expectedPublishedSHA)
}

// RecoverPublication runs startup staging cleanup and incomplete-version
// quarantine before the API serves manifests.
func (n *Node) RecoverPublication(ctx context.Context) ([]string, error) {
	return n.publication.Recover(ctx)
}
