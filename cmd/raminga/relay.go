package main

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/api/client"
)

func newRelayCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "relay",
		Short: "Inspect Circuit Relay v2 reservations and provider quotas",
	}
	var jsonOut bool
	status := &cobra.Command{
		Use:   "status",
		Short: "Show relay reservations and provider status",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			res, err := c.RelayStatus(ctx)
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			w := cmd.OutOrStdout()
			_, _ = fmt.Fprintf(w, "provider_enabled: %t\n", res.GetProvider().GetEnabled())
			for _, r := range res.GetRelays() {
				_, _ = fmt.Fprintf(w, "%s status=%s reservation=%s attempts=%d successes=%d failures=%d relayed=%s error=%s\n",
					r.GetRelayPeerId(), r.GetStatus(), r.GetReservationStatus(), r.GetAttempts(), r.GetSuccesses(), r.GetFailures(), r.GetRelayedAddr(), r.GetLastError())
			}
			return nil
		},
	}
	status.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	cmd.AddCommand(status)
	return cmd
}
