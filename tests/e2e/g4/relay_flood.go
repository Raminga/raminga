package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

// runRelayFloodContainers starts 12 full daemons on distinct source IPs, each
// configured with the provider as a known relay. This exercises the global
// MaxReservations quota without the per-IP guard (max 8 connections/IP and 4
// reservations/IP) masking it.
func (r *runner) runRelayFloodContainers(providerID string) (active, refused int, err error) {
	network := r.project + "_g4net"
	providerAddr := "/ip4/10.251.0.30/tcp/4001/p2p/" + providerID
	names := make([]string, 0, 12)
	defer func() {
		for _, name := range names {
			_, _ = r.command("host", os.Environ(), "docker", "rm", "-f", name)
		}
	}()
	for i := 0; i < 12; i++ {
		name := fmt.Sprintf("g4-relay-flood-%d", i)
		_, _ = r.command("host", os.Environ(), "docker", "rm", "-f", name)
		cfg := defaults()
		ip := fmt.Sprintf("10.251.0.%d", 50+i)
		cfg.listen = v4Listen(ip)
		cfg.announce = cfg.listen
		cfg.knownRelays = []string{providerAddr}
		cfg.relayClient = true
		cfg.autoRelay = false
		cfg.dhtEnabled = false
		cfg.autonat = false
		path := fmt.Sprintf("%s/relay-flood-%d.toml", r.configDir, i)
		if werr := os.WriteFile(path, []byte(r.renderConfig(cfg)), 0o600); werr != nil {
			return 0, 0, werr
		}
		out, code := r.command("host", os.Environ(), "docker", "run", "-d", "--name", name,
			"--network", network, "--ip", ip,
			"-e", "RAMINGA_DATA_DIR=/data", "-e", "RAMINGA_CONFIG_TEMPLATE=/config.toml",
			"-v", path+":/config.toml:ro", imageName)
		if code != 0 {
			return active, refused, fmt.Errorf("start relay-flood-%d: %s", i, out)
		}
		names = append(names, name)
	}
	deadline := time.Now().Add(45 * time.Second)
	activeSet := make(map[string]bool)
	for time.Now().Before(deadline) {
		activeSet = make(map[string]bool)
		for _, name := range names {
			out, code := r.command("host", os.Environ(), "docker", "exec", name,
				"raminga", "relay", "status", "--data-dir", "/data", "--json")
			if code != 0 {
				continue
			}
			var rs apiv1.RelayStatusResponse
			if protojson.Unmarshal([]byte(out), &rs) != nil {
				continue
			}
			for _, rr := range rs.GetRelays() {
				if rr.GetReservationStatus() == "active" {
					activeSet[name] = true
				}
			}
		}
		if len(activeSet) >= 7 {
			break
		}
		time.Sleep(2 * time.Second)
	}
	providerLogs := r.composeOutput("logs", "--no-color", "relay-provider")
	for _, line := range strings.Split(providerLogs, "\n") {
		if strings.Contains(line, "refusing relay reservation") {
			refused++
		}
	}
	return len(activeSet), refused, nil
}
