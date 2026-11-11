package report

import (
	"fmt"
	"strings"
	"time"

	"github.com/Raminga/raminga/internal/textsafe"
)

// Markdown renders a readable report. Every untrusted string is sanitized and
// table separators are escaped, so a peer ID or error message cannot break the
// layout or inject a terminal escape sequence.
func Markdown(r *Report) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "# Raminga test report\n\n")
	fmt.Fprintf(&b, "- Generated: `%s`\n", r.GeneratedAt)
	fmt.Fprintf(&b, "- Raminga: `%s` (commit `%s`, schema `%s`)\n", md(r.Tool.Version), md(r.Tool.Commit), md(r.Tool.SchemaVersion))
	fmt.Fprintf(&b, "- Host: `%s/%s`, Go `%s`, protocol `%s`\n", md(r.Host.OS), md(r.Host.Arch), md(r.Tool.GoVersion), md(r.Tool.ProtocolVersion))
	fmt.Fprintf(&b, "- Message text included: `%t`\n\n", r.MessageTextIncluded)
	fmt.Fprintf(&b, "## Node\n\n")
	fmt.Fprintf(&b, "- Peer ID: `%s`\n- Node ID: `%s`\n", md(r.Node.PeerID), md(r.Node.NodeID))
	for _, a := range r.Node.ListenAddrs {
		fmt.Fprintf(&b, "- Listen: `%s`\n", md(a))
	}
	for _, a := range r.Node.AnnounceAddrs {
		fmt.Fprintf(&b, "- Announce: `%s`\n", md(a))
	}
	fmt.Fprintf(&b, "\n## Diagnostics\n\n")
	fmt.Fprintf(&b, "- Reachability: `%s`\n", md(r.NAT.Reachability))
	fmt.Fprintf(&b, "- AutoNAT: enabled=`%t` state=`%s` probe_peers=%d\n", r.NAT.AutoNAT.Enabled, md(r.NAT.AutoNAT.State), len(r.NAT.AutoNAT.ProbePeers))
	fmt.Fprintf(&b, "- DCUtR: attempts=%d successes=%d failures=%d\n", r.NAT.DCUtR.Attempts, r.NAT.DCUtR.Successes, r.NAT.DCUtR.Failures)
	fmt.Fprintf(&b, "- DHT: enabled=`%t` mode=`%s` protocol=`%s` routing_peers=%d\n", r.NAT.DHT.Enabled, md(r.NAT.DHT.Mode), md(r.NAT.DHT.Protocol), len(r.NAT.DHT.RoutingTablePeers))
	fmt.Fprintf(&b, "- Resources: conns=%d/%d streams=%d/%d cache=%d goroutines=%d\n", r.NAT.Resources.OpenConnections, r.NAT.Resources.MaxConnections, r.NAT.Resources.OpenStreams, r.NAT.Resources.MaxStreams, r.NAT.Resources.CacheEntries, r.NAT.Resources.Goroutines)
	fmt.Fprintf(&b, "- UPnP=`%t` NAT-PMP=`%t` STUN=`%t`\n\n", r.NAT.UPnP, r.NAT.NATPMP, r.NAT.STUN)
	b.WriteString("Readable explanations:\n\n")
	for _, e := range r.NAT.Explanations {
		fmt.Fprintf(&b, "- %s\n", md(e))
	}
	if len(r.NAT.Relays) > 0 {
		b.WriteString("\n### Relay reservations\n\n| Relay | Status | Reservation | Relayed address |\n| --- | --- | --- | --- |\n")
		for _, rr := range r.NAT.Relays {
			fmt.Fprintf(&b, "| `%s` | %s | %s | `%s` |\n", md(rr.RelayPeerID), md(rr.Status), md(rr.Reservation), md(rr.RelayedAddr))
		}
	}
	if len(r.Peers) > 0 {
		b.WriteString("\n## Peers\n\n| Peer | Online | Route | Transport | Family | Direct | Limited | Direction | Relay |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n")
		for _, p := range r.Peers {
			fmt.Fprintf(&b, "| `%s` | %t | %s | %s | %s | %t | %t | %s | `%s` |\n",
				md(short(p.PeerID)), p.Online, md(p.Route), md(p.Transport), md(p.Family), p.Direct, p.Limited, md(p.Direction), md(p.RelayPeerID))
		}
	}
	if r.StillDirectAfterRelayStop != nil {
		fmt.Fprintf(&b, "\n## Relay stop\n\n- Still direct after relay stop: **%t** (observed %d s)\n", *r.StillDirectAfterRelayStop, r.StillDirectObservationSeconds)
	} else {
		b.WriteString("\n## Relay stop\n\n- Not observed (`still_direct_after_relay_stop` is null). Do not claim relay independence.\n")
	}
	b.WriteString("\n## Connection timeline\n\n")
	if len(r.Timeline) == 0 {
		b.WriteString("_No timeline events were captured._\n")
	} else {
		b.WriteString("| Time | Kind | Peer | Route | Transport | Direct | Detail |\n| --- | --- | --- | --- | --- | --- | --- |\n")
		for _, e := range r.Timeline {
			fmt.Fprintf(&b, "| %s | %s | `%s` | %s | %s | %t | %s |\n",
				md(e.At), md(e.Kind), md(short(e.PeerID)), md(e.Route), md(e.Transport), e.Direct, md(e.Detail))
		}
	}
	if len(r.RouteChanges) > 0 {
		b.WriteString("\n## Route changes\n\n| Time | Peer | From | To | Transport |\n| --- | --- | --- | --- | --- |\n")
		for _, c := range r.RouteChanges {
			fmt.Fprintf(&b, "| %s | `%s` | %s | %s | %s |\n", md(c.At), md(short(c.PeerID)), md(c.From), md(c.To), md(c.Transport))
		}
	}
	b.WriteString("\n## ACK results\n\n")
	if len(r.ACKs) == 0 {
		b.WriteString("_No send/ACK results were captured._\n")
	} else {
		b.WriteString("| Time | Message | Peer | Acked | Route | Reason |\n| --- | --- | --- | --- | --- | --- |\n")
		for _, a := range r.ACKs {
			fmt.Fprintf(&b, "| %s | `%s` | `%s` | %t | %s | %s |\n",
				md(a.At), md(a.MessageID), md(short(a.PeerID)), a.Acked, md(a.Route), md(a.Reason))
		}
	}
	if len(r.Messages) > 0 {
		b.WriteString("\n## Messages\n\n")
		if r.MessageTextIncluded {
			b.WriteString("Text is included because the operator opted in with `--include-text`; it is sanitized before rendering.\n\n")
			b.WriteString("| Time | Message | Peer | Direction | Acked | Text |\n| --- | --- | --- | --- | --- | --- |\n")
			for _, m := range r.Messages {
				fmt.Fprintf(&b, "| %s | `%s` | `%s` | %s | %t | %s |\n", md(msTime(m.CreatedAtMS)), md(m.MessageID), md(short(m.PeerID)), md(m.Direction), m.Acked, md(m.Text))
			}
		} else {
			b.WriteString("| Time | Message | Peer | Direction | Acked |\n| --- | --- | --- | --- | --- |\n")
			for _, m := range r.Messages {
				fmt.Fprintf(&b, "| %s | `%s` | `%s` | %s | %t |\n", md(msTime(m.CreatedAtMS)), md(m.MessageID), md(short(m.PeerID)), md(m.Direction), m.Acked)
			}
		}
	}
	b.WriteString("\n## Outbox\n\n")
	fmt.Fprintf(&b, "- pending=%d acked=%d failed=%d cancelled=%d bytes=%d\n", r.Outbox.Stats.Pending, r.Outbox.Stats.Acked, r.Outbox.Stats.Failed, r.Outbox.Stats.Cancelled, r.Outbox.Stats.PendingBytes)
	if len(r.Outbox.Entries) > 0 {
		b.WriteString("\n| Message | Peer | Status | Attempts | Last error |\n| --- | --- | --- | --- | --- |\n")
		for _, e := range r.Outbox.Entries {
			fmt.Fprintf(&b, "| `%s` | `%s` | %s | %d | %s |\n", md(e.MessageID), md(short(e.PeerID)), md(e.Status), e.Attempts, md(e.LastError))
		}
	}
	b.WriteString("\n## Redaction\n\n- No private key, API token or message body is present unless `message_text_included` is `true` and the operator passed `--include-text`.\n")
	return []byte(b.String())
}

