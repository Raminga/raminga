package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type nodeConfig struct {
	listen       []string
	announce     []string
	preferIPv6   bool
	dcutr        bool
	relayClient  bool
	autoRelay    bool
	autonat      bool
	dhtEnabled   bool
	dhtMode      string
	provider     bool
	knownRelays  []string
	bootstrap    []string
	maxRes       int
	maxPerIP     int
	maxPerPeer   int
	maxCircuits  int
	ttl          string
	dataLimit    int64
	duration     string
	queryTimeout string
}

func defaults() nodeConfig {
	return nodeConfig{
		preferIPv6:   false,
		dcutr:        false,
		relayClient:  false,
		autoRelay:    false,
		autonat:      true,
		dhtEnabled:   false,
		dhtMode:      "client",
		provider:     false,
		maxRes:       32,
		maxPerIP:     8,
		maxPerPeer:   1,
		maxCircuits:  8,
		ttl:          "10m",
		dataLimit:    4 << 20,
		duration:     "5m",
		queryTimeout: "5s",
	}
}

func lanListen(ip4, ip6 string) []string {
	return []string{
		"/ip4/" + ip4 + "/tcp/4001",
		"/ip6/" + ip6 + "/tcp/4001",
		"/ip4/" + ip4 + "/udp/4001/quic-v1",
		"/ip6/" + ip6 + "/udp/4001/quic-v1",
	}
}

func v4Listen(ip string) []string {
	return []string{
		"/ip4/" + ip + "/tcp/4001",
		"/ip4/" + ip + "/udp/4001/quic-v1",
	}
}

func v6Listen(ip, transport, port string) []string {
	return []string{"/ip6/" + ip + "/" + transport + "/" + port}
}

func (r *runner) ipv6FWBaseConfigs() map[string]string {
	relay := defaults()
	relay.listen = append(v6Listen("fd00:360:0::2", "tcp", "4001"), v6Listen("fd00:360:0::2", "udp", "4001/quic-v1")...)
	relay.announce = relay.listen
	relay.provider = true
	relay.autonat = false

	probe := defaults()
	probe.listen = v6Listen("fd00:360:0::20", "tcp", "4001")
	probe.announce = probe.listen
	probe.dcutr = false
	probe.relayClient = false
	probe.autonat = false

	return map[string]string{
		"relay":     r.config(relay),
		"wan-probe": r.config(probe),
	}
}

func (r *runner) ipv6FWPeerConfigs() map[string]string {
	relayAddr := "/ip6/fd00:360:0::2/tcp/4001/p2p/" + r.ids["relay"]
	mk := func(ip, global, transport, port string, dcutr bool) nodeConfig {
		cfg := defaults()
		cfg.listen = append(v6Listen(ip, transport, port), v6Listen(global, transport, port)...)
		cfg.announce = cfg.listen
		cfg.knownRelays = []string{relayAddr}
		cfg.dcutr = dcutr
		cfg.relayClient = true
		cfg.autoRelay = true
		cfg.autonat = true
		return cfg
	}
	relayOnly := func(ip, global string) nodeConfig {
		cfg := mk(ip, global, "udp", "4001/quic-v1", false)
		cfg.autoRelay = false
		return cfg
	}
	oneSided := func(ip, global string) nodeConfig {
		cfg := defaults()
		cfg.listen = append(v6Listen(ip, "tcp", "4001"), v6Listen(global, "tcp", "4001")...)
		cfg.announce = cfg.listen
		cfg.dcutr = false
		cfg.relayClient = false
		cfg.autoRelay = false
		cfg.autonat = false
		return cfg
	}
	return map[string]string{
		"a-quic":  r.config(mk("fd00:361:1::10", "2001:4860:361:1::10", "udp", "4001/quic-v1", true)),
		"b-quic":  r.config(mk("fd00:362:1::10", "2001:4860:362:1::10", "udp", "4001/quic-v1", true)),
		"a-tcp":   r.config(mk("fd00:361:1::11", "2001:4860:361:1::11", "tcp", "4001", true)),
		"b-tcp":   r.config(mk("fd00:362:1::11", "2001:4860:362:1::11", "tcp", "4001", true)),
		"a-relay": r.config(relayOnly("fd00:361:1::12", "2001:4860:361:1::12")),
		"b-relay": r.config(relayOnly("fd00:362:1::12", "2001:4860:362:1::12")),
		"one-a":   r.config(oneSided("fd00:361:1::13", "2001:4860:361:1::13")),
		"one-b":   r.config(oneSided("fd00:362:1::13", "2001:4860:362:1::13")),
	}
}

