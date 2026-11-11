package main

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/api/client"
)

func newNetworkCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "network",
		Short: "Show network diagnostics (AutoNAT, DHT, relay, resources)",
	}
	var jsonOut bool
	status := &cobra.Command{
		Use:   "status",
		Short: "Show G2 network diagnostics",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			st, err := c.Status(ctx)
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), st, true)
			}
			n := st.GetNetwork()
			_, err = fmt.Fprintf(cmd.OutOrStdout(),
				"reachability: %s\nprobe_peers: %v\ndcutr: attempts=%d successes=%d failures=%d\ndht: enabled=%t mode=%s protocol=%s routing=%v diagnosis=%s\nrelay_provider: %t\nupnp=%t nat_pmp=%t stun=%t\nresources: conns=%d/%d streams=%d/%d cache=%d\n",
				n.GetReachability(), n.GetAutonat().GetProbePeers(),
				n.GetDcutr().GetAttempts(), n.GetDcutr().GetSuccesses(), n.GetDcutr().GetFailures(),
				n.GetDht().GetEnabled(), n.GetDht().GetMode(), n.GetDht().GetProtocol(), n.GetDht().GetRoutingTablePeers(), dhtDiagnosis(n.GetDht()),
				n.GetRelayProvider().GetEnabled(), n.GetUpnp(), n.GetNatPmp(), n.GetStun(),
				n.GetResources().GetOpenConnections(), n.GetResources().GetMaxConnections(),
				n.GetResources().GetOpenStreams(), n.GetResources().GetMaxStreams(),
				n.GetResources().GetCacheEntries())
			return err
		},
	}
	status.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	cmd.AddCommand(status)
	return cmd
}
