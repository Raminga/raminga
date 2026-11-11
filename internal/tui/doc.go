// Package tui implements the Raminga terminal test panel.
//
// It is a thin Bubble Tea client of the same local Connect-RPC API used by the
// CLI: it owns no node state, opens no network listener and does not require
// the test API. Remote text is treated as untrusted and sanitized before it is
// rendered. Reports built from the session are redacted by default.
package tui
