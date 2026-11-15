package api_test

import (
	"context"
	"testing"

	"github.com/Raminga/raminga/internal/api/client"
)

func TestStage5MessageListEndpointsAndLimits(t *testing.T) {
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
	if status.GetMaxChatTextBytes() != 4096 || status.GetMaxStoredMessages() != 50000 {
		t.Fatalf("status limits = %d/%d", status.GetMaxChatTextBytes(), status.GetMaxStoredMessages())
	}

	conversations, err := c.ListConversations(ctx, "", 10)
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	if len(conversations.GetConversations()) != 1 || conversations.GetConversations()[0].GetPeerId() != "peer-b" {
		t.Fatalf("conversations = %+v", conversations.GetConversations())
	}
	if conversations.GetRetention().GetRetainedMessages() != 1 {
		t.Fatalf("retention = %+v", conversations.GetRetention())
	}

	messages, err := c.ListMessages(ctx, "peer-b", "cursor-before", 10)
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	if len(messages.GetMessages()) != 1 || messages.GetMessages()[0].GetDeliveryStatus() != "acked" {
		t.Fatalf("messages = %+v", messages.GetMessages())
	}
	if messages.GetNextBefore() != "cursor-next" || !messages.GetHasMore() {
		t.Fatalf("page cursor = %q has_more=%t", messages.GetNextBefore(), messages.GetHasMore())
	}

	relations, err := c.ListHumanOutboundPeers(ctx, "", 10)
	if err != nil {
		t.Fatalf("ListHumanOutboundPeers: %v", err)
	}
	if len(relations.GetPeers()) != 1 || relations.GetPeers()[0].GetPeerId() != "peer-b" {
		t.Fatalf("relations = %+v", relations.GetPeers())
	}
}
