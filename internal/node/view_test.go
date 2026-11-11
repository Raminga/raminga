package node_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/identity"
	"github.com/Raminga/raminga/internal/network"
	"github.com/Raminga/raminga/internal/node"
	"github.com/Raminga/raminga/internal/storage"
)

func newTestNodeOn(t *testing.T, listen string) *testNode {
	t.Helper()
	dir := t.TempDir()
	id, err := identity.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.Network.ListenAddrs = []string{listen}
	netw, err := network.New(network.Config{PrivateKey: id.PrivateKey(), ListenAddrs: []string{listen}})
	if err != nil {
		t.Fatal(err)
	}
	n, err := node.New(node.Options{DataDir: dir, Version: "test", Config: cfg, Identity: id, Store: store, Network: netw})
	if err != nil {
		t.Fatal(err)
	}
	if err := n.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	tn := &testNode{node: n, id: id, dir: dir}
	t.Cleanup(func() {
		clean, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = n.Stop(clean)
		_ = id.Close()
	})
	return tn
}

func writePublic(t *testing.T, n *testNode, rel, body string) {
	t.Helper()
	p := filepath.Join(n.dir, "public", filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestViewContentFlowAndFriendsHints(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatal(err)
	}
	hostIP := localNonLoopbackIPv4(t)
	c := newTestNodeOn(t, "/ip4/"+hostIP+"/tcp/0")
	writePublic(t, b, "profile/index.md", "# B profile\nhello from B")
	writePublic(t, b, "posts/post.txt", "post-body")
	writePublic(t, c, "profile/index.md", "# C profile\nhello from C")
	cAddr := tcpMultiaddr(t, c.status(t))
	if _, err := b.node.Connect(ctx, "", cAddr); err != nil {
		t.Fatal(err)
	}
	if _, err := b.node.SyncFriends(ctx); err != nil {
		t.Fatal(err)
	}
	list, err := a.node.ViewFriends(ctx, b.status(t).PeerID)
	if err != nil {
		t.Fatal(err)
	}
	var listed *node.PeerFriend
	for i := range list.Friends {
		if list.Friends[i].PeerID == c.status(t).PeerID {
			listed = &list.Friends[i]
		}
	}
	if listed == nil {
		t.Fatalf("C not listed: %+v", list)
	}
	hintAddrs := listed.Addrs
	if len(hintAddrs) == 0 {
		hintAddrs = []string{cAddr}
	} // LAN address is intentionally not exported.
	// Reading a list neither dials C nor writes C's row.
	st := a.status(t)
	for _, conn := range st.Connections {
		if conn.PeerID == c.status(t).PeerID {
			t.Fatalf("reading list dialed C: %+v", conn)
		}
	}
	af, _ := a.node.Friends(ctx)
	for _, f := range af {
		if f.PeerID == c.status(t).PeerID {
			t.Fatalf("listed peer written as local friend: %+v", f)
		}
	}
	if _, err := a.node.ConnectListedPeer(ctx, listed.PeerID, hintAddrs); err != nil {
		t.Fatalf("connect listed: %v", err)
	}
	profile, err := a.node.ViewProfile(ctx, b.status(t).PeerID)
	if err != nil {
		t.Fatal(err)
	}
	if !profile.Found || profile.Name != "B profile" || !strings.Contains(profile.Text, "hello from B") {
		t.Fatalf("profile=%+v", profile)
	}
	post, err := a.node.Download(ctx, b.status(t).PeerID, "posts/post.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	if post.Size != int64(len("post-body")) || post.SHA256 == "" {
		t.Fatalf("download=%+v", post)
	}
	data, _ := os.ReadFile(post.LocalPath)
	if string(data) != "post-body" {
		t.Fatalf("body=%q", data)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(post.LocalPath)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("downloaded file mode = %o, want 600", perm)
		}
	}
	wantDir := filepath.Join(a.dir, "downloads", b.status(t).PeerID)
	rel, err := filepath.Rel(wantDir, post.LocalPath)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		t.Fatalf("downloaded path %q escaped %q (rel=%q err=%v)", post.LocalPath, wantDir, rel, err)
	}
	if filepath.ToSlash(rel) != "posts/post.txt" {
		t.Fatalf("downloaded path = %q, want current manifest path posts/post.txt", rel)
	}
	cProfile, err := a.node.ViewProfile(ctx, c.status(t).PeerID)
	if err != nil || !strings.Contains(cProfile.Text, "hello from C") {
		t.Fatalf("C profile=%+v err=%v", cProfile, err)
	}
}

func TestDownloadResumeAndHashMismatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatal(err)
	}
	writePublic(t, b, "posts/big.txt", "0123456789abcdef")
	writePublic(t, b, "posts/mismatch.txt", "same-size-1")
	_, err := a.node.FetchManifest(ctx, b.status(t).PeerID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	var entryPath = "posts/big.txt"
	// Seed a partial file and resume through Range.
	partDir := filepath.Join(a.dir, "downloads", b.status(t).PeerID, "posts")
	if err := os.MkdirAll(partDir, 0o755); err != nil {
		t.Fatal(err)
	}
	part := filepath.Join(partDir, "big.txt.part")
	if err := os.WriteFile(part, []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := a.node.Download(ctx, b.status(t).PeerID, entryPath, nil)
	if err != nil {
		raw, _ := os.ReadFile(part)
		t.Fatalf("download err=%v part=%q", err, raw)
	}
	if !res.Resumed || res.Size != 16 {
		t.Fatalf("resume=%+v", res)
	}
	// Change the file after the cached manifest: hash/size verification must fail.
	if _, err := a.node.Download(ctx, b.status(t).PeerID, "posts/mismatch.txt", nil); err != nil {
		t.Fatal(err)
	}
	writePublic(t, b, "posts/mismatch.txt", "same-size-2")
	_, err = a.node.Download(ctx, b.status(t).PeerID, "posts/mismatch.txt", nil)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "changed or corrupt") {
		t.Fatalf("mismatch err=%v", err)
	}
}

func TestViewFriendsRejectsControlAndKeepsClaimsOutOfTable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatal(err)
	}
	hostile := `{"version":1,"friends":[{"name":"evil\u001b[31m","peer_id":"12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6","addrs":["/ip4/127.0.0.1/tcp/1"],"description":"x"}]}`
	writePublic(t, b, "friends.json", hostile)
	_, err := a.node.ViewFriends(ctx, b.status(t).PeerID)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "control") {
		t.Fatalf("hostile friends err=%v", err)
	}
	friends, _ := a.node.Friends(ctx)
	for _, f := range friends {
		if f.PeerID == "12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6" {
			t.Fatalf("claim inserted: %+v", f)
		}
	}
}

func TestViewFriendsRejectsOversizedAndMalformed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatal(err)
	}
	var tooMany strings.Builder
	tooMany.WriteString(`{"version":1,"friends":[`)
	for i := 0; i < 10001; i++ {
		if i > 0 {
			tooMany.WriteByte(',')
		}
		fmt.Fprintf(&tooMany, `{"name":"","peer_id":"12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6","addrs":[],"description":""}`)
	}
	tooMany.WriteString(`]}`)
	cases := []struct {
		name string
		body string
		want string
	}{
		{"oversized", strings.Repeat("x", 4<<20+1), "too large"},
		{"malformed", `{"version":1,`, "invalid friends.json"},
		{"unknown field", `{"version":1,"friends":[],"extra":1}`, "invalid friends.json"},
		{"trailing data", `{"version":1,"friends":[]}{}`, "trailing data"},
		{"wrong version", `{"version":2,"friends":[]}`, "unsupported friends.json version"},
		{"too many entries", tooMany.String(), "too many entries"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Each ViewFriends call uses at least manifest+download tokens.
			time.Sleep(250 * time.Millisecond)
			writePublic(t, b, "friends.json", tc.body)
			if _, err := b.node.Published(ctx); err != nil {
				t.Fatal(err)
			}
			_, err := a.node.ViewFriends(ctx, b.status(t).PeerID)
			if err == nil {
				t.Fatal("malformed friends.json accepted")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
		})
	}
}

func TestDownloadMissingPathExplainsRemoteManifest(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a := newTestNode(t, t.TempDir())
	b := newTestNode(t, t.TempDir())
	if _, err := a.node.Connect(ctx, "", tcpMultiaddr(t, b.status(t))); err != nil {
		t.Fatal(err)
	}
	_, err := a.node.Download(ctx, b.status(t).PeerID, "local-save-location.txt", nil)
	if err == nil {
		t.Fatal("download of a path outside the remote manifest unexpectedly succeeded")
	}
	for _, want := range []string{"对方发布清单里没有文件", "不是本地保存位置", "/files", "raminga content manifest"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("missing-path error %q missing %q", err, want)
		}
	}
}
