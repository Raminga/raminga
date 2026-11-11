package p2phttp_test

import (
	"bufio"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/p2p/net/gostream"
	relayv2client "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/client"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/internal/p2phttp"
)

func newHost(t *testing.T, listen bool, extra ...libp2p.Option) host.Host {
	t.Helper()
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	opts := []libp2p.Option{libp2p.Identity(key)}
	if listen {
		opts = append(opts, libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"))
	}
	opts = append(opts, extra...)
	h, err := libp2p.New(opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

func direct(t *testing.T, a, b host.Host) {
	t.Helper()
	if err := a.Connect(context.Background(), peer.AddrInfo{ID: b.ID(), Addrs: b.Addrs()}); err != nil {
		t.Fatal(err)
	}
}

func do(t *testing.T, c *p2phttp.Client, pid peer.ID, method, path string, body io.Reader, headers map[string]string, limit int64) (*p2phttp.Result, []byte, error) {
	t.Helper()
	req, err := http.NewRequest(method, "http://"+pid.String()+path, body)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.Do(context.Background(), pid, req, limit)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = res.Response.Body.Close() }()
	data, readErr := io.ReadAll(res.Response.Body)
	return res, data, readErr
}

func TestDirectGETPOSTIdentityAndRange(t *testing.T) {
	a := newHost(t, false)
	b := newHost(t, true)
	direct(t, a, b)
	var seen peer.ID
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	mux.HandleFunc("GET /who", func(w http.ResponseWriter, r *http.Request) {
		seen, _ = p2phttp.PeerID(r.Context())
		if r.Header.Get("X-Raminga-Peer-ID") == "spoof" {
			w.WriteHeader(599)
			return
		}
		_, _ = io.WriteString(w, seen.String())
	})
	mux.HandleFunc("POST /echo", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_, _ = w.Write(body)
	})
	mux.HandleFunc("GET /range", func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "x.txt", time.Unix(0, 0), strings.NewReader("0123456789"))
	})
	s, err := p2phttp.NewServer(b, mux, p2phttp.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close(context.Background()) })
	c, err := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	if err != nil {
		t.Fatal(err)
	}

	res, body, err := do(t, c, b.ID(), "GET", "/healthz", nil, nil, 1<<20)
	if err != nil || res.Response.StatusCode != 200 || string(body) != "ok" {
		t.Fatalf("health res=%v body=%q err=%v", res, body, err)
	}
	res, body, err = do(t, c, b.ID(), "GET", "/who", nil, map[string]string{"X-Raminga-Peer-ID": "spoofed"}, 1<<20)
	if err != nil || res.Response.StatusCode != 200 || string(body) != a.ID().String() {
		t.Fatalf("who body=%q err=%v", body, err)
	}
	if seen != a.ID() {
		t.Fatalf("handler peer=%s want %s", seen, a.ID())
	}
	_, body, err = do(t, c, b.ID(), "POST", "/echo", strings.NewReader("hello"), nil, 1<<20)
	if err != nil || string(body) != "hello" {
		t.Fatalf("echo body=%q err=%v", body, err)
	}
	res, body, err = do(t, c, b.ID(), "GET", "/range", nil, map[string]string{"Range": "bytes=2-4"}, 1<<20)
	if err != nil || res.Response.StatusCode != http.StatusPartialContent || string(body) != "234" {
		t.Fatalf("range status=%d body=%q err=%v", res.Response.StatusCode, body, err)
	}
	if res.Limited {
		t.Fatal("direct connection reported limited")
	}
}

