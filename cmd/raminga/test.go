package main

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/api/client"
)

func newTestCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "test",
		Short: "Test-only RPCs (require --enable-test-api on the daemon)",
	}
	var (
		echo    string
		jsonOut bool
	)
	ping := &cobra.Command{
		Use:   "ping",
		Short: "Call the test-only TestPing RPC",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
			defer cancel()
			res, err := c.TestPing(ctx, echo)
			if err != nil {
				return err
			}
			if jsonOut {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "echo: %s\n", res.GetEcho())
			return err
		},
	}
	ping.Flags().StringVar(&echo, "echo", "", "text to echo")
	ping.Flags().BoolVar(&jsonOut, "json", false, "print protojson")

	var disconnectJSON bool
	disconnect := &cobra.Command{
		Use:   "disconnect <peer-id>",
		Short: "Close all connections to a peer (test-only)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client.New(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(cmd.Context(), 8*time.Second)
			defer cancel()
			res, err := c.TestDisconnectPeer(ctx, args[0])
			if err != nil {
				return err
			}
			if disconnectJSON {
				return printProto(cmd.OutOrStdout(), res, true)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "disconnected: %t\n", res.GetDisconnected())
			return err
		},
	}
	disconnect.Flags().BoolVar(&disconnectJSON, "json", false, "print protojson")
	cmd.AddCommand(ping, disconnect)
	return cmd
}
