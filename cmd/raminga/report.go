package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/report"
)

func newReportCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "report",
		Short: "Export a redacted test report",
	}
	cmd.AddCommand(newReportExportCmd())
	return cmd
}

func newReportExportCmd() *cobra.Command {
	var (
		jsonOut     bool
		mdOut       bool
		outPath     string
		includeText bool
		watch       time.Duration
	)
	cmd := &cobra.Command{
		Use:   "export",
		Short: "Export JSON + Markdown with version, NAT diagnostics, timeline, route changes and ACK results",
		Long: "Build a redacted test report from the local API. Private keys and the API " +
			"token are never read. Chat text is omitted unless --include-text is passed.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if jsonOut && mdOut {
				return errors.New("--json and --md are mutually exclusive; omit both to write both files")
			}
			dataDir := dataDirFrom(cmd)
			c, err := client.New(dataDir)
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 20*time.Second)
			defer cancel()
			st, err := c.Status(ctx)
			if err != nil {
				return err
			}
			peers, err := c.Peers(ctx, true)
			if err != nil {
				return err
			}
			msgs, err := c.RecentMessages(ctx, 200)
			if err != nil {
				return err
			}
			outbox, err := c.OutboxList(ctx, 200)
			if err != nil {
				return err
			}
			timeline, changes, acks := collectEvents(cmd, c, watch)
			r := report.Build(st, peers, msgs, outbox, report.Options{
				Version:      buildVersion(),
				IncludeText:  includeText,
				Timeline:     timeline,
				RouteChanges: changes,
				ACKs:         acks,
			})
			jsonBytes, err := report.JSON(r)
			if err != nil {
				return err
			}
			mdBytes := report.Markdown(r)
			switch {
			case jsonOut:
				return writeOne(cmd, outPath, jsonBytes)
			case mdOut:
				return writeOne(cmd, outPath, mdBytes)
			default:
				dir := outPath
				if dir == "" {
					dir = filepath.Join(dataDir, "reports")
				}
				jsonPath, err := report.WriteJSON(dir, r)
				if err != nil {
					return err
				}
				mdPath, err := report.WriteMarkdown(dir, r)
				if err != nil {
					return err
				}
				_, _ = fmt.Fprintf(cmd.OutOrStdout(), "json: %s\nmd: %s\n", jsonPath, mdPath)
				return nil
			}
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "write JSON (stdout unless --out is a file)")
	cmd.Flags().BoolVar(&mdOut, "md", false, "write Markdown (stdout unless --out is a file)")
	cmd.Flags().StringVar(&outPath, "out", "", "output file (with --json/--md) or directory (default <data-dir>/reports)")
	cmd.Flags().BoolVar(&includeText, "include-text", false, "include chat message text (explicit opt-in; default redacted)")
	cmd.Flags().DurationVar(&watch, "watch", 2*time.Second, "capture events for a connection timeline (0 disables)")
	return cmd
}

func writeOne(cmd *cobra.Command, path string, data []byte) error {
	if path == "" {
		_, err := cmd.OutOrStdout().Write(data)
		return err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write report %q: %w", path, err)
	}
	_, _ = fmt.Fprintln(cmd.OutOrStdout(), path)
	return nil
}

func collectEvents(cmd *cobra.Command, c *client.Client, watch time.Duration) ([]report.Event, []report.Change, []report.ACK) {
	if watch <= 0 {
		return nil, nil, nil
	}
	ctx, cancel := context.WithTimeout(cmd.Context(), watch)
	defer cancel()
	stream, err := c.Events(ctx)
	if err != nil {
		return nil, nil, nil
	}
	defer func() { _ = stream.Close() }()
	var (
		timeline []report.Event
		changes  []report.Change
		acks     []report.ACK
		routes   = map[string]string{}
	)
	for stream.Receive() {
		ev := stream.Msg()
		if ev.GetHeartbeat() {
			continue
		}
		at := time.Now().UTC()
		if ev.GetAtUnixMs() > 0 {
			at = time.UnixMilli(ev.GetAtUnixMs()).UTC()
		}
		ts := at.Format(time.RFC3339)
		switch body := ev.GetBody().(type) {
		case *apiv1.EventsResponse_ChatReceived:
			timeline = append(timeline, report.Event{At: ts, Kind: "chat_received", PeerID: body.ChatReceived.GetFromPeerId(), Detail: "accepted=" + fmt.Sprint(body.ChatReceived.GetAccepted())})
		case *apiv1.EventsResponse_Ack:
			acks = append(acks, report.ACK{At: ts, MessageID: body.Ack.GetMessageId(), PeerID: body.Ack.GetPeerId(), Acked: body.Ack.GetAccepted(), Reason: body.Ack.GetError()})
		case *apiv1.EventsResponse_Connection:
			conn := body.Connection
			if conn.GetKind() == "connected" {
				if prev, ok := routes[conn.GetPeerId()]; ok && prev != conn.GetRoute() {
					changes = append(changes, report.Change{At: ts, PeerID: conn.GetPeerId(), From: prev, To: conn.GetRoute(), Transport: conn.GetTransport()})
				}
				routes[conn.GetPeerId()] = conn.GetRoute()
			}
			timeline = append(timeline, report.Event{
				At: ts, Kind: "connection_" + conn.GetKind(), PeerID: conn.GetPeerId(), Route: conn.GetRoute(),
				Transport: conn.GetTransport(), Direct: conn.GetDirect(), Limited: conn.GetLimited(),
				Direction: conn.GetDirection(), Relay: conn.GetRelayPeerId(), Address: conn.GetRemoteMultiaddr(),
			})
		}
	}
	return timeline, changes, acks
}