func (r *runner) lanConfigs() map[string]string {
	ip4 := map[string]string{
		"a4": "10.250.1.11", "b4": "10.250.1.12",
		"a6": "10.250.1.21", "b6": "10.250.1.22",
		"a6only": "10.250.1.31", "b6only": "10.250.1.32",
		"tcp-a": "10.250.1.41", "tcp-b": "10.250.1.42",
		"udp-a": "10.250.1.51", "udp-b": "10.250.1.52",
		"loss-a": "10.250.1.61", "loss-b": "10.250.1.62",
		"q6-a": "10.250.1.71", "q6-b": "10.250.1.72",
		"id-a": "10.250.1.81", "id-b": "10.250.1.82",
		"fb-a": "10.250.1.91", "fb-b": "10.250.1.92",
	}
	ip6 := map[string]string{
		"a4": "fd00:250:1::11", "b4": "fd00:250:1::12",
		"a6": "fd00:250:1::21", "b6": "fd00:250:1::22",
		"a6only": "fd00:250:1::31", "b6only": "fd00:250:1::32",
		"tcp-a": "fd00:250:1::41", "tcp-b": "fd00:250:1::42",
		"udp-a": "fd00:250:1::51", "udp-b": "fd00:250:1::52",
		"loss-a": "fd00:250:1::61", "loss-b": "fd00:250:1::62",
		"q6-a": "fd00:250:1::71", "q6-b": "fd00:250:1::72",
		"id-a": "fd00:250:1::81", "id-b": "fd00:250:1::82",
		"fb-a": "fd00:250:1::91", "fb-b": "fd00:250:1::92",
	}
	out := make(map[string]string, len(ip4))
	for name, addr4 := range ip4 {
		cfg := defaults()
		cfg.listen = lanListen(addr4, ip6[name])
		// The peer-ID/reuse pair is a focused LAN test. Disable AutoNAT so a
		// dial-back probe from the other side cannot create an unrelated
		// connection between the disconnect and fallback checks.
		if name == "id-a" || name == "id-b" || name == "fb-a" || name == "fb-b" {
			cfg.autonat = false
		}
		out[name] = r.config(cfg)
	}
	return out
}

func (r *runner) onesidedConfigs() map[string]string {
	pub := defaults()
	pub.listen = v4Listen("11.43.0.10")
	pub.announce = []string{"/ip4/11.43.0.10/tcp/4001", "/ip4/11.43.0.10/udp/4001/quic-v1"}
	pub.autonat = true

	peer := defaults()
	peer.listen = v4Listen("10.252.1.10")
	peer.dcutr = false
	peer.relayClient = false
	peer.autonat = false

	return map[string]string{
		"pub":  r.config(pub),
		"peer": r.config(peer),
	}
}

func (r *runner) symmetricBaseConfigs() map[string]string {
	relay := defaults()
	relay.listen = v4Listen("11.42.0.2")
	relay.announce = []string{"/ip4/11.42.0.2/tcp/4001", "/ip4/11.42.0.2/udp/4001/quic-v1"}
	relay.provider = true
	relay.autonat = false
	return map[string]string{"relay": r.config(relay)}
}

func (r *runner) symmetricPeerConfigs() map[string]string {
	relayAddr := "/ip4/11.42.0.2/tcp/4001/p2p/" + r.ids["relay"]
	mk := func(ip, wan string) nodeConfig {
		cfg := defaults()
		cfg.listen = v4Listen(ip)
		cfg.announce = []string{"/ip4/" + wan + "/udp/4001/quic-v1", "/ip4/" + wan + "/tcp/4001"}
		cfg.knownRelays = []string{relayAddr}
		cfg.dcutr = true
		cfg.relayClient = true
		cfg.autoRelay = true
		cfg.autonat = true
		return cfg
	}
	return map[string]string{
		"a": r.config(mk("10.254.1.10", "11.42.0.10")),
		"b": r.config(mk("10.254.2.10", "11.42.0.11")),
	}
}

func (r *runner) dualNATBaseConfigs() map[string]string {
	mk := func(ip string) nodeConfig {
		cfg := defaults()
		cfg.listen = v4Listen(ip)
		cfg.announce = []string{"/ip4/" + ip + "/tcp/4001", "/ip4/" + ip + "/udp/4001/quic-v1"}
		cfg.provider = true
		cfg.autonat = true
		return cfg
	}
	return map[string]string{
		"r1": r.config(mk("11.41.0.2")),
		"r2": r.config(mk("11.41.0.3")),
	}
}

