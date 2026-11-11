package main

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/content"
)

func newInitCmd() *cobra.Command {
	var (
		tcpPort       int
		quicPort      int
		listen        []string
		force         bool
		jsonOut       bool
		relayProvider bool
		announce      []string
		knownRelays   []string
		bootstrap     []string
	)
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Create a data directory and default config without starting a node",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if len(listen) > 0 && (cmd.Flags().Changed("tcp-port") || cmd.Flags().Changed("quic-port")) {
				return fmt.Errorf("--listen cannot be combined with --tcp-port/--quic-port")
			}
			dir := dataDirFrom(cmd)
			cfg, err := config.Init(dir, config.InitOptions{
				ListenAddrs:    listen,
				TCPPort:        tcpPort,
				QUICPort:       quicPort,
				Force:          force,
				RelayProvider:  relayProvider,
				AnnounceAddrs:  announce,
				KnownRelays:    knownRelays,
				BootstrapPeers: bootstrap,
			})
			if err != nil {
				return err
			}
			if err := content.EnsureLayout(dir); err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			if jsonOut {
				return json.NewEncoder(w).Encode(map[string]any{
					"data_dir":       dir,
					"config":         config.Path(dir),
					"listen_addrs":   cfg.Network.ListenAddrs,
					"announce_addrs": cfg.Network.AnnounceAddrs,
					"known_relays":   cfg.Relay.KnownRelays,
					"bootstrap":      cfg.DHT.BootstrapPeers,
					"relay_provider": cfg.Relay.Provider,
				})
			}
			_, _ = fmt.Fprintf(w, "data_dir: %s\nconfig: %s\nlisten_addrs:\n", dir, config.Path(dir))
			for _, addr := range cfg.Network.ListenAddrs {
				_, _ = fmt.Fprintf(w, "  - %s\n", addr)
			}
			_, _ = fmt.Fprintf(w, "relay_provider: %t\n", cfg.Relay.Provider)
			if len(cfg.Network.AnnounceAddrs) > 0 {
				_, _ = fmt.Fprintln(w, "announce_addrs:")
				for _, addr := range cfg.Network.AnnounceAddrs {
					_, _ = fmt.Fprintf(w, "  - %s\n", addr)
				}
			}
			if len(cfg.Relay.KnownRelays) > 0 {
				_, _ = fmt.Fprintln(w, "known_relays:")
				for _, addr := range cfg.Relay.KnownRelays {
					_, _ = fmt.Fprintf(w, "  - %s\n", addr)
				}
			}
			if len(cfg.DHT.BootstrapPeers) > 0 {
				_, _ = fmt.Fprintln(w, "bootstrap_peers:")
				for _, addr := range cfg.DHT.BootstrapPeers {
					_, _ = fmt.Fprintf(w, "  - %s\n", addr)
				}
			}
			_, _ = fmt.Fprintf(w, "next: raminga daemon --data-dir %s\n", dir)
			return nil
		},
	}
	cmd.Flags().IntVar(&tcpPort, "tcp-port", 4001, "TCP listen port written to config.toml")
	cmd.Flags().IntVar(&quicPort, "quic-port", 4001, "QUIC/UDP listen port written to config.toml")
	cmd.Flags().StringArrayVar(&listen, "listen", nil, "explicit listen multiaddr (repeatable; overrides ports)")
	cmd.Flags().BoolVar(&force, "force", false, "replace an existing config.toml")
	cmd.Flags().BoolVar(&jsonOut, "json", false, "print machine-readable init result")
	cmd.Flags().BoolVar(&relayProvider, "relay-provider", false, "enable the Circuit Relay v2 provider (off by default; safe quotas are always applied)")
	cmd.Flags().StringArrayVar(&announce, "announce", nil, "advertised multiaddr without /p2p or /p2p-circuit (repeatable)")
	cmd.Flags().StringArrayVar(&knownRelays, "known-relay", nil, "Raminga relay multiaddr including /p2p/<peer-id> (repeatable)")
	cmd.Flags().StringArrayVar(&bootstrap, "bootstrap", nil, "Raminga bootstrap multiaddr including /p2p/<peer-id> (repeatable)")
	return cmd
}
