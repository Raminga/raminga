package main

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"connectrpc.com/connect"
	"github.com/charmbracelet/x/ansi"
	"github.com/dustin/go-humanize"
)

func displayWidth(s string) int { return ansi.StringWidth(s) }

func padDisplay(s string, width int) string {
	if w := displayWidth(s); w < width {
		return s + strings.Repeat(" ", width-w)
	}
	return s
}

func humanBytes(n int64) string {
	if n < 0 {
		n = 0
	}
	return humanize.IBytes(uint64(n))
}

// sizeRow is a path plus exact byte size and an optional suffix (for example
// modified time and SHA-256). JSON output still prints the exact integer.
type sizeRow struct {
	Path  string
	Size  int64
	Extra string
}

func writeSizedRows(w io.Writer, rows []sizeRow, indent string) {
	pathWidth, sizeWidth := 0, 0
	for _, row := range rows {
		if n := displayWidth(row.Path); n > pathWidth {
			pathWidth = n
		}
		if n := displayWidth(humanBytes(row.Size)); n > sizeWidth {
			sizeWidth = n
		}
	}
	for _, row := range rows {
		_, _ = fmt.Fprintf(w, "%s%s  %s%s\n", indent, padDisplay(row.Path, pathWidth), padDisplay(humanBytes(row.Size), sizeWidth), row.Extra)
	}
}

// cliErrText removes Connect's "unavailable:" style prefix from errors printed
// by the command line while keeping the server's cause.
func cliErrText(err error) string {
	if err == nil {
		return ""
	}
	var connectErr *connect.Error
	if errors.As(err, &connectErr) {
		if msg := connectErr.Message(); msg != "" {
			return msg
		}
	}
	return err.Error()
}