func (r *runner) dualNATPeerConfigs() map[string]string {
	relay1 := "/ip4/11.41.0.2/tcp/4001/p2p/" + r.ids["r1"]
	relay2 := "/ip4/11.41.0.3/tcp/4001/p2p/" + r.ids["r2"]
	nat := func(ip, wan, transport, port string, dcutr bool) nodeConfig {
		cfg := defaults()
		cfg.listen = []string{fmt.Sprintf("/ip4/%s/%s/%s", ip, transport, port)}
		cfg.announce = []string{fmt.Sprintf("/ip4/%s/%s/%s", wan, transport, port)}
		cfg.knownRelays = []string{relay1, relay2}
		cfg.dcutr = dcutr
		cfg.relayClient = true
		cfg.autoRelay = true
		cfg.autonat = true
		return cfg
	}
	quicA := nat("10.249.1.10", "11.41.0.10", "udp", "4001/quic-v1", true)
	quicB := nat("10.249.2.10", "11.41.0.11", "udp", "4001/quic-v1", true)
	tcpA := nat("10.249.1.11", "11.41.0.10", "tcp", "4100", true)
	tcpB := nat("10.249.2.11", "11.41.0.11", "tcp", "4100", true)
	relayA := nat("10.249.1.12", "11.41.0.10", "udp", "4001/quic-v1", false)
	relayB := nat("10.249.2.12", "11.41.0.11", "udp", "4001/quic-v1", false)
	out := map[string]string{
		"a-quic": r.config(quicA), "b-quic": r.config(quicB),
		"a-tcp": r.config(tcpA), "b-tcp": r.config(tcpB),
		"a-relay": r.config(relayA), "b-relay": r.config(relayB),
	}
	// Relay-only peers ask for reservations on both relays. AutoRelay is off:
	// the scenario explicitly chooses a relay path so failover is observable.
	relayCfgA := relayA
	relayCfgA.autoRelay = false
	relayCfgB := relayB
	relayCfgB.autoRelay = false
	out["a-relay"] = r.config(relayCfgA)
	out["b-relay"] = r.config(relayCfgB)
	return out
}

func (r *runner) config(cfg nodeConfig) string {
	var b strings.Builder
	b.WriteString("# Generated by the G3 e2e runner. Raminga-only helpers; no public bootstrap/STUN/UPnP/NAT-PMP.\n")
	b.WriteString("[network]\n")
	b.WriteString("listen_addrs = " + tomlStrings(cfg.listen) + "\n")
	b.WriteString("announce_addrs = " + tomlStrings(cfg.announce) + "\n")
	b.WriteString("prefer_ipv6 = " + strconv.FormatBool(cfg.preferIPv6) + "\n")
	b.WriteString("enable_dcutr = " + strconv.FormatBool(cfg.dcutr) + "\n")
	b.WriteString("dcutr_timeout = \"10s\"\n")
	b.WriteString("enable_relay_client = " + strconv.FormatBool(cfg.relayClient) + "\n")
	b.WriteString("enable_auto_relay = " + strconv.FormatBool(cfg.autoRelay) + "\n")
	b.WriteString("[relay]\n")
	b.WriteString("provider = " + strconv.FormatBool(cfg.provider) + "\n")
	b.WriteString("known_relays = " + tomlStrings(cfg.knownRelays) + "\n")
	b.WriteString("max_reservations = " + strconv.Itoa(cfg.maxRes) + "\n")
	b.WriteString("reservation_ttl = \"" + cfg.ttl + "\"\n")
	b.WriteString("max_reservations_per_ip = " + strconv.Itoa(cfg.maxPerIP) + "\n")
	b.WriteString("max_reservations_per_peer = " + strconv.Itoa(cfg.maxPerPeer) + "\n")
	b.WriteString("max_circuits = " + strconv.Itoa(cfg.maxCircuits) + "\n")
	b.WriteString("reservation_data_limit_bytes = " + strconv.FormatInt(cfg.dataLimit, 10) + "\n")
	b.WriteString("reservation_duration_limit = \"" + cfg.duration + "\"\n")
	b.WriteString("[dht]\n")
	b.WriteString("enabled = " + strconv.FormatBool(cfg.dhtEnabled) + "\n")
	b.WriteString("mode = \"" + cfg.dhtMode + "\"\n")
	b.WriteString("protocol_prefix = \"/raminga\"\n")
	b.WriteString("bootstrap_peers = " + tomlStrings(cfg.bootstrap) + "\n")
	b.WriteString("refresh_interval = \"5s\"\n")
	b.WriteString("query_timeout = \"" + cfg.queryTimeout + "\"\n")
	b.WriteString("[autonat]\n")
	b.WriteString("enabled = " + strconv.FormatBool(cfg.autonat) + "\n")
	b.WriteString("[peerstore]\n")
	b.WriteString("cache_enabled = true\n")
	b.WriteString("cache_max_entries = 512\n")
	b.WriteString("cache_ttl = \"168h\"\n")
	b.WriteString("[limits]\n")
	b.WriteString("max_message_bytes = 1048576\n")
	b.WriteString("max_chat_text_bytes = 4096\n")
	b.WriteString("max_connections = 256\n")
	b.WriteString("max_streams = 1024\n")
	b.WriteString("max_memory_bytes = 134217728\n")
	b.WriteString("max_fds = 256\n")
	b.WriteString("app_messages_per_second = 20\n")
	b.WriteString("app_burst = 40\n")
	b.WriteString("[log]\n")
	b.WriteString("level = \"info\"\n")
	return b.String()
}

