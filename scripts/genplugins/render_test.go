package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/Raminga/raminga/agent"
)

func realLaunchers(t *testing.T) ([]byte, []byte) {
	t.Helper()
	sh, err := os.ReadFile(filepath.Join("..", "..", "plugins", "shared", "launcher", "launcher.sh"))
	if err != nil {
		t.Fatalf("read launcher.sh template: %v", err)
	}
	ps1, err := os.ReadFile(filepath.Join("..", "..", "plugins", "shared", "launcher", "launcher.ps1"))
	if err != nil {
		t.Fatalf("read launcher.ps1 template: %v", err)
	}
	return sh, ps1
}

func renderFixture(t *testing.T) map[string][]byte {
	t.Helper()
	sh, ps1 := realLaunchers(t)
	in, err := loadRenderInputs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("loadRenderInputs: %v", err)
	}
	files, err := render(sh, ps1, in)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	return files
}

func fixtureVersion(t *testing.T) string {
	t.Helper()
	in, err := loadRenderInputs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("loadRenderInputs: %v", err)
	}
	return in.Version
}

func TestRenderProducesBothShells(t *testing.T) {
	files := renderFixture(t)

	for _, path := range []string{
		".claude-plugin/marketplace.json",
		"plugins/claude/.claude-plugin/plugin.json",
		"plugins/claude/.mcp.json",
		"plugins/claude/skills/raminga/SKILL.md",
		"plugins/claude/bin/raminga-launcher.sh",
		"plugins/codex/plugin.json",
		"plugins/codex/mcp.json",
		"plugins/codex/skills/raminga/SKILL.md",
		"plugins/codex/skills/raminga-onboarding/SKILL.md",
		"plugins/codex/bin/raminga-launcher.ps1",
		"plugins/dsh/package.json",
		"plugins/dsh/src/tools.generated.ts",
		"plugins/dsh/src/untrusted.generated.ts",
		"cmd/raminga/version_default.go",
	} {
		if _, ok := files[path]; !ok {
			t.Errorf("render missing %s", path)
		}
	}

	for _, path := range []string{"plugins/claude/bin/raminga-launcher.sh", "plugins/codex/bin/raminga-launcher.ps1"} {
		if strings.Contains(string(files[path]), "__RAMINGA_RELEASE_") {
			t.Errorf("%s still contains an unsubstituted token", path)
		}
		if !strings.Contains(string(files[path]), fixtureVersion(t)) {
			t.Errorf("%s does not contain the pinned version %q", path, fixtureVersion(t))
		}
	}
}

func TestRenderClaudePluginJSONIsValid(t *testing.T) {
	files := renderFixture(t)
	var manifest struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Author  struct {
			Name string `json:"name"`
		} `json:"author"`
		License  string   `json:"license"`
		Keywords []string `json:"keywords"`
	}
	if err := json.Unmarshal(files["plugins/claude/.claude-plugin/plugin.json"], &manifest); err != nil {
		t.Fatalf("plugin.json is not valid JSON: %v", err)
	}
	if manifest.Name != "raminga" || manifest.Version != fixtureVersion(t) {
		t.Fatalf("plugin.json name/version = %q/%q", manifest.Name, manifest.Version)
	}
	if manifest.License != "Apache-2.0" || manifest.Author.Name != "Raminga" {
		t.Fatalf("plugin.json license/author = %q/%q", manifest.License, manifest.Author.Name)
	}
	if len(manifest.Keywords) < 3 {
		t.Fatalf("plugin.json needs 3+ keywords, got %d", len(manifest.Keywords))
	}
}

func TestRenderCodexPluginJSONHasOnboardingSkill(t *testing.T) {
	files := renderFixture(t)
	var manifest struct {
		Name       string `json:"name"`
		Extensions struct {
			OpenAI struct {
				OnboardingSkill string `json:"onboardingSkill"`
			} `json:"com.openai"`
		} `json:"extensions"`
	}
	if err := json.Unmarshal(files["plugins/codex/plugin.json"], &manifest); err != nil {
		t.Fatalf("codex plugin.json is not valid JSON: %v", err)
	}
	if manifest.Name != "raminga" {
		t.Fatalf("codex plugin.json name = %q", manifest.Name)
	}
	want := "./skills/raminga-onboarding/SKILL.md"
	if manifest.Extensions.OpenAI.OnboardingSkill != want {
		t.Fatalf("onboardingSkill = %q, want %q", manifest.Extensions.OpenAI.OnboardingSkill, want)
	}
}

