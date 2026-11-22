package api_test

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/node"
)

func TestP3APIVersionAndReadCursorContract(t *testing.T) {
	ts := startServer(t, false)
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx := context.Background()

	status, err := c.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if status.GetApiVersion() != "6" {
		t.Fatalf("api_version = %q, want 6", status.GetApiVersion())
	}

	read, err := c.MarkConversationRead(ctx, "peer-b", "m1")
	if err != nil {
		t.Fatal(err)
	}
	if read.GetPeerId() != "peer-b" || read.GetLastReadMessageId() != "m1" || read.GetUnreadCount() != 2 {
		t.Fatalf("mark read response = %+v", read)
	}
	if _, err := c.MarkConversationRead(ctx, "peer-b", "missing"); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("missing message code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestP3FavoritesAndDiscoveryPeerFilterContract(t *testing.T) {
	ts := startServer(t, false)
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx := context.Background()

	favorites, err := c.ListFavorites(ctx, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(favorites.GetFavorites()) != 1 || !favorites.GetFavorites()[0].GetAvailable() || !favorites.GetHasMore() {
		t.Fatalf("favorites = %+v", favorites)
	}
	saved, err := c.SetFavorite(ctx, "peer-b", "posts/a.json", strings.Repeat("a", 64), "A", true)
	if err != nil || !saved.GetFavorite() || saved.GetItem().GetId() != "fav_1" {
		t.Fatalf("set favorite = %+v err=%v", saved, err)
	}
	if _, err := c.SetFavorite(ctx, "peer-b", "messages/m1", strings.Repeat("a", 64), "bad", true); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("invalid favorite code = %v, want InvalidArgument", connect.CodeOf(err))
	}
	if _, err := c.SetFavorite(ctx, "peer-b", "posts/a.json", "bad", "bad", true); err == nil {
		t.Fatal("invalid SHA-256 must be rejected")
	}
	// Message/contact paths must never look like a favorite target.
	for _, path := range []string{"messages/m1.json", "contacts/peer-b.json", "agent/contact-notes.json"} {
		if _, err := c.SetFavorite(ctx, "peer-b", path, strings.Repeat("b", 64), "bad", true); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("path %q code = %v, want InvalidArgument", path, connect.CodeOf(err))
		}
	}

	discoveries, err := c.ListDiscoveriesForPeer(ctx, "", 20, false, "peer-b")
	if err != nil {
		t.Fatal(err)
	}
	if ts.backend.discoveryPeerID != "peer-b" {
		t.Fatalf("backend peer filter = %q, want peer-b", ts.backend.discoveryPeerID)
	}
	_ = discoveries
}

func TestP3ConversationAndFriendUnreadUseTheSameView(t *testing.T) {
	ts := startServer(t, false)
	ts.backend.friends = []node.Friend{{PeerID: "peer-b", UnreadCount: 3}}
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx := context.Background()
	friends, err := c.ListFriends(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(friends.GetFriends()) != 1 || friends.GetFriends()[0].GetUnreadCount() != 3 {
		t.Fatalf("friend unread = %+v", friends.GetFriends())
	}
	conv, err := c.ListConversations(ctx, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if conv.GetTotalUnread() != 3 {
		t.Fatalf("conversation total_unread = %d, want 3", conv.GetTotalUnread())
	}
}
