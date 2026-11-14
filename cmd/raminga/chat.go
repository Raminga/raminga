package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/peerarg"
)

func newChatCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "chat",
		Short: "Send chat messages and consume events through the local API",
	}
	cmd.AddCommand(newChatSendCmd(), newChatEventsCmd(), newChatHistoryCmd(), newChatOutboxCmd(), newChatCancelCmd())
	return cmd
}

func newChatSendCmd() *cobra.Command {
	var (
		peerID    string
		multiaddr string
		text      string
		jsonOut   bool
	)
	cmd := &cobra.Command{
		Use:   "send",
		Short: "Send one HTTP chat message and report its matching ACK",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if text == "" {
				return errors.New("--text is required")
			}
			peerID = peerarg.Normalize(peerID)
			multiaddr = peerarg.Normalize(multiaddr)
			if peerID == "" && multiaddr == "" {
				return errors.New("--to or --multiaddr is required")
			}
			if multiaddr == "" && strings.Contains(peerID, "/") {
				multiaddr = peerID
				peerID = ""
			}
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 30*time.Second)
			defer cancel()
			res, err := c.SendChat(ctx, peerID, multiaddr, text)
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			w := cmd.OutOrStdout()
			_, _ = fmt.Fprintf(w, "message_id: %s\nacked: %t\n", res.GetMessageId(), res.GetAcked())
			if res.GetAcked() {
				_, _ = fmt.Fprintf(w, "ack_id: %s\nack_message_id: %s\n", res.GetAckId(), res.GetAckMessageId())
			} else if res.GetError() != "" {
				_, _ = fmt.Fprintf(w, "error: %s\n", res.GetError())
			}
			if res.GetOutboxStatus() != "" {
				_, _ = fmt.Fprintf(w, "outbox_status: %s\n", res.GetOutboxStatus())
			}
			if res.GetDeliveryStatus() != "" {
				_, _ = fmt.Fprintf(w, "delivery_status: %s\n", res.GetDeliveryStatus())
			}
			_, _ = fmt.Fprintf(w, "route: %s\ntransport: %s\nremote_multiaddr: %s\nreused: %t\nsource: %s\n",
				res.GetRoute(), res.GetTransport(), res.GetRemoteMultiaddr(), res.GetReused(), res.GetSource())
			if res.GetNote() != "" {
				_, _ = fmt.Fprintf(w, "note: %s\n", res.GetNote())
			}
			printDialAttempts(w, res.GetAttempts())
			return nil
		},
	}
	cmd.Flags().StringVar(&peerID, "to", "", "target peer ID")
	cmd.Flags().StringVar(&multiaddr, "multiaddr", "", "optional target multiaddr (/p2p included)")
	cmd.Flags().StringVar(&text, "text", "", "UTF-8 chat text")
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}

func newChatEventsCmd() *cobra.Command {
	var (
		count   int
		timeout time.Duration
		jsonOut bool
	)
	cmd := &cobra.Command{
		Use:   "events",
		Short: "Stream chat, ACK and connection events",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx := cmd.Context()
			if timeout > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, timeout)
				defer cancel()
			}
			stream, err := c.Events(ctx)
			if err != nil {
				return err
			}
			defer func() { _ = stream.Close() }()

			seen := 0
			for stream.Receive() {
				ev := stream.Msg()
				if ev.GetHeartbeat() {
					continue
				}
				if err := printEvent(cmd.OutOrStdout(), ev, jsonOut); err != nil {
					return err
				}
				seen++
				if count > 0 && seen >= count {
					return nil
				}
			}
			if err := stream.Err(); err != nil {
				// Ctrl+C (SIGINT/SIGTERM) and an explicit --timeout are normal
				// stream endings, not command failures.
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) ||
					errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
					return nil
				}
				return err
			}
			return nil
		},
	}
	cmd.Flags().IntVar(&count, "count", 0, "exit after N real events (0 = until Ctrl+C)")
	cmd.Flags().DurationVar(&timeout, "timeout", 0, "optional stream timeout (0 = none; Ctrl+C stops)")
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print one protojson event per line")
	return cmd
}

