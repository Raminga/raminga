package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
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
		apiTCP        bool
		logLevel      string
	)
	cmd := &cobra.Command{
		Use:   "daemon",
		Short: "Run the node daemon (single writer of node state)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runDaemon(cmd.Context(), dataDirFrom(cmd), enableTestAPI, logLevel, apiTCP || envTCPRequested())
		},
	}
	cmd.Flags().BoolVar(&enableTestAPI, "enable-test-api", false, "enable test-only RPCs (default off)")
	cmd.Flags().BoolVar(&apiTCP, "api-tcp", false, "serve the local API only on an ephemeral 127.0.0.1 TCP listener with per-run TLS/token (default: Unix socket)")
	cmd.Flags().StringVar(&logLevel, "log-level", "", "override log level: debug|info|warn|error")
	return cmd
}

func runDaemon(ctx context.Context, dataDir string, enableTestAPI bool, logLevel string, apiTCP bool) error {
	if !apiTCP {
		if err := paths.ValidateSocketPath(paths.SocketPath(dataDir)); err != nil {
			return fmt.Errorf("daemon: %w", err)
		}
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

	// A missing database is a genuine first initialization: resolve and
	// validate config.toml (including the selected release preset) before
	// SQLite creates an empty file. Otherwise a failed preset resolution would
	// leave an initialized database that looks like recovery on the next
	// invocation and could ignore a corrected preset.
	dbPath := filepath.Join(id.DataDir(), storage.FileName)
	_, statErr := os.Stat(dbPath)
	existingDatabase := statErr == nil
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return fmt.Errorf("inspect node database %q: %w", dbPath, statErr)
	}
	var (
		store *storage.Store
		cfg   config.Config
	)
	if existingDatabase {
		// Read the one-time bootstrap import marker before a missing
		// config.toml can resolve the official preset. A pre-existing database
		// is recovery, even if it predates the marker: recovery must not absorb
		// a new official seed into existing node state.
		store, err = storage.Open(ctx, id.DataDir())
		if err != nil {
			return err
		}
		imported, markerErr := store.BootstrapImported(ctx)
		if markerErr != nil {
			_ = store.Close()
			return fmt.Errorf("read bootstrap import marker: %w", markerErr)
		}
		cfg, err = config.LoadWithOptions(id.DataDir(), config.LoadOptions{
			BootstrapImported: imported,
			ExistingDatabase:  true,
		})
	} else {
		// No import marker can exist without a database. Strictly load the
		// initial config before storage.Open so an invalid selected preset
		// cannot create the SQLite file that would make the next attempt look
		// like existing-database recovery.
		cfg, err = config.LoadWithOptions(id.DataDir(), config.LoadOptions{})
	}
	if err != nil {
		if store != nil {
			_ = store.Close()
		}
		return err
	}
	if store == nil {
		store, err = storage.Open(ctx, id.DataDir())
		if err != nil {
			return err
		}
	}
	levelName := cfg.Log.Level
	if logLevel != "" {
		levelName = logLevel
	}
	level, err := parseLevel(levelName)
	if err != nil {
		_ = store.Close()
		return err
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	logger.Info("opening node state",
		"peer_id", id.PeerID().String(),
		"node_id", id.NodeID(),
		"data_dir", id.DataDir())

	pausedIDs, err := store.ListPausedPeers(ctx)
	if err != nil {
		logger.Warn("load paused peers failed", "error", err)
	}
	// config.toml's [dht].bootstrap_peers (and the release preset applied by
	// init) is a first-initialization input only. The one-time import writes
	// the bootstrap role into the ordinary peer records; every later config
	// edit or restart reads the database instead, so an explicit clear stays
	// cleared and the TOML is never rewritten.
	if _, imported, importErr := store.ImportBootstrapPeersOnce(ctx, cfg.DHT.BootstrapPeers); importErr != nil {
		_ = store.Close()
		return fmt.Errorf("import bootstrap peer preset: %w", importErr)
	} else if imported {
		logger.Info("imported legacy bootstrap peer preset", "count", len(cfg.DHT.BootstrapPeers))
	}
	bootstrapRows, err := store.ListBootstrapPeers(ctx)
	if err != nil {
		_ = store.Close()
		return fmt.Errorf("load bootstrap peers: %w", err)
	}
	bootstrapAddrs := make([]string, 0)
	for _, peer := range bootstrapRows {
		bootstrapAddrs = append(bootstrapAddrs, peer.Addrs...)
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
			BootstrapPeers:  bootstrapAddrs,
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

	apiServer, err := api.NewServerWithOptions(n, id.DataDir(), enableTestAPI, logger, api.Options{EnableTCP: apiTCP})
	if err != nil {
		_ = n.Stop(context.Background())
		return err
	}
	if err := apiServer.Start(ctx); err != nil {
		_ = n.Stop(context.Background())
		return err
	}
	apiLocation := api.SocketPath(id.DataDir())
	if apiTCP {
		apiLocation = "127.0.0.1 (ephemeral TLS)"
	}
	logger.Info("daemon ready",
		"peer_id", id.PeerID().String(),
		"node_id", id.NodeID(),
		"api", apiLocation,
		"api_tcp", apiTCP)

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
