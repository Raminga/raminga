package main

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/api/client"
)

func newDisconnectCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "disconnect <peer-id>",
		Short: "Close connections to a peer and stop dialing it until the next explicit connect (the peer may still connect in)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 10*time.Second)
			defer cancel()
			res, err := c.DisconnectPeer(ctx, args[0])
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "disconnected: %t\n", res.GetDisconnected())
			return err
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print protojson")
	return cmd
}
