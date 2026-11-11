package main

import (
	"fmt"
	"io"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

// printProto writes stable JSON. EmitUnpopulated keeps CLI/e2e output explicit
// (for example acked=false is always present).
func printProto(w io.Writer, msg proto.Message, pretty bool) error {
	opts := protojson.MarshalOptions{EmitUnpopulated: true}
	if pretty {
		opts.Multiline = true
		opts.Indent = "  "
	}
	b, err := opts.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = w.Write(append(b, '\n'))
	return err
}

// printDialAttempts renders each candidate dial result, including failures and
// dial backoff, so a peer-ID dial never hides which family was tried.
func printDialAttempts(w io.Writer, attempts []*apiv1.DialAttempt) {
	if len(attempts) == 0 {
		return
	}
	_, _ = fmt.Fprintln(w, "attempts:")
	for _, attempt := range attempts {
		status := "failed"
		if attempt.GetOk() {
			status = "ok"
		}
		line := fmt.Sprintf("  - %s source=%s family=%s %s", attempt.GetMultiaddr(), attempt.GetSource(), attempt.GetFamily(), status)
		if attempt.GetError() != "" {
			line += " error=" + attempt.GetError()
		}
		if attempt.GetBackoff() {
			line += " backoff=true"
		}
		if attempt.GetNote() != "" {
			line += " note=" + attempt.GetNote()
		}
		_, _ = fmt.Fprintln(w, line)
	}
}