func TestRelayedLimitedGETPOST(t *testing.T) {
	r := newHost(t, true, libp2p.EnableRelayService(), libp2p.ForceReachabilityPublic())
	cHost := newHost(t, true, libp2p.EnableRelay())
	a := newHost(t, false, libp2p.EnableRelay())
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	reservation, err := relayv2client.Reserve(ctx, cHost, peer.AddrInfo{ID: r.ID(), Addrs: r.Addrs()})
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	_ = reservation
	if len(r.Addrs()) == 0 {
		t.Fatal("relay has no addresses")
	}
	base := r.Addrs()[0].Encapsulate(ma.StringCast("/p2p/" + r.ID().String()))
	circuit := base.Encapsulate(ma.StringCast("/p2p-circuit/p2p/" + cHost.ID().String()))
	if err := a.Connect(network.WithAllowLimitedConn(ctx, "p2phttp-test"), peer.AddrInfo{ID: cHost.ID(), Addrs: []ma.Multiaddr{circuit}}); err != nil {
		t.Fatalf("circuit connect: %v", err)
	}
	conns := a.Network().ConnsToPeer(cHost.ID())
	if len(conns) == 0 || !conns[0].Stat().Limited {
		t.Fatalf("connection not limited: %+v", conns)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	mux.HandleFunc("POST /echo", func(w http.ResponseWriter, req *http.Request) { b, _ := io.ReadAll(req.Body); _, _ = w.Write(b) })
	s, err := p2phttp.NewServer(cHost, mux, p2phttp.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close(context.Background()) }()
	cl, err := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	if err != nil {
		t.Fatal(err)
	}
	res, body, err := do(t, cl, cHost.ID(), "GET", "/healthz", nil, nil, 1<<20)
	if err != nil || string(body) != "ok" || !res.Limited {
		t.Fatalf("relayed GET body=%q limited=%v err=%v", body, res != nil && res.Limited, err)
	}
	_, body, err = do(t, cl, cHost.ID(), "POST", "/echo", strings.NewReader("relay-body"), nil, 1<<20)
	if err != nil || string(body) != "relay-body" {
		t.Fatalf("relayed POST body=%q err=%v", body, err)
	}
}

func TestLimitsAndMalformed(t *testing.T) {
	a := newHost(t, false)
	b := newHost(t, true)
	direct(t, a, b)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	mux.HandleFunc("GET /panic", func(http.ResponseWriter, *http.Request) { panic("handler panic") })
	opts := p2phttp.DefaultOptions()
	opts.MaxBodyBytes = 16
	opts.MaxHeaderBytes = 1024
	s, err := p2phttp.NewServer(b, mux, opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close(context.Background()) }()
	c, _ := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	// Explicit body-limit request.
	req, _ := http.NewRequest("POST", "http://"+b.ID().String()+"/healthz", strings.NewReader(strings.Repeat("x", 100)))
	res, err := c.Do(context.Background(), b.ID(), req, 1<<20)
	if err != nil {
		t.Fatalf("oversized body transport: %v", err)
	}
	if res.Response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status=%d", res.Response.StatusCode)
	}
	_ = res.Response.Body.Close()
	// Unknown path.
	res2, body2, err := do(t, c, b.ID(), "GET", "/nope", nil, nil, 1<<20)
	if err != nil || res2.Response.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown status=%v body=%q err=%v", res2, body2, err)
	}
	// Oversized header: client may reject before sending; either is a rejection.
	req3, _ := http.NewRequest("GET", "http://"+b.ID().String()+"/healthz", nil)
	req3.Header.Set("X-Huge", strings.Repeat("H", 32<<10))
	if res3, err3 := c.Do(context.Background(), b.ID(), req3, 1<<20); err3 == nil {
		_ = res3.Response.Body.Close()
		if res3.Response.StatusCode < 400 {
			t.Fatalf("oversized header accepted: %d", res3.Response.StatusCode)
		}
	}
	// Panic must not kill the server.
	res4, _, err4 := do(t, c, b.ID(), "GET", "/panic", nil, nil, 1<<20)
	if err4 != nil || res4.Response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("panic status=%v err=%v", res4, err4)
	}
	if _, body5, err5 := do(t, c, b.ID(), "GET", "/healthz", nil, nil, 1<<20); err5 != nil || string(body5) != "ok" {
		t.Fatalf("health after panic body=%q err=%v", body5, err5)
	}
	// Malformed request on a raw stream; server must survive.
	stream, err := gostream.Dial(context.Background(), a, b.ID(), p2phttp.ProtocolID)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(stream, "BOGUS\r\n\r\n")
	_ = stream.Close()
	time.Sleep(50 * time.Millisecond)
	if _, body6, err6 := do(t, c, b.ID(), "GET", "/healthz", nil, nil, 1<<20); err6 != nil || string(body6) != "ok" {
		t.Fatalf("health after malformed body=%q err=%v", body6, err6)
	}
}

