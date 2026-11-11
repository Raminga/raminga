// Package protocol owns the cross-node chat contract: strict JSON over the
// Raminga HTTP-over-libp2p transport. The authenticated stream Peer ID is the
// only sender identity; payload sender fields are accepted but ignored.
package protocol

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/hashicorp/golang-lru/v2/expirable"
	"github.com/libp2p/go-libp2p/core/peer"
	"golang.org/x/time/rate"
)

const (
	// HTTPProtocol is the libp2p protocol carrying net/http streams.
	HTTPProtocol = "/raminga/http/1.0.0"
	// ChatPath is the chat route on HTTPProtocol.
	ChatPath = "/chat"

	// DefaultMaxBodyBytes bounds one JSON request body. It is deliberately
	// smaller than the generic p2phttp 1 MiB default.
	DefaultMaxBodyBytes = 64 << 10
	// DefaultMaxChatTextBytes bounds UTF-8 chat text.
	DefaultMaxChatTextBytes = 4096
	// DefaultDedupeTTL is how long an accepted message ID is remembered.
	DefaultDedupeTTL = 10 * time.Minute
	// DefaultDedupeSize bounds the dedupe cache.
	DefaultDedupeSize = 4096
	// DefaultSendTimeout bounds one HTTP request/response.
	DefaultSendTimeout = 20 * time.Second
	// DefaultRatePerSecond is the per-peer inbound chat rate.
	DefaultRatePerSecond = 5
	// DefaultRateBurst is the per-peer inbound chat burst.
	DefaultRateBurst = 10
	// DefaultRateTrackedPeers bounds the per-peer limiter cache.
	DefaultRateTrackedPeers = 1024
	// MaxMessageIDBytes bounds the client-supplied message ID.
	MaxMessageIDBytes = 128
	// MaxResponseBytes bounds an ACK response.
	MaxResponseBytes = 16 << 10
)

// ErrTooLarge reports a request body larger than the configured limit.
var ErrTooLarge = errors.New("protocol: request body exceeds configured maximum size")

// Message is the JSON request body. SenderPeerID/SenderNodeID are accepted for
// old-payload compatibility but are never used as identity.
type Message struct {
	MessageID    string `json:"message_id"`
	SenderPeerID string `json:"sender_peer_id,omitempty"`
	SenderNodeID string `json:"sender_node_id,omitempty"`
	Text         string `json:"text"`
	SentAtUnixMs int64  `json:"sent_at_unix_ms"`
}

// Ack is the JSON response for a durably stored (or deduplicated) message.
type Ack struct {
	MessageID     string `json:"message_id"`
	AckID         string `json:"ack_id"`
	Accepted      bool   `json:"accepted"`
	Error         string `json:"error,omitempty"`
	AckedAtUnixMs int64  `json:"acked_at_unix_ms"`
}

// Handler processes an inbound message. remote is authenticated by the
// transport. status is 200 for accepted, or an HTTP error status.
type Handler func(remote peer.ID, msg *Message) (accepted bool, reason string, status int)

type Options struct {
	MaxBodyBytes     int
	MaxChatTextBytes int
	DedupeTTL        time.Duration
	DedupeSize       int
	RatePerSecond    float64
	RateBurst        int
	RateTrackedPeers int
	Handler          Handler
	Logger           *slog.Logger
}

type Service struct {
	maxBodyBytes     int
	maxChatTextBytes int
	dedupe           *expirable.LRU[string, struct{}]
	limiters         *expirable.LRU[string, *rate.Limiter]
	ratePerSecond    float64
	rateBurst        int
	handler          Handler
	logger           *slog.Logger
}

