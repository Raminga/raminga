package main

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/api/client"
)

func newDHTCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "dht",
		Short: "Inspect and query the independent Raminga Kademlia DHT",
	}
	var statusJSON bool
	status := &cobra.Command{
		Use:   "status",
		Short: "Show Raminga DHT diagnostics",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			res, err := c.DhtStatus(ctx)
			if err != nil {
				return err
			}
			if statusJSON {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			d := res.GetDht()
			lastPublish := "-"
			if d.GetLastPublishUnixMs() > 0 {
				lastPublish = time.UnixMilli(d.GetLastPublishUnixMs()).UTC().Format(time.RFC3339)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "enabled: %t\nmode: %s\nprotocol: %s\nbootstrap: %v\nrouting_table: %v\nlast_error: %s\nlast_publish: %s\nlast_publish_error: %s\ndiagnosis: %s\n",
				d.GetEnabled(), d.GetMode(), d.GetProtocol(), d.GetBootstrapPeers(), d.GetRoutingTablePeers(), d.GetLastError(), lastPublish, d.GetLastPublishError(), dhtDiagnosis(d))
			return err
		},
	}
	status.Flags().BoolVar(&statusJSON, "json", false, "print protojson")

	var addJSON bool
	add := &cobra.Command{
		Use:   "add <peer-multiaddr>",
		Short: "Manually add a Raminga peer",
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
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "peer_id: %s\nsource: %s\n", res.GetPeer().GetPeerId(), res.GetPeer().GetSource())
			return err
		},
	}
	add.Flags().BoolVar(&addJSON, "json", false, "print protojson")

	var findJSON bool
	find := &cobra.Command{
		Use:   "find <peer-id>",
		Short: "Find a peer through the Raminga DHT",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 30*time.Second)
			defer cancel()
			res, err := c.DhtFindPeer(ctx, args[0])
			if err != nil {
				return err
			}
			if findJSON {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			p := res.GetPeer()
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "peer_id: %s\nfound: %t\nsource: %s\naddrs: %v\nerror: %s\n",
				p.GetPeerId(), p.GetFound(), p.GetSource(), p.GetAddrs(), p.GetError())
			return err
		},
	}
	find.Flags().BoolVar(&findJSON, "json", false, "print protojson")
	cmd.AddCommand(status, add, find)
	return cmd
}

// dhtDiagnosis explains an empty routing table in human terms while keeping the
// same diagnostic visible in both dht status and network status.
func dhtDiagnosis(d *apiv1.DHTStatus) string {
	if !d.GetEnabled() {
		return "DHT is disabled in config"
	}
	peers := len(d.GetRoutingTablePeers())
	bootstrap := len(d.GetBootstrapPeers())
	switch {
	case peers > 0:
		return fmt.Sprintf("%d routing-table peer(s)", peers)
	case bootstrap == 0:
		return "no peers yet; configure dht.bootstrap_peers or add peers"
	default:
		return fmt.Sprintf("no routing peers yet; %d bootstrap peer(s) configured but not connected", bootstrap)
	}
}
