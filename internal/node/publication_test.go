package node_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Raminga/raminga/internal/content"
	"github.com/Raminga/raminga/internal/node"
)

func testPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 63, G: 228, B: 182, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func ptr(v string) *string { return &v }

func TestPublishedProfileAndPostAreReadableBySecondNode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatal(err)
	}
	profile, err := b.node.SavePublicDraft(ctx, node.DraftUpdate{
		DraftID: "profile", Kind: "profile", ExpectedRevision: 0,
		AgentName: ptr("Nebula"), AgentDescription: ptr("喜欢星空"),
		AgentInterests: []string{"天文", "独立游戏"}, AgentStyle: ptr("好奇而温和"),
		HumanName: ptr("JO JO"), HumanBio: ptr("喜欢创造有趣的东西"),
	})
	if err != nil {
		t.Fatal(err)
	}
	avatar, err := b.node.PutPublicDraftImage(ctx, profile.DraftID, "avatar", "avatar.png", testPNG(t, 40, 40))
	if err != nil {
		t.Fatal(err)
	}
	humanAvatar, err := b.node.PutPublicDraftImage(ctx, profile.DraftID, "human_avatar", "human-avatar.png", testPNG(t, 28, 28))
	if err != nil {
		t.Fatal(err)
	}
	profile, err = b.node.SavePublicDraft(ctx, node.DraftUpdate{
		DraftID: "profile", Kind: "profile", ExpectedRevision: profile.Revision,
		AvatarAssetID: avatar.AssetID, HumanAvatarAssetID: humanAvatar.AssetID,
		AgentName: ptr("Nebula"), AgentDescription: ptr("喜欢星空"),
		AgentInterests: []string{"天文", "独立游戏"}, AgentStyle: ptr("好奇而温和"),
		HumanName: ptr("JO JO"), HumanBio: ptr("喜欢创造有趣的东西"),
	})
	if err != nil {
		t.Fatal(err)
	}
	pres, err := b.node.PublishPublicDraft(ctx, profile.DraftID, profile.Revision, "", "")
	if err != nil || pres.Status != node.PublishStatusPublished {
		t.Fatalf("publish profile = %+v, %v", pres, err)
	}
	if pres.ManifestSHA256 == "" || pres.ProfilePath != "profile/profile.json" {
		t.Fatalf("profile receipt = %+v", pres)
	}

	post, err := b.node.SavePublicDraft(ctx, node.DraftUpdate{
		Kind: "post", AuthorKind: "agent", ExpectedRevision: 0,
		Title: ptr("第一条 Agent 动态"), BodyMarkdown: ptr("来自真实双节点的正文。"),
		Tags: []string{"测试"},
	})
	if err != nil {
		t.Fatal(err)
	}
	image, err := b.node.PutPublicDraftImage(ctx, post.DraftID, "image", "photo.png", testPNG(t, 24, 16))
	if err != nil {
		t.Fatal(err)
	}
	post, err = b.node.SavePublicDraft(ctx, node.DraftUpdate{
		DraftID: post.DraftID, Kind: "post", AuthorKind: "agent", ExpectedRevision: post.Revision,
		ImageAssetIDs: []string{image.AssetID},
	})
	if err != nil {
		t.Fatal(err)
	}
	postres, err := b.node.PublishPublicDraft(ctx, post.DraftID, post.Revision, "", "")
	if err != nil || postres.Status != node.PublishStatusPublished || postres.PostPath == "" {
		t.Fatalf("publish post = %+v, %v", postres, err)
	}

	remote, err := a.node.ViewProfile(ctx, b.status(t).PeerID)
	if err != nil {
		t.Fatal(err)
	}
	if !remote.Found || remote.Name != "JO JO" || remote.Text != "喜欢创造有趣的东西" {
		t.Fatalf("remote profile = %+v", remote)
	}
	if remote.Profile.AgentName != "Nebula" || len(remote.Profile.AgentInterests) != 2 || remote.Profile.AvatarPath == "" {
		t.Fatalf("structured profile = %+v", remote.Profile)
	}
	if remote.Profile.SourcePath != "profile/profile.json" || remote.Profile.LegacyFallback {
		t.Fatalf("profile source = %+v", remote.Profile)
	}
	if !strings.HasPrefix(remote.Profile.AvatarPath, "profile/avatar-") || remote.Profile.AvatarSHA256 == "" {
		t.Fatalf("avatar = %+v", remote.Profile)
	}
	if !strings.HasPrefix(remote.Profile.HumanAvatarPath, "profile/human-avatar-") || remote.Profile.HumanAvatarSHA256 == "" || remote.Profile.HumanAvatarMime != "image/png" {
		t.Fatalf("human avatar = %+v", remote.Profile)
	}

	manifest, err := a.node.FetchManifest(ctx, b.status(t).PeerID, 0, content.MaxManifestLimit)
	if err != nil {
		t.Fatal(err)
	}
	paths := map[string]content.Entry{}
	for _, entry := range manifest.Entries {
		paths[entry.Path] = entry
	}
	for _, want := range []string{"profile/profile.json", "profile/index.md", remote.Profile.AvatarPath, remote.Profile.HumanAvatarPath, postres.PostPath} {
		if _, ok := paths[want]; !ok {
			t.Fatalf("manifest missing %s: %+v", want, paths)
		}
	}
	downloaded, err := a.node.Download(ctx, b.status(t).PeerID, postres.PostPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		SchemaVersion int `json:"schema_version"`
		Author        struct {
			PeerID      string `json:"peer_id"`
			Kind        string `json:"kind"`
			DisplayName string `json:"display_name"`
		} `json:"author"`
		Images []struct {
			Path   string `json:"path"`
			SHA256 string `json:"sha256"`
			Size   int64  `json:"size_bytes"`
		} `json:"images"`
	}
	raw, err := os.ReadFile(downloaded.LocalPath)
	if err != nil || json.Unmarshal(raw, &saved) != nil {
		t.Fatalf("read post: %v %s", err, raw)
	}
	if saved.SchemaVersion != 2 || saved.Author.PeerID != b.status(t).PeerID || saved.Author.Kind != "agent" || saved.Author.DisplayName != "Nebula" {
		t.Fatalf("post author = %+v", saved)
	}
	if len(saved.Images) != 1 || saved.Images[0].Size <= 0 {
		t.Fatalf("post images = %+v", saved.Images)
	}
	imageRel := strings.TrimSuffix(postres.PostPath, "post.json") + saved.Images[0].Path
	time.Sleep(1100 * time.Millisecond) // content fetch rate limiter is per second
	img, err := a.node.Download(ctx, b.status(t).PeerID, imageRel, nil)
	if err != nil {
		t.Fatalf("download post image: %v", err)
	}
	if img.SHA256 != saved.Images[0].SHA256 {
		t.Fatalf("image hash = %s, want %s", img.SHA256, saved.Images[0].SHA256)
	}
}

