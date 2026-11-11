package node

import (
	"testing"

	ma "github.com/multiformats/go-multiaddr"
)

func TestRemotePathSafety(t *testing.T) {
	bad := []string{"", "/abs", "../x", "a/../../b", "a\\b", "a\x00b", "a/CON", "a/con.txt", "a/C:evil", "a/aux", "a/.", "a//b"}
	for _, p := range bad {
		if validRemotePath(p) {
			t.Fatalf("accepted unsafe path %q", p)
		}
	}
	for _, p := range []string{"profile/index.md", "posts/2026/a.txt", "friends.json"} {
		if !validRemotePath(p) {
			t.Fatalf("rejected safe path %q", p)
		}
	}
}

func TestFriendHintAddressFilter(t *testing.T) {
	bad := []string{"/ip4/127.0.0.1/tcp/1", "/ip4/0.0.0.0/tcp/1", "/ip6/::1/tcp/1", "/ip6/fe80::1/tcp/1", "/ip4/169.254.1.1/tcp/1"}
	for _, raw := range bad {
		a, err := ma.NewMultiaddr(raw)
		if err != nil {
			t.Fatal(err)
		}
		if usableHintAddr(a) {
			t.Fatalf("accepted unusable hint %s", raw)
		}
	}
	for _, raw := range []string{"/ip4/10.0.0.2/tcp/1", "/ip4/1.1.1.1/tcp/1"} {
		a, _ := ma.NewMultiaddr(raw)
		if !usableHintAddr(a) {
			t.Fatalf("rejected hint %s", raw)
		}
	}
}