func TestRenderClaudeMCPJSONUsesShellLauncher(t *testing.T) {
	files := renderFixture(t)
	var cfg struct {
		Servers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(files["plugins/claude/.mcp.json"], &cfg); err != nil {
		t.Fatalf("claude .mcp.json is not valid JSON: %v", err)
	}
	server := cfg.Servers["raminga"]
	if server.Command != "sh" {
		t.Fatalf("command = %q, want sh", server.Command)
	}
	want := "${CLAUDE_PLUGIN_ROOT}/bin/raminga-launcher.sh"
	if len(server.Args) != 1 || server.Args[0] != want {
		t.Fatalf("args = %v, want [%s]", server.Args, want)
	}
}

func TestRenderCodexMCPJSONIsStdio(t *testing.T) {
	files := renderFixture(t)
	var cfg struct {
		Schema  string `json:"$schema"`
		Servers map[string]struct {
			Type    string   `json:"type"`
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(files["plugins/codex/mcp.json"], &cfg); err != nil {
		t.Fatalf("codex mcp.json is not valid JSON: %v", err)
	}
	if cfg.Schema != "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" {
		t.Fatalf("codex mcp.json $schema = %q", cfg.Schema)
	}
	server, ok := cfg.Servers["raminga"]
	if !ok {
		t.Fatal("codex mcp.json has no raminga server")
	}
	// Agent Plugins forbids placeholder expansion in `command`; the plugin
	// root variable belongs in args instead.
	if server.Type != "stdio" || server.Command != "sh" {
		t.Fatalf("raminga server = %+v, want stdio sh", server)
	}
	want := "${PLUGIN_ROOT}/bin/raminga-launcher.sh"
	if len(server.Args) != 1 || server.Args[0] != want {
		t.Fatalf("args = %v, want [%s]", server.Args, want)
	}
}

func TestRenderOnboardingSkillWrapsFirstUse(t *testing.T) {
	files := renderFixture(t)
	onboarding := string(files["plugins/codex/skills/raminga-onboarding/SKILL.md"])
	if !strings.HasPrefix(onboarding, "---\nname: raminga-onboarding\n") {
		t.Fatal("onboarding skill missing frontmatter")
	}
	firstUse, err := agent.Guidance("first-use.md")
	if err != nil {
		t.Fatalf("Guidance(first-use.md): %v", err)
	}
	if !strings.Contains(onboarding, string(firstUse)) {
		t.Fatal("onboarding skill must embed the first-use guidance")
	}
}

func TestRenderSkillListsEveryTool(t *testing.T) {
	files := renderFixture(t)
	skill := string(files["plugins/codex/skills/raminga/SKILL.md"])
	if !strings.HasPrefix(skill, "---\nname: raminga\n") {
		t.Fatal("SKILL.md missing frontmatter")
	}
	catalog, err := agent.ToolCatalog()
	if err != nil {
		t.Fatalf("ToolCatalog: %v", err)
	}
	for _, tool := range catalog.Tools {
		if !strings.Contains(skill, "- `"+tool.Name+"`") {
			t.Errorf("SKILL.md missing tool %q", tool.Name)
		}
	}
}

func TestRenderSkillIsSelfContained(t *testing.T) {
	files := renderFixture(t)
	for _, path := range []string{
		"plugins/claude/skills/raminga/SKILL.md",
		"plugins/codex/skills/raminga/SKILL.md",
	} {
		skill := string(files[path])
		for _, want := range []string{
			"# Raminga Agent guide",
			"## Core rules",
			"## First use",
			"## Journey workflow",
			"## Data contract",
			"## Session file examples",
			"### state.json",
			"### events.jsonl",
			"### report.md",
			`"session_id": "replace-with-session-id"`,
			`"event_id": "replace-with-unique-event-id"`,
			"# Journey Report",
			"current_time",
			"mode `0700`",
			"`raminga_agent_init`",
		} {
			if !strings.Contains(skill, want) {
				t.Errorf("%s missing self-contained content %q", path, want)
			}
		}
		if strings.Contains(skill, "references/core.md") {
			t.Errorf("%s still points at a sibling reference file", path)
		}
	}
	for path := range files {
		if strings.Contains(path, "/references/") {
			t.Errorf("render still produces a reference file %s", path)
		}
	}
}

func TestWriteAndCheckRoundTrip(t *testing.T) {
	files := renderFixture(t)

	root := t.TempDir()
	if err := writeFiles(root, files); err != nil {
		t.Fatalf("writeFiles: %v", err)
	}
	if err := checkFiles(root, files); err != nil {
		t.Fatalf("checkFiles after clean write: %v", err)
	}

	edited := clone(files)
	edited["plugins/codex/skills/raminga/SKILL.md"] = append([]byte("// hand edit\n"), edited["plugins/codex/skills/raminga/SKILL.md"]...)
	if err := checkFiles(root, edited); err == nil {
		t.Fatal("checkFiles must detect a hand-edited generated file")
	}

	stale := clone(files)
	delete(stale, "plugins/codex/skills/raminga/SKILL.md")
	if err := checkFiles(root, stale); err == nil {
		t.Fatal("checkFiles must detect a stale generated file")
	}
}

func TestWritePreservesHandAuthoredAndRemovesStale(t *testing.T) {
	files := renderFixture(t)
	root := t.TempDir()
	if err := writeFiles(root, files); err != nil {
		t.Fatalf("writeFiles: %v", err)
	}

	// Simulate the committed hand-authored Codex agent config.
	hand := filepath.Join(root, "plugins", "codex", "openai.yaml")
	if err := os.MkdirAll(filepath.Dir(hand), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hand, []byte("interface: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	reduced := clone(files)
	delete(reduced, "plugins/codex/skills/raminga/SKILL.md")
	if err := writeFiles(root, reduced); err != nil {
		t.Fatalf("writeFiles (reduced): %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "plugins", "codex", "skills", "raminga", "SKILL.md")); !os.IsNotExist(err) {
		t.Fatal("stale generated file still exists after regenerate")
	}
	if _, err := os.Stat(hand); err != nil {
		t.Fatalf("hand-authored openai.yaml was removed: %v", err)
	}
}

func clone(m map[string][]byte) map[string][]byte {
	out := make(map[string][]byte, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func TestRenderDSHToolsUsesSingleSource(t *testing.T) {
	files := renderFixture(t)
	generated := string(files["plugins/dsh/src/tools.generated.ts"])
	catalog, err := agent.ToolCatalog()
	if err != nil {
		t.Fatalf("ToolCatalog: %v", err)
	}
	for _, tool := range catalog.Tools {
		if !strings.Contains(generated, "name: "+strconv.Quote(tool.Name)) {
			t.Errorf("DSH generated tools missing %q", tool.Name)
		}
		if tool.Description != "" && !strings.Contains(generated, tsString(tool.Description)) {
			t.Errorf("DSH generated tools missing description for %q", tool.Name)
		}
		if tool.ResultUntrusted && !strings.Contains(generated, "resultUntrusted: true") {
			t.Errorf("DSH generated tools must mark an untrusted tool")
		}
	}
	if !strings.Contains(generated, "CONFIRM_TOOLS") {
		t.Error("DSH generated tools must export CONFIRM_TOOLS")
	}
	if !strings.Contains(generated, "AGENT_ONBOARDING_FILES") {
		t.Error("DSH generated tools must export AGENT_ONBOARDING_FILES")
	}
	for _, want := range []string{
		"## Core rules",
		"## Journey workflow",
		"## Data contract",
		"## Session file examples",
		"current_time",
		"agent/sessions/",
	} {
		if !strings.Contains(generated, want) {
			t.Errorf("DSH generated tools must embed the self-contained guide (%q missing)", want)
		}
	}
}

func TestWriteFilesMakesShellExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits are not meaningful on Windows")
	}
	files := renderFixture(t)
	root := t.TempDir()
	if err := writeFiles(root, files); err != nil {
		t.Fatalf("writeFiles: %v", err)
	}
	for _, rel := range []string{
		"plugins/claude/bin/raminga-launcher.sh",
		"plugins/codex/bin/raminga-launcher.sh",
	} {
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Errorf("%s mode = %o, want executable", rel, info.Mode().Perm())
		}
	}
}

func TestRenderMarketplaceAndDSHPackageVersions(t *testing.T) {
	files := renderFixture(t)
	version := fixtureVersion(t)

	var marketplace struct {
		Owner struct {
			Name  string `json:"name"`
			Email string `json:"email"`
			URL   string `json:"url"`
		} `json:"owner"`
		Plugins []struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Author  struct {
				Email string `json:"email"`
				URL   string `json:"url"`
			} `json:"author"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(files[".claude-plugin/marketplace.json"], &marketplace); err != nil {
		t.Fatalf("marketplace.json is not valid JSON: %v", err)
	}
	if marketplace.Owner.Email != "" {
		t.Fatalf("marketplace owner still has an email: %q", marketplace.Owner.Email)
	}
	if marketplace.Owner.Name != "Raminga" || marketplace.Owner.URL != pluginHomepage {
		t.Fatalf("marketplace owner = %+v", marketplace.Owner)
	}
	found := false
	for _, plugin := range marketplace.Plugins {
		if plugin.Name != "raminga" {
			continue
		}
		found = true
		if plugin.Version != version {
			t.Fatalf("marketplace plugin version = %q, want %q", plugin.Version, version)
		}
		if plugin.Author.Email != "" || plugin.Author.URL != pluginHomepage {
			t.Fatalf("marketplace plugin author = %+v", plugin.Author)
		}
	}
	if !found {
		t.Fatal("marketplace.json has no raminga plugin")
	}

	var pkg struct {
		Name                 string            `json:"name"`
		Version              string            `json:"version"`
		OptionalDependencies map[string]string `json:"optionalDependencies"`
		Description          string            `json:"description"`
		Main                 string            `json:"main"`
	}
	if err := json.Unmarshal(files["plugins/dsh/package.json"], &pkg); err != nil {
		t.Fatalf("plugins/dsh/package.json is not valid JSON: %v", err)
	}
	if pkg.Name != "@raminga/dsh" || pkg.Version != version {
		t.Fatalf("dsh package name/version = %q/%q", pkg.Name, pkg.Version)
	}
	if pkg.Description == "" || pkg.Main != "./lib/index.js" {
		t.Fatal("dsh package lost hand-maintained fields")
	}
	if len(pkg.OptionalDependencies) != len(dshPlatformPackages) {
		t.Fatalf("optionalDependencies = %v", pkg.OptionalDependencies)
	}
	for _, name := range dshPlatformPackages {
		if got := pkg.OptionalDependencies[name]; got != version {
			t.Errorf("%s = %q, want %q", name, got, version)
		}
	}
}

func TestRenderDefaultVersionGoUsesVERSION(t *testing.T) {
	files := renderFixture(t)
	generated := string(files["cmd/raminga/version_default.go"])
	want := "const defaultVersion = " + strconv.Quote(fixtureVersion(t))
	if !strings.Contains(generated, want) {
		t.Fatalf("version_default.go missing %q:\n%s", want, generated)
	}
}

func TestSnapshotVersionTemplateMatchesVERSION(t *testing.T) {
	version := fixtureVersion(t)
	config, err := os.ReadFile(filepath.Join("..", "..", ".goreleaser.yaml"))
	if err != nil {
		t.Fatalf("read .goreleaser.yaml: %v", err)
	}
	want := `version_template: "` + version + `-snapshot-{{ .ShortCommit }}"`
	if !strings.Contains(string(config), want) {
		t.Fatalf(".goreleaser.yaml snapshot template must contain %q", want)
	}
}
