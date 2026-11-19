package node

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/Raminga/raminga/internal/content"
)

const (
	maxProfileJSONBytes = 128 << 10
	maxAgentCardBytes   = 96 << 10
	maxIndexMDBytes     = 256 << 10
	maxAvatarBytes      = 4 << 20
)

type publicProfileJSON struct {
	SchemaVersion int `json:"schema_version"`
	Agent         struct {
		Name              string   `json:"name"`
		Description       string   `json:"description"`
		Interests         []string `json:"interests"`
		ConversationStyle string   `json:"conversation_style"`
		Avatar            string   `json:"avatar"`
		AvatarSHA256      string   `json:"avatar_sha256"`
		AvatarMime        string   `json:"avatar_mime"`
	} `json:"agent"`
	Human struct {
		Name        string `json:"name"`
		BioMarkdown string `json:"bio_markdown"`
	} `json:"human"`
	UpdatedAt string `json:"updated_at"`
}

type publicAgentCardJSON struct {
	SchemaVersion     int      `json:"schema_version"`
	DisplayName       string   `json:"display_name"`
	Description       string   `json:"description"`
	Interests         []string `json:"interests"`
	ConversationStyle string   `json:"conversation_style"`
	UpdatedAt         string   `json:"updated_at"`
}

func (n *Node) manifestEntries(ctx context.Context, pid peer.ID) ([]content.Entry, bool, error) {
	var all []content.Entry
	offset := 0
	limited := false
	for offset < 100000 {
		page, err := n.FetchManifest(ctx, pid.String(), offset, content.MaxManifestLimit)
		if err != nil {
			return nil, false, err
		}
		limited = limited || page.Limited
		all = append(all, page.Entries...)
		if len(page.Entries) == 0 || offset+len(page.Entries) >= page.Total {
			break
		}
		offset += len(page.Entries)
	}
	return all, limited, nil
}

func profileText(value string, maxRunes int) (string, error) {
	value = strings.ReplaceAll(value, "\x00", "")
	if !utf8.ValidString(value) {
		return "", errors.New("不是有效 UTF-8")
	}
	for _, r := range value {
		if r == '\n' || r == '\r' || r == '\t' {
			continue
		}
		if unicode.IsControl(r) {
			return "", errors.New("包含控制字符")
		}
	}
	if utf8.RuneCountInString(value) > maxRunes {
		return "", fmt.Errorf("超过 %d 字符", maxRunes)
	}
	return strings.TrimSpace(value), nil
}

func (n *Node) downloadProfileBytes(ctx context.Context, pid peer.ID, rel string, maxBytes int64) ([]byte, error) {
	res, err := n.Download(ctx, pid.String(), rel, nil)
	if err != nil {
		return nil, err
	}
	if res.Size > maxBytes {
		return nil, fmt.Errorf("文件超过 %d 字节", maxBytes)
	}
	data, err := os.ReadFile(res.LocalPath)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("文件超过 %d 字节", maxBytes)
	}
	return data, nil
}

func decodeStrictJSON(data []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra struct{}
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("JSON 尾部有多余数据")
	}
	return nil
}

