// Command tuiwalk drives the real interactive TUI on a pty inside a lab
// container. It sends real slash commands and plain chat text (not
// --script/--pipe) and waits for the documented log lines between steps.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Raminga/raminga/tests/e2e/tuipty"
)

func main() {
	var (
		role      = flag.String("role", "", "a or b")
		bin       = flag.String("bin", "raminga", "raminga binary")
		dataDir   = flag.String("data-dir", "/data", "node data dir")
		peer      = flag.String("peer", "b-quic", "target peer name")
		phaseFile = flag.String("phase-file", "/data/tui-phase1", "phase marker written after first ACK")
		stopFile  = flag.String("stop-file", "/data/tui-relays-stopped", "host marker after relays stop")
		bAcked    = flag.String("b-acked-file", "/data/tui-b-acked", "host marker after B ACK")
		textA     = flag.String("text-a", "g45-tui-a-to-b", "A first message")
		textA2    = flag.String("text-a2", "g45-tui-a-still-direct", "A post-stop message")
		textB     = flag.String("text-b", "g45-tui-b-to-a", "B message")
		reportDir = flag.String("report-dir", "/data/report", "TUI report directory")
		connect   = flag.String("connect", "", "optional explicit /connect argument (default: -peer name)")
		expectCon = flag.String("expect-connect", "已经中继", "log substring after /connect, or none")
		expectUp  = flag.String("expect-upgrade", "已升级为", "log substring for direct upgrade, or none")
		stopFlow  = flag.Bool("stop-flow", true, "wait for relays to stop and verify still-direct")
		doReport  = flag.Bool("report", true, "export and check report")
	)
	flag.Parse()
	if err := run(*role, *bin, *dataDir, *peer, *phaseFile, *stopFile, *bAcked, *textA, *textA2, *textB, *reportDir, *connect, *expectCon, *expectUp, *stopFlow, *doReport); err != nil {
		fmt.Fprintln(os.Stderr, "tuiwalk:", err)
		os.Exit(1)
	}
}

func run(role, bin, dataDir, peer, phaseFile, stopFile, bAcked, textA, textA2, textB, reportDir, connectArg, expectCon, expectUp string, stopFlow, doReport bool) error {
	sess, err := tuipty.Start(bin, dataDir, "--report-dir", reportDir)
	if err != nil {
		return fmt.Errorf("start TUI: %w", err)
	}
	defer sess.Close()
	if err := sess.WaitFor("Raminga", 3*time.Second); err != nil {
		return fmt.Errorf("startup: %w", err)
	}
	if raw := sess.RawOutput(); strings.Contains(raw, "\x1b]11;?") || strings.Contains(raw, "\x1b[6n") {
		return fmt.Errorf("TUI issued a blocking terminal status probe")
	}
	switch role {
	case "a":
		target := connectArg
		if target == "" {
			target = peer
		}
		if err := command(sess, "/connect "+target); err != nil {
			return err
		}
		if expectCon != "" && expectCon != "none" {
			if err := sess.WaitFor(expectCon, 30*time.Second); err != nil {
				return fmt.Errorf("connect log: %w", err)
			}
		}
		if expectUp != "" && expectUp != "none" {
			if err := sess.WaitFor(expectUp, 150*time.Second); err != nil {
				return fmt.Errorf("direct upgrade log: %w", err)
			}
		}
		if err := chat(sess, peer, textA); err != nil {
			return fmt.Errorf("first chat: %w", err)
		}
		if err := os.WriteFile(phaseFile, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644); err != nil {
			return err
		}
		if stopFlow {
			if err := waitFile(stopFile, 180*time.Second); err != nil {
				return fmt.Errorf("wait relays-stopped: %w", err)
			}
			if err := command(sess, "/mark 已停中继"); err != nil {
				return err
			}
			sleep(12 * time.Second)
			if err := chat(sess, peer, textA2); err != nil {
				return fmt.Errorf("post-stop chat: %w", err)
			}
			if err := waitFile(bAcked, 120*time.Second); err != nil {
				return fmt.Errorf("wait B ACK: %w", err)
			}
		}
		if doReport {
			if err := command(sess, "/report"); err != nil {
				return err
			}
			if err := sess.WaitFor("报告已保存", 10*time.Second); err != nil {
				return fmt.Errorf("report: %w", err)
			}
		}
		if err := quit(sess); err != nil {
			return fmt.Errorf("quit: %w", err)
		}
	case "b":
		sleep(5 * time.Second)
		if err := chat(sess, peer, textB); err != nil {
			return fmt.Errorf("reverse chat: %w", err)
		}
		if err := os.WriteFile(bAcked, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644); err != nil {
			return err
		}
		if err := quit(sess); err != nil {
			return fmt.Errorf("quit: %w", err)
		}
	case "blocked":
		if err := command(sess, "/connect "+peer); err != nil {
			return err
		}
		if err := sess.WaitFor("连接失败", 30*time.Second); err != nil {
			return fmt.Errorf("expected connect failure: %w", err)
		}
		return quit(sess)
	default:
		return fmt.Errorf("unknown role %q", role)
	}
	return nil
}

// command types a slash command one character at a time and presses one plain
// Enter, exactly like the reviewer's pty walk. The popup is open while typing;
// Enter must accept the highlighted item and submit the argument in one step.
func command(sess *tuipty.Session, line string) error {
	if err := sess.Type(line); err != nil {
		return err
	}
	sleep(250 * time.Millisecond)
	return sess.Send("\r")
}

func chat(sess *tuipty.Session, peer, text string) error {
	if err := command(sess, "/chat "+peer); err != nil {
		return err
	}
	if err := sess.WaitFor("当前聊天对象", 3*time.Second); err != nil {
		return fmt.Errorf("chat target: %w", err)
	}
	mark := sess.Mark()
	if err := sess.Type(text); err != nil {
		return err
	}
	sleep(150 * time.Millisecond)
	if err := sess.Send("\r"); err != nil {
		return err
	}
	if err := sess.WaitForSince(text, mark, 20*time.Second); err != nil {
		return fmt.Errorf("send log: %w", err)
	}
	if err := sess.WaitForSince("已送达", mark, 20*time.Second); err != nil {
		return fmt.Errorf("ACK log: %w", err)
	}
	return nil
}

func quit(sess *tuipty.Session) error {
	for i := 0; i < 3; i++ {
		if err := sess.Type("/quit"); err != nil {
			return err
		}
		sleep(150 * time.Millisecond)
		if err := sess.Send("\r"); err != nil {
			return err
		}
		if err := sess.WaitExit(2 * time.Second); err == nil {
			return nil
		}
	}
	return fmt.Errorf("/quit did not exit")
}

func sleep(d time.Duration) { time.Sleep(d) }

func waitFile(path string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for %s", path)
}