func TestSlowHeaderTimeout(t *testing.T) {
	a := newHost(t, false)
	b := newHost(t, true)
	direct(t, a, b)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	opts := p2phttp.DefaultOptions()
	opts.ReadHeaderTimeout = 100 * time.Millisecond
	s, err := p2phttp.NewServer(b, mux, opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close(context.Background()) }()
	stream, err := gostream.Dial(context.Background(), a, b.ID(), p2phttp.ProtocolID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	_, _ = io.WriteString(stream, "GET /healthz HTTP/1.1\r\nHost: "+b.ID().String()+"\r\n")
	_ = stream.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err = stream.Read(make([]byte, 1))
	if err == nil {
		t.Fatal("slow header was not cut off")
	}
	// A normal request still works.
	c, _ := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	if _, body, err := do(t, c, b.ID(), "GET", "/healthz", nil, nil, 1<<20); err != nil || string(body) != "ok" {
		t.Fatalf("health after slow header body=%q err=%v", body, err)
	}
}

func TestRateAndConcurrencyLimits(t *testing.T) {
	a := newHost(t, false)
	b := newHost(t, true)
	direct(t, a, b)
	mux := http.NewServeMux()
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	mux.HandleFunc("GET /block", func(w http.ResponseWriter, r *http.Request) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
		_, _ = io.WriteString(w, "done")
	})
	opts := p2phttp.DefaultOptions()
	opts.PerPeerRate = 1
	opts.PerPeerBurst = 1
	opts.PerPeerConcurrent = 1
	opts.GlobalConcurrent = 1
	s, err := p2phttp.NewServer(b, mux, opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close(context.Background()) }()
	c, _ := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	res, _, err := do(t, c, b.ID(), "GET", "/healthz", nil, nil, 1<<20)
	if err != nil || res.Response.StatusCode != 200 {
		t.Fatalf("first status=%v err=%v", res, err)
	}
	res, _, err = do(t, c, b.ID(), "GET", "/healthz", nil, nil, 1<<20)
	if err != nil || res.Response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("second status=%v err=%v", res, err)
	}
	// Wait for the token to refill, then hold a concurrent request.
	time.Sleep(1100 * time.Millisecond)
	done := make(chan struct{})
	go func() {
		req, _ := http.NewRequest("GET", "http://"+b.ID().String()+"/block", nil)
		if r, e := c.Do(context.Background(), b.ID(), req, 1<<20); e == nil {
			_ = r.Response.Body.Close()
		}
		close(done)
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked handler did not start")
	}
	res, _, err = do(t, c, b.ID(), "GET", "/healthz", nil, nil, 1<<20)
	if err != nil || res.Response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("concurrent status=%v err=%v", res, err)
	}
	close(release)
	<-done
}