func newChatHistoryCmd() *cobra.Command {
	var (
		limit   uint32
		jsonOut bool
	)
	cmd := &cobra.Command{
		Use:   "history",
		Short: "List persisted messages and their ACK state",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
			defer cancel()
			res, err := c.RecentMessages(ctx, limit)
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			w := cmd.OutOrStdout()
			if len(res.GetMessages()) == 0 {
				_, _ = fmt.Fprintln(w, "no messages")
				return nil
			}
			for _, m := range res.GetMessages() {
				_, _ = fmt.Fprintf(w, "%s direction=%s acked=%t delivery=%s origin=%s peer=%s text=%q\n",
					m.GetMessageId(), m.GetDirection(), m.GetAcked(), m.GetDeliveryStatus(), m.GetOrigin(), m.GetPeerId(), m.GetText())
			}
			return nil
		},
	}
	cmd.Flags().Uint32Var(&limit, "limit", 20, "maximum messages (1..500)")
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}

func printEvent(w io.Writer, ev *apiv1.EventsResponse, jsonOut bool) error {
	if jsonOut {
		return printProto(w, ev, false)
	}
	switch body := ev.GetBody().(type) {
	case *apiv1.EventsResponse_ChatReceived:
		_, err := fmt.Fprintf(w, "chat from=%s message_id=%s text=%s bytes=%d duplicate=%t\n",
			body.ChatReceived.GetFromPeerId(), body.ChatReceived.GetMessageId(),
			safeQuote(body.ChatReceived.GetText()), len(body.ChatReceived.GetText()), body.ChatReceived.GetDuplicate())
		return err
	case *apiv1.EventsResponse_Ack:
		_, err := fmt.Fprintf(w, "ack message_id=%s peer=%s accepted=%t error=%s\n",
			body.Ack.GetMessageId(), body.Ack.GetPeerId(), body.Ack.GetAccepted(), safeQuote(body.Ack.GetError()))
		return err
	case *apiv1.EventsResponse_Connection:
		_, err := fmt.Fprintf(w, "connection kind=%s peer=%s transport=%s route=%s direct=%t limited=%t relay=%s addr=%s\n",
			body.Connection.GetKind(), body.Connection.GetPeerId(), body.Connection.GetTransport(),
			body.Connection.GetRoute(), body.Connection.GetDirect(), body.Connection.GetLimited(),
			body.Connection.GetRelayPeerId(), safeQuote(body.Connection.GetRemoteMultiaddr()))
		return err
	default:
		_, err := fmt.Fprintf(w, "event at=%d type=unknown\n", ev.GetAtUnixMs())
		return err
	}
}

func newChatOutboxCmd() *cobra.Command {
	var (
		limit   uint32
		jsonOut bool
	)
	cmd := &cobra.Command{
		Use:   "outbox",
		Short: "List durable unacknowledged outbound messages and their retry state",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
			defer cancel()
			res, err := c.OutboxList(ctx, limit)
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			w := cmd.OutOrStdout()
			st := res.GetStats()
			_, _ = fmt.Fprintf(w, "pending: %d acked: %d failed: %d cancelled: %d pending_bytes: %d\n",
				st.GetPending(), st.GetAcked(), st.GetFailed(), st.GetCancelled(), st.GetPendingBytes())
			for _, e := range res.GetEntries() {
				_, _ = fmt.Fprintf(w, "%s status=%s peer=%s attempts=%d bytes=%d expires=%d last_error=%s multiaddr=%s text=%q\n",
					e.GetMessageId(), e.GetStatus(), e.GetPeerId(), e.GetAttempts(), e.GetBytes(),
					e.GetExpiresAtUnixMs(), safeQuote(e.GetLastError()), safeQuote(e.GetMultiaddr()), e.GetText())
			}
			return nil
		},
	}
	cmd.Flags().Uint32Var(&limit, "limit", 100, "maximum entries (1..500)")
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}

func newChatCancelCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "cancel <message-id>",
		Short: "Cancel one pending outbox entry; it will not be resent",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
			defer cancel()
			res, err := c.OutboxCancel(ctx, args[0])
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "cancelled: %t status: %s\n", res.GetCancelled(), res.GetStatus())
			return err
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}

// safeQuote renders untrusted text as one escaped, control-character-free
// token. strconv.Quote keeps printable UTF-8 and escapes quotes, newlines, NUL
// and other control bytes, so terminal escape sequences cannot be injected.
func safeQuote(s string) string {
	return strconv.Quote(s)
}
