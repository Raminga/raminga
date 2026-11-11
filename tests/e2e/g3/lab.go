package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type labAction struct {
	up      bool
	down    bool
	status  bool
	rebuild bool
}

type labNode struct {
	service string
	role    string
	addrs   []string
}

type labRelay struct {
	service string
	addr    string
}

// runLab is the manual Docker lab entry point. It shares the G3 compose
// stacks, image and config generation with the automated suite but never runs
// a business scenario or sends chat.
func (r *runner) runLab(a labAction) int {
	st := r.labStack()
	if st == nil {
		fmt.Fprintf(os.Stderr, "lab: unknown lab %q (want lan, onesided, symmetric or dualnat)\n", r.lab)
		return 1
	}
	r.stack = st
	actions := 0
	for _, on := range []bool{a.up, a.down, a.status} {
		if on {
			actions++
		}
	}
	if actions != 1 {
		fmt.Fprintln(os.Stderr, "lab: choose exactly one of -up, -down or -status")
		return 1
	}
	switch {
	case a.down:
		return r.labDown(st)
	case a.status:
		return r.labStatus(st)
	default:
		return r.labUp(st, a.rebuild)
	}
}

func (r *runner) labStack() *stackInfo {
	for _, st := range r.stacks() {
		if st.name == r.lab {
			st.project = "raminga-lab-" + st.name
			st.configDir = filepath.Join(r.root, ".local", "lab", st.name, "configs")
			return st
		}
	}
	return nil
}

func (r *runner) labUp(st *stackInfo, rebuild bool) int {
	if err := r.ensureLabImage(rebuild); err != nil {
		fmt.Fprintf(os.Stderr, "lab: image: %v\n", err)
		return 1
	}
	// Start from a clean project so a previous failed run cannot leak state.
	if out, code := r.compose(st, "down", "-v", "--remove-orphans"); code != 0 {
		fmt.Fprintf(os.Stderr, "lab: clean previous stack: %s\n", strings.TrimSpace(out))
	}
	if err := removeCheatSheet(r.root, st.name); err != nil {
		fmt.Fprintf(os.Stderr, "lab: remove stale cheat sheet: %v\n", err)
		return 1
	}
	if err := r.setupStack(st); err != nil {
		fmt.Fprintf(os.Stderr, "lab: setup %s: %v\n", st.name, err)
		r.teardownStack(st)
		return 1
	}
	if err := r.labSelfCheck(st); err != nil {
		fmt.Fprintf(os.Stderr, "lab: facility self-check failed: %v\n", err)
		r.teardownStack(st)
		return 1
	}
	doc, err := r.labCheatSheet(st)
	if err != nil {
		fmt.Fprintf(os.Stderr, "lab: cheat sheet: %v\n", err)
		r.teardownStack(st)
		return 1
	}
	path := cheatSheetPath(r.root, st.name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "lab: write cheat sheet dir: %v\n", err)
		r.teardownStack(st)
		return 1
	}
	if err := os.WriteFile(path, []byte(doc), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "lab: write cheat sheet: %v\n", err)
		r.teardownStack(st)
		return 1
	}
	fmt.Print(doc)
	fmt.Printf("\nlab: %s is UP (project %s); cheat sheet: %s\n", st.name, st.project, path)
	fmt.Printf("lab: stop with: make lab-down LAB=%s\n", st.name)
	return 0
}