func TestNoDialAndStopNoLeak(t *testing.T) {
	a := newHost(t, false)
	b := newHost(t, true)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	s, err := p2phttp.NewServer(b, mux, p2phttp.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	c, _ := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	req, _ := http.NewRequest("GET", "http://"+b.ID().String()+"/healthz", nil)
	if _, err := c.Do(context.Background(), b.ID(), req, 1<<20); err == nil {
		t.Fatal("no-dial client connected without a connection")
	}
	before := runtime.NumGoroutine()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	closeStart := time.Now()
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(closeStart); elapsed > 2*time.Second {
		t.Fatalf("server close exceeded bound: %s", elapsed)
	}
	time.Sleep(100 * time.Millisecond)
	after := runtime.NumGoroutine()
	if after > before+3 {
		t.Fatalf("goroutines before=%d after=%d", before, after)
	}
}

func TestOversizedResponse(t *testing.T) {
	a := newHost(t, false)
	b := newHost(t, true)
	direct(t, a, b)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /big", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, strings.Repeat("x", 100)) })
	s, _ := p2phttp.NewServer(b, mux, p2phttp.DefaultOptions())
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close(context.Background()) }()
	c, _ := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	_, _, err := do(t, c, b.ID(), "GET", "/big", nil, nil, 10)
	if !errors.Is(err, p2phttp.ErrResponseTooLarge) {
		t.Fatalf("oversized response err=%v", err)
	}
}

func TestRateLimitOtherPeerUnaffected(t *testing.T) {
	a := newHost(t, false)
	b := newHost(t, true)
	direct(t, a, b)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	opts := p2phttp.DefaultOptions()
	opts.PerPeerRate = 1
	opts.PerPeerBurst = 1
	s, _ := p2phttp.NewServer(b, mux, opts)
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close(context.Background()) }()
	ca, _ := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	if r, _, err := do(t, ca, b.ID(), "GET", "/healthz", nil, nil, 1<<20); err != nil || r.Response.StatusCode != 200 {
		t.Fatalf("A first: %v", err)
	}
	if r, _, err := do(t, ca, b.ID(), "GET", "/healthz", nil, nil, 1<<20); err != nil || r.Response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("A limited: %v", err)
	}
	cHost := newHost(t, false)
	direct(t, cHost, b)
	cc, _ := p2phttp.NewClient(cHost, p2phttp.DefaultClientOptions())
	if r, _, err := do(t, cc, b.ID(), "GET", "/healthz", nil, nil, 1<<20); err != nil || r.Response.StatusCode != 200 {
		t.Fatalf("C unaffected: %v", err)
	}
}

func TestGlobalConcurrencyLimit(t *testing.T) {
	a := newHost(t, false)
	cHost := newHost(t, false)
	b := newHost(t, true)
	direct(t, a, b)
	direct(t, cHost, b)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /block", func(w http.ResponseWriter, _ *http.Request) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
		_, _ = io.WriteString(w, "done")
	})
	opts := p2phttp.DefaultOptions()
	opts.PerPeerConcurrent = 2
	opts.GlobalConcurrent = 1
	s, _ := p2phttp.NewServer(b, mux, opts)
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close(context.Background()) }()
	ca, _ := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	cc, _ := p2phttp.NewClient(cHost, p2phttp.DefaultClientOptions())
	done := make(chan struct{})
	go func() {
		req, _ := http.NewRequest("GET", "http://"+b.ID().String()+"/block", nil)
		if r, e := ca.Do(context.Background(), b.ID(), req, 1<<20); e == nil {
			_ = r.Response.Body.Close()
		}
		close(done)
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked handler did not start")
	}
	req, _ := http.NewRequest("GET", "http://"+b.ID().String()+"/block", nil)
	if r, err := cc.Do(context.Background(), b.ID(), req, 1<<20); err != nil {
		t.Fatalf("global second transport: %v", err)
	} else {
		_ = r.Response.Body.Close()
		if r.Response.StatusCode != http.StatusTooManyRequests {
			t.Fatalf("global second status=%d", r.Response.StatusCode)
		}
	}
	close(release)
	<-done
}

