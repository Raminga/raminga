package main

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/api/client"
)

func newPeersCmd() *cobra.Command {
	var (
		jsonOut bool
		cached  bool
	)
	cmd := &cobra.Command{
		Use:   "peers",
		Short: "List live peers and cached restart hints",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			res, err := c.Peers(ctx, cached)
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			w := cmd.OutOrStdout()
			for _, p := range res.GetPeers() {
				_, _ = fmt.Fprintf(w, "%s online=%t route=%s transport=%s sources=%v addrs=%v\n",
					p.GetPeerId(), p.GetOnline(), p.GetRoute(), p.GetTransport(), p.GetSources(), p.GetAddrs())
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	cmd.Flags().BoolVar(&cached, "cached", false, "include cached hints (online=false)")

	var addJSON bool
	add := &cobra.Command{
		Use:   "add <peer-multiaddr>",
		Short: "Manually add a Raminga peer to the PeerStore and SQLite cache",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			res, err := c.DhtAddPeer(ctx, args[0])
			if err != nil {
				return err
			}
			if addJSON {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "peer_id: %s\nsource: %s\naddrs: %v\n",
				res.GetPeer().GetPeerId(), res.GetPeer().GetSource(), res.GetPeer().GetAddrs())
			return err
		},
	}
	add.Flags().BoolVar(&addJSON, "json", false, "print protojson")
	cmd.AddCommand(add)

	return cmd
}
