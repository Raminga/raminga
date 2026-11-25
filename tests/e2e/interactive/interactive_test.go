// Package interactive runs the real TUI binary under a pty against two real
// local daemons. It exercises the interactive key path (not --script/--pipe):
// connect -> switch views -> chat -> ACK -> report -> q.
package interactive

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/report"
	"github.com/Raminga/raminga/tests/e2e/tuipty"
)

func TestInteractiveTUI(t *testing.T) {
	if os.Getenv("RAMINGA_INTERACTIVE_TUI") != "1" {
		t.Skip("set RAMINGA_INTERACTIVE_TUI=1 (or run make interactive-tui-test)")
	}
	root := repoRoot(t)
	bin := os.Getenv("RAMINGA_TEST_BINARY")
	if bin == "" {
		bin = filepath.Join(t.TempDir(), "raminga")
		build := exec.Command("go", "build", "-o", bin, "./cmd/raminga")
		build.Dir = root
		build.Env = os.Environ()
		if out, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build raminga: %v\n%s", err, out)
		}
	}
	base, err := os.MkdirTemp("/tmp", "rg45-")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(base) }()
	aDir := filepath.Join(base, "a")
	bDir := filepath.Join(base, "b")
	aPort, bPort := freePort(t), freePort(t)
	// Announce addresses that are distinct from the local test connection.
	const hostLabel = "inline-long-address."
	const lanIP = "192.168.250.42"
	longAnnounce := "/dns4/" + strings.Repeat(hostLabel, 6) + "example.test/tcp/4001"
	lanAnnounce := "/ip4/" + lanIP + "/tcp/4001"
	runInit(t, bin, aDir, aPort, longAnnounce, lanAnnounce)
	runInit(t, bin, bDir, bPort)
	a, aLog := startDaemon(t, bin, aDir)
	defer stopDaemon(t, a, aLog)
	b, bLog := startDaemon(t, bin, bDir)
	defer stopDaemon(t, b, bLog)
	aStatus := waitStatus(t, aDir)
	bStatus := waitStatus(t, bDir)
	bAddr := fmt.Sprintf("/ip4/127.0.0.1/tcp/%d/p2p/%s", bPort, bStatus.GetPeerId())
	for _, addr := range []string{longAnnounce, lanAnnounce} {
		if !slices.Contains(aStatus.GetAdvertisedAddrs(), addr) {
			t.Fatalf("daemon did not advertise %q: %v", addr, aStatus.GetAdvertisedAddrs())
		}
	}

	sess, err := tuipty.Start(bin, aDir)
	if err != nil {
		t.Fatalf("start interactive TUI: %v", err)
	}
	defer sess.Close()
	start := time.Now()
	if err := sess.WaitFor("Raminga", 3*time.Second); err != nil {
		t.Fatalf("startup did not render status bar within 3s (terminal probe?): %v", err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("startup took %s", elapsed)
	}
	if raw := sess.RawOutput(); strings.Contains(raw, "\x1b]11;?") || strings.Contains(raw, "\x1b[6n") {
		t.Fatalf("TUI issued the blocking terminal status probe before rendering: %q", raw)
	}

	// Check the status output before typing a multiaddr into the input field.
	statusMark := sess.Mark()
	for attempt := 0; ; attempt++ {
		if err := sess.SendLine("/status"); err != nil {
			t.Fatal(err)
		}
		err := sess.WaitForSince("可用连接方式：局域网直连", statusMark, time.Second)
		if err == nil {
			break
		}
		if attempt == 9 {
			t.Fatal(err)
		}
	}
	// Wait for the next command's output so the entire status response is captured.
	copyMark := sess.Mark()
	if err := sess.SendLine("/copy"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForSince("已发送到剪贴板（终端需支持 OSC52）："+aStatus.GetPeerId(), copyMark, 3*time.Second); err != nil {
		t.Fatal(err)
	}
	statusOutput := sess.OutputSince(statusMark)
	if !strings.Contains(statusOutput, "本机："+aStatus.GetPeerId()) {
		t.Fatalf("status did not show the full Raminga ID:\n%s", statusOutput)
	}
	for _, hidden := range []string{hostLabel, "example.test", lanIP, "/dns4/", "/ip4/", "/ip6/"} {
		if strings.Contains(statusOutput, hidden) {
			t.Fatalf("status or copy output disclosed %q:\n%s", hidden, statusOutput)
		}
	}
	t.Log("80-column PTY showed the Raminga ID and LAN connection mode while hiding the announced addresses")

	// Type like a user: character by character, with the completion popup open,
	// then a single plain Enter that accepts the argument and submits.
	if err := sess.Type("/connect " + bAddr); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := sess.Send("\r"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitFor("已连接", 20*time.Second); err != nil {
		t.Fatalf("connect result not shown: %v", err)
	}
	if err := sess.Type("/chat " + bStatus.GetPeerId()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := sess.Send("\r"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitFor("当前聊天对象", 3*time.Second); err != nil {
		t.Fatalf("chat target not selected: %v", err)
	}
	if err := sess.Type("interactive pty hello"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	mark := sess.Mark()
	if err := sess.Send("\r"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForSince("interactive pty hello ✓", mark, 15*time.Second); err != nil {
		t.Fatalf("chat ACK not shown on one line: %v", err)
	}
	if err := sess.Type("/report"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := sess.Send("\r"); err != nil {
		t.Fatal(err)
	}
	reportPath := filepath.Join(aDir, "reports", "test-report.json")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(reportPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("report was not written: %v\n%s", err, sess.Output())
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := sess.Type("/quit"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if err := sess.Send("\r"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitExit(5 * time.Second); err != nil {
		t.Fatalf("/quit did not exit cleanly: %v", err)
	}

	// B must have received the TUI message.
	bc, err := client.New(bDir)
	if err != nil {
		t.Fatal(err)
	}
	defer bc.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	msgs, err := bc.RecentMessages(ctx, 50)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range msgs.GetMessages() {
		if m.GetDirection() == "in" && m.GetText() == "interactive pty hello" {
			found = true
		}
	}
	if !found {
		t.Fatalf("B did not store the interactive message; history=%v", msgs.GetMessages())
	}

	raw, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	schemaPath := filepath.Join(root, "docs", "schemas", "test-report.schema.json")
	if err := report.ValidateFile(raw, schemaPath); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "interactive pty hello") {
		t.Fatal("report leaked message text without --include-text")
	}
	var doc map[string]any
	if err := jsonUnmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["message_text_included"] != false {
		t.Fatalf("message_text_included = %v", doc["message_text_included"])
	}
	_ = aStatus
}

func repoRoot(t *testing.T) string {
	t.Helper()
	if root := os.Getenv("RAMINGA_REPO_ROOT"); root != "" {
		return root
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	return l.Addr().(*net.TCPAddr).Port
}

func runInit(t *testing.T, bin, dir string, port int, announces ...string) {
	t.Helper()
	args := []string{"init", "--no-bootstrap-preset", "--data-dir", dir,
		"--listen", fmt.Sprintf("/ip4/127.0.0.1/tcp/%d", port),
		"--listen", fmt.Sprintf("/ip4/127.0.0.1/udp/%d/quic-v1", port)}
	for _, announce := range announces {
		args = append(args, "--announce", announce)
	}
	cmd := exec.Command(bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("init: %v\n%s", err, out)
	}
}

func startDaemon(t *testing.T, bin, dir string) (*exec.Cmd, *os.File) {
	t.Helper()
	log, err := os.Create(filepath.Join(dir, "daemon.log"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "daemon", "--data-dir", dir, "--log-level", "error")
	cmd.Stdout = log
	cmd.Stderr = log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	return cmd, log
}

func stopDaemon(t *testing.T, cmd *exec.Cmd, log *os.File) {
	t.Helper()
	if cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	}
	_ = log.Close()
}

func waitStatus(t *testing.T, dir string) *apiv1.StatusResponse {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		c, err := client.New(dir)
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			st, err := c.Status(ctx)
			cancel()
			c.Close()
			if err == nil {
				return st
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("daemon %s did not become ready", dir)
	return nil
}

func jsonUnmarshal(b []byte, v any) error {
	return json.Unmarshal(b, v)
}