func tomlStrings(values []string) string {
	if len(values) == 0 {
		return "[]"
	}
	quoted := make([]string, len(values))
	for i, value := range values {
		quoted[i] = strconv.Quote(value)
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

func (r *runner) setupStack(st *stackInfo) error {
	if err := os.RemoveAll(st.configDir); err != nil {
		return err
	}
	if err := os.MkdirAll(st.configDir, 0o700); err != nil {
		return err
	}

	switch st.name {
	case "lan":
		for service, cfg := range r.lanConfigs() {
			if err := r.writeConfig(service, cfg); err != nil {
				return err
			}
		}
		if out, code := r.compose(st, "up", "-d", "--wait", "--wait-timeout", "300"); code != 0 {
			return fmt.Errorf("compose up lan: %s", out)
		}
		return r.waitStack(st)
	case "onesided":
		for service, cfg := range r.onesidedConfigs() {
			if err := r.writeConfig(service, cfg); err != nil {
				return err
			}
		}
		if out, code := r.compose(st, "up", "-d", "--wait", "--wait-timeout", "240"); code != 0 {
			return fmt.Errorf("compose up one-sided: %s", out)
		}
		return r.waitStack(st)
	case "symmetric":
		for service, cfg := range r.symmetricBaseConfigs() {
			if err := r.writeConfig(service, cfg); err != nil {
				return err
			}
		}
		if out, code := r.compose(st, append([]string{"up", "-d", "--wait", "--wait-timeout", "180"}, st.base...)...); code != 0 {
			return fmt.Errorf("compose up symmetric base: %s", out)
		}
		if err := r.waitBase(st); err != nil {
			return err
		}
		for service, cfg := range r.symmetricPeerConfigs() {
			if err := r.writeConfig(service, cfg); err != nil {
				return err
			}
		}
		if out, code := r.compose(st, "up", "-d", "--wait", "--wait-timeout", "300"); code != 0 {
			return fmt.Errorf("compose up symmetric peers: %s", out)
		}
		return r.waitStack(st)
	case "dualnat":
		for service, cfg := range r.dualNATBaseConfigs() {
			if err := r.writeConfig(service, cfg); err != nil {
				return err
			}
		}
		if out, code := r.compose(st, append([]string{"up", "-d", "--wait", "--wait-timeout", "180"}, st.base...)...); code != 0 {
			return fmt.Errorf("compose up dualnat base: %s", out)
		}
		if err := r.waitBase(st); err != nil {
			return err
		}
		for service, cfg := range r.dualNATPeerConfigs() {
			if err := r.writeConfig(service, cfg); err != nil {
				return err
			}
		}
		if out, code := r.compose(st, "up", "-d", "--wait", "--wait-timeout", "300"); code != 0 {
			return fmt.Errorf("compose up dualnat peers: %s", out)
		}
		return r.waitStack(st)
	case "ipv6fw":
		for service, cfg := range r.ipv6FWBaseConfigs() {
			if err := r.writeConfig(service, cfg); err != nil {
				return err
			}
		}
		if out, code := r.compose(st, append([]string{"up", "-d", "--wait", "--wait-timeout", "240"}, st.base...)...); code != 0 {
			return fmt.Errorf("compose up ipv6fw base: %s", out)
		}
		if err := r.waitBase(st); err != nil {
			return err
		}
		for service, cfg := range r.ipv6FWPeerConfigs() {
			if err := r.writeConfig(service, cfg); err != nil {
				return err
			}
		}
		if out, code := r.compose(st, "up", "-d", "--wait", "--wait-timeout", "300"); code != 0 {
			return fmt.Errorf("compose up ipv6fw peers: %s", out)
		}
		return r.waitStack(st)
	default:
		return fmt.Errorf("unknown stack %q", st.name)
	}
}

func (r *runner) waitBase(st *stackInfo) error {
	for _, service := range st.base {
		if st.nonNode[service] {
			continue
		}
		s, err := r.waitReady(service, 120*time.Second)
		if err != nil {
			return err
		}
		r.ids[service] = s.GetPeerId()
	}
	return nil
}

func (r *runner) waitStack(st *stackInfo) error {
	for _, service := range st.wait {
		if st.nonNode[service] {
			continue
		}
		s, err := r.waitReady(service, 120*time.Second)
		if err != nil {
			return err
		}
		r.ids[service] = s.GetPeerId()
	}
	return nil
}

func (r *runner) teardownStack(st *stackInfo) {
	_, _ = r.compose(st, "down", "-v", "--remove-orphans")
}
