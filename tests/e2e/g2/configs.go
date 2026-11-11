package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type nodeConfig struct {
	listen       []string
	announce     []string
	knownRelays  []string
	bootstrap    []string
	dcutr        bool
	relayClient  bool
	autoRelay    bool
	autonat      bool
	dhtEnabled   bool
	dhtMode      string
	provider     bool
	maxRes       int
	maxPerIP     int
	maxPerPeer   int
	maxCircuits  int
	ttl          string
	dataLimit    int64
	duration     string
	queryTimeout string
}

func (r *runner) baseConfigs() map[string]string {
	wan := func(ip string, proto string) string {
		return "/ip4/" + ip + "/" + proto
	}
	defaults := func(ip string) nodeConfig {
		return nodeConfig{
			listen:       []string{"/ip4/0.0.0.0/tcp/4001"},
			announce:     []string{wan(ip, "tcp/4001")},
			dcutr:        false,
			relayClient:  false,
			autoRelay:    false,
			autonat:      true,
			dhtEnabled:   true,
			dhtMode:      "server",
			provider:     false,
			maxRes:       32,
			maxPerIP:     8,
			maxPerPeer:   1,
			maxCircuits:  8,
			ttl:          "10m",
			dataLimit:    4 << 20,
			duration:     "5m",
			queryTimeout: "10s",
		}
	}
	r1 := defaults("11.40.0.2")
	r1.provider = true
	r2 := defaults("11.40.0.3")
	r2.provider = true
	off := defaults("11.40.0.5")
	quota := defaults("11.40.0.7")
	quota.provider = true
	quota.maxRes = 2
	quota.maxPerIP = 1
	quota.maxPerPeer = 1
	quota.maxCircuits = 2
	quota.ttl = "10m"
	quota.dataLimit = 1 << 20
	quota.duration = "5m"
	boot := defaults("11.40.0.6")
	boot.autonat = false
	return map[string]string{
		"r1":       r.config(r1),
		"r2":       r.config(r2),
		"r-off":    r.config(off),
		"r-quota":  r.config(quota),
		"dht-boot": r.config(boot),
	}
}