func (r *runner) labDown(st *stackInfo) int {
	if out, code := r.compose(st, "down", "-v", "--remove-orphans"); code != 0 {
		fmt.Fprintf(os.Stderr, "lab: down failed: %s\n", strings.TrimSpace(out))
		return 1
	}
	project := st.project
	var leftovers []string
	for _, spec := range []struct {
		label string
		args  []string
	}{
		{"containers", []string{"ps", "-aq", "--filter", "label=com.docker.compose.project=" + project}},
		{"networks", []string{"network", "ls", "-q", "--filter", "label=com.docker.compose.project=" + project}},
		{"volumes", []string{"volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + project}},
	} {
		out := r.hostOutput("docker", spec.args...)
		if strings.TrimSpace(out) != "" {
			leftovers = append(leftovers, spec.label+": "+strings.TrimSpace(out))
		}
	}
	if len(leftovers) > 0 {
		fmt.Fprintf(os.Stderr, "lab: project %s still has resources: %s\n", project, strings.Join(leftovers, "; "))
		return 1
	}
	if err := removeCheatSheet(r.root, st.name); err != nil {
		fmt.Fprintf(os.Stderr, "lab: remove stale cheat sheet: %v\n", err)
		return 1
	}
	fmt.Printf("lab: %s is DOWN; project %s has no containers, networks or volumes; cheat sheet removed\n", st.name, project)
	return 0
}

func cheatSheetPath(root, lab string) string {
	return filepath.Join(root, ".local", "lab", lab+".md")
}

// removeCheatSheet deletes the generated cheat sheet so Peer IDs and
// container names of a stopped lab cannot be mistaken for live values.
func removeCheatSheet(root, lab string) error {
	if err := os.Remove(cheatSheetPath(root, lab)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (r *runner) labStatus(st *stackInfo) int {
	out, code := r.compose(st, "ps", "--format", "table {{.Service}}\t{{.Name}}\t{{.Status}}\t{{.Ports}}")
	if code != 0 {
		fmt.Fprintf(os.Stderr, "lab: compose ps: %s\n", strings.TrimSpace(out))
		return 1
	}
	fmt.Println(strings.TrimRight(out, "\n"))
	for _, service := range st.wait {
		if st.nonNode[service] {
			continue
		}
		stOut, code := r.quiet(service, "raminga", "status", "--data-dir", "/data")
		if code != 0 {
			fmt.Printf("%s: not running (%s)\n", service, strings.TrimSpace(stOut))
			continue
		}
		fmt.Printf("--- %s ---\n%s", service, stOut)
	}
	return 0
}

func (r *runner) ensureLabImage(rebuild bool) error {
	stampPath := filepath.Join(r.root, ".local", "lab", "image.stamp")
	if !rebuild {
		createdRaw := strings.TrimSpace(r.hostOutput("docker", "image", "inspect", "-f", "{{.Created}}", imageName))
		if createdRaw != "" && !strings.Contains(createdRaw, "(") {
			created, err := time.Parse(time.RFC3339Nano, createdRaw)
			if err == nil {
				// Docker can reuse an identical config/layer set, leaving
				// .Created at the original build even after a later build.
				// Our own post-build stamp records the successful build time,
				// so a runner-only edit does not trigger endless rebuilds.
				if stamp, statErr := os.Stat(stampPath); statErr == nil && stamp.ModTime().After(created) {
					created = stamp.ModTime()
				}
				newer, err := r.sourceNewerThan(created)
				if err == nil && !newer {
					fmt.Printf("lab: reusing image %s (built %s)\n", imageName, created.Format(time.RFC3339))
					return nil
				}
			}
		}
	}
	fmt.Printf("lab: building image %s\n", imageName)
	out, code := r.recordCommand("host", "docker", "build", "--progress=plain", "-t", imageName, "-f", "tests/e2e/Dockerfile", ".")
	if code != 0 {
		return fmt.Errorf("docker build failed: %s", tail(out, 4000))
	}
	if err := os.MkdirAll(filepath.Dir(stampPath), 0o755); err != nil {
		return fmt.Errorf("create image stamp dir: %w", err)
	}
	if err := os.WriteFile(stampPath, []byte(time.Now().UTC().Format(time.RFC3339Nano)+"\n"), 0o644); err != nil {
		return fmt.Errorf("write image stamp: %w", err)
	}
	return nil
}

func (r *runner) sourceNewerThan(created time.Time) (bool, error) {
	// Only files that actually affect the runtime image. Runner-only changes
	// (lab.go, lab-verify.sh, evidence) must not force a Docker rebuild.
	paths := []string{
		"cmd", "internal", "gen", "api", "spec", "go.mod", "go.sum",
		"tests/e2e/Dockerfile", "tests/e2e/entrypoint.sh", "tests/e2e/configs",
		"tests/e2e/nat-router.sh", "tests/e2e/g2/nat-peer-entrypoint.sh",
	}
	newer := false
	for _, rel := range paths {
		path := filepath.Join(r.root, rel)
		info, err := os.Stat(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return false, err
		}
		if !info.IsDir() {
			if info.ModTime().After(created) {
				newer = true
			}
			continue
		}
		err = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if strings.Contains(p, string(filepath.Separator)+".local") {
					return filepath.SkipDir
				}
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			if info.ModTime().After(created) {
				newer = true
			}
			return nil
		})
		if err != nil {
			return false, err
		}
	}
	return newer, nil
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func (r *runner) labCheck(name string, pass bool, detail string) {
	status := "PASS"
	if !pass {
		status = "FAIL"
	}
	fmt.Printf("lab: check %-52s %s  %s\n", name, status, strings.TrimSpace(detail))
}

func ipv6DropCounter(r *runner, service string) int {
	out, code := r.sh(service, "ip6tables -w 5 -vnL FORWARD | awk '$0 ~ /DROP/ {s+=$1} END {print s+0}'")
	if code != 0 {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0
	}
	return n
}

func (r *runner) labSelfCheck(st *stackInfo) error {
	failed := 0
	checkContains := func(name, service, script, want string) {
		out, code := r.sh(service, script)
		if code != 0 || !strings.Contains(out, want) {
			r.labCheck(name, false, fmt.Sprintf("%s exit=%d out=%s", service, code, strings.TrimSpace(out)))
			failed++
			return
		}
		r.labCheck(name, true, service)
	}
	checkIptables := func(name string, services ...string) {
		for _, service := range services {
			out, code := r.sh(service, "iptables -w 5 -S; echo ---; iptables -w 5 -t nat -S")
			ok := code == 0 && strings.Contains(out, "MASQUERADE") && !strings.Contains(out, "-j DNAT") &&
				strings.Contains(out, "ESTABLISHED") && strings.Contains(out, "RELATED")
			if !ok {
				r.labCheck(name+" "+service, false, strings.TrimSpace(out))
				failed++
				continue
			}
			r.labCheck(name+" "+service, true, "strict conntrack, MASQUERADE, no DNAT")
		}
	}
	checkNoPublishedPorts := func() {
		out, code := r.compose(st, "ps", "--format", "{{.Service}} {{.Ports}}")
		ok := code == 0 && !strings.Contains(out, "0.0.0.0:") && !strings.Contains(out, "->")
		if !ok {
			r.labCheck("no host-published ports", false, strings.TrimSpace(out))
			failed++
			return
		}
		r.labCheck("no host-published ports", true, "all services use internal networks")
	}

	switch st.name {
	case "lan":
		checkContains("a6 has ULA IPv6 address", "a6", "ip -6 addr show", "fd00:250:1::21")
		checkContains("a6 IPv6 route exists", "a6", "ip -6 route", "fd00:250:1::/64")
		checkContains("b6 has ULA IPv6 address", "b6", "ip -6 addr show", "fd00:250:1::22")
		// The G3 IPv6 facility installs a stateful ip6tables INPUT policy on
		// both peers. Lab-up does the same so the manual IPv6 walkthrough runs
		// against the real firewall rather than an open link.
		rulesA := "ip6tables -w 5 -F INPUT; ip6tables -w 5 -P INPUT DROP; " +
			"ip6tables -w 5 -A INPUT -i lo -j ACCEPT; " +
			"ip6tables -w 5 -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; " +
			"ip6tables -w 5 -A INPUT -p ipv6-icmp -j ACCEPT; " +
			"ip6tables -w 5 -A INPUT -p tcp -s fd00:250:1::22 --dport 4001 -j ACCEPT; " +
			"ip6tables -w 5 -A INPUT -p udp -s fd00:250:1::22 --dport 4001 -j ACCEPT"
		rulesB := strings.ReplaceAll(rulesA, "fd00:250:1::22", "fd00:250:1::21")
		for _, item := range []struct{ service, rules string }{{"a6", rulesA}, {"b6", rulesB}} {
			out, code := r.sh(item.service, item.rules)
			ok := code == 0
			if !ok {
				r.labCheck(item.service+" stateful ip6tables INPUT", false, strings.TrimSpace(out))
				failed++
				continue
			}
			dump, _ := r.sh(item.service, "ip6tables -w 5 -S INPUT")
			ok = strings.Contains(dump, "-P INPUT DROP") && strings.Contains(dump, "ESTABLISHED") && strings.Contains(dump, "RELATED")
			r.labCheck(item.service+" stateful ip6tables INPUT", ok, "policy DROP + conntrack")
			if !ok {
				failed++
			}
		}
		out, code := r.sh("a6", "ping -6 -c 2 -W 2 fd00:250:1::22")
		r.labCheck("IPv6 on-link probe through stateful firewall", code == 0 && strings.Contains(out, "2 received"), strings.TrimSpace(out))
		if code != 0 || !strings.Contains(out, "2 received") {
			failed++
		}
		ct, _ := r.sh("b6", "conntrack -L -f ipv6 2>/dev/null | head -5; true")
		ok := strings.Contains(strings.ToLower(ct), "icmpv6")
		r.labCheck("IPv6 conntrack state is observable", ok, strings.TrimSpace(ct))
		if !ok {
			failed++
		}
		checkContains("IPv4 coexists on the dual-stack LAN", "a6", "ip -4 addr show", "10.250.1.21")
		checkNoPublishedPorts()
	case "onesided":
		checkIptables("strict NAT router rules", "nat")
		checkContains("restricted peer default route via NAT", "peer", "ip route", "default via 10.252.1.2")
		out, code := r.sh("peer", "ping -c 1 -W 2 11.43.0.10")
		r.labCheck("restricted side reaches public node", code == 0 && strings.Contains(out, "1 received"), strings.TrimSpace(out))
		if code != 0 || !strings.Contains(out, "1 received") {
			failed++
		}
		time.Sleep(300 * time.Millisecond)
		ct, _ := r.sh("nat", "conntrack -L 2>/dev/null | grep '10.252.1.10' | head -5; true")
		ok := strings.Contains(ct, "10.252.1.10") && strings.Contains(ct, "11.43.0.10")
		r.labCheck("MASQUERADE conntrack mapping exists", ok, strings.TrimSpace(ct))
		if !ok {
			failed++
		}
		checkNoPublishedPorts()
	case "ipv6fw":
		for _, item := range []struct {
			service string
			wan     string
			lan     string
			other   string
			peer    string
		}{
			{"fw-a", "fd00:360:0::10", "fd00:361:1::2", "fd00:362:1::/64", "fd00:360:0::11"},
			{"fw-b", "fd00:360:0::11", "fd00:362:1::2", "fd00:361:1::/64", "fd00:360:0::10"},
		} {
			checkContains(item.service+" has both IPv6 ULA sites", item.service, "ip -6 addr show", item.lan)
			checkContains(item.service+" routes the other ULA site", item.service, "ip -6 route", "via "+canonicalIP6(item.peer))
			rules, _ := r.sh(item.service, "ip6tables -w 5 -S")
			ok := strings.Contains(rules, "-P INPUT DROP") && strings.Contains(rules, "-P FORWARD DROP") &&
				strings.Contains(rules, "ESTABLISHED") && strings.Contains(rules, "RELATED") &&
				!strings.Contains(rules, "--dport 4001") && !strings.Contains(rules, "DNAT")
			r.labCheck(item.service+" stateful firewall, no Raminga allow/DNAT", ok, strings.TrimSpace(rules))
			if !ok {
				failed++
			}
		}
		for _, service := range []string{"a-quic", "b-quic"} {
			out, code := r.sh(service, "ping -6 -c 1 -W 2 fd00:360:0::2")
			ok := code == 0 && strings.Contains(out, "1 received")
			r.labCheck(service+" reaches the IPv6 relay", ok, strings.TrimSpace(out))
			if !ok {
				failed++
			}
		}
		time.Sleep(300 * time.Millisecond)
		ct, _ := r.sh("fw-a", "conntrack -L -f ipv6 2>/dev/null | head -10; true")
		ok := strings.Contains(strings.ToLower(ct), "icmpv6")
		r.labCheck("IPv6 conntrack is observable on the site firewall", ok, strings.TrimSpace(ct))
		if !ok {
			failed++
		}
		before := ipv6DropCounter(r, "fw-a")
		probe, code := r.sh("wan-probe", "ping -6 -c 1 -W 2 fd00:361:1::10")
		r.labCheck("unsolicited WAN->site probe is dropped", code != 0, strings.TrimSpace(probe))
		if code == 0 {
			failed++
		}
		after := ipv6DropCounter(r, "fw-a")
		r.labCheck("site firewall DROP counter increased", after > before, fmt.Sprintf("before=%d after=%d", before, after))
		if after <= before {
			failed++
		}
		checkNoPublishedPorts()
	case "symmetric":
		checkIptables("symmetric MASQUERADE rules", "nat-a", "nat-b")
		for _, service := range []string{"nat-a", "nat-b"} {
			out, code := r.sh(service, "iptables -w 5 -t nat -S POSTROUTING")
			ok := code == 0 && strings.Contains(out, "--random-fully")
			r.labCheck(service+" random-fully mapping", ok, strings.TrimSpace(out))
			if !ok {
				failed++
			}
		}
		checkContains("peer A default route via NAT", "a", "ip route", "default via 10.254.1.2")
		out, code := r.sh("a", "ping -c 1 -W 2 11.42.0.2")
		r.labCheck("NATed peer reaches WAN relay", code == 0 && strings.Contains(out, "1 received"), strings.TrimSpace(out))
		if code != 0 || !strings.Contains(out, "1 received") {
			failed++
		}
		time.Sleep(300 * time.Millisecond)
		ct, _ := r.sh("nat-a", "conntrack -L 2>/dev/null | grep '10.254.1.10' | head -5; true")
		ok := strings.Contains(ct, "10.254.1.10") && strings.Contains(ct, "11.42.0.2")
		r.labCheck("MASQUERADE conntrack mapping exists", ok, strings.TrimSpace(ct))
		if !ok {
			failed++
		}
		checkNoPublishedPorts()
	case "dualnat":
		checkIptables("strict dual-NAT rules", "nat-a", "nat-b")
		for _, service := range []string{"a-quic", "a-tcp", "a-relay"} {
			checkContains(service+" default route via NAT-A", service, "ip route", "default via 10.249.1.2")
		}
		out, code := r.sh("a-quic", "ping -c 1 -W 2 11.41.0.2")
		r.labCheck("NATed peer reaches WAN relay R1", code == 0 && strings.Contains(out, "1 received"), strings.TrimSpace(out))
		if code != 0 || !strings.Contains(out, "1 received") {
			failed++
		}
		cross, crossCode := r.sh("a-quic", "ping -c 1 -W 2 10.249.2.10")
		r.labCheck("cross-LAN direct address is unreachable", crossCode != 0, strings.TrimSpace(cross))
		if crossCode == 0 {
			failed++
		}
		time.Sleep(300 * time.Millisecond)
		ct, _ := r.sh("nat-a", "conntrack -L 2>/dev/null | grep '10.249.1.10' | head -5; true")
		ok := strings.Contains(ct, "10.249.1.10") && strings.Contains(ct, "11.41.0.2")
		r.labCheck("MASQUERADE conntrack mapping exists", ok, strings.TrimSpace(ct))
		if !ok {
			failed++
		}
		checkNoPublishedPorts()
	default:
		return fmt.Errorf("no checks for lab %q", st.name)
	}
	if failed > 0 {
		return fmt.Errorf("%d facility check(s) failed", failed)
	}
	return nil
}

func (r *runner) labCheatSheet(st *stackInfo) (string, error) {
	containers, err := r.labContainers(st)
	if err != nil {
		return "", err
	}
	nodes, relays := r.labTopology(st)
	for i := range nodes {
		nodes[i].service = strings.TrimSpace(nodes[i].service)
	}
	// Wait for the relay reservations the main recipes rely on, but never
	// connect or send chat during lab-up.
	switch st.name {
	case "symmetric":
		if _, err := r.waitRelayActive("b", r.ids["relay"], 90*time.Second); err != nil {
			return "", fmt.Errorf("b reservation: %w", err)
		}
		if _, err := r.waitRelayActive("a", r.ids["relay"], 90*time.Second); err != nil {
			return "", fmt.Errorf("a reservation: %w", err)
		}
	case "dualnat":
		for _, service := range []string{"b-quic", "a-quic", "b-tcp", "b-relay"} {
			if _, err := r.waitRelayActive(service, r.ids["r1"], 90*time.Second); err != nil {
				return "", fmt.Errorf("%s reservation: %w", service, err)
			}
		}
	case "ipv6fw":
		for _, service := range []string{"b-quic", "a-quic", "b-tcp", "a-tcp"} {
			if _, err := r.waitRelayActive(service, r.ids["relay"], 90*time.Second); err != nil {
				return "", fmt.Errorf("%s IPv6 relay reservation: %w", service, err)
			}
		}
	}

	for i := range nodes {
		nodes[i].addrs = r.labNodeAddrs(st, nodes[i], relays)
	}
	if err := r.seedPeerNames(nodes); err != nil {
		return "", err
	}
	return renderCheatSheet(st, nodes, relays, containers, r.ids), nil
}

func renderTUISteps(st *stackInfo, nodes []labNode, ids map[string]string) string {
	container := func(service string) string {
		return "raminga-lab-" + st.name + "-" + service + "-1"
	}
	var b strings.Builder
	b.WriteString("## TUI 实验步骤（推荐）\n\n")
	b.WriteString("容器已设置 `RAMINGA_DATA_DIR=/data`，`raminga tui` 无需再写 `--data-dir`。下面的 `> ` 表示在 TUI 底部输入行输入；每步后对照“应看到”的日志。名字已由 `make lab-up` 写入本机 SQLite，**不需要粘贴 multiaddr**。\n\n")
	step := func(title, service string, cmds []string, expect string) {
		fmt.Fprintf(&b, "### %s\n\n", title)
		fmt.Fprintf(&b, "在 `%s` 打开：\n\n```tui\ndocker exec -it %s raminga tui\n```\n\n", service, container(service))
		b.WriteString("依次输入：\n\n```tui\n")
		for _, c := range cmds {
			b.WriteString("> " + c + "\n")
		}
		b.WriteString("```\n\n应看到（日志行）：\n\n```text\n" + expect + "\n```\n\n")
	}
	cont := func(title string, cmds []string, expect string) {
		fmt.Fprintf(&b, "### %s（继续同一个 TUI）\n\n", title)
		b.WriteString("在刚才的 TUI 输入：\n\n```tui\n")
		for _, c := range cmds {
			b.WriteString("> " + c + "\n")
		}
		b.WriteString("```\n\n应看到：\n\n```text\n" + expect + "\n```\n\n")
	}
	step2 := func(title, service string, cmds []string, expect string) {
		fmt.Fprintf(&b, "### %s\n\n", title)
		fmt.Fprintf(&b, "在 `%s` 打开第二个 TUI：\n\n```tui\ndocker exec -it %s raminga tui\n```\n\n", service, container(service))
		b.WriteString("依次输入：\n\n```tui\n")
		for _, c := range cmds {
			b.WriteString("> " + c + "\n")
		}
		b.WriteString("```\n\n应看到：\n\n```text\n" + expect + "\n```\n\n")
	}
	switch st.name {
	case "lan":
		step("1. IPv4 直连 + 聊天", "a4", []string{"/connect b4", "/chat b4", "hello from a4", "/report", "/quit"},
			"✓ 已建立直连 /ip4/10.250.1.12/tcp/4001（TCP）\n✓ 当前聊天对象：b4\n→ 你对 b4：hello from a4 已送达 ✓\n✓ 报告已保存：/data/reports/test-report.json")
		step("2. IPv6 直连 + 聊天", "a6", []string{"/connect b6", "/chat b6", "ipv6 back from b6", "/quit"},
			"✓ 已建立直连 /ip6/fd00:250:1::22/tcp/4001（TCP）\n→ 你对 b6：ipv6 back from b6 已送达 ✓")
		step("3. IPv6-only + 名字选择", "a6only", []string{"/connect b6only", "/chat b6only", "peer-id ipv6 only", "/quit"},
			"✓ 已建立直连 /ip6/fd00:250:1::32/...（TCP）\n→ 你对 b6only：peer-id ipv6 only 已送达 ✓")
		step("4. IPv6 QUIC 直连", "q6-a", []string{"/connect q6-b", "/chat q6-b", "ipv6 quic fresh pair", "/quit"},
			"✓ 已建立直连 /ip6/fd00:250:1::72/udp/4001/quic-v1（QUIC）\n→ 你对 q6-b：ipv6 quic fresh pair 已送达 ✓")
		b.WriteString("主机侧设施步骤（不开放端口，仅本 lab 容器内）：\n\n```tui\ndocker exec -it " + container("tcp-a") + " sh -c 'iptables -w 5 -A INPUT -p udp --dport 4001 -j DROP; iptables -w 5 -A OUTPUT -p udp --dport 4001 -j DROP'\ndocker exec -it " + container("loss-a") + " tc qdisc replace dev eth0 root netem delay 120ms 20ms loss 10%\n```\n\n")
		step("5. UDP 封锁后的 TCP 回退", "tcp-a", []string{"/connect tcp-b", "/chat tcp-b", "tcp works", "/quit"},
			"✓ 已建立直连 /ip4/10.250.1.42/tcp/4001（TCP）；QUIC 失败不应写成直连")
		step("6. UDP 可用的 QUIC 对", "udp-a", []string{"/connect udp-b", "/chat udp-b", "quic works", "/quit"}, "✓ 已建立直连 .../udp/4001/quic-v1（QUIC）")
	case "onesided":
		step("1. 先验证公网侧主动拨号 BLOCKED（预期）", "pub", []string{"/connect peer"}, "✗ 连接失败：所有候选地址都失败（连接超时）\n  · /ip4/...（超时）\n这是预期 BLOCKED，不是 bug")
		step("2. NAT 后节点主动连接公网节点", "peer", []string{"/connect pub", "/chat pub", "hello from peer", "/report", "/quit"}, "✓ 已建立直连 /ip4/11.43.0.10/tcp/4001（TCP）\n→ 你对 pub：hello from peer 已送达 ✓")
		step2("3. 公网节点沿已建立连接回消息", "pub", []string{"/chat peer", "hello back from pub", "/quit"}, "→ 你对 peer：hello back from pub 已送达 ✓；这不证明反向可达")
	case "symmetric":
		step("1. 对称 NAT：仅中继", "a", []string{"/connect b", "/chat b", "symmetric relay only", "/diag", "/report", "/quit"},
			"✓ 已经中继 relay 连接（受限）\n… 等待打洞（DCUtR）升级为直连\n→ 仅中继可用：当前没有直连；可能是对称 NAT/CGNAT 或 UDP 被封锁。")
		step2("2. 对端回消息", "b", []string{"/chat a", "symmetric back", "/quit"}, "→ 你对 a：symmetric back 已送达 ✓")
	case "dualnat":
		step("1. QUIC 中继 → 打洞直连", "a-quic", []string{"/connect b-quic", "/chat b-quic", "dualnat hello"},
			"✓ 已经中继 r1 连接（受限）\n✓ 已升级为 QUIC 直连 /ip4/11.41.0.11/udp/4001/quic-v1\n→ 你对 b-quic：dualnat hello 已送达 ✓")
		b.WriteString("主机侧停 relay（保持 TUI 运行）：\n\n```tui\ndocker stop " + container("r1") + " " + container("r2") + "\n```\n\n")
		cont("2. 停中继后仍直连并导出报告", []string{"/mark 已停中继", "still direct after relay stop", "/report", "/quit"},
			"✓ 停中继后直连仍然保持（已观察 10 秒）\n○ b-quic 的中继线路已关闭（直连仍在）\n→ 你对 b-quic：still direct after relay stop 已送达 ✓\n✓ 报告已保存：/data/reports/test-report.json")
		step2("3. 反向聊天", "b-quic", []string{"/chat a-quic", "direct from b", "/quit"}, "→ 你对 a-quic：direct from b 已送达 ✓")
		b.WriteString("主机侧重新启动 Relay（后续 TCP/relay-only 步骤需要）：\n\n```tui\ndocker start " + container("r1") + " " + container("r2") + "\n```\n\n重启后在任一 TUI 输入 `/diag`，确认中继预约恢复为 active，再继续。\n\n")
		step("4. TCP 双 NAT：通常 BLOCKED + 中继回退（偶见 direct）", "a-tcp", []string{"/connect b-tcp", "/diag", "/chat b-tcp", "tcp relay fallback", "/quit"},
			"通常：✗ 连接失败：所有候选地址都失败（连接超时）（TCP direct BLOCKED）\n通常：  · /ip4/...（超时）\n通常：→ 双 NAT 下 TCP 直连 BLOCKED；当前经中继回退，不能写成 direct。\n偶见：✓ 已建立直连 .../tcp/4100；此时 /diag 不再说 BLOCKED，仍以真实日志为准。")
		step("5. DCUtR 关闭：始终中继", "a-relay", []string{"/connect b-relay", "/chat b-relay", "relay only", "/diag", "/quit"},
			"✓ 已经中继 r1 连接（受限）\n→ 仅中继可用：当前没有直连")
	case "ipv6fw":
		step("1. IPv6 Relay → QUIC 直连", "a-quic", []string{"/connect b-quic", "/chat b-quic", "ipv6fw relay hello"},
			"✓ 已经中继 relay 连接（受限）\n✓ 已升级为 QUIC 直连 /ip6/...（QUIC）\n→ 你对 b-quic：ipv6fw relay hello 已送达 ✓")
		b.WriteString("主机侧停 IPv6 relay：\n\n```tui\ndocker stop " + container("relay") + "\n```\n\n")
		cont("2. 停 Relay 后仍直连 + 报告", []string{"/mark 已停中继", "ipv6fw still direct", "/report", "/quit"},
			"✓ 停中继后直连仍然保持（已观察 10 秒）\n○ b-quic 的中继线路已关闭（直连仍在）\n→ 你对 b-quic：ipv6fw still direct 已送达 ✓")
		b.WriteString("主机侧重新启动 IPv6 Relay（后续 TCP/单侧步骤需要）：\n\n```tui\ndocker start " + container("relay") + "\n```\n\n重启后输入 `/diag`，确认中继预约恢复为 active，再继续。\n\n")
		step("3. TCP 直连（PASS 或预期 BLOCKED）", "a-tcp", []string{"/connect b-tcp", "/diag", "/quit"},
			"✓ 已建立直连 ...（TCP）或 ✗ 连接失败：所有候选地址都失败（连接超时）；两种都如实显示")
		b.WriteString("主机侧单侧防火墙步骤：\n\n```tui\ndocker exec -it " + container("fw-a") + " sh -c 'ip6tables -w 5 -F FORWARD; ip6tables -w 5 -P FORWARD ACCEPT'\n```\n\n")
		step("4. 单侧防火墙", "one-a", []string{"/connect " + ids["one-b"], "/quit"}, "✗ 连接失败：所有候选地址都失败（连接超时）（open→closed 预期 BLOCKED；one-a 无法经 Relay 连接 one-b，故用 Peer ID）")
	}
	return b.String()
}

// seedPeerNames stores a local alias on every node for every other node of
// the lab, using the real service name and the generated addresses. Names are
// local-only and never dialed here; the TUI /connect command resolves them.
func (r *runner) seedPeerNames(nodes []labNode) error {
	for _, src := range nodes {
		for _, dst := range nodes {
			if src.service == dst.service || len(dst.addrs) == 0 || r.ids[dst.service] == "" {
				continue
			}
			// Friend naming requires an existing row. Connect first (the name
			// is the lab intent); blocked pairs keep their expected failure and
			// are left unnamed. Do not disconnect here: that would persistently
			// pause the peer and poison the rest of the lab.
			connected := false
			for _, addr := range dst.addrs {
				if _, code := r.quiet(src.service, "raminga", "connect", addr, "--data-dir", "/data"); code == 0 {
					connected = true
					break
				}
			}
			if !connected {
				continue
			}
			out, code := r.quiet(src.service, "raminga", "friends", "name", dst.service, r.ids[dst.service], "--data-dir", "/data")
			if code != 0 {
				return fmt.Errorf("seed friend name %s on %s: exit=%d out=%s", dst.service, src.service, code, strings.TrimSpace(out))
			}
		}
	}
	return nil
}

func (r *runner) labContainers(st *stackInfo) (map[string]string, error) {
	out, code := r.compose(st, "ps", "--format", "{{.Service}}\t{{.Name}}")
	if code != 0 {
		return nil, fmt.Errorf("compose ps: %s", strings.TrimSpace(out))
	}
	names := make(map[string]string)
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) >= 2 && fields[0] != "" {
			names[fields[0]] = fields[1]
		}
	}
	return names, nil
}

func (r *runner) labTopology(st *stackInfo) ([]labNode, []labRelay) {
	switch st.name {
	case "lan":
		return []labNode{
			{service: "a4", role: "IPv4+IPv6 direct peer A"},
			{service: "b4", role: "IPv4+IPv6 direct peer B"},
			{service: "a6", role: "IPv6/ip6tables pair A"},
			{service: "b6", role: "IPv6/ip6tables pair B"},
			{service: "a6only", role: "IPv6-only pair A"},
			{service: "b6only", role: "IPv6-only pair B"},
			{service: "tcp-a", role: "UDP-blocked pair A (TCP works)"},
			{service: "tcp-b", role: "UDP-blocked pair B (TCP works)"},
			{service: "udp-a", role: "TCP-blocked pair A (QUIC works after setup)"},
			{service: "udp-b", role: "TCP-blocked pair B (QUIC works after setup)"},
			{service: "loss-a", role: "netem pair A (manual tc step)"},
			{service: "loss-b", role: "netem pair B (manual tc step)"},
			{service: "q6-a", role: "fresh IPv6 QUIC pair A"},
			{service: "q6-b", role: "fresh IPv6 QUIC pair B"},
			{service: "id-a", role: "Peer-ID-only selection pair A"},
			{service: "id-b", role: "Peer-ID-only selection pair B"},
			{service: "fb-a", role: "address-family fallback pair A"},
			{service: "fb-b", role: "address-family fallback pair B"},
		}, nil
	case "onesided":
		return []labNode{
			{service: "pub", role: "WAN-reachable public node"},
			{service: "peer", role: "strict-NAT peer (outbound only)"},
		}, nil
	case "symmetric":
		return []labNode{
			{service: "relay", role: "WAN Circuit Relay v2 provider"},
			{service: "a", role: "symmetric-NAT peer A"},
			{service: "b", role: "symmetric-NAT peer B"},
		}, []labRelay{{service: "relay", addr: "/ip4/11.42.0.2/tcp/4001/p2p/" + r.ids["relay"]}}
	case "ipv6fw":
		return []labNode{
			{service: "relay", role: "IPv6 WAN Circuit Relay v2 provider"},
			{service: "wan-probe", role: "WAN IPv6 probe node (unsolicited dials)"},
			{service: "a-quic", role: "closed-firewall QUIC peer A"},
			{service: "b-quic", role: "closed-firewall QUIC peer B"},
			{service: "a-tcp", role: "closed-firewall TCP peer A"},
			{service: "b-tcp", role: "closed-firewall TCP peer B"},
			{service: "a-relay", role: "IPv6 relay-only peer A (DCUtR off)"},
			{service: "b-relay", role: "IPv6 relay-only peer B (DCUtR off)"},
			{service: "one-a", role: "one-sided variant open-site peer A"},
			{service: "one-b", role: "one-sided variant closed-site peer B"},
		}, []labRelay{{service: "relay", addr: "/ip6/fd00:360:0::2/tcp/4001/p2p/" + r.ids["relay"]}}
	case "dualnat":
		return []labNode{
			{service: "r1", role: "WAN relay R1"},
			{service: "r2", role: "WAN relay R2 (failover)"},
			{service: "a-quic", role: "dual-NAT QUIC peer A"},
			{service: "b-quic", role: "dual-NAT QUIC peer B"},
			{service: "a-tcp", role: "dual-NAT TCP peer A (direct expected BLOCKED)"},
			{service: "b-tcp", role: "dual-NAT TCP peer B (direct expected BLOCKED)"},
			{service: "a-relay", role: "relay-only peer A (DCUtR off)"},
			{service: "b-relay", role: "relay-only peer B (DCUtR off)"},
		}, []labRelay{
			{service: "r1", addr: "/ip4/11.41.0.2/tcp/4001/p2p/" + r.ids["r1"]},
			{service: "r2", addr: "/ip4/11.41.0.3/tcp/4001/p2p/" + r.ids["r2"]},
		}
	}
	return nil, nil
}

func (r *runner) labNodeAddrs(st *stackInfo, n labNode, relays []labRelay) []string {
	id := r.ids[n.service]
	relay := func(service string) string {
		for _, rr := range relays {
			if rr.service == service {
				return rr.addr
			}
		}
		return ""
	}
	circuit := func(relayService, peerService string) string {
		base := relay(relayService)
		if base == "" || r.ids[peerService] == "" {
			return ""
		}
		return base + "/p2p-circuit/p2p/" + r.ids[peerService]
	}
	switch st.name {
	case "lan":
		ips := map[string]string{
			"a4": "10.250.1.11", "b4": "10.250.1.12",
			"a6": "fd00:250:1::21", "b6": "fd00:250:1::22",
			"a6only": "fd00:250:1::31", "b6only": "fd00:250:1::32",
			"tcp-a": "10.250.1.41", "tcp-b": "10.250.1.42",
			"udp-a": "10.250.1.51", "udp-b": "10.250.1.52",
			"loss-a": "10.250.1.61", "loss-b": "10.250.1.62",
			"q6-a": "fd00:250:1::71", "q6-b": "fd00:250:1::72",
			"id-a": "fd00:250:1::81", "id-b": "fd00:250:1::82",
			"fb-a": "fd00:250:1::91", "fb-b": "fd00:250:1::92",
		}
		ip := ips[n.service]
		if strings.Contains(ip, ":") {
			return []string{
				"/ip6/" + ip + "/tcp/4001/p2p/" + id,
				"/ip6/" + ip + "/udp/4001/quic-v1/p2p/" + id,
			}
		}
		return []string{
			"/ip4/" + ip + "/tcp/4001/p2p/" + id,
			"/ip4/" + ip + "/udp/4001/quic-v1/p2p/" + id,
		}
	case "onesided":
		if n.service == "pub" {
			return []string{
				"/ip4/11.43.0.10/tcp/4001/p2p/" + id,
				"/ip4/11.43.0.10/udp/4001/quic-v1/p2p/" + id,
			}
		}
		return []string{
			"/ip4/10.252.1.10/tcp/4001/p2p/" + id,
			"/ip4/10.252.1.10/udp/4001/quic-v1/p2p/" + id,
		}
	case "symmetric":
		if n.service == "relay" {
			return []string{relay("relay"), strings.Replace(relay("relay"), "/tcp/4001", "/udp/4001/quic-v1", 1)}
		}
		return []string{circuit("relay", n.service)}
	case "dualnat":
		switch n.service {
		case "r1", "r2":
			base := relay(n.service)
			return []string{base, strings.Replace(base, "/tcp/4001", "/udp/4001/quic-v1", 1)}
		case "a-quic", "b-quic":
			wan := "11.41.0.10"
			if n.service == "b-quic" {
				wan = "11.41.0.11"
			}
			return []string{
				"/ip4/" + wan + "/udp/4001/quic-v1/p2p/" + id,
				circuit("r1", n.service),
				circuit("r2", n.service),
			}
		case "a-tcp", "b-tcp":
			wan := "11.41.0.10"
			if n.service == "b-tcp" {
				wan = "11.41.0.11"
			}
			return []string{
				"/ip4/" + wan + "/tcp/4100/p2p/" + id,
				circuit("r1", n.service),
				circuit("r2", n.service),
			}
		case "a-relay", "b-relay":
			return []string{circuit("r1", n.service), circuit("r2", n.service)}
		}
	case "ipv6fw":
		switch n.service {
		case "relay":
			base := relay("relay")
			return []string{base, strings.Replace(base, "/tcp/4001", "/udp/4001/quic-v1", 1)}
		case "wan-probe":
			return []string{"/ip6/fd00:360:0::20/tcp/4001/p2p/" + id}
		case "a-quic":
			return []string{
				"/ip6/fd00:361:1::10/udp/4001/quic-v1/p2p/" + id,
				circuit("relay", n.service),
				"/ip6/2001:4860:361:1::10/udp/4001/quic-v1/p2p/" + id,
			}
		case "b-quic":
			return []string{
				"/ip6/fd00:362:1::10/udp/4001/quic-v1/p2p/" + id,
				circuit("relay", n.service),
				"/ip6/2001:4860:362:1::10/udp/4001/quic-v1/p2p/" + id,
			}
		case "a-tcp":
			return []string{
				"/ip6/fd00:361:1::11/tcp/4001/p2p/" + id,
				circuit("relay", n.service),
				"/ip6/2001:4860:361:1::11/tcp/4001/p2p/" + id,
			}
		case "b-tcp":
			return []string{
				"/ip6/fd00:362:1::11/tcp/4001/p2p/" + id,
				circuit("relay", n.service),
				"/ip6/2001:4860:362:1::11/tcp/4001/p2p/" + id,
			}
		case "a-relay", "b-relay":
			return []string{circuit("relay", n.service)}
		case "one-a":
			return []string{
				"/ip6/fd00:361:1::13/tcp/4001/p2p/" + id,
				"/ip6/2001:4860:361:1::13/tcp/4001/p2p/" + id,
			}
		case "one-b":
			return []string{
				"/ip6/fd00:362:1::13/tcp/4001/p2p/" + id,
				"/ip6/2001:4860:362:1::13/tcp/4001/p2p/" + id,
			}
		}
	}
	return nil
}

func renderCheatSheet(st *stackInfo, nodes []labNode, relays []labRelay, containers map[string]string, ids map[string]string) string {
	var b strings.Builder
	name := func(service string) string {
		if n := containers[service]; n != "" {
			return n
		}
		return "raminga-lab-" + st.name + "-" + service + "-1"
	}
	exec := func(service, command string) string {
		if strings.HasPrefix(command, "raminga ") && !strings.Contains(command, "--data-dir") {
			command += " --data-dir /data"
		}
		return "docker exec -it " + name(service) + " " + command
	}
	// expectBlocked runs a command that must fail and turns that failure into
	// exit status 0 with an explicit marker, so copy-paste and the literal
	// cheat-sheet self-test both succeed while still showing the real error.
	expectBlocked := func(service, args string) string {
		inner := "raminga " + args + " --data-dir /data"
		return exec(service, "sh -c 'if "+inner+"; then echo UNEXPECTED-SUCCESS; exit 1; else echo expected-BLOCKED; fi'")
	}
	// acceptTCPEither records a real TCP simultaneous-open PASS or a real
	// BLOCKED+Relay fallback. It deliberately does not force either outcome.
	acceptTCPEither := func(service, args string) string {
		inner := "raminga " + args + " --data-dir /data"
		return exec(service, "sh -c 'if "+inner+"; then echo TCP-DIRECT-PASS; else echo TCP-DIRECT-BLOCKED; fi; raminga status --data-dir /data'")
	}
	fmt.Fprintf(&b, "# Raminga 手动 Docker 实验：%s\n\n", st.name)
	fmt.Fprintf(&b, "> 生成时间：%s（compose project `%s`）。`make lab-down LAB=%s` 会删除本文件；再次 `make lab-up` 会重新生成新的 Peer ID。\n\n",
		time.Now().Format("2006-01-02 15:04:05 -07:00"), st.project, st.name)
	b.WriteString("本文件由 `make lab-up LAB=" + st.name + "` 自动生成，所有 Peer ID、容器名和多地址均为本次实际值。\n")
	b.WriteString("Docker 是受控模拟，不是真实公网/NAT 证据。Facility 自检已通过；本实验没有运行任何业务场景，也没有发送聊天。\n")
	b.WriteString("容器内 daemon 未启用 `--enable-test-api`（`raminga status` 可看到 `test_api: false`）。\n\n")
	b.WriteString("## 节点与角色\n\n| 服务 | 容器 | Peer ID | 角色 |\n| --- | --- | --- | --- |\n")
	for _, n := range nodes {
		fmt.Fprintf(&b, "| %s | `%s` | `%s` | %s |\n", n.service, name(n.service), ids[n.service], n.role)
	}
	b.WriteString("\n## 实际多地址\n\n")
	for _, n := range nodes {
		if len(n.addrs) == 0 {
			continue
		}
		fmt.Fprintf(&b, "**%s** (`%s`):\n\n```text\n", n.service, name(n.service))
		for _, addr := range n.addrs {
			b.WriteString(addr + "\n")
		}
		b.WriteString("```\n\n")
	}
	if len(relays) > 0 {
		b.WriteString("## Relay / bootstrap\n\n")
		for _, rr := range relays {
			fmt.Fprintf(&b, "- %s relay: `%s`\n", rr.service, rr.addr)
		}
		b.WriteString("- DHT bootstrap: `[]`（这些 lab 配置关闭了 DHT，relay 通过 `relay.known_relays` 显式配置；不是公网 bootstrap）\n")
		b.WriteString("- `raminga dht status --data-dir /data` 会明确显示 DHT disabled。\n\n")
	} else {
		b.WriteString("## Relay / bootstrap\n\n- 无 relay；DHT bootstrap: `[]`（lab 配置关闭 DHT）。\n\n")
	}

	b.WriteString(renderTUISteps(st, nodes, ids))
	b.WriteString("## 附录：CLI 等价命令（`make lab-verify` 自动执行）\n\n### 通用命令\n\n")
	for _, n := range nodes {
		fmt.Fprintf(&b, "- `%s status --data-dir /data`\n", exec(n.service, "raminga"))
	}
	b.WriteString("\n打开两个终端，分别运行事件流（Ctrl+C 退出，退出码 0）：\n\n```sh\n")
	switch st.name {
	case "lan":
		b.WriteString(exec("a4", "raminga chat events --data-dir /data") + "\n")
		b.WriteString(exec("b4", "raminga chat events --data-dir /data") + "\n")
	case "onesided":
		b.WriteString(exec("peer", "raminga chat events --data-dir /data") + "\n")
		b.WriteString(exec("pub", "raminga chat events --data-dir /data") + "\n")
	case "symmetric":
		b.WriteString(exec("a", "raminga chat events --data-dir /data") + "\n")
		b.WriteString(exec("b", "raminga chat events --data-dir /data") + "\n")
	case "dualnat":
		b.WriteString(exec("a-quic", "raminga chat events --data-dir /data") + "\n")
		b.WriteString(exec("b-quic", "raminga chat events --data-dir /data") + "\n")
	case "ipv6fw":
		b.WriteString(exec("a-quic", "raminga chat events --data-dir /data") + "\n")
		b.WriteString(exec("b-quic", "raminga chat events --data-dir /data") + "\n")
	}
	b.WriteString("```\n\n")

	b.WriteString("## 分步操作\n\n")
	switch st.name {
	case "lan":
		a, bb := "a4", "b4"
		fmt.Fprintf(&b, "1. 在 A 上连接 B（IPv4 TCP）：\n\n```sh\n%s\n```\n\n", exec(a, "raminga connect "+pickAddr(nodes, bb, 0)))
		fmt.Fprintf(&b, "2. A 发消息给 B（B 的事件流应出现 `text=\"...\"`，A 输出 `acked: true`）：\n\n```sh\n%s\n```\n\n", exec(a, "raminga chat send --to "+ids[bb]+" --text \"hello from a4\""))
		fmt.Fprintf(&b, "3. 查看直连证据：\n\n```sh\n%s\n%s\n```\n\n", exec(a, "raminga status --data-dir /data"), exec(a, "raminga peers --data-dir /data"))
		fmt.Fprintf(&b, "4. IPv6 直连（`transport=tcp`, `remote_multiaddr` 含 `/ip6/fd00:250:1::22/`）：\n\n```sh\n%s\n```\n\n", exec("a6", "raminga connect "+pickAddr(nodes, "b6", 0)))
		fmt.Fprintf(&b, "5. IPv6 双向聊天（B→A 走同一 IPv6 TCP 连接；B 的事件流应显示 A 的文本）：\n\n```sh\n%s\n```\n\n", exec("b6", "raminga chat send --to "+ids["a6"]+" --text \"ipv6 back from b6\""))
		fmt.Fprintf(&b, "6. IPv6-only + 仅凭 Peer ID 选址：在 `a6only`/`b6only` 上先封掉 IPv4，再把 B 的 IPv6/IPv4 地址放进 PeerStore（不拨号），最后只给 Peer ID。预期自动选 IPv6 并直连；`connect` 会打印实际地址与尝试记录。\n\n```sh\n%s\n%s\n%s\n%s\n%s\n```\n\n",
			exec("a6only", "sh -c 'iptables -w 5 -A INPUT -s 10.250.1.32 -j DROP; iptables -w 5 -A OUTPUT -d 10.250.1.32 -j DROP'"),
			exec("b6only", "sh -c 'iptables -w 5 -A INPUT -s 10.250.1.31 -j DROP; iptables -w 5 -A OUTPUT -d 10.250.1.31 -j DROP'"),
			exec("a6only", "raminga peers add /ip6/fd00:250:1::32/tcp/4001/p2p/"+ids["b6only"]),
			exec("a6only", "raminga peers add /ip4/10.250.1.32/tcp/4001/p2p/"+ids["b6only"]),
			exec("a6only", "raminga connect "+ids["b6only"]))
		fmt.Fprintf(&b, "7. 仅凭 Peer ID 的聊天（`chat send --to`，不给 multiaddr）：\n\n```sh\n%s\n```\n\n", exec("a6only", "raminga chat send --to "+ids["b6only"]+" --text \"peer-id ipv6 only\""))
		fmt.Fprintf(&b, "8. 全新一对节点上的 IPv6 QUIC（`q6-a`→`q6-b`，预期 `transport=quic direct=true`，地址含 `/ip6/`）：\n\n```sh\n%s\n%s\n```\n\n",
			exec("q6-a", "raminga connect "+pickAddr(nodes, "q6-b", 1)),
			exec("q6-a", "raminga chat send --to "+ids["q6-b"]+" --text \"ipv6 quic fresh pair\""))
		fmt.Fprintf(&b, "9. QUIC 直连：用未被 TCP 连接复用的 `udp-a`→`udp-b` 对，预期 `transport=quic direct=true`：\n\n```sh\n%s\n```\n\n", exec("udp-a", "raminga connect "+pickAddr(nodes, "udp-b", 1)))
		fmt.Fprintf(&b, "10. 复用提示：对已有连接再执行 `connect <同一 peer 的另一个传输地址>`，预期 `reused: true`；若请求的传输与现有连接不同，会打印 `requested_transport` 与 `transport_changed: true`。\n\n```sh\n%s\n```\n\n", exec("q6-a", "raminga connect "+pickAddr(nodes, "q6-b", 0)))
		fmt.Fprintf(&b, "11. UDP 封锁对 `tcp-a`/`tcp-b` 仅在手工加入 iptables 后生效；先加 UDP DROP，QUIC 应失败而 TCP 仍可用：\n\n```sh\n%s\n%s\n%s\n```\n\n",
			exec("tcp-a", "sh -c 'iptables -w 5 -C INPUT -p udp --dport 4001 -j DROP 2>/dev/null || iptables -w 5 -A INPUT -p udp --dport 4001 -j DROP; iptables -w 5 -C OUTPUT -p udp --dport 4001 -j DROP 2>/dev/null || iptables -w 5 -A OUTPUT -p udp --dport 4001 -j DROP'"),
			expectBlocked("tcp-a", "connect "+pickAddr(nodes, "tcp-b", 1)),
			exec("tcp-a", "raminga connect "+pickAddr(nodes, "tcp-b", 0)))
		fmt.Fprintf(&b, "12. netem 动作（只在 `loss-a` 注入，属于手动设施步骤）：\n\n```sh\n%s\n%s\n```\n\n",
			exec("loss-a", "tc qdisc replace dev eth0 root netem delay 120ms 20ms loss 10%"),
			exec("loss-a", "tc qdisc show dev eth0"))
	case "onesided":
		fmt.Fprintf(&b, "1. 先（在任何连接建立前）从 `pub` 反向拨 `peer`，必须失败：`pub` 只能路由 WAN，没有进入 `10.252.1.0/24` 的路由，NAT 也没有入站映射。\n\n```sh\n%s\n```\n\n", expectBlocked("pub", "connect /ip4/10.252.1.10/tcp/4001/p2p/"+ids["peer"]))
		fmt.Fprintf(&b, "2. 唯一可行方向：NAT 后的 `peer` 主动拨公网 `pub`。\n\n```sh\n%s\n```\n\n", exec("peer", "raminga connect "+pickAddr(nodes, "pub", 0)))
		fmt.Fprintf(&b, "3. `peer` 发消息给 `pub`，`pub` 的事件流显示 `text=\"hello from peer\"`：\n\n```sh\n%s\n```\n\n", exec("peer", "raminga chat send --to "+ids["pub"]+" --text \"hello from peer\""))
		fmt.Fprintf(&b, "4. 反向**应用消息**可以通过已建立的连接回送；这不是反向可达性证明：\n\n```sh\n%s\n```\n\n", exec("pub", "raminga chat send --to "+ids["peer"]+" --text \"hello back from pub\""))
		fmt.Fprintf(&b, "   连接建立后 `raminga connect /ip4/10.252.1.10/tcp/4001/p2p/%s` 可能复用现有连接而返回成功；要验证入站封锁，请先重启两侧 daemon 或在连接建立前执行步骤 1。\n\n", ids["peer"])
		fmt.Fprintf(&b, "5. 在 NAT 路由器看真实映射：\n\n```sh\n%s\n```\n\n", exec("nat", "conntrack -L"))
	case "ipv6fw":
		fmt.Fprintf(&b, "1. 先在任何连接建立前，从 WAN 上的 `wan-probe` 主动拨 `a-tcp` 的站点内地址。两侧路由器 FORWARD 默认 DROP，且没有任何 4001 白名单，预期真实超时（不是 `dial backoff`）：\n\n```sh\n%s\n```\n\n", expectBlocked("wan-probe", "connect /ip6/fd00:361:1::11/tcp/4001/p2p/"+ids["a-tcp"]))
		fmt.Fprintf(&b, "2. 在 `a-quic` 上经 IPv6 Relay 连接 `b-quic`（初始一定是 limited relay）：\n\n```sh\n%s\n```\n\n", exec("a-quic", "raminga connect "+pickAddr(nodes, "b-quic", 1)))
		fmt.Fprintf(&b, "3. A → B 消息；`b-quic` 的事件流应显示文本：\n\n```sh\n%s\n```\n\n", exec("a-quic", "raminga chat send --to "+ids["b-quic"]+" --text \"ipv6fw relay hello\""))
		fmt.Fprintf(&b, "4. 等待 DCUtR（通常几秒，最多约 25 秒）：\n\n```sh\n%s\n```\n\n", exec("a-quic", "sh -c 'sleep 25'"))
		fmt.Fprintf(&b, "5. 证明 IPv6 QUIC direct：`status`/`peers` 中目标 peer 为 `transport=quic route=direct direct=true limited=false`，地址含 `/ip6/` 且不含 `/p2p-circuit`：\n\n```sh\n%s\n%s\n```\n\n",
			exec("a-quic", "raminga status --data-dir /data"), exec("a-quic", "raminga peers --data-dir /data"))
		fmt.Fprintf(&b, "6. 双向 direct ACK：\n\n```sh\n%s\n%s\n```\n\n",
			exec("a-quic", "raminga chat send --to "+ids["b-quic"]+" --text \"ipv6fw direct from a\""),
			exec("b-quic", "raminga chat send --to "+ids["a-quic"]+" --text \"ipv6fw direct from b\""))
		tcpDirect := "raminga connect " + pickAddr(nodes, "b-tcp", 0) + " --data-dir /data"
		fmt.Fprintf(&b, "7. TCP direct 可能 PASS 或 BLOCKED；两种结果都如实打印，绝不把 relay 写成 direct：\n\n```sh\n%s\n```\n\n",
			exec("a-tcp", "sh -c 'if "+tcpDirect+"; then echo TCP-DIRECT-PASS; else echo TCP-DIRECT-BLOCKED; fi'"))
		fmt.Fprintf(&b, "8. 经 IPv6 Relay 回退并聊天（无论上一步 TCP 是否 direct，都必须能 ACK）：\n\n```sh\n%s\n%s\n```\n\n",
			exec("a-tcp", "raminga connect "+pickAddr(nodes, "b-tcp", 1)),
			exec("a-tcp", "raminga chat send --to "+ids["b-tcp"]+" --text \"ipv6fw tcp fallback\""))
		fmt.Fprintf(&b, "9. 停掉唯一的 IPv6 Relay，QUIC direct 必须仍在：\n\n```sh\ndocker stop %s\n%s\n%s\n%s\n```\n\n",
			name("relay"),
			exec("a-quic", "raminga status --data-dir /data"),
			exec("a-quic", "raminga chat send --to "+ids["b-quic"]+" --text \"ipv6fw still direct after relay stop\""),
			exec("b-quic", "raminga chat send --to "+ids["a-quic"]+" --text \"ipv6fw still direct from b\""))
		fmt.Fprintf(&b, "10. 单侧防火墙变体：把 site A 的 FORWARD 改为 ACCEPT（site B 仍 DROP）。closed→open 直连应成功；open→closed 主动拨号必须失败。\n\n```sh\n%s\n%s\n%s\n%s\n```\n\n",
			exec("fw-a", "sh -c 'ip6tables -w 5 -F FORWARD; ip6tables -w 5 -P FORWARD ACCEPT'"),
			expectBlocked("one-a", "connect /ip6/fd00:362:1::13/tcp/4001/p2p/"+ids["one-b"]),
			exec("one-b", "raminga connect /ip6/fd00:361:1::13/tcp/4001/p2p/"+ids["one-a"]),
			exec("one-b", "raminga chat send --to "+ids["one-a"]+" --text \"one-sided closed to open\""))
		fmt.Fprintf(&b, "11. 反向应用消息走同一条已建立连接（不证明 open→closed 入站可达）：\n\n```sh\n%s\n```\n\n", exec("one-a", "raminga chat send --to "+ids["one-b"]+" --text \"one-sided reply over established conn\""))
		fmt.Fprintf(&b, "12. 查看真实 IPv6 conntrack 与防火墙规则（无 4001 白名单、无 DNAT）：\n\n```sh\n%s\n%s\n%s\n%s\n```\n\n",
			exec("fw-a", "sh -c 'conntrack -L -f ipv6 -p udp 2>/dev/null | head -10; ip6tables -w 5 -S FORWARD'"),
			exec("fw-b", "sh -c 'conntrack -L -f ipv6 -p udp 2>/dev/null | head -10; ip6tables -w 5 -S FORWARD'"),
			exec("fw-a", "ip6tables -w 5 -S"),
			exec("fw-b", "ip6tables -w 5 -S"))
	case "symmetric":
		fmt.Fprintf(&b, "1. 在 A 上经唯一可行路径连接 B（Circuit Relay）：\n\n```sh\n%s\n```\n\n", exec("a", "raminga connect "+pickAddr(nodes, "b", 0)))
		fmt.Fprintf(&b, "2. A → B 消息；事件应显示 `route=relay direct=false limited=true`：\n\n```sh\n%s\n```\n\n", exec("a", "raminga chat send --to "+ids["b"]+" --text \"symmetric relay only\""))
		fmt.Fprintf(&b, "3. 查看诊断（不应出现 direct；DCUtR 只会有真实失败/尝试）：\n\n```sh\n%s\n%s\n%s\n```\n\n",
			exec("a", "raminga status --data-dir /data"), exec("a", "raminga relay status --data-dir /data"), exec("a", "raminga network status --data-dir /data"))
		fmt.Fprintf(&b, "4. NAT 映射：\n\n```sh\n%s\n%s\n```\n\n", exec("nat-a", "conntrack -L"), exec("nat-b", "conntrack -L"))
	case "dualnat":
		fmt.Fprintf(&b, "1. 在 `a-quic` 上经 R1 连接 `b-quic`（初始一定是 limited relay）：\n\n```sh\n%s\n```\n\n", exec("a-quic", "raminga connect "+pickAddr(nodes, "b-quic", 1)))
		fmt.Fprintf(&b, "2. A → B 消息；等待 DCUtR 后 `status` 应出现 direct QUIC：\n\n```sh\n%s\n```\n\n", exec("a-quic", "raminga chat send --to "+ids["b-quic"]+" --text \"dualnat hello\""))
		fmt.Fprintf(&b, "3. 证明 direct：`status` 显示到目标 peer 的 `transport=quic route=direct direct=true limited=false`；`peers` 中该 peer 的 `addrs` 应含 `/ip4/11.41.0.11/udp/4001/quic-v1`，且所有 relay 停止后仍保留：\n\n```sh\n%s\n%s\n```\n\n",
			exec("a-quic", "raminga status --data-dir /data"), exec("a-quic", "raminga peers --data-dir /data"))
		fmt.Fprintf(&b, "4. TCP 双 NAT direct **通常 BLOCKED，偶见 simultaneous-open 成功**：`connect` TCP 直连地址通常失败后回退 relay，Docker 中偶尔直接成功；两种都按真实日志记录，不得把 attempt/relay 写成 direct：\n\n```sh\n%s\n%s\n```\n\n",
			acceptTCPEither("a-tcp", "connect "+pickAddr(nodes, "b-tcp", 0)),
			exec("a-tcp", "raminga connect "+pickAddr(nodes, "b-tcp", 1)))
		fmt.Fprintf(&b, "5. relay-only 对（DCUtR 关闭）必须始终 limited relay：\n\n```sh\n%s\n%s\n```\n\n",
			exec("a-relay", "raminga connect "+pickAddr(nodes, "b-relay", 0)),
			exec("a-relay", "raminga peers --data-dir /data"))
		fmt.Fprintf(&b, "6. 在 NAT 路由器看 conntrack（UDP 4001 / TCP 4100）：\n\n```sh\n%s\n%s\n%s\n```\n\n",
			exec("nat-a", "conntrack -L -p udp"), exec("nat-b", "conntrack -L -p udp"), exec("nat-a", "conntrack -L -p tcp"))
		fmt.Fprintf(&b, "7. 最后停掉两个 relay，连接必须仍然 direct 且可聊天：\n\n```sh\ndocker stop %s %s\n%s\n%s\n%s\n```\n\n",
			name("r1"), name("r2"),
			exec("a-quic", "raminga status --data-dir /data"),
			exec("a-quic", "raminga chat send --to "+ids["b-quic"]+" --text \"still direct after relay stop\""),
			exec("b-quic", "raminga chat send --to "+ids["a-quic"]+" --text \"direct from b\""))
		fmt.Fprintf(&b, "   重新启动 relay：`docker start %s %s`；relay 重启后预约需要几秒恢复，等待 `relay status` 显示 active 再做 relay 相关操作。\n\n", name("r1"), name("r2"))
	}
	b.WriteString("## 停止 / 恢复 / 清理\n\n")
	b.WriteString("- 停止全部：`make lab-down LAB=" + st.name + "`（会删除本项目容器、网络、volume）\n")
	stopExample := ""
	if len(relays) > 0 {
		stopExample = name(relays[0].service)
	} else if len(nodes) > 0 {
		stopExample = name(nodes[0].service)
	}
	fmt.Fprintf(&b, "- 只停节点：`docker stop %s`（上表中任意容器名）；只停 relay 用于验证 direct 存活。\n", stopExample)
	b.WriteString("- 重新启动整个 lab：`make lab-up LAB=" + st.name + "`（会先清掉本项目的旧资源）。\n")
	b.WriteString("- 本文件路径：`.local/lab/" + st.name + ".md`\n")
	return b.String()
}

func pickAddr(nodes []labNode, service string, index int) string {
	for _, n := range nodes {
		if n.service != service {
			continue
		}
		if index < len(n.addrs) {
			return n.addrs[index]
		}
		if len(n.addrs) > 0 {
			return n.addrs[0]
		}
	}
	return ""
}
