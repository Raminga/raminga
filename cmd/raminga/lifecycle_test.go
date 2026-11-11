//go:build !windows

package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

var (
	testCLIBin string
	testCLIDir string
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "raminga-cli-bin-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "create test binary dir: %v\n", err)
		os.Exit(1)
	}
	testCLIDir = dir
	testCLIBin = filepath.Join(dir, "raminga")
	cmd := exec.Command("go", "build", "-trimpath", "-o", testCLIBin, ".")
	cmd.Dir = "."
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build test binary: %v\n%s\n", err, out)
		_ = os.RemoveAll(dir)
		os.Exit(1)
	}
	code := m.Run()
	_ = os.RemoveAll(testCLIDir)
	os.Exit(code)
}

func requireCLI(t *testing.T) string {
	t.Helper()
	if testCLIBin == "" {
		t.Skip("test CLI binary was not built")
	}
	return testCLIBin
}

func cleanEnv(extra ...string) []string {
	env := make([]string, 0, len(os.Environ())+len(extra))
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "RAMINGA_DATA_DIR=") || strings.HasPrefix(kv, "INVOCATION_ID=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, extra...)
}

func runCLI(t *testing.T, env []string, args ...string) (string, string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, testCLIBin, args...)
	cmd.Env = cleanEnv(env...)
	cmd.Stdin = strings.NewReader("")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("raminga %s timed out: stdout=%s stderr=%s", strings.Join(args, " "), stdout.String(), stderr.String())
	}
	return stdout.String(), stderr.String(), err
}

