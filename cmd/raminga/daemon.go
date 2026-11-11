package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/spf13/cobra"

	"github.com/Raminga/raminga/internal/api"
	"github.com/Raminga/raminga/internal/api/paths"
	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/identity"
	"github.com/Raminga/raminga/internal/network"
	"github.com/Raminga/raminga/internal/node"
	"github.com/Raminga/raminga/internal/storage"
)

func newDaemonCmd() *cobra.Command {
	var (
		enableTestAPI bool
		logLevel      string
	)
	cmd := &cobra.Command{
		Use:   "daemon",
		Short: "Run the node daemon (single writer of node state)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runDaemon(cmd.Context(), dataDirFrom(cmd), enableTestAPI, logLevel)
		},
	}
	cmd.Flags().BoolVar(&enableTestAPI, "enable-test-api", false, "enable test-only RPCs (default off)")
	cmd.Flags().StringVar(&logLevel, "log-level", "", "override log level: debug|info|warn|error")
	return cmd
}

func runDaemon(ctx context.Context, dataDir string, enableTestAPI bool, logLevel string) error {
	if err := paths.ValidateSocketPath(paths.SocketPath(dataDir)); err != nil {
		return fmt.Errorf("daemon: %w", err)
	}
	id, err := identity.Open(dataDir)
	if err != nil {
		return err
	}
	defer func() {
		if err := id.Close(); err != nil {
			fmt.Fprintf(os.Stderr, "raminga: release data directory lock: %v\n", err)
		}
	}()

	cfg, err := config.Load(id.DataDir())
	if err != nil {
		return err
	}
	levelName := cfg.Log.Level
	if logLevel != "" {
		levelName = logLevel
	}
	level, err := parseLevel(levelName)
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	logger.Info("opening node state",
		"peer_id", id.PeerID().String(),
		"node_id", id.NodeID(),
		"data_dir", id.DataDir())

	store, err := storage.Open(ctx, id.DataDir())
	if err != nil {
		return err
	}
	pausedIDs, err := store.ListPausedPeers(ctx)
	if err != nil {
		logger.Warn("load paused peers failed", "error", err)
	}
	netw, err := network.New(network.Config{
		PrivateKey:      id.PrivateKey(),
		ListenAddrs:     cfg.Network.ListenAddrs,
		AnnounceAddrs:   cfg.Network.AnnounceAddrs,
		PreferIPv6:      cfg.Network.PreferIPv6,
		UserAgent:       "raminga/" + buildVersion(),
		Logger:          logger,
		EnableRelay:     cfg.Network.EnableRelayClient,
		EnableDCUtR:     cfg.Network.EnableDCUtR,
		DCUtRTimeout:    cfg.DcutrTimeout(),
		EnableAutoRelay: cfg.Network.EnableAutoRelay,
		EnableAutoNAT:   cfg.AutoNAT.Enabled,
		Relay: network.RelayConfig{
			Provider:                 cfg.Relay.Provider,
			KnownRelays:              cfg.Relay.KnownRelays,
			MaxReservations:          cfg.Relay.MaxReservations,
			ReservationTTL:           cfg.ReservationTTL(),
			MaxReservationsPerIP:     cfg.Relay.MaxReservationsPerIP,
			MaxReservationsPerPeer:   cfg.Relay.MaxReservationsPerPeer,
			MaxCircuits:              cfg.Relay.MaxCircuits,
			ReservationDataLimit:     cfg.Relay.ReservationDataLimitBytes,
			ReservationDurationLimit: cfg.ReservationDurationLimit(),
			OnReserve: func(pid peer.ID, addr string) {
				addrs := []string{}
				if addr != "" {
					addrs = append(addrs, addr)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if _, _, err := store.UpsertFriend(ctx, pid.String(), addrs, false, true); err != nil {
					logger.Warn("record relay reservation friend failed", "peer_id", pid.String(), "error", err)
				}
			},
		},
		DHT: network.DHTConfig{
			Enabled:         cfg.DHT.Enabled,
			Mode:            cfg.DHT.Mode,
			ProtocolPrefix:  cfg.DHT.ProtocolPrefix,
			BootstrapPeers:  cfg.DHT.BootstrapPeers,
			RefreshInterval: cfg.DHTRefreshInterval(),
			QueryTimeout:    cfg.DHTQueryTimeout(),
		},
		Limits: network.ResourceLimits{
			MaxConnections: cfg.Limits.MaxConnections,
			MaxStreams:     cfg.Limits.MaxStreams,
			MaxMemoryBytes: cfg.Limits.MaxMemoryBytes,
			MaxFDs:         cfg.Limits.MaxFDs,
		},
		PeerCache:    node.NewPeerCache(store),
		PeerCacheTTL: cfg.PeerStoreCacheTTL(),
		PeerCacheMax: cfg.PeerStore.CacheMaxEntries,
		PausedPeers:  pausedIDs,
	})
	if err != nil {
		_ = store.Close()
		return err
	}
	for _, raw := range cfg.DHT.BootstrapPeers {
		if err := netw.SeedPeer(raw, "bootstrap"); err != nil {
			logger.Warn("seed DHT bootstrap peer failed", "addr", raw, "error", err)
		}
	}
	for _, raw := range cfg.Relay.KnownRelays {
		if err := netw.SeedPeer(raw, "pinned"); err != nil {
			logger.Warn("seed pinned relay failed", "addr", raw, "error", err)
		}
	}
	n, err := node.New(node.Options{
		DataDir:    id.DataDir(),
		Version:    buildVersion(),
		Config:     cfg,
		Identity:   id,
		Store:      store,
		Network:    netw,
		Logger:     logger,
		TestAPI:    enableTestAPI,
		Supervised: os.Getenv("INVOCATION_ID") != "",
	})
	if err != nil {
		_ = netw.Close()
		_ = store.Close()
		return err
	}
	if err := n.Start(ctx); err != nil {
		_ = n.Stop(context.Background())
		return err
	}

	apiServer, err := api.NewServer(n, id.DataDir(), enableTestAPI, logger)
	if err != nil {
		_ = n.Stop(context.Background())
		return err
	}
	if err := apiServer.Start(ctx); err != nil {
		_ = n.Stop(context.Background())
		return err
	}
	logger.Info("daemon ready",
		"peer_id", id.PeerID().String(),
		"node_id", id.NodeID(),
		"api_socket", api.SocketPath(id.DataDir()))

	var runErr error
	select {
	case <-ctx.Done():
		logger.Info("shutdown signal received")
	case <-apiServer.ShutdownRequests():
		logger.Info("shutdown requested via local API")
	case err := <-apiServer.Errors():
		runErr = err
		logger.Error("local API failed", "error", err)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Stop the node first so the local API remains reachable until the
	// data-dir lock is released. `raminga restart` waits for the API to go away
	// and can then start the new binary without racing the old lock.
	nodeErr := n.Stop(shutdownCtx)
	apiErr := apiServer.Close(shutdownCtx)
	return errors.Join(runErr, apiErr, nodeErr)
}

func parseLevel(name string) (slog.Level, error) {
	switch name {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("invalid log level %q: use debug|info|warn|error", name)
	}
}