func (r *runner) peerConfigs() map[string]string {
	relay1 := "/ip4/11.40.0.2/tcp/4001/p2p/" + r.ids["r1"]
	relay2 := "/ip4/11.40.0.3/tcp/4001/p2p/" + r.ids["r2"]
	relayQuota := "/ip4/11.40.0.7/tcp/4001/p2p/" + r.ids["r-quota"]
	relayOff := "/ip4/11.40.0.5/tcp/4001/p2p/" + r.ids["r-off"]
	bootstrap := "/ip4/11.40.0.6/tcp/4001/p2p/" + r.ids["dht-boot"]

	defaults := func() nodeConfig {
		return nodeConfig{
			dcutr:        false,
			relayClient:  false,
			autoRelay:    false,
			autonat:      false,
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
			queryTimeout: "10s",
		}
	}
	natRelay := func(ip, transport, port string) nodeConfig {
		cfg := defaults()
		cfg.listen = []string{fmt.Sprintf("/ip4/0.0.0.0/%s/%s", transport, port)}
		cfg.announce = []string{fmt.Sprintf("/ip4/%s/%s/%s", ip, transport, port)}
		cfg.knownRelays = []string{relay1, relay2}
		cfg.bootstrap = []string{bootstrap}
		cfg.dcutr = true
		cfg.relayClient = true
		cfg.autoRelay = true
		cfg.autonat = true
		cfg.dhtEnabled = true
		cfg.dhtMode = "client"
		cfg.queryTimeout = "5s"
		return cfg
	}
	out := make(map[string]string)

	quic := natRelay("11.40.0.10", "udp", "4001/quic-v1")
	quicB := quic
	quicB.announce = []string{"/ip4/11.40.0.11/udp/4001/quic-v1"}
	out["a-quic"] = r.config(quic)
	out["b-quic"] = r.config(quicB)

	tcp := natRelay("11.40.0.10", "tcp", "4100")
	tcpB := tcp
	tcpB.announce = []string{"/ip4/11.40.0.11/tcp/4100"}
	out["a-tcp"] = r.config(tcp)
	out["b-tcp"] = r.config(tcpB)

	relayPeer := natRelay("11.40.0.10", "udp", "4001/quic-v1")
	relayPeer.dcutr = false
	relayPeerB := relayPeer
	relayPeerB.announce = []string{"/ip4/11.40.0.11/udp/4001/quic-v1"}
	out["a-relay"] = r.config(relayPeer)
	out["b-relay"] = r.config(relayPeerB)

	pub := defaults()
	pub.listen = []string{"/ip4/0.0.0.0/tcp/4001", "/ip4/0.0.0.0/udp/4001/quic-v1"}
	pub.announce = []string{"/ip4/11.40.0.20/tcp/4001", "/ip4/11.40.0.20/udp/4001/quic-v1"}
	pub.autonat = true
	out["pub"] = r.config(pub)

	for _, item := range []struct {
		name string
		ip   string
		mode string
		boot []string
	}{
		{"dht-a", "11.40.0.21", "server", []string{bootstrap}},
		{"dht-b", "11.40.0.22", "server", []string{bootstrap}},
		{"dht-c", "11.40.0.23", "client", nil},
	} {
		cfg := defaults()
		cfg.listen = []string{"/ip4/0.0.0.0/tcp/4001", "/ip4/0.0.0.0/udp/4001/quic-v1"}
		cfg.announce = []string{
			"/ip4/" + item.ip + "/tcp/4001",
			"/ip4/" + item.ip + "/udp/4001/quic-v1",
		}
		cfg.dhtEnabled = true
		cfg.dhtMode = item.mode
		cfg.bootstrap = item.boot
		cfg.queryTimeout = "5s"
		if item.name == "dht-c" {
			cfg.queryTimeout = "2s"
		}
		out[item.name] = r.config(cfg)
	}

	for _, item := range []struct {
		name  string
		ip    string
		relay string
	}{
		{"quota-a1", "10.241.1.30", relayQuota},
		{"quota-a2", "10.241.1.31", relayQuota},
		{"off-peer", "10.241.1.32", relayOff},
	} {
		cfg := defaults()
		cfg.listen = []string{"/ip4/0.0.0.0/tcp/4001"}
		cfg.knownRelays = []string{item.relay}
		cfg.relayClient = true
		out[item.name] = r.config(cfg)
	}

	for _, item := range []struct {
		name string
		ip   string
	}{
		{"a-one", "11.40.0.10"},
		{"b-one", "11.40.0.11"},
	} {
		cfg := defaults()
		cfg.listen = []string{"/ip4/0.0.0.0/tcp/4001", "/ip4/0.0.0.0/udp/4001/quic-v1"}
		cfg.announce = []string{
			"/ip4/" + item.ip + "/tcp/4001",
			"/ip4/" + item.ip + "/udp/4001/quic-v1",
		}
		cfg.autonat = true
		out[item.name] = r.config(cfg)
	}
	return out
}

func (r *runner) config(cfg nodeConfig) string {
	var b strings.Builder
	b.WriteString("# Generated by the G2 e2e runner. Raminga-only helpers; no public bootstrap/STUN/UPnP/NAT-PMP.\n")
	b.WriteString("[network]\n")
	b.WriteString("listen_addrs = " + tomlStrings(cfg.listen) + "\n")
	b.WriteString("announce_addrs = " + tomlStrings(cfg.announce) + "\n")
	b.WriteString("prefer_ipv6 = true\n")
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
	b.WriteString("max_connections = 128\n")
	b.WriteString("max_streams = 512\n")
	b.WriteString("max_memory_bytes = 134217728\n")
	b.WriteString("max_fds = 256\n")
	b.WriteString("app_messages_per_second = 20\n")
	b.WriteString("app_burst = 40\n")
	b.WriteString("[log]\n")
	level := "info"
	if os.Getenv("G2_DEBUG") == "1" {
		level = "debug"
	}
	b.WriteString("level = \"" + level + "\"\n")
	return b.String()
}

func tomlStrings(values []string) string {
	if len(values) == 0 {
		return "[]"
	}
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, fmt.Sprintf("%q", value))
	}
	return "[" + strings.Join(parts, ", ") + "]"
}
