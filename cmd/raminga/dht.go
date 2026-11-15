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
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "enabled: %t\nconfigured_mode: %s\nactive_mode: %s\nprotocol: %s\nbootstrap: %v\nbootstrap_connected: %d\nconnected_peers: %d\nrouting_table: %v\nlast_bootstrap: %s\nlast_refresh: %s\nlast_error: %s\nlast_publish: %s\nlast_publish_error: %s\ndiagnosis: %s\n",
				d.GetEnabled(), d.GetMode(), d.GetActiveMode(), d.GetProtocol(),
				d.GetBootstrapPeers(), d.GetBootstrapConnected(), d.GetConnectedPeers(), d.GetRoutingTablePeers(),
				formatUnixMillis(d.GetLastBootstrapUnixMs()), formatUnixMillis(d.GetLastRefreshUnixMs()),
				d.GetLastError(), formatUnixMillis(d.GetLastPublishUnixMs()), d.GetLastPublishError(), dhtDiagnosis(d))
			return err
		},
	}
	status.Flags().BoolVar(&statusJSON, "json", false, "print protojson")

	var addJSON bool
	add := &cobra.Command{
		Use:   "add <peer-multiaddr>",
		Short: "Add a local PeerStore hint (does not publish to the DHT or connect)",
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
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "peer_id: %s\nsource: %s\nscope: local PeerStore hint only (no DHT publish, connection, or online check)\n",
				res.GetPeer().GetPeerId(), res.GetPeer().GetSource())
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
	connected := int(d.GetConnectedPeers())
	bootstrapConnected := int(d.GetBootstrapConnected())
	switch {
	case peers > 0:
		return fmt.Sprintf("%d routing-table peer(s); %d connected peer(s)", peers, connected)
	case bootstrapConnected > 0:
		return fmt.Sprintf("connected to %d bootstrap peer(s) but not in the routing table; the peer may be a DHT client or the table has not refreshed", bootstrapConnected)
	case connected > 0:
		return fmt.Sprintf("connected to %d peer(s) but none are in the DHT routing table", connected)
	case bootstrap > 0:
		return fmt.Sprintf("not connected; %d bootstrap peer(s) configured but no active connection", bootstrap)
	default:
		return "not connected; no bootstrap peers configured; configure dht.bootstrap_peers or add peers"
	}
}

func formatUnixMillis(ms int64) string {
	if ms <= 0 {
		return "-"
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}
