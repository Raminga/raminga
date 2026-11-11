package p2phttp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"

	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/libp2p/go-libp2p/p2p/net/gostream"
	"github.com/multiformats/go-multistream"
)

var (
	ErrResponseTooLarge = errors.New("p2phttp: response body exceeds limit")
	ErrNoDialFunc       = errors.New("p2phttp: no dial helper configured")
)

// ProtocolUnsupportedError reports that the remote multistream muxer does not
// offer the Raminga HTTP protocol. Wrapping keeps the original dial error
// available through errors.Is/errors.As.
type ProtocolUnsupportedError struct {
	Protocol protocol.ID
	Err      error
}

func (e *ProtocolUnsupportedError) Error() string {
	return fmt.Sprintf("对方不支持协议 %s，可能是版本不兼容，双方需升级到同一版本", e.Protocol)
}

func (e *ProtocolUnsupportedError) Unwrap() error { return e.Err }

// IsProtocolUnsupported detects multistream.ErrNotSupported through the
// net/http transport's *url.Error wrapping instead of matching error strings.
func IsProtocolUnsupported(err error) bool {
	var unsupported multistream.ErrNotSupported[protocol.ID]
	return errors.As(err, &unsupported)
}

// ProtocolMismatch converts an unsupported-protocol dial error into the
// user-facing version-incompatibility message and leaves other errors alone.
func ProtocolMismatch(err error, proto protocol.ID) error {
	if err == nil || !IsProtocolUnsupported(err) {
		return err
	}
	return &ProtocolUnsupportedError{Protocol: proto, Err: err}
}

type ClientOptions struct {
	MaxResponseHeaderBytes int64
	DefaultBodyLimit       int64
	Dial                   func(context.Context, peer.ID) error
}

func DefaultClientOptions() ClientOptions {
	return ClientOptions{MaxResponseHeaderBytes: 16 << 10, DefaultBodyLimit: 1 << 20}
}

type Client struct {
	host host.Host
	hc   *http.Client
	opts ClientOptions
}

type Result struct {
	Response *http.Response
	Limited  bool
}

func NewClient(h host.Host, opts ClientOptions) (*Client, error) {
	if h == nil {
		return nil, errors.New("p2phttp: host is required")
	}
	if opts.MaxResponseHeaderBytes <= 0 {
		opts.MaxResponseHeaderBytes = 16 << 10
	}
	if opts.DefaultBodyLimit <= 0 {
		opts.DefaultBodyLimit = 1 << 20
	}
	c := &Client{host: h, opts: opts}
	tr := &http.Transport{
		Proxy:                  nil,
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: opts.MaxResponseHeaderBytes,
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			host := addr
			if h, _, splitErr := net.SplitHostPort(addr); splitErr == nil {
				host = h
			}
			pid, err := peer.Decode(host)
			if err != nil {
				return nil, fmt.Errorf("p2phttp: invalid peer host %q: %w", addr, err)
			}
			ctx = network.WithAllowLimitedConn(ctx, "p2phttp")
			ctx = network.WithNoDial(ctx, "p2phttp")
			return gostream.Dial(ctx, h, pid, ProtocolID)
		},
	}
	c.hc = &http.Client{
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return c, nil
}

// SetDial installs the address-fallback helper used by DoWithDial.
func (c *Client) SetDial(dial func(context.Context, peer.ID) error) {
	if c != nil {
		c.opts.Dial = dial
	}
}

func (c *Client) Dial(ctx context.Context, pid peer.ID) error {
	if c.opts.Dial == nil {
		return ErrNoDialFunc
	}
	return c.opts.Dial(ctx, pid)
}

func (c *Client) Close() { c.hc.CloseIdleConnections() }

func (c *Client) Do(ctx context.Context, pid peer.ID, req *http.Request, maxBody int64) (*Result, error) {
	if req == nil {
		return nil, errors.New("p2phttp: request is required")
	}
	if maxBody <= 0 {
		maxBody = c.opts.DefaultBodyLimit
	}
	if req.URL == nil {
		return nil, errors.New("p2phttp: request URL is required")
	}
	if req.URL.Scheme == "" {
		req.URL.Scheme = "http"
	}
	if req.URL.Host == "" {
		req.URL.Host = pid.String()
	}
	if req.URL.Host != pid.String() {
		return nil, fmt.Errorf("p2phttp: URL host %q does not match peer %s", req.URL.Host, pid)
	}
	resp, err := c.hc.Do(req.WithContext(ctx))
	if err != nil {
		return nil, err
	}
	if resp.ContentLength > maxBody {
		_ = resp.Body.Close()
		return nil, ErrResponseTooLarge
	}
	resp.Body = &limitReadCloser{rc: resp.Body, limit: maxBody}
	limited := false
	for _, conn := range c.host.Network().ConnsToPeer(pid) {
		if conn.Stat().Limited {
			limited = true
			break
		}
	}
	return &Result{Response: resp, Limited: limited}, nil
}

func (c *Client) DoWithDial(ctx context.Context, pid peer.ID, req *http.Request, maxBody int64) (*Result, error) {
	if err := c.Dial(ctx, pid); err != nil {
		return nil, err
	}
	return c.Do(ctx, pid, req, maxBody)
}

type limitReadCloser struct {
	rc    io.ReadCloser
	limit int64
	read  int64
}

func (l *limitReadCloser) Read(p []byte) (int, error) {
	if l.read > l.limit {
		return 0, ErrResponseTooLarge
	}
	if l.read == l.limit {
		var one [1]byte
		n, err := l.rc.Read(one[:])
		if n > 0 {
			return 0, ErrResponseTooLarge
		}
		return 0, err
	}
	if int64(len(p)) > l.limit-l.read {
		p = p[:l.limit-l.read]
	}
	n, err := l.rc.Read(p)
	l.read += int64(n)
	return n, err
}
func (l *limitReadCloser) Close() error { return l.rc.Close() }