func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "rg-cli-")
	if err != nil {
		t.Fatalf("short temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func freePort(t *testing.T, network string) string {
	t.Helper()
	if network == "udp" {
		conn, err := net.ListenPacket("udp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = conn.Close() }()
		return strconv.Itoa(conn.LocalAddr().(*net.UDPAddr).Port)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	return strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
}

// initNodeDir writes a config with free ports so parallel packages and a real
// local daemon cannot collide on the default 4001.
func initNodeDir(t *testing.T, bin string) string {
	t.Helper()
	dir := shortTempDir(t)
	tcp, udp := freePort(t, "tcp"), freePort(t, "udp")
	stdout, stderr, err := runCLI(t, nil, "init", "--data-dir", dir, "--tcp-port", tcp, "--quic-port", udp)
	if err != nil {
		t.Fatalf("init: %v\nstdout=%s\nstderr=%s", err, stdout, stderr)
	}
	return dir
}

func stopCleanup(t *testing.T, dir string) {
	t.Helper()
	t.Cleanup(func() {
		_, _, _ = runCLI(t, nil, "stop", "--data-dir", dir)
	})
}

func TestBareNoTTYPrintsHelp(t *testing.T) {
	requireCLI(t)
	stdout, stderr, err := runCLI(t, nil)
	if err != nil {
		t.Fatalf("bare raminga without a TTY: %v\nstderr=%s", err, stderr)
	}
	for _, want := range []string{"Usage:", "stop", "restart", "daemon"} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("help output missing %q:\n%s", want, stdout)
		}
	}
}

func TestStartStatusStopAndStopAgain(t *testing.T) {
	bin := requireCLI(t)
	dir := initNodeDir(t, bin)
	stopCleanup(t, dir)

	stdout, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir)
	if err != nil {
		t.Fatalf("restart on a stopped node: %v\nstdout=%s\nstderr=%s", err, stdout, stderr)
	}
	if !strings.Contains(stdout, startingNodeMsg) || !strings.Contains(stdout, "已重启节点：raminga") {
		t.Fatalf("restart output = %q", stdout)
	}
	info, err := os.Stat(daemonLogPath(dir))
	if err != nil {
		t.Fatalf("daemon log: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("daemon log mode = %o, want 600", perm)
	}

	st, err := localStatus(dir, 5*time.Second)
	if err != nil {
		t.Fatalf("status after start: %v", err)
	}
	if st.GetVersion() == "" || st.GetSupervised() {
		t.Fatalf("unexpected status: supervised=%t version=%q", st.GetSupervised(), st.GetVersion())
	}
	stdout, stderr, err = runCLI(t, nil, "status", "--data-dir", dir)
	if err != nil || !strings.Contains(stdout, "peer_id:") {
		t.Fatalf("status: %v stdout=%s stderr=%s", err, stdout, stderr)
	}

	stdout, stderr, err = runCLI(t, nil, "stop", "--data-dir", dir)
	if err != nil || !strings.Contains(stdout, stoppedMsg) {
		t.Fatalf("stop: %v stdout=%s stderr=%s", err, stdout, stderr)
	}
	stdout, stderr, err = runCLI(t, nil, "stop", "--data-dir", dir)
	if err != nil || !strings.Contains(stdout, notRunningMsg) {
		t.Fatalf("second stop: %v stdout=%s stderr=%s", err, stdout, stderr)
	}
	if _, err := localStatus(dir, time.Second); err == nil {
		t.Fatal("node still reachable after stop")
	}
}

func TestTUIDoesNotAutoStart(t *testing.T) {
	bin := requireCLI(t)
	dir := initNodeDir(t, bin)
	script := filepath.Join(shortTempDir(t), "tui-script.txt")
	if err := os.WriteFile(script, []byte("/quit\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, _ := runCLI(t, nil, "tui", "--data-dir", dir, "--pipe", "--script", script)
	if !strings.Contains(stdout+stderr, "节点未运行") {
		t.Fatalf("tui without a daemon did not report 节点未运行: stdout=%s stderr=%s", stdout, stderr)
	}
	if _, err := localStatus(dir, time.Second); err == nil {
		t.Fatal("raminga tui auto-started a daemon")
	}
	if _, err := os.Stat(daemonLogPath(dir)); err == nil {
		t.Fatal("raminga tui created daemon.log")
	}
}

func TestRestartChangesProcess(t *testing.T) {
	bin := requireCLI(t)
	dir := initNodeDir(t, bin)
	stopCleanup(t, dir)

	if _, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir); err != nil {
		t.Fatalf("first restart: %v stderr=%s", err, stderr)
	}
	before, err := localStatus(dir, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir); err != nil {
		t.Fatalf("second restart: %v stderr=%s", err, stderr)
	}
	after, err := localStatus(dir, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if before.GetStartedAtUnixMs() == after.GetStartedAtUnixMs() {
		t.Fatalf("restart did not replace the daemon: started_at=%d", after.GetStartedAtUnixMs())
	}
	if before.GetPeerId() != after.GetPeerId() {
		t.Fatalf("restart changed Peer ID: %s -> %s", before.GetPeerId(), after.GetPeerId())
	}
}

func TestConcurrentStartsUseOneDaemon(t *testing.T) {
	bin := requireCLI(t)
	dir := initNodeDir(t, bin)
	stopCleanup(t, dir)

	start := func() *exec.Cmd {
		cmd := exec.Command(bin, "restart", "--data-dir", dir)
		cmd.Env = cleanEnv()
		cmd.Stdin = strings.NewReader("")
		return cmd
	}
	a, b := start(), start()
	var outA, outB bytes.Buffer
	a.Stdout, a.Stderr = &outA, &outA
	b.Stdout, b.Stderr = &outB, &outB
	if err := a.Start(); err != nil {
		t.Fatal(err)
	}
	if err := b.Start(); err != nil {
		t.Fatal(err)
	}
	if err := a.Wait(); err != nil {
		t.Fatalf("concurrent start A: %v\n%s", err, outA.String())
	}
	if err := b.Wait(); err != nil {
		t.Fatalf("concurrent start B: %v\n%s", err, outB.String())
	}
	if _, err := localStatus(dir, 5*time.Second); err != nil {
		t.Fatalf("no daemon after concurrent starts: %v", err)
	}

	if _, err := exec.LookPath("pgrep"); err == nil {
		pattern := "daemon --data-dir " + dir
		deadline := time.Now().Add(5 * time.Second)
		for {
			out, err := exec.Command("pgrep", "-f", pattern).Output()
			count := 0
			if err == nil {
				for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
					if strings.TrimSpace(line) != "" {
						count++
					}
				}
			}
			if count == 1 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("concurrent starts left %d daemons for %s\nlog:\n%s", count, dir, tailFile(daemonLogPath(dir), 40))
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
}

func TestStaleSocketDoesNotBlockStart(t *testing.T) {
	bin := requireCLI(t)
	dir := initNodeDir(t, bin)
	stopCleanup(t, dir)

	sock := filepath.Join(dir, "api.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("create stale socket: %v", err)
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(sock); err != nil {
		t.Fatalf("stale socket not left behind: %v", err)
	}
	if _, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir); err != nil {
		t.Fatalf("start over stale socket: %v\n%s", err, stderr)
	}
	if _, err := localStatus(dir, 5*time.Second); err != nil {
		t.Fatalf("status after stale-socket start: %v", err)
	}
}

func TestDaemonLogRotationAndMode(t *testing.T) {
	bin := requireCLI(t)
	dir := initNodeDir(t, bin)
	stopCleanup(t, dir)

	logPath := daemonLogPath(dir)
	old := bytes.Repeat([]byte("x"), daemonLogMaxSize+1)
	if err := os.WriteFile(logPath, old, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir); err != nil {
		t.Fatalf("restart with oversized log: %v\n%s", err, stderr)
	}
	rotated, err := os.Stat(logPath + ".1")
	if err != nil {
		t.Fatalf("rotated log missing: %v", err)
	}
	if rotated.Size() != int64(len(old)) {
		t.Fatalf("rotated log size = %d, want %d", rotated.Size(), len(old))
	}
	info, err := os.Stat(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("new daemon log mode = %o, want 600", perm)
	}
}

func TestStartFailureReportsLog(t *testing.T) {
	requireCLI(t)
	dir := shortTempDir(t)
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[network\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir)
	if err == nil {
		t.Fatalf("restart with invalid config unexpectedly succeeded: %s", stdout)
	}
	combined := stdout + stderr
	if !strings.Contains(combined, daemonLogPath(dir)) {
		t.Fatalf("failure output does not name the log:\n%s", combined)
	}
	if !strings.Contains(combined, "invalid TOML") {
		t.Fatalf("failure output does not show the log tail:\n%s", combined)
	}
	if strings.Contains(combined, "exit status") {
		t.Fatalf("failure output leaks a Go process error:\n%s", combined)
	}
}

func TestSupervisedStopAndRestartRefused(t *testing.T) {
	bin := requireCLI(t)
	dir := initNodeDir(t, bin)

	cmd := exec.Command(bin, "daemon", "--data-dir", dir)
	cmd.Env = cleanEnv("INVOCATION_ID=test-systemd")
	cmd.Stdin = strings.NewReader("")
	var daemonOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &daemonOut, &daemonOut
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGTERM)
		}
		_ = cmd.Wait()
	})
	deadline := time.Now().Add(15 * time.Second)
	var st *apiv1.StatusResponse
	var stErr error
	for time.Now().Before(deadline) {
		if st, stErr = localStatus(dir, time.Second); stErr == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if stErr != nil {
		t.Fatalf("supervised daemon did not start: %v\n%s", stErr, daemonOut.String())
	}
	if !st.GetSupervised() {
		t.Fatalf("StatusResponse.supervised = false for INVOCATION_ID daemon")
	}

	stdout, stderr, err := runCLI(t, nil, "stop", "--data-dir", dir)
	if err == nil || !strings.Contains(stderr, systemdStopMsg) {
		t.Fatalf("stop under systemd: %v stdout=%s stderr=%s", err, stdout, stderr)
	}
	stdout, stderr, err = runCLI(t, nil, "restart", "--data-dir", dir)
	if err == nil || !strings.Contains(stderr, systemdRestartMsg) {
		t.Fatalf("restart under systemd: %v stdout=%s stderr=%s", err, stdout, stderr)
	}
}

// installPathEnv is a temp HOME plus an unrelated PATH with the tools the script
// needs. HOME is always temporary so these tests can't touch a real rc file.
type installPathEnv struct {
	root, pkg, home, prefix string
}

func newInstallPathEnv(t *testing.T) installPathEnv {
	t.Helper()
	bin := requireCLI(t)
	root := shortTempDir(t)
	e := installPathEnv{root: root, pkg: filepath.Join(root, "pkg"), home: filepath.Join(root, "home"), prefix: filepath.Join(root, "home", ".local", "bin")}
	for _, dir := range []string{e.pkg, e.home} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, src := range map[string]string{"raminga": bin, "install.sh": filepath.Join("..", "..", "scripts", "install.sh")} {
		raw, err := os.ReadFile(src)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(e.pkg, name), raw, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

func (e installPathEnv) run(t *testing.T, shell, pathPrefix string, args ...string) string {
	t.Helper()
	cmd := exec.Command("/bin/sh", append([]string{filepath.Join(e.pkg, "install.sh")}, args...)...)
	cmd.Dir = e.pkg
	cmd.Env = []string{"HOME=" + e.home, "SHELL=" + shell, "PATH=" + pathPrefix + "/usr/bin:/bin:/usr/sbin:/sbin"}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func (e installPathEnv) rc(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(e.home, name))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return string(raw)
}

func TestInstallScriptWritesPathOnce(t *testing.T) {
	e := newInstallPathEnv(t)
	const line = `export PATH="$HOME/.local/bin:$PATH"`
	if err := os.WriteFile(filepath.Join(e.home, ".zshrc"), []byte("alias x=y"), 0o644); err != nil {
		t.Fatal(err)
	}
	first := e.run(t, "/bin/zsh", "")
	if !strings.Contains(first, ".zshrc") || !strings.Contains(first, "source "+filepath.Join(e.home, ".zshrc")) {
		t.Fatalf("must name the file and the source command:\n%s", first)
	}
	rc := e.rc(t, ".zshrc")
	if !strings.HasPrefix(rc, "alias x=y\n# Added by Raminga install.sh\n"+line+"\n") {
		t.Fatalf("rc content:\n%q", rc)
	}
	second := e.run(t, "/bin/zsh", "")
	if !strings.Contains(second, "未重复写入") || e.rc(t, ".zshrc") != rc {
		t.Fatalf("rerun must not write again:\n%s\n%q", second, e.rc(t, ".zshrc"))
	}
}

func TestInstallScriptShellAndPrefixChoices(t *testing.T) {
	e := newInstallPathEnv(t)
	wantBash := ".bashrc"
	if runtime.GOOS == "darwin" {
		wantBash = ".bash_profile"
	}
	custom := filepath.Join(e.root, "custom")
	e.run(t, "/bin/bash", "", "--prefix", custom)
	if rc := e.rc(t, wantBash); !strings.Contains(rc, `export PATH="`+custom+`:$PATH"`) {
		t.Fatalf("%s must hold the --prefix directory:\n%q", wantBash, rc)
	}
	if rc := e.rc(t, ".zshrc"); rc != "" {
		t.Fatalf("zshrc must be untouched for bash: %q", rc)
	}
}

func TestInstallScriptOnlyPrintsWhenItShouldNotWrite(t *testing.T) {
	const line = `export PATH="$HOME/.local/bin:$PATH"`
	for name, tc := range map[string]struct {
		shell string
		args  []string
	}{
		"no-modify-path": {"/bin/zsh", []string{"--no-modify-path"}},
		"unknown shell":  {"/bin/fish", nil},
	} {
		t.Run(name, func(t *testing.T) {
			e := newInstallPathEnv(t)
			out := e.run(t, tc.shell, "", tc.args...)
			if !strings.Contains(out, line) {
				t.Fatalf("must print the manual line:\n%s", out)
			}
			entries, err := os.ReadDir(e.home)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".") && entry.Name() != ".local" {
					t.Fatalf("wrote %s", entry.Name())
				}
			}
		})
	}
}

func TestInstallScriptLeavesPathAloneWhenAlreadyOnIt(t *testing.T) {
	e := newInstallPathEnv(t)
	out := e.run(t, "/bin/zsh", e.prefix+":")
	if rc := e.rc(t, ".zshrc"); rc != "" {
		t.Fatalf("must not write when already on PATH: %q\n%s", rc, out)
	}
	if strings.Contains(out, "警告") || strings.Contains(out, "export PATH") {
		t.Fatalf("nothing to report:\n%s", out)
	}
}

func TestInstallScriptWarnsAboutShadowingBinary(t *testing.T) {
	e := newInstallPathEnv(t)
	oldDir := filepath.Join(e.root, "old")
	if err := os.MkdirAll(oldDir, 0o755); err != nil {
		t.Fatal(err)
	}
	oldBin := filepath.Join(oldDir, "raminga")
	if err := os.WriteFile(oldBin, []byte("#!/bin/sh\necho raminga old-1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Not on PATH yet: the rc line fixes new terminals, and the warning says how.
	out := e.run(t, "/bin/zsh", oldDir+":")
	for _, want := range []string{"警告", oldBin, "raminga old-1", "source"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q:\n%s", want, out)
		}
	}
	// On PATH but behind the old one: only the user can fix the order.
	out = e.run(t, "/bin/zsh", oldDir+":"+e.prefix+":")
	for _, want := range []string{"警告", oldBin, "raminga old-1", "排在前面"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q:\n%s", want, out)
		}
	}
	// A symlink to the installed binary isn't a different program.
	link := filepath.Join(e.root, "link")
	if err := os.MkdirAll(link, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(e.prefix, "raminga"), filepath.Join(link, "raminga")); err != nil {
		t.Fatal(err)
	}
	if out = e.run(t, "/bin/zsh", link+":"+e.prefix+":"); strings.Contains(out, "警告") {
		t.Fatalf("symlink must not warn:\n%s", out)
	}
}

func TestInstallScriptTempPrefixAndReinstall(t *testing.T) {
	bin := requireCLI(t)
	root := shortTempDir(t)
	pkg := filepath.Join(root, "pkg")
	prefix := filepath.Join(root, "prefix")
	if err := os.MkdirAll(pkg, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"raminga", "install.sh"} {
		src := bin
		if name == "install.sh" {
			src = filepath.Join("..", "..", "scripts", "install.sh")
		}
		raw, err := os.ReadFile(src)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(pkg, name), raw, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	run := func() (string, string, error) {
		cmd := exec.Command("sh", filepath.Join(pkg, "install.sh"), "--prefix", prefix)
		cmd.Dir = pkg
		cmd.Env = cleanEnv("HOME=" + root)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		return stdout.String(), stderr.String(), err
	}
	for i := 0; i < 2; i++ {
		stdout, stderr, err := run()
		if err != nil {
			t.Fatalf("install run %d: %v\nstdout=%s\nstderr=%s", i+1, err, stdout, stderr)
		}
		if !strings.Contains(stdout, "已安装 raminga ") {
			t.Fatalf("install run %d output = %q", i+1, stdout)
		}
		installed := filepath.Join(prefix, "raminga")
		info, err := os.Stat(installed)
		if err != nil {
			t.Fatalf("installed binary missing after run %d: %v", i+1, err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Fatalf("installed binary is not executable: %o", info.Mode().Perm())
		}
		out, err := exec.Command(installed, "version").Output()
		if err != nil || !strings.HasPrefix(string(out), "raminga ") {
			t.Fatalf("installed version: %v %q", err, out)
		}
	}
}
