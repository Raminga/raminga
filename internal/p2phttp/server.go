// Package p2phttp implements Raminga HTTP over libp2p streams using net/http
// and gostream. It deliberately does not use the experimental p2p/http package.
package p2phttp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/libp2p/go-libp2p/p2p/net/gostream"
	"golang.org/x/time/rate"
)

const (
	// ProtocolID is the single Raminga HTTP-over-libp2p protocol.
	ProtocolID = protocol.ID("/raminga/http/1.0.0")

	DefaultReadHeaderTimeout = 10 * time.Second
	DefaultReadTimeout       = 30 * time.Second
	DefaultIdleTimeout       = 60 * time.Second
	DefaultMaxHeaderBytes    = 16 << 10
	DefaultMaxBodyBytes      = 1 << 20
	DefaultPerPeerRate       = 5
	DefaultPerPeerBurst      = 10
	DefaultMaxTrackedPeers   = 1024
	DefaultPerPeerConcurrent = 4
	DefaultGlobalConcurrent  = 64
)

// Options configures the server. Per-route long downloads should use
// http.NewResponseController to set their own write deadline; the server leaves
// WriteTimeout at zero so a global write timeout cannot kill downloads.
type Options struct {
	ReadHeaderTimeout time.Duration
	ReadTimeout       time.Duration
	IdleTimeout       time.Duration
	MaxHeaderBytes    int
	MaxBodyBytes      int64
	PerPeerRate       float64
	PerPeerBurst      int
	MaxTrackedPeers   int
	PerPeerConcurrent int
	GlobalConcurrent  int
	// DisableRateLimit lets a route (e.g. chat with dedupe-before-rate) own
	// its per-peer budget instead of applying the generic HTTP limiter.
	DisableRateLimit bool
}

func DefaultOptions() Options {
	return Options{
		ReadHeaderTimeout: DefaultReadHeaderTimeout,
		ReadTimeout:       DefaultReadTimeout,
		IdleTimeout:       DefaultIdleTimeout,
		MaxHeaderBytes:    DefaultMaxHeaderBytes,
		MaxBodyBytes:      DefaultMaxBodyBytes,
		PerPeerRate:       DefaultPerPeerRate,
		PerPeerBurst:      DefaultPerPeerBurst,
		MaxTrackedPeers:   DefaultMaxTrackedPeers,
		PerPeerConcurrent: DefaultPerPeerConcurrent,
		GlobalConcurrent:  DefaultGlobalConcurrent,
	}
}

type peerIDKey struct{}
type connKey struct{}

// WithPeerID stores the authenticated stream Peer ID in a request context.
func WithPeerID(ctx context.Context, pid peer.ID) context.Context {
	return context.WithValue(ctx, peerIDKey{}, pid)
}

// PeerID returns the authenticated caller Peer ID from the request context.
func PeerID(ctx context.Context) (peer.ID, bool) {
	pid, ok := ctx.Value(peerIDKey{}).(peer.ID)
	return pid, ok
}

type Server struct {
	host      host.Host
	handler   http.Handler
	opts      Options
	httpSrv   *http.Server
	ln        net.Listener
	done      chan struct{}
	serveErr  error
	started   bool
	closeOnce sync.Once

	limMu  sync.Mutex
	limits *lru.Cache[peer.ID, *rate.Limiter]

	concMu  sync.Mutex
	global  int
	perPeer map[peer.ID]int
}

func NewServer(h host.Host, handler http.Handler, opts Options) (*Server, error) {
	if h == nil || handler == nil {
		return nil, errors.New("p2phttp: host and handler are required")
	}
	if opts.ReadHeaderTimeout <= 0 {
		opts.ReadHeaderTimeout = DefaultReadHeaderTimeout
	}
	if opts.ReadTimeout <= 0 {
		opts.ReadTimeout = DefaultReadTimeout
	}
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = DefaultIdleTimeout
	}
	if opts.MaxHeaderBytes <= 0 {
		opts.MaxHeaderBytes = DefaultMaxHeaderBytes
	}
	if opts.MaxBodyBytes <= 0 {
		opts.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if opts.PerPeerRate <= 0 {
		opts.PerPeerRate = DefaultPerPeerRate
	}
	if opts.PerPeerBurst <= 0 {
		opts.PerPeerBurst = DefaultPerPeerBurst
	}
	if opts.MaxTrackedPeers <= 0 {
		opts.MaxTrackedPeers = DefaultMaxTrackedPeers
	}
	if opts.PerPeerConcurrent <= 0 {
		opts.PerPeerConcurrent = DefaultPerPeerConcurrent
	}
	if opts.GlobalConcurrent <= 0 {
		opts.GlobalConcurrent = DefaultGlobalConcurrent
	}
	limits, err := lru.New[peer.ID, *rate.Limiter](opts.MaxTrackedPeers)
	if err != nil {
		return nil, err
	}
	return &Server{host: h, handler: handler, opts: opts, limits: limits, perPeer: make(map[peer.ID]int), done: make(chan struct{})}, nil
}

