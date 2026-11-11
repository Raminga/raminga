package main

import (
	"fmt"
	"runtime"

	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/protocol"
)

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the raminga version and build platform",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "raminga %s\nprotocol %s\n%s %s/%s\n",
				buildVersion(), string(protocol.HTTPProtocol), runtime.Version(), runtime.GOOS, runtime.GOARCH)
			return err
		},
	}
}