func TestOversizedBodiesAreRejectedAndClosedOverLibp2p(t *testing.T) {
	a := newHost(t, false)
	b := newHost(t, true)
	direct(t, a, b)
	handlerCalls := 0
	mux := http.NewServeMux()
	mux.HandleFunc("POST /chat", func(w http.ResponseWriter, r *http.Request) {
		handlerCalls++
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	})
	opts := p2phttp.DefaultOptions()
	opts.MaxBodyBytes = 1024
	s, err := p2phttp.NewServer(b, mux, opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close(context.Background()) }()

	readResponse := func(stream net.Conn, timeout time.Duration) (int, error) {
		_ = stream.SetReadDeadline(time.Now().Add(timeout))
		req := &http.Request{Method: http.MethodPost}
		resp, err := http.ReadResponse(bufio.NewReader(stream), req)
		if err != nil {
			return 0, err
		}
		defer func() { _ = resp.Body.Close() }()
		return resp.StatusCode, nil
	}
	// Declared length over the limit: the server must not wait for the body.
	stream, err := gostream.Dial(context.Background(), a, b.ID(), p2phttp.ProtocolID)
	if err != nil {
		t.Fatal(err)
	}
	_ = stream.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.WriteString(stream, "POST /chat HTTP/1.1\r\nHost: "+b.ID().String()+"\r\nContent-Type: application/json\r\nContent-Length: 65536\r\n\r\n")
	start := time.Now()
	status, err := readResponse(stream, 2*time.Second)
	t.Logf("declared status=%d err=%v", status, err)
	if err != nil || status != http.StatusRequestEntityTooLarge {
		t.Fatalf("declared status=%d err=%v", status, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("declared rejection took %s", elapsed)
	}
	_ = stream.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := stream.Read(make([]byte, 1)); err == nil {
		t.Fatal("declared rejection left stream open")
	}
	_ = stream.Close()

	// Undeclared (chunked) body over the limit: write concurrently, read the
	// 413, and require the stream to close promptly.
	stream, err = gostream.Dial(context.Background(), a, b.ID(), p2phttp.ProtocolID)
	if err != nil {
		t.Fatal(err)
	}
	_ = stream.SetDeadline(time.Now().Add(3 * time.Second))
	body := strings.Repeat("x", 4096)
	_, _ = io.WriteString(stream, "POST /chat HTTP/1.1\r\nHost: "+b.ID().String()+"\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n")
	writeDone := make(chan struct{})
	go func() {
		defer close(writeDone)
		_, _ = io.WriteString(stream, "1000\r\n"+body[:0x1000]+"\r\n0\r\n\r\n")
	}()
	start = time.Now()
	status, err = readResponse(stream, 2*time.Second)
	if err != nil || status != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunked status=%d err=%v", status, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("chunked rejection took %s", elapsed)
	}
	_ = stream.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := stream.Read(make([]byte, 1)); err == nil {
		t.Fatal("chunked rejection left stream open")
	}
	_ = stream.Close()
	<-writeDone
	if handlerCalls != 0 {
		t.Fatalf("oversized request reached handler %d times", handlerCalls)
	}
}

func TestProtocolMismatchIsTypedAndActionable(t *testing.T) {
	a := newHost(t, false)
	b := newHost(t, true)
	direct(t, a, b)
	// b never registers the Raminga HTTP protocol.
	c, err := p2phttp.NewClient(a, p2phttp.DefaultClientOptions())
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodGet, "http://"+b.ID().String()+"/manifest", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Do(context.Background(), b.ID(), req, 1<<20)
	if err == nil {
		t.Fatal("request to a host without the protocol unexpectedly succeeded")
	}
	if !p2phttp.IsProtocolUnsupported(err) {
		t.Fatalf("typed detection failed: %v", err)
	}
	mismatch := p2phttp.ProtocolMismatch(err, p2phttp.ProtocolID)
	var typed *p2phttp.ProtocolUnsupportedError
	if !errors.As(mismatch, &typed) {
		t.Fatalf("ProtocolMismatch did not return typed error: %v", mismatch)
	}
	for _, want := range []string{"对方不支持协议 /raminga/http/1.0.0", "双方需升级到同一版本"} {
		if !strings.Contains(mismatch.Error(), want) {
			t.Fatalf("message %q missing %q", mismatch.Error(), want)
		}
	}
	if !errors.Is(mismatch, err) && typed.Unwrap() == nil {
		t.Fatal("underlying protocol error was not preserved")
	}
}