func (n *Node) loadPeerProfile(ctx context.Context, pid peer.ID) (PeerProfile, error) {
	entries, limited, err := n.manifestEntries(ctx, pid)
	if err != nil {
		return PeerProfile{}, err
	}
	profile := PeerProfile{PeerID: pid.String()}
	byPath := make(map[string]content.Entry, len(entries))
	for _, e := range entries {
		profile.Files = append(profile.Files, e.Path)
		byPath[e.Path] = e
	}
	_ = limited
	var warnings []string
	var indexText string
	var humanName, humanBio string

	readIndex := func() {
		if _, ok := byPath["profile/index.md"]; !ok {
			return
		}
		data, err := n.downloadProfileBytes(ctx, pid, "profile/index.md", maxIndexMDBytes)
		if err != nil {
			warnings = append(warnings, "读取 profile/index.md 失败")
			return
		}
		indexText = string(data)
		humanBio = strings.TrimSpace(indexText)
		humanName = firstHeading(indexText)
	}

	profileJSONPath := "profile/profile.json"
	if _, ok := byPath[profileJSONPath]; ok {
		data, err := n.downloadProfileBytes(ctx, pid, profileJSONPath, maxProfileJSONBytes)
		if err == nil {
			var p publicProfileJSON
			if jsonErr := decodeStrictJSON(data, &p); jsonErr == nil && p.SchemaVersion == 2 {
				name, nameErr := profileText(p.Agent.Name, 64)
				desc, descErr := profileText(p.Agent.Description, 2000)
				style, styleErr := profileText(p.Agent.ConversationStyle, 1000)
				human, humanErr := profileText(p.Human.Name, 64)
				bio, bioErr := profileText(p.Human.BioMarkdown, 4000)
				if nameErr == nil && descErr == nil && styleErr == nil && humanErr == nil && bioErr == nil {
					interests := make([]string, 0, len(p.Agent.Interests))
					for _, raw := range p.Agent.Interests {
						value, err := profileText(raw, 80)
						if err == nil && value != "" {
							interests = append(interests, value)
						}
						if len(interests) >= 10 {
							break
						}
					}
					profile.Profile.AgentName = name
					profile.Profile.AgentDescription = desc
					profile.Profile.AgentInterests = interests
					profile.Profile.AgentConversationStyle = style
					profile.Profile.HumanName = human
					profile.Profile.HumanBioMarkdown = bio
					profile.Profile.SourcePath = profileJSONPath
					profile.Name = human
					profile.Text = bio
					profile.Found = true
					if p.Agent.Avatar != "" {
						avatar, warning := n.checkedAvatar(pid, byPath, p.Agent.Avatar, p.Agent.AvatarSHA256, p.Agent.AvatarMime)
						if warning != "" {
							warnings = append(warnings, warning)
						} else {
							profile.Profile.AvatarPath = avatar.path
							profile.Profile.AvatarSHA256 = avatar.sha
							profile.Profile.AvatarMime = avatar.mime
						}
					}
					readIndex()
					if profile.Name == "" {
						profile.Name = humanName
					}
					if profile.Text == "" {
						profile.Text = strings.TrimSpace(indexText)
					}
					if profile.Name == "" {
						profile.Name = pid.String()
					}
					profile.Profile.Warning = strings.Join(warnings, "；")
					return profile, nil
				}
				warnings = append(warnings, "profile.json 字段无效或超限，已回退旧格式")
			} else {
				warnings = append(warnings, "profile.json 损坏或版本不支持，已回退旧格式")
			}
		} else {
			warnings = append(warnings, "读取 profile.json 失败，已回退旧格式")
		}
	}

	// Legacy fallback: agent-card.json v1 + index.md. Missing Agent fields stay
	// empty; a human name is never presented as the Agent's name.
	profile.Profile.LegacyFallback = true
	if _, ok := byPath["profile/agent-card.json"]; ok {
		data, err := n.downloadProfileBytes(ctx, pid, "profile/agent-card.json", maxAgentCardBytes)
		if err == nil {
			var card publicAgentCardJSON
			if jsonErr := decodeStrictJSON(data, &card); jsonErr == nil && card.SchemaVersion == 1 {
				name, nameErr := profileText(card.DisplayName, 64)
				desc, descErr := profileText(card.Description, 2000)
				style, styleErr := profileText(card.ConversationStyle, 1000)
				if nameErr == nil && descErr == nil && styleErr == nil {
					profile.Profile.AgentName = name
					profile.Profile.AgentDescription = desc
					profile.Profile.AgentConversationStyle = style
					interests := make([]string, 0, len(card.Interests))
					for _, raw := range card.Interests {
						value, err := profileText(raw, 80)
						if err == nil && value != "" {
							interests = append(interests, value)
						}
						if len(interests) >= 10 {
							break
						}
					}
					profile.Profile.AgentInterests = interests
					profile.Profile.SourcePath = "profile/agent-card.json"
					profile.Found = true
				} else {
					warnings = append(warnings, "agent-card.json 字段无效或超限")
				}
			} else {
				warnings = append(warnings, "agent-card.json 损坏或版本不支持")
			}
		} else {
			warnings = append(warnings, "读取 agent-card.json 失败")
		}
	}
	readIndex()
	if humanName != "" || strings.TrimSpace(indexText) != "" {
		profile.Found = true
		if profile.Profile.SourcePath == "" {
			profile.Profile.SourcePath = "profile/index.md"
		}
	}
	profile.Profile.HumanName = humanName
	if humanBio != "" && strings.HasPrefix(humanBio, "#") {
		if idx := strings.IndexByte(humanBio, '\n'); idx >= 0 {
			profile.Profile.HumanBioMarkdown = strings.TrimSpace(humanBio[idx+1:])
		}
	} else {
		profile.Profile.HumanBioMarkdown = humanBio
	}
	profile.Name = humanName
	if profile.Name == "" {
		profile.Name = pid.String()
	}
	profile.Text = strings.TrimSpace(indexText)
	profile.Profile.Warning = strings.Join(warnings, "；")
	return profile, nil
}

type checkedAvatar struct {
	path string
	sha  string
	mime string
}

func (n *Node) checkedAvatar(pid peer.ID, entries map[string]content.Entry, name, sha, mime string) (checkedAvatar, string) {
	if path.Base(name) != name || strings.Contains(name, "\\") || strings.Contains(name, "..") {
		return checkedAvatar{}, "头像文件名为非法路径，已忽略"
	}
	if !strings.HasPrefix(name, "avatar-") || (!strings.HasSuffix(name, ".png") && !strings.HasSuffix(name, ".jpg")) {
		return checkedAvatar{}, "头像文件名不符合 avatar-<sha8>.png 约定，已忽略"
	}
	if len(sha) != 64 || strings.ToLower(sha) != sha {
		return checkedAvatar{}, "头像 SHA-256 格式无效，已忽略"
	}
	if mime != "image/png" && mime != "image/jpeg" {
		return checkedAvatar{}, "头像 MIME 只支持 PNG/JPEG，已忽略"
	}
	entry, ok := entries["profile/"+name]
	if !ok || entry.Size > maxAvatarBytes {
		return checkedAvatar{}, "头像不在公开清单中或超过大小上限，已忽略"
	}
	if !strings.EqualFold(entry.SHA256, sha) {
		return checkedAvatar{}, "头像哈希与公开清单不一致，已忽略"
	}
	if (mime == "image/png" && !strings.HasSuffix(name, ".png")) || (mime == "image/jpeg" && !strings.HasSuffix(name, ".jpg")) {
		return checkedAvatar{}, "头像扩展名与 MIME 不一致，已忽略"
	}
	return checkedAvatar{path: "profile/" + name, sha: sha, mime: mime}, ""
}
