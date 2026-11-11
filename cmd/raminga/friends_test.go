package main

import (
	"context"
	"testing"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

const testFriendPeer = "QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"

type fakeFriendLister struct {
	friends []*apiv1.Friend
}

func (f fakeFriendLister) ListFriends(context.Context) (*apiv1.ListFriendsResponse, error) {
	return &apiv1.ListFriendsResponse{Friends: f.friends}, nil
}

func TestResolveFriendArgMatchesNameBeforeNormalize(t *testing.T) {
	lister := fakeFriendLister{friends: []*apiv1.Friend{{
		Name:   "a b",
		PeerId: testFriendPeer,
	}}}
	got, err := resolveFriendArg(context.Background(), lister, "  a b  ")
	if err != nil {
		t.Fatalf("resolve friend name with space: %v", err)
	}
	if got != testFriendPeer {
		t.Fatalf("resolved peer = %q, want %q", got, testFriendPeer)
	}

	got, err = resolveFriendArg(context.Background(), lister, testFriendPeer)
	if err != nil {
		t.Fatalf("resolve peer ID: %v", err)
	}
	if got != testFriendPeer {
		t.Fatalf("resolved peer = %q, want %q", got, testFriendPeer)
	}
}
