package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/spf13/cobra"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/peerarg"
)

func newFriendsCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "friends", Short: "Local friend records"}
	var listJSON bool
	list := &cobra.Command{
		Use: "list", Short: "List local friends", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			res, err := c.ListFriends(ctx)
			if err != nil {
				return err
			}
			if listJSON {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			for _, f := range res.GetFriends() {
				_, _ = fmt.Fprintf(cmd.OutOrStdout(), "%s name=%q manual=%t paused=%t description=%q addrs=%v\n",
					f.GetPeerId(), f.GetName(), f.GetManuallyConnected(), f.GetPaused(), f.GetDescription(), f.GetAddrs())
			}
			return nil
		},
	}
	list.Flags().BoolVar(&listJSON, "json", false, "print protojson")

	var nameJSON bool
	name := &cobra.Command{
		Use: "name <名字> <Peer ID|名字>", Short: "Set a name for an existing friend", Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			pid, err := resolveFriendArg(ctx, c, args[1])
			if err != nil {
				return err
			}
			res, err := c.SetFriendName(ctx, pid, args[0])
			if err != nil {
				return err
			}
			if nameJSON {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "peer_id: %s\nname: %s\n", res.GetFriend().GetPeerId(), res.GetFriend().GetName())
			return err
		},
	}
	name.Flags().BoolVar(&nameJSON, "json", false, "print protojson")

	var descJSON bool
	describe := &cobra.Command{
		Use: "describe <Peer ID|名字> <描述>", Short: "Set a friend description", Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			pid, err := resolveFriendArg(ctx, c, args[0])
			if err != nil {
				return err
			}
			res, err := c.SetFriendDescription(ctx, pid, strings.Join(args[1:], " "))
			if err != nil {
				return err
			}
			if descJSON {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "peer_id: %s\ndescription: %s\n", res.GetFriend().GetPeerId(), res.GetFriend().GetDescription())
			return err
		},
	}
	describe.Flags().BoolVar(&descJSON, "json", false, "print protojson")

	var cancelPending bool
	remove := &cobra.Command{
		Use: "remove <Peer ID|名字>", Short: "Remove a friend (pending outbox requires --cancel-pending)", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			pid, err := resolveFriendArg(ctx, c, args[0])
			if err != nil {
				return err
			}
			res, err := c.RemoveFriend(ctx, pid, cancelPending)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "removed: %t\npending_outbox: %d\nnote: public/friends.json is regenerated automatically\n", res.GetRemoved(), res.GetPendingOutbox())
			return err
		},
	}
	remove.Flags().BoolVar(&cancelPending, "cancel-pending", false, "cancel pending outbox entries before removing")
	sync := &cobra.Command{
		Use: "sync", Short: "Regenerate public/friends.json immediately", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			res, err := c.SyncFriends(ctx)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "written: %t\n", res.GetWritten())
			return err
		},
	}
	cmd.AddCommand(list, name, describe, remove, sync)
	return cmd
}

// friendLister is the subset of *client.Client used to resolve friend names.
type friendLister interface {
	ListFriends(context.Context) (*apiv1.ListFriendsResponse, error)
}

func resolveFriendArg(ctx context.Context, c friendLister, arg string) (string, error) {
	raw := strings.TrimSpace(arg)
	res, err := c.ListFriends(ctx)
	if err != nil {
		return "", err
	}
	for _, f := range res.GetFriends() {
		if f.GetName() == raw {
			return f.GetPeerId(), nil
		}
	}
	if pid, err := peer.Decode(peerarg.Normalize(raw)); err == nil {
		return pid.String(), nil
	}
	return "", fmt.Errorf("好友表中找不到 %q；%s", raw, peerarg.WrappedHint)
}
