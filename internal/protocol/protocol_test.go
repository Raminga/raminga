package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/libp2p/go-libp2p/core/peer"
)

func jsonReq(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, ChatPath, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestDecodeMessageStrictAndSenderIgnored(t *testing.T) {
	good := `{"message_id":"m1","sender_peer_id":"forged","sender_node_id":"forged-node","text":"hello","sent_at_unix_ms":123}`
	msg, err := DecodeMessage([]byte(good), 32)
	if err != nil {
		t.Fatal(err)
	}
	if msg.MessageID != "m1" || msg.Text != "hello" || msg.SentAtUnixMs != 123 {
		t.Fatalf("msg=%+v", msg)
	}
	if msg.SenderPeerID != "" || msg.SenderNodeID != "" {
		t.Fatal("sender payload was trusted")
	}
	bad := []string{
		`{"message_id":"m","text":"x","unknown":1}`,
		`{"message_id":"m","text":"x"} {}`,
		"{\"message_id\":\"m\",\"text\":\"\xff\"}",
		`{"message_id":"","text":"x"}`,
		`{"message_id":"m","text":"   "}`,
		`{"message_id":"m","text":"` + strings.Repeat("x", 33) + `"}`,
		`{"message_id":"m","text":"x","sent_at_unix_ms":"bad"}`,
	}
	for _, raw := range bad {
		if _, err := DecodeMessage([]byte(raw), 32); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
}

func TestHTTPHandlerContract(t *testing.T) {
	var calls atomic.Int64
	var failStatus atomic.Int64
	svc, err := New(Options{
		MaxBodyBytes: 128, MaxChatTextBytes: 4096,
		RatePerSecond: 1, RateBurst: 1,
		Handler: func(_ peer.ID, msg *Message) (bool, string, int) {
			calls.Add(1)
			switch failStatus.Load() {
			case http.StatusForbidden:
				return false, "denied", http.StatusForbidden
			case http.StatusServiceUnavailable:
				return false, "storage unavailable", http.StatusServiceUnavailable
			}
			if msg.Text == "deny" {
				return false, "denied", http.StatusForbidden
			}
			if msg.Text == "storage" {
				return false, "storage unavailable", http.StatusServiceUnavailable
			}
			return true, "", http.StatusOK
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	remote := peer.ID("peer-a")
	body := `{"message_id":"m1","sender_peer_id":"forged","text":"hello","sent_at_unix_ms":1}`
	rec := httptest.NewRecorder()
	svc.HandleHTTP(rec, jsonReq(body), remote)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body)
	}
	var ack Ack
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil {
		t.Fatal(err)
	}
	if ack.MessageID != "m1" || ack.AckID == "" || !ack.Accepted {
		t.Fatalf("ack=%+v", ack)
	}
	// Duplicate returns 200 without a second handler call, even after rate refill.
	rec = httptest.NewRecorder()
	svc.HandleHTTP(rec, jsonReq(body), remote)
	if rec.Code != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("duplicate status=%d calls=%d", rec.Code, calls.Load())
	}
	// A second unique message exhausts burst=1.
	rec = httptest.NewRecorder()
	svc.HandleHTTP(rec, jsonReq(`{"message_id":"m2","text":"second"}`), remote)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("rate status=%d", rec.Code)
	}
	// Malformed variants.
	for _, req := range []*http.Request{
		jsonReq(`{"message_id":"m3","text":"x","extra":1}`),
		jsonReq(`{"message_id":"m3","text":"x"} garbage`),
		func() *http.Request { r := jsonReq(`{}`); r.Header.Set("Content-Type", "text/plain"); return r }(),
	} {
		rec = httptest.NewRecorder()
		svc.HandleHTTP(rec, req, remote)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("malformed status=%d body=%s", rec.Code, rec.Body)
		}
	}
	// Policy and storage status mapping.
	for _, tc := range []struct {
		text string
		want int
	}{{"deny", http.StatusForbidden}, {"storage", http.StatusServiceUnavailable}} {
		// Refill by using a fresh peer for each status.
		remote2 := peer.ID("peer-" + tc.text)
		rec = httptest.NewRecorder()
		svc.HandleHTTP(rec, jsonReq(`{"message_id":"m-`+tc.text+`","text":"`+tc.text+`"}`), remote2)
		if rec.Code != tc.want {
			t.Fatalf("%s status=%d", tc.text, rec.Code)
		}
	}
	// Oversized body and empty body.
	rec = httptest.NewRecorder()
	svc.HandleHTTP(rec, jsonReq(`{"message_id":"big","text":"`+strings.Repeat("x", 200)+`"}`), peer.ID("peer-b"))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("body status=%d", rec.Code)
	}
	rec = httptest.NewRecorder()
	svc.HandleHTTP(rec, jsonReq(""), peer.ID("peer-c"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty status=%d", rec.Code)
	}
	_ = context.Background()
}

