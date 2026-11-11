package network

import (
	"crypto/rand"
	"testing"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/record"
	ma "github.com/multiformats/go-multiaddr"
)

func signedAddrRecord(t *testing.T, priv crypto.PrivKey, pid peer.ID, addrs []ma.Multiaddr, seq uint64) []byte {
	t.Helper()
	rec := &peer.PeerRecord{PeerID: pid, Addrs: addrs, Seq: seq}
	env, err := record.Seal(rec, priv)
	if err != nil {
		t.Fatal(err)
	}
	value, err := env.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestAddrRecordValidator(t *testing.T) {
	privA, pubA, _ := crypto.GenerateEd25519Key(rand.Reader)
	privB, _, _ := crypto.GenerateEd25519Key(rand.Reader)
	pidA, _ := peer.IDFromPublicKey(pubA)
	pidB, _ := peer.IDFromPrivateKey(privB)
	addr := mustMA(t, "/ip4/203.0.113.1/tcp/4001")
	valid := signedAddrRecord(t, privA, pidA, []ma.Multiaddr{addr}, 1)
	many := make([]ma.Multiaddr, 17)
	for i := range many {
		many[i] = addr
	}
	tooMany := signedAddrRecord(t, privA, pidA, many, 1)
	wrongPeer := signedAddrRecord(t, privB, pidB, []ma.Multiaddr{addr}, 1)
	mismatch := signedAddrRecord(t, privB, pidA, []ma.Multiaddr{addr}, 1)
	hi := signedAddrRecord(t, privA, pidA, []ma.Multiaddr{addr}, 2)
	equal := signedAddrRecord(t, privA, pidA, []ma.Multiaddr{addr}, 1)
	cases := []struct {
		name    string
		key     string
		value   []byte
		wantErr bool
	}{
		{"valid", addrRecordKey(pidA), valid, false},
		{"wrong signer", addrRecordKey(pidA), wrongPeer, true},
		{"mismatched key", addrRecordKey(pidB), valid, true},
		{"mismatched record peer", addrRecordKey(pidA), mismatch, true},
		{"too many addresses", addrRecordKey(pidA), tooMany, true},
		{"garbage", addrRecordKey(pidA), []byte("not an envelope"), true},
		{"nil", addrRecordKey(pidA), nil, true},
		{"oversized", addrRecordKey(pidA), append(valid, make([]byte, addrRecordMax)...), true},
	}
	v := addrRecordValidator{}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := v.Validate(tc.key, tc.value)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
	idx, err := v.Select(addrRecordKey(pidA), [][]byte{valid, hi})
	if err != nil || idx != 1 {
		t.Fatalf("higher seq idx=%d err=%v", idx, err)
	}
	idx, err = v.Select(addrRecordKey(pidA), [][]byte{valid, equal})
	if err != nil || idx != 0 {
		t.Fatalf("equal seq idx=%d err=%v", idx, err)
	}
	if _, err := v.Select(addrRecordKey(pidA), [][]byte{valid, []byte("bad")}); err == nil {
		t.Fatal("malformed Select accepted")
	}
}

func TestPublishableAddrsFiltersPrivateKeepsCircuit(t *testing.T) {
	private := mustMA(t, "/ip4/10.0.0.2/tcp/4001")
	circuit := mustMA(t, "/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6/p2p-circuit/p2p/12D3KooWLaHQeWmPbiVnVe7Bgu2HbXcCQPBV8ioP5XgpQFPJPSEq")
	loop := mustMA(t, "/ip4/127.0.0.1/tcp/4001")
	public := mustMA(t, "/ip4/1.1.1.1/tcp/4001")
	got := addrsToStrings(publishableAddrs([]ma.Multiaddr{private, circuit, loop, public}))
	if len(got) != 2 || !containsString(got, circuit.String()) || !containsString(got, public.String()) {
		t.Fatalf("publishable = %v, want circuit+public", got)
	}
}
