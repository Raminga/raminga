package publication

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"time"

	"github.com/Raminga/raminga/internal/content"
	"github.com/Raminga/raminga/internal/storage"
)

const profileMetadataPath = "profile/profile.json"

type profileRequestFile struct {
	PublishFile
	BeforeSHA256 string
}

func (c *Coordinator) profileMetadataLocked() (string, string, error) {
	raw, err := c.content.ReadPublicFileLocked(profileMetadataPath, metadataMaxBytes)
	if errors.Is(err, os.ErrNotExist) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	var profile profileJSONV2
	_ = json.Unmarshal(raw, &profile)
	return hashBytes(raw), profile.UpdatedAt, nil
}

func (c *Coordinator) profilePublicationTime(ctx context.Context, now time.Time, previous string) (time.Time, error) {
	last, err := c.store.LatestProfilePublicationTime(ctx)
	if err != nil {
		return time.Time{}, err
	}
	if last.Valid && now.UnixNano() <= last.Int64 {
		now = time.Unix(0, last.Int64+1)
	}
	if prior, err := time.Parse(time.RFC3339Nano, previous); err == nil && !now.After(prior) {
		now = prior.Add(time.Nanosecond)
	}
	return now.UTC(), nil
}

// stageProfileRequestLocked records the targets of a new request or verifies
// that a pending request can still resume. Already present targets require no
// staging write, including content-addressed avatars.
func (c *Coordinator) stageProfileRequestLocked(ctx context.Context, request *storage.ProfilePublicationRequest, targets []targetFile, pending bool) ([]targetFile, bool, error) {
	files := make([]profileRequestFile, 0, len(targets))
	if pending {
		if err := json.Unmarshal(request.FilesJSON, &files); err != nil {
			return nil, false, err
		}
		if len(files) != len(targets) {
			return nil, false, nil
		}
	}
	var changed []targetFile
	for i, target := range targets {
		file := PublishFile{Path: target.path, SizeBytes: int64(len(target.data)), SHA256: hashBytes(target.data)}
		actual, size, err := c.content.PublicFileSHA256Locked(file.Path, max(metadataMaxBytes, avatarMaxBytes))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			if pending {
				return nil, false, nil
			}
			return nil, false, err
		}
		matches := actual == file.SHA256 && size == file.SizeBytes
		if pending {
			if files[i].PublishFile != file || (!matches && actual != files[i].BeforeSHA256) {
				return nil, false, nil
			}
		} else {
			files = append(files, profileRequestFile{PublishFile: file, BeforeSHA256: actual})
		}
		if !matches {
			changed = append(changed, target)
		}
	}
	if !pending {
		raw, err := json.Marshal(files)
		if err != nil {
			return nil, false, err
		}
		request.FilesJSON = raw
		if err := c.store.BeginProfilePublication(ctx, *request); err != nil {
			return nil, false, err
		}
	}
	return changed, true, nil
}

// recoverProfileReceiptLocked finalizes a commit whose metadata was switched
// before its private receipt could be saved. It only reads public files.
func (c *Coordinator) recoverProfileReceiptLocked(ctx context.Context, r storage.ProfilePublicationRequest) (PublishResult, error) {
	var targets []profileRequestFile
	if err := json.Unmarshal(r.FilesJSON, &targets); err != nil {
		return PublishResult{}, err
	}
	result := PublishResult{
		CurrentRevision: r.Revision, CurrentPublishedSHA256: r.TargetSHA256,
		ManifestVersion: 1, ProfilePath: profileMetadataPath,
	}
	for _, file := range targets {
		sha, size, err := c.content.PublicFileSHA256Locked(file.Path, file.SizeBytes+1)
		if err != nil || sha != file.SHA256 || size != file.SizeBytes {
			result.Status = StatusConflict
			result.Error = "公开文件已在别处修改，未覆盖；请重新载入"
			return result, nil
		}
		result.Files = append(result.Files, file.PublishFile)
	}
	snap, err := c.content.RefreshLocked(ctx)
	if err != nil {
		result.Status = StatusPartial
		result.Error = "公开文件已提交，但清单扫描失败：" + c.safeError(err)
		return result, nil
	}
	slices.SortFunc(result.Files, func(a, b PublishFile) int { return cmp.Compare(a.Path, b.Path) })
	result.ManifestGeneratedAt = snap.GeneratedAt
	result.ManifestSHA256 = content.ManifestDigest(snap)
	result.Status = StatusPublished
	if err := c.finishProfileReceipt(ctx, r, result); err != nil {
		result.Status = StatusPartial
		result.Error = "公开文件已提交，但发布状态回写失败：" + c.safeError(err)
	}
	return result, nil
}

func (c *Coordinator) finishProfileReceipt(ctx context.Context, r storage.ProfilePublicationRequest, result PublishResult) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return c.store.FinishProfilePublication(ctx, r, result.ProfilePath, raw)
}
