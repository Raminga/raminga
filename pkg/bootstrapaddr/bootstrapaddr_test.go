package bootstrapaddr

import (
	"testing"
)

const peerID = "12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6"

func TestParseCanonicalAndRejectsUnsafeInput(t *testing.T) {
	got, err := Parse("/ip4/127.0.0.1/tcp/4001/p2p/" + peerID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PeerID != peerID || got.Multiaddr != "/ip4/127.0.0.1/tcp/4001/p2p/"+peerID {
		t.Fatalf("parsed = %+v", got)
	}
	for _, raw := range []string{
		"",
		" /ip4/127.0.0.1/tcp/4001/p2p/" + peerID,
		"/ip4/127.0.0.1/tcp/4001/p2p/" + peerID + "\n",
		"/ip4/127.0.0.1/tcp/4001",
		"/ip4/127.0.0.1/tcp/4001/p2p/not-a-peer",
		"/dnsaddr/bootstrap.libp2p.io/p2p/" + peerID,
		"/ip4/203.0.113.1/tcp/4001/p2p/" + peerID + "/ipfs/Qm",
	} {
		if _, err := Parse(raw); err == nil {
			t.Fatalf("Parse(%q) unexpectedly succeeded", raw)
		}
	}
	if !IsPublicBootstrap("https://ipfs.io/") || IsPublicBootstrap("raminga.example") {
		t.Fatal("public marker classification drifted")
	}
}
