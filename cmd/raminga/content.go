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
	"github.com/Raminga/raminga/internal/textsafe"
)

func newContentCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "content", Short: "View remote public content and the local published manifest"}
	cmd.AddCommand(newContentManifestCmd(), newContentProfileCmd(), newContentFriendsCmd(), newContentGetCmd(), newContentConnectCmd(), newContentPublishedCmd())
	return cmd
}

func resolvePeerArg(ctx context.Context, c *client.Client, arg string) (string, error) {
	raw := strings.TrimSpace(arg)
	res, listErr := c.ListFriends(ctx)
	if listErr == nil {
		for _, f := range res.GetFriends() {
			if f.GetName() == raw {
				return f.GetPeerId(), nil
			}
		}
	}
	clean := peerarg.Normalize(arg)
	if pid, err := peer.Decode(clean); err == nil {
		return pid.String(), nil
	}
	if listErr == nil {
		for _, f := range res.GetFriends() {
			if f.GetName() == clean {
				return f.GetPeerId(), nil
			}
		}
	}
	if listErr != nil {
		return "", fmt.Errorf("unknown name or Peer ID %q；读取好友表失败：%w；%s", raw, listErr, peerarg.WrappedHint)
	}
	return "", fmt.Errorf("unknown name or Peer ID %q；%s", raw, peerarg.WrappedHint)
}

func safeText(s string) string { return textsafe.Sanitize(s) }
func safeLines(s string) string {
	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = textsafe.Sanitize(lines[i])
	}
	return strings.Join(lines, "\n")
}

func newContentManifestCmd() *cobra.Command {
	var offset, limit int32
	var jsonOut bool
	cmd := &cobra.Command{Use: "manifest <Peer ID|名字>", Short: "Fetch a remote manifest page", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.New(dataDirFrom(cmd))
		if err != nil {
			return err
		}
		defer c.Close()
		ctx, cancel := context.WithTimeout(cmd.Context(), 30*time.Second)
		defer cancel()
		pid, err := resolvePeerArg(ctx, c, args[0])
		if err != nil {
			return err
		}
		res, err := c.GetPeerManifest(ctx, pid, offset, limit)
		if err != nil {
			return err
		}
		if jsonOut {
			return printProto(cmd.OutOrStdout(), res, true)
		}
		w := cmd.OutOrStdout()
		_, _ = fmt.Fprintf(w, "peer_id: %s\ntotal: %d\nlimited: %t\n", safeText(res.GetPeerId()), res.GetTotal(), res.GetLimited())
		rows := make([]sizeRow, 0, len(res.GetEntries()))
		for _, e := range res.GetEntries() {
			rows = append(rows, sizeRow{
				Path:  safeText(e.GetPath()),
				Size:  e.GetSize(),
				Extra: fmt.Sprintf("  modified=%d sha256=%s", e.GetModifiedUnixMs(), safeText(e.GetSha256())),
			})
		}
		writeSizedRows(w, rows, "")
		return nil
	}}
	cmd.Flags().Int32Var(&offset, "offset", 0, "manifest offset")
	cmd.Flags().Int32Var(&limit, "limit", 100, "manifest page size")
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}

func newContentProfileCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{Use: "profile <Peer ID|名字>", Short: "View a remote profile", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.New(dataDirFrom(cmd))
		if err != nil {
			return err
		}
		defer c.Close()
		ctx, cancel := context.WithTimeout(cmd.Context(), 60*time.Second)
		defer cancel()
		pid, err := resolvePeerArg(ctx, c, args[0])
		if err != nil {
			return err
		}
		res, err := c.GetPeerProfile(ctx, pid)
		if err != nil {
			return err
		}
		if jsonOut {
			return printProto(cmd.OutOrStdout(), res, true)
		}
		w := cmd.OutOrStdout()
		if !res.GetFound() {
			_, _ = fmt.Fprintf(w, "peer_id: %s\n(no profile/index.md)\nfiles:\n", safeText(res.GetPeerId()))
			for _, f := range res.GetFiles() {
				_, _ = fmt.Fprintf(w, "  %s\n", safeText(f))
			}
			return nil
		}
		_, _ = fmt.Fprintf(w, "peer_id: %s\nname: %s\n\n%s\n", safeText(res.GetPeerId()), safeText(res.GetName()), safeLines(res.GetText()))
		return nil
	}}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}

func newContentFriendsCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{Use: "friends <Peer ID|名字>", Short: "Read a remote friend list (untrusted claims)", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.New(dataDirFrom(cmd))
		if err != nil {
			return err
		}
		defer c.Close()
		ctx, cancel := context.WithTimeout(cmd.Context(), 60*time.Second)
		defer cancel()
		pid, err := resolvePeerArg(ctx, c, args[0])
		if err != nil {
			return err
		}
		res, err := c.GetPeerFriends(ctx, pid)
		if err != nil {
			return err
		}
		if jsonOut {
			return printProto(cmd.OutOrStdout(), res, true)
		}
		w := cmd.OutOrStdout()
		_, _ = fmt.Fprintf(w, "owner: %s\nclaims:\n", safeText(res.GetPeerId()))
		for _, f := range res.GetFriends() {
			_, _ = fmt.Fprintf(w, "  %s  peer_id=%s description=%s addrs=%v\n", safeText(f.GetName()), safeText(f.GetPeerId()), safeText(f.GetDescription()), safeText(fmt.Sprint(f.GetAddrs())))
		}
		return nil
	}}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}

func newContentGetCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{Use: "get <Peer ID|名字> <path>", Short: "Download one remote manifest file and verify SHA-256", Args: cobra.ExactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.New(dataDirFrom(cmd))
		if err != nil {
			return err
		}
		defer c.Close()
		ctx, cancel := context.WithTimeout(cmd.Context(), 10*time.Minute)
		defer cancel()
		pid, err := resolvePeerArg(ctx, c, args[0])
		if err != nil {
			return err
		}
		stream, err := c.DownloadPeerFile(ctx, pid, args[1])
		if err != nil {
			return err
		}
		defer func() { _ = stream.Close() }()
		var final *apiv1.DownloadPeerFileResponse
		for stream.Receive() {
			msg := stream.Msg()
			if msg.GetPhase() == "complete" || msg.GetLocalPath() != "" {
				final = msg
				continue
			}
			if !jsonOut {
				_, _ = fmt.Fprintf(cmd.OutOrStdout(), "%s %s %d/%d\n", msg.GetPhase(), safeText(msg.GetPath()), msg.GetReceivedBytes(), msg.GetTotalBytes())
			}
		}
		if err := stream.Err(); err != nil {
			return err
		}
		if final == nil {
			return fmt.Errorf("download ended without completion")
		}
		if jsonOut {
			return printProto(cmd.OutOrStdout(), final, true)
		}
		_, err = fmt.Fprintf(cmd.OutOrStdout(), "saved: %s\nsize: %d\nsha256: %s\n", safeText(final.GetLocalPath()), final.GetTotalBytes(), safeText(final.GetSha256()))
		return err
	}}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print final protojson")
	return cmd
}

func newContentPublishedCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{Use: "published", Short: "List local published files, skipped paths and friends.json sync time (forces a fresh scan)", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		c, err := client.New(dataDirFrom(cmd))
		if err != nil {
			return err
		}
		defer c.Close()
		ctx, cancel := context.WithTimeout(cmd.Context(), 30*time.Second)
		defer cancel()
		res, err := c.Published(ctx)
		if err != nil {
			return err
		}
		if jsonOut {
			return printProto(cmd.OutOrStdout(), res, true)
		}
		w := cmd.OutOrStdout()
		if res.GetGeneratedAtUnixMs() > 0 {
			_, _ = fmt.Fprintf(w, "generated_at: %s\n", time.UnixMilli(res.GetGeneratedAtUnixMs()).UTC().Format(time.RFC3339))
		}
		if res.GetFriendsSyncedAtUnixMs() > 0 {
			_, _ = fmt.Fprintf(w, "friends.json 最后变更时间: %s\n", time.UnixMilli(res.GetFriendsSyncedAtUnixMs()).UTC().Format(time.RFC3339))
		} else {
			_, _ = fmt.Fprintln(w, "friends.json 最后变更时间: 尚未生成")
		}
		_, _ = fmt.Fprintf(w, "published: %d\n", len(res.GetFiles()))
		rows := make([]sizeRow, 0, len(res.GetFiles()))
		for _, f := range res.GetFiles() {
			rows = append(rows, sizeRow{Path: safeText(f.GetPath()), Size: f.GetSize()})
		}
		writeSizedRows(w, rows, "  ")
		_, _ = fmt.Fprintf(w, "skipped: %d\n", len(res.GetSkipped()))
		for _, skipped := range res.GetSkipped() {
			_, _ = fmt.Fprintf(w, "  %s reason=%s\n", safeText(skipped.GetPath()), safeText(skipped.GetReason()))
		}
		return nil
	}}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}

func newContentConnectCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{Use: "connect <owner> <listed-peer>", Short: "Connect to a peer listed in another node's friends.json", Args: cobra.ExactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.New(dataDirFrom(cmd))
		if err != nil {
			return err
		}
		defer c.Close()
		ctx, cancel := context.WithTimeout(cmd.Context(), 60*time.Second)
		defer cancel()
		owner, err := resolvePeerArg(ctx, c, args[0])
		if err != nil {
			return err
		}
		list, err := c.GetPeerFriends(ctx, owner)
		if err != nil {
			return err
		}
		wantPeer := peerarg.Normalize(args[1])
		var target *apiv1.PeerFriendClaim
		for _, f := range list.GetFriends() {
			if f.GetPeerId() == wantPeer || f.GetName() == args[1] || f.GetName() == wantPeer {
				target = f
				break
			}
		}
		if target == nil {
			return fmt.Errorf("listed peer %q not found", args[1])
		}
		res, err := c.ConnectListedPeer(ctx, target.GetPeerId(), target.GetAddrs())
		if err != nil {
			return err
		}
		if jsonOut {
			return printProto(cmd.OutOrStdout(), res, true)
		}
		_, err = fmt.Fprintf(cmd.OutOrStdout(), "peer_id: %s\nroute: %s\ndirect: %t\nlimited: %t\n", safeText(res.GetPeerId()), safeText(res.GetRoute()), res.GetDirect(), res.GetLimited())
		return err
	}}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}
