package main

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

func (r *runner) outbox(service string) (*apiv1.OutboxListResponse, error) {
	out, code := r.exec(service, "raminga", "chat", "outbox", "--data-dir", "/data", "--limit", "500", "--json")
	if code != 0 {
		return nil, fmt.Errorf("outbox %s: %s", service, out)
	}
	var res apiv1.OutboxListResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("parse outbox %s: %w", service, err)
	}
	return &res, nil
}

func (r *runner) findOutbox(service, textPrefix string) (*apiv1.OutboxEntry, error) {
	res, err := r.outbox(service)
	if err != nil {
		return nil, err
	}
	for _, e := range res.GetEntries() {
		if strings.Contains(e.GetText(), textPrefix) {
			return e, nil
		}
	}
	return nil, fmt.Errorf("outbox entry with text %q not found", textPrefix)
}

func (r *runner) waitOutboxStatus(service, messageID, want string, timeout time.Duration) (*apiv1.OutboxEntry, error) {
	deadline := time.Now().Add(timeout)
	var last *apiv1.OutboxEntry
	for time.Now().Before(deadline) {
		res, err := r.outbox(service)
		if err == nil {
			for _, e := range res.GetEntries() {
				if e.GetMessageId() == messageID {
					last = e
					if e.GetStatus() == want {
						return e, nil
					}
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	if last == nil {
		return nil, fmt.Errorf("outbox entry %s not found while waiting for %s", messageID, want)
	}
	return last, fmt.Errorf("outbox entry %s is %s, want %s within %s", messageID, last.GetStatus(), want, timeout)
}

func (r *runner) scenarioOutboxUnit() (string, error) {
	c := &checker{r: r}
	out, code := r.command("host", nil, "go", "test", "./internal/storage", "./internal/node",
		"-run", "Outbox|RetryDelay|DuplicateInbound", "-count=1")
	c.check("outbox unit tests pass", code == 0, strings.TrimSpace(lastLines(out, 4)))
	return "go test ./internal/storage ./internal/node -run Outbox|RetryDelay|DuplicateInbound", c.err()
}

func (r *runner) scenarioOutboxDownUp() (string, error) {
	c := &checker{r: r}
	if out, code := r.compose("stop", "late"); code != 0 {
		return "", fmt.Errorf("stop late: %s", out)
	}
	defer func() {
		_, _ = r.compose("start", "late")
		_ = r.waitReady("late", 60*time.Second)
	}()
	prefix := fmt.Sprintf("g4-outbox-up-%d", time.Now().UnixNano())
	start := time.Now()
	send, err := r.chatSend("victim-open", "late", prefix)
	if err != nil {
		return "", err
	}
	c.check("send to stopped peer is not ACKed", !send.GetAcked(), fmt.Sprintf("acked=%t error=%q", send.GetAcked(), send.GetError()))
	c.check("send reports pending outbox", send.GetOutboxStatus() == "pending", send.GetOutboxStatus())
	entry, err := r.findOutbox("victim-open", prefix)
	if err != nil {
		return "", err
	}
	c.check("outbox entry is pending while peer is down", entry.GetStatus() == "pending", entry.GetStatus())
	if _, code := r.compose("start", "late"); code != 0 {
		return "", errors.New("start late failed")
	}
	if err := r.waitReady("late", 60*time.Second); err != nil {
		return "", err
	}
	acked, err := r.waitOutboxStatus("victim-open", entry.GetMessageId(), "acked", 30*time.Second)
	if err != nil {
		return "", err
	}
	elapsed := time.Since(start)
	c.check("auto-resend gets a real ACK within 30s", acked.GetStatus() == "acked" && elapsed <= 30*time.Second,
		fmt.Sprintf("status=%s elapsed=%s attempts=%d", acked.GetStatus(), elapsed, acked.GetAttempts()))
	rows, _ := r.rows("late", "", prefix)
	c.check("receiver stores exactly one row", rows == 1, fmt.Sprintf("rows=%d", rows))
	return fmt.Sprintf("delivered=%s attempts=%d", elapsed, acked.GetAttempts()), c.err()
}

func (r *runner) scenarioOutboxExpiry() (string, error) {
	c := &checker{r: r}
	if out, code := r.compose("stop", "late"); code != 0 {
		return "", fmt.Errorf("stop late: %s", out)
	}
	defer func() {
		_, _ = r.compose("start", "late")
		_ = r.waitReady("late", 60*time.Second)
	}()
	prefix := fmt.Sprintf("g4-outbox-exp-%d", time.Now().UnixNano())
	send, err := r.chatSend("expiry", "late", prefix)
	if err != nil {
		return "", err
	}
	c.check("send to stopped peer is not ACKed", !send.GetAcked(), fmt.Sprintf("acked=%t", send.GetAcked()))
	entry, err := r.findOutbox("expiry", prefix)
	if err != nil {
		return "", err
	}
	time.Sleep(10 * time.Second)
	failed, err := r.waitOutboxStatus("expiry", entry.GetMessageId(), "failed", 5*time.Second)
	if err != nil {
		return "", err
	}
	c.check("expired entry is failed with expiry reason", strings.Contains(failed.GetLastError(), "expired"),
		failed.GetLastError())
	h, err := r.history("expiry")
	if err != nil {
		return "", err
	}
	unacked := false
	for _, m := range h.GetMessages() {
		if strings.Contains(m.GetText(), prefix) && !m.GetAcked() {
			unacked = true
		}
	}
	c.check("expired message row remains acked=0", unacked, "history checked")
	if _, code := r.compose("start", "late"); code != 0 {
		return "", errors.New("start late failed")
	}
	if err := r.waitReady("late", 60*time.Second); err != nil {
		return "", err
	}
	time.Sleep(5 * time.Second)
	rows, _ := r.rows("late", "", prefix)
	c.check("expired entry is never delivered", rows == 0, fmt.Sprintf("rows=%d", rows))
	return fmt.Sprintf("expired=%s", failed.GetMessageId()), c.err()
}
