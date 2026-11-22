package publication

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Recover cleans abandoned staging directories and quarantines incomplete v2
// public versions before the API serves its first manifest. It never deletes a
// complete old version and never rewrites valid v1 files.
func (c *Coordinator) Recover(ctx context.Context) ([]string, error) {
	c.content.LockPublish()
	defer c.content.UnlockPublish()
	var warnings []string
	stagingRoot := filepath.Join(c.dataDir, "publication", "staging")
	if entries, err := os.ReadDir(stagingRoot); err == nil {
		for _, entry := range entries {
			if err := os.RemoveAll(filepath.Join(stagingRoot, entry.Name())); err != nil {
				return warnings, fmt.Errorf("publication: clean staging %s: %w", entry.Name(), err)
			}
		}
	} else if !os.IsNotExist(err) {
		return warnings, fmt.Errorf("publication: inspect staging: %w", err)
	}
	if err := os.MkdirAll(stagingRoot, 0o700); err != nil {
		return warnings, err
	}
	snap, err := c.content.RefreshLocked(ctx)
	if err != nil {
		return warnings, err
	}
	quarantined := false
	for _, entry := range snap.Entries {
		if contextErr(ctx) != nil {
			return warnings, ctx.Err()
		}
		bad, reason := c.validatePublishedLocked(entry.Path)
		if !bad {
			continue
		}
		if err := c.quarantineLocked(entry.Path); err != nil {
			warnings = append(warnings, fmt.Sprintf("隔离不完整公开文件失败：%s（%s）", path.Base(entry.Path), reason))
			continue
		}
		quarantined = true
		warnings = append(warnings, fmt.Sprintf("已隔离不完整公开文件：%s（%s）", entry.Path, reason))
	}
	if quarantined {
		if _, err := c.content.RefreshLocked(ctx); err != nil {
			return warnings, err
		}
	}
	return warnings, nil
}

func (c *Coordinator) validatePublishedLocked(rel string) (bool, string) {
	if rel == "profile/profile.json" {
		var p profileJSONV2
		data, err := c.content.ReadPublicFileLocked(rel, metadataMaxBytes)
		if err != nil {
			return true, "无法读取"
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return true, "JSON 损坏"
		}
		if p.SchemaVersion != 2 {
			return false, ""
		}
		if p.Agent.Avatar != "" {
			if path.Base(p.Agent.Avatar) != p.Agent.Avatar {
				return true, "头像路径无效"
			}
			avatarRel := "profile/" + p.Agent.Avatar
			sha, size, err := c.content.PublicFileSHA256Locked(avatarRel, avatarMaxBytes)
			if err != nil || sha != p.Agent.AvatarSHA256 || size <= 0 {
				return true, "头像缺失或哈希不一致"
			}
		}
		return false, ""
	}
	if !strings.HasSuffix(rel, "/post.json") {
		return false, ""
	}
	var post postJSONV2
	data, err := c.content.ReadPublicFileLocked(rel, metadataMaxBytes)
	if err != nil {
		return true, "无法读取"
	}
	if err := json.Unmarshal(data, &post); err != nil {
		return true, "JSON 损坏"
	}
	if post.SchemaVersion != 2 {
		// A future version is not evidence of a half-written v2 file.
		return false, ""
	}
	if post.Author.PeerID != c.peerID || post.Format != "markdown" || post.ID == "" {
		return true, "元数据字段不一致"
	}
	dir := path.Dir(rel)
	for _, img := range post.Images {
		if !strings.HasPrefix(img.Path, "images/") || strings.Contains(img.Path, "..") || strings.Contains(img.Path, "\\") {
			return true, "图片路径无效"
		}
		full := dir + "/" + img.Path
		sha, size, err := c.content.PublicFileSHA256Locked(full, imageMaxBytes)
		if err != nil || sha != img.SHA256 || size != img.SizeBytes {
			return true, "图片缺失或哈希不一致"
		}
	}
	return false, ""
}

func (c *Coordinator) quarantineLocked(rel string) error {
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	dest := filepath.Join(c.dataDir, "publication", "quarantine", stamp, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	src := filepath.Join(c.dataDir, "public", filepath.FromSlash(rel))
	return os.Rename(src, dest)
}