func (s *Server) Start(ctx context.Context) error {
	ln, err := gostream.Listen(s.host, ProtocolID, gostream.IgnoreEOF())
	if err != nil {
		return fmt.Errorf("p2phttp: listen: %w", err)
	}
	s.ln = ln
	s.started = true
	s.httpSrv = &http.Server{
		Handler:           s.wrap(s.handler),
		ReadHeaderTimeout: s.opts.ReadHeaderTimeout,
		ReadTimeout:       s.opts.ReadTimeout,
		IdleTimeout:       s.opts.IdleTimeout,
		MaxHeaderBytes:    s.opts.MaxHeaderBytes,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			return context.WithValue(ctx, connKey{}, c)
		},
		// No WriteTimeout: routes set per-response deadlines with ResponseController.
	}
	go func() {
		defer close(s.done)
		err := s.httpSrv.Serve(ln)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.serveErr = err
		}
	}()
	return nil
}

func (s *Server) Close(ctx context.Context) error {
	var err error
	s.closeOnce.Do(func() {
		if !s.started {
			return
		}
		if s.httpSrv != nil {
			err = s.httpSrv.Shutdown(ctx)
			if err != nil {
				_ = s.httpSrv.Close()
			}
		}
		if s.ln != nil {
			_ = s.ln.Close()
		}
		select {
		case <-s.done:
		case <-ctx.Done():
			err = errors.Join(err, ctx.Err())
		}
	})
	return err
}

func callerPeerID(r *http.Request) (peer.ID, error) {
	raw := r.RemoteAddr
	if pid, err := peer.Decode(raw); err == nil {
		return pid, nil
	}
	if host, _, err := net.SplitHostPort(raw); err == nil {
		if pid, err := peer.Decode(host); err == nil {
			return pid, nil
		}
	}
	return "", fmt.Errorf("p2phttp: invalid remote peer address %q", raw)
}

func (s *Server) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pid, err := callerPeerID(r)
		if err != nil {
			http.Error(w, "unauthenticated stream peer", http.StatusBadRequest)
			return
		}
		r = r.WithContext(WithPeerID(r.Context(), pid))
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				http.Error(w, "internal handler panic", http.StatusInternalServerError)
			}
		}()
		if !s.acquire(pid) {
			http.Error(w, "too many concurrent requests", http.StatusTooManyRequests)
			return
		}
		defer s.release(pid)
		if !s.opts.DisableRateLimit && !s.allow(pid) {
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		if r.ContentLength > s.opts.MaxBodyBytes {
			s.rejectOversized(w, r)
			return
		}
		body, readErr := io.ReadAll(http.MaxBytesReader(w, r.Body, s.opts.MaxBodyBytes))
		if readErr != nil {
			s.rejectOversized(w, r)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(w, r)
	})
}

// rejectOversized writes a small 413, flushes it and aborts the HTTP
// connection. Aborting is necessary over gostream: otherwise a peer still
// writing an oversized body can keep the stream open until its own deadline.
func (s *Server) rejectOversized(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Connection", "close")
	http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	if c, ok := r.Context().Value(connKey{}).(net.Conn); ok {
		_ = c.Close()
	}
}

func (s *Server) allow(pid peer.ID) bool {
	s.limMu.Lock()
	lim, ok := s.limits.Get(pid)
	if !ok {
		lim = rate.NewLimiter(rate.Limit(s.opts.PerPeerRate), s.opts.PerPeerBurst)
		s.limits.Add(pid, lim)
	}
	s.limMu.Unlock()
	return lim.Allow()
}

func (s *Server) acquire(pid peer.ID) bool {
	s.concMu.Lock()
	defer s.concMu.Unlock()
	if s.global >= s.opts.GlobalConcurrent || s.perPeer[pid] >= s.opts.PerPeerConcurrent {
		return false
	}
	s.global++
	s.perPeer[pid]++
	return true
}

func (s *Server) release(pid peer.ID) {
	s.concMu.Lock()
	if s.perPeer[pid] > 0 {
		s.perPeer[pid]--
		if s.perPeer[pid] == 0 {
			delete(s.perPeer, pid)
		}
	}
	if s.global > 0 {
		s.global--
	}
	s.concMu.Unlock()
}

// RateLimit wraps one route with the server's per-peer token bucket. The
// server wrapper already applies the per-peer/global concurrency limits.
func (s *Server) RateLimit(next http.Handler) http.Handler {
	if s == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pid, ok := PeerID(r.Context())
		if !ok {
			http.Error(w, "unauthenticated stream peer", http.StatusBadRequest)
			return
		}
		if !s.allow(pid) {
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Handler returns the wrapped handler for tests/diagnostics.
func (s *Server) Handler() http.Handler { return s.httpSrv.Handler }