func md(s string) string {
	s = textsafe.Sanitize(s)
	s = strings.ReplaceAll(s, "|", `\|`)
	s = strings.ReplaceAll(s, "`", "'")
	return s
}

func msTime(ms int64) string {
	if ms <= 0 {
		return "-"
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}

func short(id string) string {
	if len(id) > 24 {
		return id[:24] + "…"
	}
	return id
}

// Validate checks raw JSON against the maintained JSON Schema.
func Validate(data, schema []byte) error {
	compiler := newCompiler()
	doc, err := unmarshalJSON(schema)
	if err != nil {
		return fmt.Errorf("parse schema: %w", err)
	}
	if err := compiler.AddResource("mem://test-report.schema.json", doc); err != nil {
		return fmt.Errorf("add schema: %w", err)
	}
	sch, err := compiler.Compile("mem://test-report.schema.json")
	if err != nil {
		return fmt.Errorf("compile schema: %w", err)
	}
	inst, err := unmarshalJSON(data)
	if err != nil {
		return fmt.Errorf("parse report: %w", err)
	}
	if err := sch.Validate(inst); err != nil {
		return fmt.Errorf("report does not match schema: %w", err)
	}
	return nil
}

// ValidateFile validates JSON bytes against a schema file.
func ValidateFile(data []byte, schemaPath string) error {
	schema, err := readFile(schemaPath)
	if err != nil {
		return err
	}
	return Validate(data, schema)
}

// MarshalJSONValue is a convenience for tests that need a decoded report.
func MarshalJSONValue(r *Report) (any, error) {
	b, err := JSON(r)
	if err != nil {
		return nil, err
	}
	return unmarshalJSON(b)
}