func TestDecodeAck(t *testing.T) {
	good := `{"message_id":"m1","ack_id":"a1","accepted":true,"acked_at_unix_ms":2}`
	ack, err := DecodeAck([]byte(good), "m1")
	if err != nil || ack.AckID != "a1" {
		t.Fatalf("ack=%+v err=%v", ack, err)
	}
	for _, raw := range []string{
		`{"message_id":"other","ack_id":"a1","accepted":true}`,
		`{"message_id":"m1","ack_id":"","accepted":true}`,
		`{"message_id":"m1","ack_id":"a1","accepted":false}`,
		`{"message_id":"m1","ack_id":"a1","accepted":true} {}`,
	} {
		if _, err := DecodeAck([]byte(raw), "m1"); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
}

type vectorFile struct {
	Protocol string `json:"protocol"`
	Path     string `json:"path"`
	Request  struct {
		AuthenticatedPeerID string          `json:"authenticated_peer_id"`
		Body                json.RawMessage `json:"body"`
		ExpectedMessageID   string          `json:"expected_message_id"`
	} `json:"request"`
	Response struct {
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	} `json:"response"`
}

func TestHTTPContractVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "spec", "chat-http-v1-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if v.Protocol != HTTPProtocol || v.Path != ChatPath {
		t.Fatalf("header=%+v", v)
	}
	msg, err := DecodeMessage(v.Request.Body, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if msg.MessageID != v.Request.ExpectedMessageID {
		t.Fatalf("message_id=%q", msg.MessageID)
	}
	if msg.SenderPeerID != "" {
		t.Fatal("vector sender claim was trusted")
	}
	var ack Ack
	if err := json.Unmarshal(v.Response.Body, &ack); err != nil {
		t.Fatal(err)
	}
	if v.Response.Status != 200 || ack.MessageID != msg.MessageID || ack.AckID == "" || !ack.Accepted {
		t.Fatalf("response=%+v ack=%+v", v.Response, ack)
	}
	if _, err := DecodeAck(v.Response.Body, msg.MessageID); err != nil {
		t.Fatal(err)
	}
}

func FuzzDecodeChatRequest(f *testing.F) {
	for _, seed := range []string{
		`{"message_id":"m1","text":"hello"}`,
		`{"message_id":"m1","text":"x","sender_peer_id":"forged"}`,
		`{"message_id":"","text":""}`,
		`not-json`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		msg, err := DecodeMessage(data, 4096)
		if err == nil && msg == nil {
			t.Fatal("nil message without error")
		}
		if err == nil {
			if err := ValidateMessage(msg, 4096); err != nil {
				t.Fatalf("decoded message invalid: %v", err)
			}
			if msg.SenderPeerID != "" || msg.SenderNodeID != "" {
				t.Fatal("sender claim retained")
			}
		}
		svc, newErr := New(Options{Handler: func(peer.ID, *Message) (bool, string, int) { return true, "", http.StatusOK }})
		if newErr != nil {
			t.Fatal(newErr)
		}
		req := httptest.NewRequest(http.MethodPost, ChatPath, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		svc.HandleHTTP(rec, req, peer.ID("fuzz-peer"))
		if rec.Code == http.StatusOK {
			if _, ackErr := DecodeAck(rec.Body.Bytes(), ""); ackErr != nil {
				t.Fatalf("200 without valid ACK: %v", ackErr)
			}
		}
	})
}

func TestStatusErrorPermanentMapping(t *testing.T) {
	for _, tc := range []struct {
		status    int
		permanent bool
	}{
		{400, true}, {403, true}, {413, true}, {429, false}, {503, false}, {500, false},
	} {
		e := &StatusError{Status: tc.status, Reason: "x"}
		if e.Permanent() != tc.permanent {
			t.Fatalf("status %d permanent=%v want %v", tc.status, e.Permanent(), tc.permanent)
		}
		if !strings.Contains(e.Error(), "http ") {
			t.Fatalf("error %q", e.Error())
		}
	}
}
