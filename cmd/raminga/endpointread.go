package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/api/endpoint"
)

// internalAPIEndpointCommand is a host-private bridge used by the DSH plugin
// on Windows. It is deliberately hidden from the normal CLI surface and only
// writes the protected discovery document to a pipe: the bearer token must
// never appear on a command line, in terminal output, or in a log.
const internalAPIEndpointCommand = "internal-api-endpoint"

func newInternalAPIEndpointCmd() *cobra.Command {
	return &cobra.Command{
		Use:    internalAPIEndpointCommand,
		Short:  "Read the protected local API endpoint for a host client",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			// Private IPC streams are the only stdout we accept: anonymous
			// pipes on Windows, and either a pipe or a socketpair under the
			// Node test/runtime harness on Unix. A TTY, console or redirected
			// file would make the per-run token visible outside the host
			// process that asked for it.
			info, err := os.Stdout.Stat()
			if err != nil {
				return fmt.Errorf("inspect stdout: %w", err)
			}
			if info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
				return errors.New("refusing to write the local API discovery document to a non-pipe stdout; this command is only for a host client's private pipe")
			}
			doc, found, err := endpoint.ReadIfPresent(dataDirFrom(cmd))
			if err != nil {
				return err
			}
			response := struct {
				Found    bool               `json:"found"`
				Document *endpoint.Document `json:"document,omitempty"`
			}{Found: found}
			if found {
				response.Document = &doc
			}
			encoder := json.NewEncoder(os.Stdout)
			encoder.SetEscapeHTML(false)
			if err := encoder.Encode(response); err != nil {
				return fmt.Errorf("write local API discovery to private pipe: %w", err)
			}
			return nil
		},
	}
}
