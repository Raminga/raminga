package publication

import (
	"context"
	"fmt"
	"path"

	"github.com/Raminga/raminga/internal/storage"
)

// ImportPost opens an existing local public post for controlled editing. It
// copies the post body and images into private SQLite draft assets, records the
// exact public path/hash for optimistic conflict detection, and never writes to
// public/. Unknown top-level JSON fields stay in the original file and are
// merged back on publish.
func (c *Coordinator) ImportPost(ctx context.Context, rel string) (storage.PublicDraft, error) {
	if _, ok := validSourcePostPath(rel); !ok {
		return storage.PublicDraft{}, fmt.Errorf("%w: 只能导入本机 posts 目录中的公开动态", ErrDraftInvalid)
	}
	unlock := c.lockDraft("import:" + rel)
	defer unlock()
	c.content.LockPublish()
	defer c.content.UnlockPublish()

	if existing, found, err := c.store.FindPublicDraftByPublishedPath(ctx, rel); err != nil {
		return storage.PublicDraft{}, err
	} else if found {
		return existing, nil
	}

	data, err := c.content.ReadPublicFileLocked(rel, metadataMaxBytes)
	if err != nil {
		return storage.PublicDraft{}, fmt.Errorf("%w: 原公开动态不存在或不可读取", ErrDraftInvalid)
	}
	source, err := parseSourcePost(rel, data, c.peerID)
	if err != nil {
		return storage.PublicDraft{}, err
	}
	if source.schemaVersion == 1 && len(source.images) > 0 {
		return storage.PublicDraft{}, fmt.Errorf("%w: 旧版 v1 动态包含无法映射的资源", ErrDraftInvalid)
	}

	type importedAsset struct {
		image storage.PublicDraftAsset
	}
	assets := make([]importedAsset, 0, len(source.images))
	for _, meta := range source.images {
		full := path.Join(path.Dir(rel), meta.Path)
		imageData, readErr := c.content.ReadPublicFileLocked(full, imageMaxBytes)
		if readErr != nil {
			return storage.PublicDraft{}, fmt.Errorf("%w: 公开动态图片缺失或不可读取", ErrDraftInvalid)
		}
		image, imageErr := ValidateImage(imageData, "image", "image"+imageExtension(meta.Mime))
		if imageErr != nil || image.SHA256 != meta.SHA256 || image.Mime != meta.Mime ||
			int64(len(image.Bytes)) != meta.SizeBytes || image.Width != meta.Width || image.Height != meta.Height {
			return storage.PublicDraft{}, fmt.Errorf("%w: 公开动态图片与元数据不一致", ErrDraftInvalid)
		}
		assets = append(assets, importedAsset{image: storage.PublicDraftAsset{
			Role: "image", SHA256: image.SHA256, Mime: image.Mime,
			Width: image.Width, Height: image.Height, Bytes: image.Bytes,
		}})
	}

	id, err := newDraftID()
	if err != nil {
		return storage.PublicDraft{}, err
	}
	created, err := c.store.CreatePublicDraft(ctx, storage.PublicDraft{
		DraftID: id, Kind: storage.DraftKindPost, AuthorKind: source.authorKind,
		Title: source.title, BodyMarkdown: source.body, Tags: source.tags,
		AgentInterests: []string{}, ImageAssetIDs: []string{},
		PublishedPath: rel, PublishedSHA256: hashBytes(data), PublishedRevision: source.revision,
	})
	if err != nil {
		return storage.PublicDraft{}, err
	}
	cleanup := func() {
		_, _ = c.store.DeletePublicDraft(ctx, created.DraftID, created.Revision)
	}
	ids := make([]string, 0, len(assets))
	for i := range assets {
		asset := assets[i].image
		asset.DraftID = created.DraftID
		stored, putErr := c.store.PutPublicDraftAsset(ctx, asset)
		if putErr != nil {
			cleanup()
			return storage.PublicDraft{}, putErr
		}
		ids = append(ids, stored.AssetID)
	}
	if len(ids) == 0 {
		return created, nil
	}
	updated, err := c.store.UpdatePublicDraft(ctx, storage.PublicDraft{
		DraftID: created.DraftID, Kind: created.Kind, AuthorKind: created.AuthorKind,
		Title: created.Title, BodyMarkdown: created.BodyMarkdown, Tags: created.Tags,
		AgentInterests: []string{}, ImageAssetIDs: ids,
	}, created.Revision)
	if err != nil {
		cleanup()
		return storage.PublicDraft{}, err
	}
	return updated, nil
}
