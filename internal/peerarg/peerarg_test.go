package peerarg

import "testing"

func TestNormalizeRemovesAllWhitespace(t *testing.T) {
	in := " /ip4/1.1.1.1/tcp/4001/p2p/12D3KooW\n\tAbC \r\n/ip6/::1/tcp/4001 "
	want := "/ip4/1.1.1.1/tcp/4001/p2p/12D3KooWAbC/ip6/::1/tcp/4001"
	if got := Normalize(in); got != want {
		t.Fatalf("Normalize = %q, want %q", got, want)
	}
}
