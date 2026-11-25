package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/contactcard"
	"github.com/Raminga/raminga/internal/peerarg"
)

func newStatusCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show node status through the local API",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
			defer cancel()
			st, err := c.Status(ctx)
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), st, true)
			}
			w := cmd.OutOrStdout()
			_, _ = fmt.Fprintf(w, "peer_id: %s\nnode_id: %s\nversion: %s\nprotocol: %s\ndata_dir: %s\ntest_api: %t\nsupervised: %t\n",
				st.GetPeerId(), st.GetNodeId(), st.GetVersion(), st.GetProtocolVersion(), st.GetDataDir(), st.GetTestApiEnabled(), st.GetSupervised())
			_, _ = fmt.Fprintln(w, "listen_addrs:")
			for _, a := range st.GetListenAddrs() {
				_, _ = fmt.Fprintf(w, "  - %s\n", a)
			}
			for _, warning := range st.GetContentWarnings() {
				_, _ = fmt.Fprintf(w, "content_warning: %s\n", warning)
			}
			if len(st.GetPeers()) == 0 {
				_, _ = fmt.Fprintln(w, "peers: none")
				return nil
			}
			_, _ = fmt.Fprintln(w, "peers:")
			for _, p := range st.GetPeers() {
				_, _ = fmt.Fprintf(w, "  - %s online=%t transport=%s route=%s direct=%t limited=%t direction=%s\n",
					p.GetPeerId(), p.GetOnline(), p.GetTransport(), p.GetRoute(), p.GetDirect(), p.GetLimited(), p.GetDirection())
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}

func newConnectCmd() *cobra.Command {
	var (
		jsonOut bool
		peerID  string
	)
	cmd := &cobra.Command{
		Use:   "connect <peer-multiaddr|peer-id|share-code>",
		Short: "Dial a peer by address, Raminga ID, or share code",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			target := peerarg.Normalize(peerID)
			multiaddr := ""
			code := ""
			if len(args) == 1 {
				arg := peerarg.Normalize(args[0])
				if contactcard.IsInput(arg) {
					if target != "" {
						return errors.New("a share code cannot be used with --peer-id")
					}
					code = arg
				} else if strings.Contains(arg, "/") {
					multiaddr = arg
				} else {
					target = arg
				}
			}
			if target == "" && multiaddr == "" && code == "" {
				return errors.New("a peer multiaddr, Raminga ID or share code is required")
			}
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 30*time.Second)
			defer cancel()
			var res *apiv1.ConnectResponse
			if code != "" {
				res, err = c.ConnectContactCard(ctx, code, !jsonOut)
			} else {
				res, err = c.Connect(ctx, target, multiaddr)
			}
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			w := cmd.OutOrStdout()
			if code != "" {
				_, err = fmt.Fprintf(w, "peer_id: %s\nroute: %s\nsource: %s\n", res.GetPeerId(), res.GetRoute(), res.GetSource())
				return err
			}
			_, err = fmt.Fprintf(w, "peer_id: %s\ntransport: %s\nroute: %s\ndirect: %t\nlimited: %t\nremote_multiaddr: %s\nreused: %t\nsource: %s\n",
				res.GetPeerId(), res.GetTransport(), res.GetRoute(), res.GetDirect(), res.GetLimited(), res.GetRemoteMultiaddr(), res.GetReused(), res.GetSource())
			if err != nil {
				return err
			}
			if res.GetRequestedTransport() != "" {
				_, _ = fmt.Fprintf(w, "requested_transport: %s\ntransport_changed: %t\n", res.GetRequestedTransport(), res.GetTransportChanged())
			}
			if res.GetNote() != "" {
				_, _ = fmt.Fprintf(w, "note: %s\n", res.GetNote())
			}
			printDialAttempts(w, res.GetAttempts())
			return nil
		},
	}
	cmd.Flags().StringVar(&peerID, "peer-id", "", "peer ID to dial when no positional argument is given")
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}

func newShareCmd() *cobra.Command {
	var includeAddresses, jsonOut bool
	cmd := &cobra.Command{
		Use:   "share [contact-peer-id]",
		Short: "Print a Raminga share code for this node or a local contact",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var peerID string
			if len(args) > 0 {
				peerID = peerarg.Normalize(args[0])
			}
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
			defer cancel()
			res, err := c.ContactCard(ctx, peerID, includeAddresses)
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), res.GetShareCode())
			return err
		},
	}
	cmd.Flags().BoolVar(&includeAddresses, "include-addresses", false, "include known public dial addresses recipients can read and forward")
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}