func TestViewProfileFallsBackToLegacyFilesWithoutFakingAgentFields(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatal(err)
	}
	writePublicFile(t, b, "profile/index.md", "# Legacy Human\n\n旧格式人类介绍。")
	writePublicFile(t, b, "profile/agent-card.json", `{"schema_version":1,"display_name":"Old Nova","description":"旧 Agent 卡片","interests":["旧兴趣"],"conversation_style":"旧风格","updated_at":"2026-11-18T00:00:00Z"}`)
	p, err := a.node.ViewProfile(ctx, b.status(t).PeerID)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Found || p.Name != "Legacy Human" || !strings.Contains(p.Text, "旧格式人类介绍") {
		t.Fatalf("legacy profile = %+v", p)
	}
	if !p.Profile.LegacyFallback || p.Profile.AgentName != "Old Nova" || p.Profile.SourcePath != "profile/agent-card.json" {
		t.Fatalf("legacy structured profile = %+v", p.Profile)
	}
	// Without agent-card.json, the human name must not become the Agent name.
	c := newTestNode(t, t.TempDir())
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, c.status(t))); err != nil {
		t.Fatal(err)
	}
	writePublicFile(t, c, "profile/index.md", "# Only Human\n\n只有人类资料。")
	p, err = a.node.ViewProfile(ctx, c.status(t).PeerID)
	if err != nil {
		t.Fatal(err)
	}
	if p.Profile.AgentName != "" || p.Name != "Only Human" {
		t.Fatalf("human name leaked into Agent fields: %+v", p)
	}
	if !p.Profile.LegacyFallback || p.Profile.SourcePath != "profile/index.md" {
		t.Fatalf("legacy source = %+v", p.Profile)
	}
}

func writePublicFile(t *testing.T, n *testNode, rel, body string) {
	t.Helper()
	p := filepath.Join(n.dir, "public", filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPublicProfileV2WithoutHumanAvatarStillReads(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatal(err)
	}
	writePublicFile(t, b, "profile/index.md", "# Old Human\n\n旧版 v2 人类介绍。")
	writePublicFile(t, b, "profile/profile.json", `{"schema_version":2,"agent":{"name":"Old Agent","description":"旧 v2 Agent","interests":["旧兴趣"],"conversation_style":"温和"},"human":{"name":"Old Human","bio_markdown":"旧版 v2 人类介绍。"},"updated_at":"2026-11-18T00:00:00Z"}`)
	p, err := a.node.ViewProfile(ctx, b.status(t).PeerID)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Found || p.Profile.AgentName != "Old Agent" || p.Profile.HumanName != "Old Human" {
		t.Fatalf("v2 profile = %+v", p.Profile)
	}
	if p.Profile.HumanAvatarPath != "" || p.Profile.HumanAvatarSHA256 != "" || p.Profile.HumanAvatarMime != "" {
		t.Fatalf("old v2 profile invented a human avatar: %+v", p.Profile)
	}
	if p.Profile.AvatarPath != "" {
		t.Fatalf("old v2 profile invented an agent avatar: %+v", p.Profile)
	}
}
