// Command raminga-attacker is a TEST-ONLY malicious peer used by the G4
// acceptance suite. It speaks the real libp2p HTTP transport and is never
// built into the shipped raminga CLI.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/p2p/host/autorelay"
	"github.com/libp2p/go-libp2p/p2p/net/gostream"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/internal/p2phttp"
	"github.com/Raminga/raminga/internal/protocol"
)

type result struct {
	Mode      string   `json:"mode"`
	PeerID    string   `json:"peer_id,omitempty"`
	Multiaddr string   `json:"multiaddr,omitempty"`
	Acks      []ackOut `json:"acks,omitempty"`
	Events    []string `json:"events,omitempty"`
	Errors    []string `json:"errors,omitempty"`
	Sent      int      `json:"sent"`
	Accepted  int      `json:"accepted"`
	Rejected  int      `json:"rejected"`
	Closed    int      `json:"closed"`
	Open      int      `json:"open"`
	Started   int      `json:"started"`
}

type ackOut struct {
	MessageID string `json:"message_id"`
	Accepted  bool   `json:"accepted"`
	Error     string `json:"error,omitempty"`
	Sender    string `json:"sender,omitempty"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "attacker: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		mode      = flag.String("mode", "", "spoof|valid|duplicates|malformed|flood|slowloris|many|listen-ack|reserve")
		target    = flag.String("target", "", "target /p2p multiaddr")
		listen    = flag.String("listen", "", "listen multiaddr for listen-ack/reserve")
		identity  = flag.String("identity", "", "optional persisted identity file")
		ready     = flag.String("ready", "", "write ready JSON here (listen-ack)")
		ackMode   = flag.String("ack-mode", "wrong-id", "wrong-id|wrong-sender|valid")
		spoofPeer = flag.String("spoof-peer", "", "Peer ID to claim in sender_peer_id")
		msgID     = flag.String("msg-id", "g4-msg", "message ID")
		text      = flag.String("text", "g4 test message", "message text")
		count     = flag.Int("count", 1, "message/stream/host count")
		duration  = flag.Duration("duration", 5*time.Second, "hold/observation duration")
		relay     = flag.String("relay", "", "relay /p2p multiaddr for reserve mode")
		variant   = flag.String("variant", "", "optional malformed variant name")
	)
	flag.Parse()
	if *mode == "" {
		return errors.New("-mode is required")
	}
	switch *mode {
	case "listen-ack":
		return listenAck(*listen, *identity, *ready, *ackMode, *duration)
	case "reserve":
		return reserveFlood(*relay, *count, *duration)
	}
	info, err := peer.AddrInfoFromString(*target)
	if err != nil {
		return fmt.Errorf("parse target: %w", err)
	}
	if len(info.Addrs) == 0 {
		return errors.New("target needs an explicit multiaddr")
	}

	res := result{Mode: *mode}
	dispatch := map[string]func(host.Host, peer.ID) error{
		"spoof":      func(h host.Host, id peer.ID) error { return runSpoof(h, id, *spoofPeer, *count, *msgID, &res) },
		"valid":      func(h host.Host, id peer.ID) error { return runValid(h, id, *count, *msgID, *text, &res) },
		"duplicates": func(h host.Host, id peer.ID) error { return runDuplicates(h, id, *count, *msgID, &res) },
		"malformed":  func(h host.Host, id peer.ID) error { return runMalformed(h, id, *variant, &res) },
		"flood":      func(h host.Host, id peer.ID) error { return runFlood(h, id, *count, &res) },
		"slowloris":  func(h host.Host, id peer.ID) error { return runSlowloris(h, id, *count, *duration, &res) },
	}
	addrs := info.Addrs
	dispatch["many"] = func(_ host.Host, id peer.ID) error { return runMany(id, addrs, *count, &res) }
	fn, ok := dispatch[*mode]
	if !ok {
		return fmt.Errorf("unknown mode %q", *mode)
	}
	h, err := newHost(nil, "")
	if err != nil {
		return err
	}
	defer func() { _ = h.Close() }()
	res.PeerID = h.ID().String()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	if err := h.Connect(ctx, *info); err != nil {
		return fmt.Errorf("connect target: %w", err)
	}
	if err := fn(h, info.ID); err != nil {
		res.Errors = append(res.Errors, err.Error())
	}
	writeJSON(res)
	if len(res.Errors) > 0 {
		return errors.New("attacker mode reported errors")
	}
	return nil
}

func writeJSON(v any) { enc := json.NewEncoder(os.Stdout); enc.SetIndent("", "  "); _ = enc.Encode(v) }

func newHost(priv crypto.PrivKey, listen string) (host.Host, error) {
	var opts []libp2p.Option
	if priv != nil {
		opts = append(opts, libp2p.Identity(priv))
	}
	if listen == "" {
		opts = append(opts, libp2p.NoListenAddrs)
	} else {
		opts = append(opts, libp2p.ListenAddrStrings(listen))
	}
	return libp2p.New(opts...)
}

var clients sync.Map

func clientFor(h host.Host) (*p2phttp.Client, error) {
	if v, ok := clients.Load(h.ID()); ok {
		return v.(*p2phttp.Client), nil
	}
	cl, err := p2phttp.NewClient(h, p2phttp.ClientOptions{})
	if err != nil {
		return nil, err
	}
	clients.Store(h.ID(), cl)
	return cl, nil
}

func postAck(h host.Host, target peer.ID, body []byte, timeout time.Duration) (ackOut, int, error) {
	cl, err := clientFor(h)
	if err != nil {
		return ackOut{}, 0, err
	}
	req, err := http.NewRequest(http.MethodPost, "http://"+target.String()+protocol.ChatPath, bytes.NewReader(body))
	if err != nil {
		return ackOut{}, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	res, err := cl.Do(ctx, target, req, protocol.MaxResponseBytes)
	if err != nil {
		return ackOut{}, 0, err
	}
	defer func() { _ = res.Response.Body.Close() }()
	data, _ := io.ReadAll(io.LimitReader(res.Response.Body, protocol.MaxResponseBytes))
	if res.Response.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		msg := e.Error
		if msg == "" {
			msg = http.StatusText(res.Response.StatusCode)
		}
		return ackOut{Error: fmt.Sprintf("http %d: %s", res.Response.StatusCode, msg)}, res.Response.StatusCode, nil
	}
	var ack protocol.Ack
	if err := json.Unmarshal(data, &ack); err != nil {
		return ackOut{}, res.Response.StatusCode, err
	}
	return ackOut{MessageID: ack.MessageID, Accepted: ack.Accepted, Error: ack.Error, Sender: target.String()}, res.Response.StatusCode, nil
}

func bodyFor(claimed, messageID, text string) []byte {
	raw, _ := json.Marshal(protocol.Message{MessageID: messageID, SenderPeerID: claimed, SenderNodeID: "attacker-node", Text: text, SentAtUnixMs: time.Now().UnixMilli()})
	return raw
}

func record(res *result, ack ackOut) {
	res.Acks = append(res.Acks, ack)
	if ack.Accepted {
		res.Accepted++
	} else {
		res.Rejected++
	}
}

func runSpoof(h host.Host, target peer.ID, spoof string, count int, msgID string, res *result) error {
	for i := 0; i < count; i++ {
		res.Sent++
		ack, _, err := postAck(h, target, bodyFor(spoof, fmt.Sprintf("%s-%d", msgID, i), "spoofed sender"), 10*time.Second)
		if err != nil {
			res.Errors = append(res.Errors, err.Error())
			continue
		}
		record(res, ack)
	}
	return nil
}

func runValid(h host.Host, target peer.ID, count int, msgID, text string, res *result) error {
	for i := 0; i < count; i++ {
		res.Sent++
		ack, _, err := postAck(h, target, bodyFor(h.ID().String(), fmt.Sprintf("%s-%d", msgID, i), text), 10*time.Second)
		if err != nil {
			res.Errors = append(res.Errors, err.Error())
			continue
		}
		record(res, ack)
	}
	return nil
}

func runDuplicates(h host.Host, target peer.ID, count int, msgID string, res *result) error {
	for i := 0; i < count; i++ {
		res.Sent++
		ack, _, err := postAck(h, target, bodyFor(h.ID().String(), msgID, "duplicate payload"), 10*time.Second)
		if err != nil {
			res.Errors = append(res.Errors, err.Error())
			continue
		}
		record(res, ack)
	}
	return nil
}

func rawRequest(h host.Host, target peer.ID, payload string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	stream, err := gostream.Dial(ctx, h, target, p2phttp.ProtocolID)
	if err != nil {
		return "", err
	}
	defer func() { _ = stream.Close() }()
	_ = stream.SetDeadline(time.Now().Add(timeout))
	writeDone := make(chan error, 1)
	go func() { _, werr := io.WriteString(stream, payload); writeDone <- werr }()
	line, readErr := bufio.NewReader(stream).ReadString('\n')
	_ = stream.Close()
	select {
	case werr := <-writeDone:
		_ = werr
	case <-time.After(time.Second):
	}
	if readErr != nil {
		return "", readErr
	}
	return strings.TrimSpace(line), nil
}

func runMalformed(h host.Host, target peer.ID, only string, res *result) error {
	hostHdr := "Host: " + target.String() + "\r\n"
	longHdr := "X-Huge: " + strings.Repeat("H", 32<<10) + "\r\n"
	variants := []struct{ name, payload string }{
		{"bad-request-line", "BOGUS /chat HTTP/1.1\r\n" + hostHdr + "\r\n"},
		{"oversized-header", "POST /chat HTTP/1.1\r\n" + hostHdr + longHdr + "Content-Length: 0\r\n\r\n"},
		{"oversized-body", fmt.Sprintf("POST /chat HTTP/1.1\r\n%sContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", hostHdr, (1<<20)+1024, strings.Repeat("x", (1<<20)+1024))},
		{"truncated-body", "POST /chat HTTP/1.1\r\n" + hostHdr + "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"message_id\":"},
		{"broken-json", "POST /chat HTTP/1.1\r\n" + hostHdr + "Content-Type: application/json\r\nContent-Length: 12\r\n\r\n{\"message_id\""},
		{"wrong-content-type", "POST /chat HTTP/1.1\r\n" + hostHdr + "Content-Type: text/plain\r\nContent-Length: 2\r\n\r\n{}"},
		{"empty-body", "POST /chat HTTP/1.1\r\n" + hostHdr + "Content-Type: application/json\r\nContent-Length: 0\r\n\r\n"},
		{"unsupported-method", "PUT /chat HTTP/1.1\r\n" + hostHdr + "Content-Length: 0\r\n\r\n"},
		{"unknown-route", "POST /nope HTTP/1.1\r\n" + hostHdr + "Content-Length: 0\r\n\r\n"},
	}
	for _, v := range variants {
		if only != "" && v.name != only {
			continue
		}
		res.Sent++
		start := time.Now()
		timeout := 10 * time.Second
		if v.name == "oversized-body" {
			timeout = 5 * time.Second
		}
		line, err := rawRequest(h, target, v.payload, timeout)
		elapsed := time.Since(start)
		if err != nil {
			res.Events = append(res.Events, fmt.Sprintf("%s: closed/rejected in %s (%v)", v.name, elapsed.Round(time.Millisecond), err))
			res.Rejected++
			continue
		}
		if strings.Contains(line, " 200 ") {
			res.Events = append(res.Events, v.name+": malformed input was ACCEPTED")
			res.Errors = append(res.Errors, v.name+": accepted malformed input")
			continue
		}
		res.Events = append(res.Events, fmt.Sprintf("%s: closed/rejected in %s (%s)", v.name, elapsed.Round(time.Millisecond), line))
		res.Rejected++
	}
	return nil
}

func runFlood(h host.Host, target peer.ID, count int, res *result) error {
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	for i := 0; i < count; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			ack, _, err := postAck(h, target, bodyFor(h.ID().String(), fmt.Sprintf("flood-%d-%d", time.Now().UnixNano(), i), "flood"), 10*time.Second)
			mu.Lock()
			defer mu.Unlock()
			res.Sent++
			if err != nil {
				res.Errors = append(res.Errors, err.Error())
				return
			}
			record(res, ack)
		}(i)
	}
	wg.Wait()
	time.Sleep(3 * time.Second)
	ack, _, err := postAck(h, target, bodyFor(h.ID().String(), fmt.Sprintf("flood-cooldown-%d", time.Now().UnixNano()), "after cooldown"), 10*time.Second)
	if err != nil {
		res.Errors = append(res.Errors, "cooldown: "+err.Error())
		return nil
	}
	res.Sent++
	record(res, ack)
	return nil
}

func runSlowloris(h host.Host, target peer.ID, count int, duration time.Duration, res *result) error {
	ctx := context.Background()
	var all []net.Conn
	for i := 0; i < count; i++ {
		stream, err := gostream.Dial(ctx, h, target, p2phttp.ProtocolID)
		if err != nil {
			res.Errors = append(res.Errors, err.Error())
			continue
		}
		all = append(all, stream)
		res.Open++
		_, _ = io.WriteString(stream, "POST /chat HTTP/1.1\r\nHost: "+target.String()+"\r\n")
	}
	start := time.Now()
	var wg sync.WaitGroup
	for _, s := range all {
		wg.Add(1)
		go func(s net.Conn) {
			defer wg.Done()
			_ = s.SetReadDeadline(time.Now().Add(duration + 15*time.Second))
			_, err := s.Read(make([]byte, 1))
			_ = s.Close()
			if err != nil {
				res.Closed++
			}
		}(s)
	}
	wg.Wait()
	if elapsed := time.Since(start); elapsed > duration+15*time.Second {
		res.Errors = append(res.Errors, "slowloris streams were not closed by the server deadline")
	}
	return nil
}

func runMany(target peer.ID, addrs []ma.Multiaddr, count int, res *result) error {
	hosts := make([]host.Host, 0, count)
	for i := 0; i < count; i++ {
		h, err := newHost(nil, "")
		if err != nil {
			res.Errors = append(res.Errors, err.Error())
			continue
		}
		connected := false
		for attempt := 0; attempt < 3 && !connected; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := h.Connect(ctx, peer.AddrInfo{ID: target, Addrs: addrs}); err == nil {
				connected = true
			}
			cancel()
			if !connected {
				time.Sleep(300 * time.Millisecond)
			}
		}
		if !connected {
			res.Errors = append(res.Errors, fmt.Sprintf("host %d could not connect after 3 attempts", i))
			_ = h.Close()
			continue
		}
		hosts = append(hosts, h)
		res.Started++
		time.Sleep(150 * time.Millisecond)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, h := range hosts {
		wg.Add(1)
		go func(h host.Host) {
			defer wg.Done()
			defer func() { _ = h.Close() }()
			for j := 0; j < 20; j++ {
				ack, _, err := postAck(h, target, bodyFor(h.ID().String(), fmt.Sprintf("many-%d-%d-%d", time.Now().UnixNano(), len(hosts), j), "many peer flood"), 10*time.Second)
				mu.Lock()
				res.Sent++
				if err != nil {
					res.Errors = append(res.Errors, err.Error())
					mu.Unlock()
					continue
				}
				record(res, ack)
				mu.Unlock()
			}
		}(h)
	}
	wg.Wait()
	return nil
}

func listenAck(listen, identityPath, readyPath, ackMode string, duration time.Duration) error {
	if listen == "" {
		return errors.New("listen-ack requires -listen")
	}
	priv, err := loadOrCreateKey(identityPath)
	if err != nil {
		return err
	}
	h, err := newHost(priv, listen)
	if err != nil {
		return err
	}
	defer func() { _ = h.Close() }()
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+protocol.ChatPath, func(w http.ResponseWriter, r *http.Request) {
		var msg protocol.Message
		_ = json.NewDecoder(io.LimitReader(r.Body, protocol.DefaultMaxBodyBytes)).Decode(&msg)
		ack := protocol.Ack{MessageID: msg.MessageID, AckID: "forged-ack-id", Accepted: true, AckedAtUnixMs: time.Now().UnixMilli()}
		switch ackMode {
		case "wrong-id":
			ack.MessageID = "forged-wrong-message-id"
		case "wrong-sender":
			ack.AckID = ""
		case "valid":
		default:
			ack.MessageID = "forged-wrong-message-id"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ack)
	})
	srv, err := p2phttp.NewServer(h, mux, p2phttp.DefaultOptions())
	if err != nil {
		return err
	}
	if err := srv.Start(context.Background()); err != nil {
		return err
	}
	defer func() { _ = srv.Close(context.Background()) }()
	var addrs []string
	for _, a := range h.Addrs() {
		addrs = append(addrs, a.String()+"/p2p/"+h.ID().String())
	}
	payload := result{Mode: "listen-ack", PeerID: h.ID().String(), Multiaddr: first(addrs), Events: addrs}
	if readyPath != "" {
		raw, _ := json.MarshalIndent(payload, "", "  ")
		if err := os.WriteFile(readyPath, raw, 0o600); err != nil {
			return err
		}
	}
	writeJSON(payload)
	if duration == 0 {
		select {}
	}
	time.Sleep(duration)
	return nil
}

func first(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func loadOrCreateKey(path string) (crypto.PrivKey, error) {
	if path == "" {
		return nil, nil
	}
	if raw, err := os.ReadFile(path); err == nil {
		return crypto.UnmarshalPrivateKey(raw)
	}
	priv, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		return nil, err
	}
	raw, err := crypto.MarshalPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return nil, err
	}
	return priv, nil
}

func reserveFlood(relay string, count int, duration time.Duration) error {
	if relay == "" {
		return errors.New("reserve requires -relay")
	}
	info, err := peer.AddrInfoFromString(relay)
	if err != nil {
		return fmt.Errorf("parse relay: %w", err)
	}
	res := result{Mode: "reserve"}
	var hosts []host.Host
	for i := 0; i < count; i++ {
		h, err := libp2p.New(
			libp2p.NoListenAddrs,
			libp2p.ForceReachabilityPrivate(),
			libp2p.EnableRelay(),
			libp2p.EnableAutoRelayWithStaticRelays([]peer.AddrInfo{*info}, autorelay.WithBootDelay(0), autorelay.WithMinInterval(time.Second)),
		)
		if err != nil {
			res.Errors = append(res.Errors, err.Error())
			continue
		}
		hosts = append(hosts, h)
		res.Started++
	}
	time.Sleep(duration)
	for i, h := range hosts {
		reserved := false
		for _, a := range h.Addrs() {
			if containsCircuit(a.String()) {
				res.Events = append(res.Events, "reserved:"+a.String())
				reserved = true
			}
		}
		if !reserved {
			res.Events = append(res.Events, fmt.Sprintf("unreserved:host-%d", i))
		}
		_ = h.Close()
	}
	writeJSON(res)
	return nil
}

func containsCircuit(s string) bool {
	for i := 0; i+11 <= len(s); i++ {
		if s[i:i+11] == "p2p-circuit" {
			return true
		}
	}
	return false
}