func New(opts Options) (*Service, error) {
	if opts.Handler == nil {
		return nil, errors.New("protocol: message handler is required")
	}
	if opts.MaxBodyBytes <= 0 {
		opts.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if opts.MaxChatTextBytes <= 0 {
		opts.MaxChatTextBytes = DefaultMaxChatTextBytes
	}
	if opts.DedupeTTL <= 0 {
		opts.DedupeTTL = DefaultDedupeTTL
	}
	if opts.DedupeSize <= 0 {
		opts.DedupeSize = DefaultDedupeSize
	}
	if opts.RatePerSecond <= 0 {
		opts.RatePerSecond = DefaultRatePerSecond
	}
	if opts.RateBurst <= 0 {
		opts.RateBurst = DefaultRateBurst
	}
	if opts.RateTrackedPeers <= 0 {
		opts.RateTrackedPeers = DefaultRateTrackedPeers
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		maxBodyBytes:     opts.MaxBodyBytes,
		maxChatTextBytes: opts.MaxChatTextBytes,
		dedupe:           expirable.NewLRU[string, struct{}](opts.DedupeSize, nil, opts.DedupeTTL),
		limiters:         expirable.NewLRU[string, *rate.Limiter](opts.RateTrackedPeers, nil, opts.DedupeTTL),
		ratePerSecond:    opts.RatePerSecond,
		rateBurst:        opts.RateBurst,
		handler:          opts.Handler,
		logger:           logger,
	}, nil
}

// DecodeMessage strictly decodes one JSON request. Unknown fields, trailing
// JSON values, invalid UTF-8 and oversized text are rejected.
func DecodeMessage(data []byte, maxTextBytes int) (*Message, error) {
	if !utf8.Valid(data) {
		return nil, errors.New("protocol: body must be valid UTF-8")
	}
	if maxTextBytes <= 0 {
		maxTextBytes = DefaultMaxChatTextBytes
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var msg Message
	if err := dec.Decode(&msg); err != nil {
		return nil, fmt.Errorf("protocol: malformed JSON: %w", err)
	}
	var extra struct{}
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, errors.New("protocol: trailing data after JSON body")
	}
	if err := ValidateMessage(&msg, maxTextBytes); err != nil {
		return nil, err
	}
	// Sender fields are accepted but deliberately discarded.
	msg.SenderPeerID = ""
	msg.SenderNodeID = ""
	return &msg, nil
}

func ValidateMessage(m *Message, maxTextBytes int) error {
	if m == nil {
		return errors.New("protocol: missing chat message")
	}
	if m.MessageID == "" || len(m.MessageID) > MaxMessageIDBytes {
		return fmt.Errorf("protocol: message_id must be 1..%d bytes", MaxMessageIDBytes)
	}
	if maxTextBytes <= 0 {
		maxTextBytes = DefaultMaxChatTextBytes
	}
	if len(m.Text) > maxTextBytes {
		return fmt.Errorf("protocol: text is %d bytes, max %d", len(m.Text), maxTextBytes)
	}
	if strings.TrimSpace(m.Text) == "" {
		return errors.New("protocol: text must not be empty")
	}
	if !utf8.ValidString(m.Text) {
		return errors.New("protocol: text must be valid UTF-8")
	}
	return nil
}

func (s *Service) HandleHTTP(w http.ResponseWriter, r *http.Request, remote peer.ID) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusBadRequest)
		return
	}
	if r.ContentLength > int64(s.maxBodyBytes) {
		writeError(w, http.StatusRequestEntityTooLarge)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, int64(s.maxBodyBytes)))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge)
		return
	}
	msg, err := DecodeMessage(body, s.maxChatTextBytes)
	if err != nil {
		s.logger.Debug("chat HTTP request rejected", "peer_id", remote.String(), "error", err)
		writeError(w, http.StatusBadRequest)
		return
	}
	key := remote.String() + "\x00" + msg.MessageID
	if s.dedupe.Contains(key) {
		s.logger.Debug("duplicate chat message suppressed", "peer_id", remote.String(), "message_id", msg.MessageID)
		writeAck(w, msg.MessageID)
		return
	}
	if !s.allow(remote) {
		writeError(w, http.StatusTooManyRequests)
		return
	}
	accepted, reason, status := s.handler(remote, msg)
	if accepted {
		s.dedupe.Add(key, struct{}{})
		writeAck(w, msg.MessageID)
		return
	}
	if status == 0 {
		status = http.StatusForbidden
	}
	if status == http.StatusOK {
		status = http.StatusForbidden
	}
	s.logger.Warn("chat HTTP request rejected", "peer_id", remote.String(), "message_id", msg.MessageID, "status", status, "reason", reason)
	writeError(w, status, reason)
}

func (s *Service) allow(remote peer.ID) bool {
	key := remote.String()
	limiter, ok := s.limiters.Get(key)
	if !ok {
		limiter = rate.NewLimiter(rate.Limit(s.ratePerSecond), s.rateBurst)
		s.limiters.Add(key, limiter)
	}
	return limiter.Allow()
}

func writeAck(w http.ResponseWriter, messageID string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(Ack{MessageID: messageID, AckID: NewMessageID(), Accepted: true, AckedAtUnixMs: time.Now().UnixMilli()})
}

func writeError(w http.ResponseWriter, status int, reason ...string) {
	msg := http.StatusText(status)
	if len(reason) > 0 && strings.TrimSpace(reason[0]) != "" {
		msg = reason[0]
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Error string `json:"error"`
	}{Error: msg})
}

// DecodeAck strictly decodes and validates an ACK response.
func DecodeAck(data []byte, wantMessageID string) (*Ack, error) {
	if !utf8.Valid(data) {
		return nil, errors.New("protocol: ACK body must be valid UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var ack Ack
	if err := dec.Decode(&ack); err != nil {
		return nil, fmt.Errorf("protocol: malformed ACK: %w", err)
	}
	var extra struct{}
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, errors.New("protocol: trailing data after ACK")
	}
	if ack.MessageID == "" || ack.AckID == "" {
		return nil, errors.New("protocol: ACK missing message_id or ack_id")
	}
	if wantMessageID != "" && ack.MessageID != wantMessageID {
		return nil, fmt.Errorf("protocol: ACK message_id %q does not match %q", ack.MessageID, wantMessageID)
	}
	if !ack.Accepted {
		return nil, fmt.Errorf("protocol: ACK rejected: %s", ack.Error)
	}
	return &ack, nil
}

// NewMessageID returns a random 128-bit hex identifier.
func NewMessageID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("protocol: crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(b[:])
}

// StatusError reports a non-200 HTTP chat response. It is never delivered.
type StatusError struct {
	Status int
	Reason string
}

func (e *StatusError) Error() string {
	if e.Reason != "" {
		return fmt.Sprintf("http %d: %s", e.Status, e.Reason)
	}
	return fmt.Sprintf("http %d", e.Status)
}

// Permanent reports whether retrying this status cannot help.
func (e *StatusError) Permanent() bool {
	return e.Status == http.StatusBadRequest || e.Status == http.StatusRequestEntityTooLarge || e.Status == http.StatusForbidden
}
