package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"

	"github.com/Raminga/raminga/agent"
	"github.com/Raminga/raminga/internal/untrusted"
)

// Release metadata injected into every generated shell. P6 (the release
// pipeline) must keep these in sync with the tag that produces the GitHub
// Release assets the launcher downloads.
const (
	releaseVersion    = "0.1.0"
	releaseRepo       = "Raminga/raminga"
	pluginName        = "raminga"
	pluginAuthorName  = "Raminga"
	pluginAuthorEmail = "devnull@raminga.invalid" // placeholder; replace before publishing
	pluginLicense     = "Apache-2.0"
	pluginHomepage    = "https://github.com/Raminga/raminga"
)

var pluginKeywords = []string{"p2p", "social", "agent", "decentralized", "raminga"}

// generatedRoots are the plugin-shell directories genplugins owns (in whole or
// in part). Stale-file detection walks only these, so a hand-authored file
// anywhere else is never touched.
var generatedRoots = []string{"plugins/claude", "plugins/codex"}

// handAuthoredFiles are files under a generatedRoot that genplugins does not
// produce and must preserve: the legacy Codex agent config relocated in P1 and
// superseded by the Codex plugin manifest.
var handAuthoredFiles = map[string]bool{
	"plugins/codex/openai.yaml": true,
}

// launcherTokens are the placeholders in plugins/shared/launcher templates that
// genplugins substitutes with the release metadata above.
var launcherTokens = []struct{ token, value string }{
	{"__RAMINGA_RELEASE_VERSION__", releaseVersion},
	{"__RAMINGA_RELEASE_REPO__", releaseRepo},
}

// render produces every generated file (repo-relative forward-slash path ->
// bytes) for the Claude Code and Codex shells, from the single-source agent
// content and the launcher templates. All output is LF and deterministic so
// `genplugins --check` can diff byte-for-byte.
func render(launcherSH, launcherPS1 []byte) (map[string][]byte, error) {
	catalog, err := agent.ToolCatalog()
	if err != nil {
		return nil, err
	}
	guidance, err := loadGuidance()
	if err != nil {
		return nil, err
	}
	guide, err := renderAgentGuide(catalog, guidance)
	if err != nil {
		return nil, err
	}
	sh := substitute(launcherSH)
	ps1 := substitute(launcherPS1)

	out := map[string][]byte{
		"plugins/claude/.claude-plugin/plugin.json": renderClaudePluginJSON(),
		"plugins/claude/.mcp.json":                  renderClaudeMCPJSON(),
		"plugins/claude/bin/raminga-launcher.sh":    sh,
		"plugins/claude/bin/raminga-launcher.ps1":   ps1,

		"plugins/codex/plugin.json":                        renderCodexPluginJSON(),
		"plugins/codex/mcp.json":                           renderCodexMCPJSON(),
		"plugins/codex/bin/raminga-launcher.sh":            sh,
		"plugins/codex/bin/raminga-launcher.ps1":           ps1,
		"plugins/codex/skills/raminga-onboarding/SKILL.md": renderOnboardingSkill(guidance["first-use.md"]),

		"plugins/dsh/src/tools.generated.ts":     renderDSHTools(catalog, guide),
		"plugins/dsh/src/untrusted.generated.ts": renderDSHUntrusted(),
	}
	addSkill(out, "plugins/claude", guide)
	addSkill(out, "plugins/codex", guide)
	return out, nil
}

// addSkill writes the self-contained operational SKILL.md for one shell. The
// body is generated from agent/ guidance and templates; there are no
// references/ files, because hosts may deny reads outside the skill entry
// point (Claude Code does so unless the plugin directory is allowlisted).
func addSkill(out map[string][]byte, prefix string, guide []byte) {
	out[prefix+"/skills/raminga/SKILL.md"] = renderSkill(guide)
}

func loadGuidance() (map[string][]byte, error) {
	guidance := make(map[string][]byte, 4)
	for _, name := range []string{"core", "journey", "first-use", "data-contract"} {
		b, err := agent.Guidance(name + ".md")
		if err != nil {
			return nil, err
		}
		guidance[name+".md"] = b
	}
	return guidance, nil
}

func substitute(src []byte) []byte {
	s := string(src)
	for _, t := range launcherTokens {
		s = strings.ReplaceAll(s, t.token, t.value)
	}
	return []byte(s)
}

// author is the plugin author object shared by both manifests.
type author struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

// claudePluginManifest is the .claude-plugin/plugin.json shape.
type claudePluginManifest struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Author      author   `json:"author"`
	License     string   `json:"license"`
	Keywords    []string `json:"keywords"`
	Homepage    string   `json:"homepage"`
	Repository  string   `json:"repository"`
}

func renderClaudePluginJSON() []byte {
	return marshalJSON(claudePluginManifest{
		Name:    pluginName,
		Version: releaseVersion,
		Description: "Operate a local Raminga Node from Claude Code: run bounded, " +
			"evidence-backed social journeys, visit peers, exchange chat, and manage " +
			"private Agent memory over a decentralized P2P network.",
		Author:     author{Name: pluginAuthorName, Email: pluginAuthorEmail},
		License:    pluginLicense,
		Keywords:   pluginKeywords,
		Homepage:   pluginHomepage,
		Repository: pluginHomepage,
	})
}

// codexPluginManifest is the Codex root plugin.json shape (portable Agent
// Plugins format): the OpenAI-specific onboarding skill lives under
// extensions["com.openai"], which is what distinguishes it from the legacy
// .codex-plugin/plugin.json fallback.
type codexPluginManifest struct {
	Schema      string          `json:"$schema"`
	Name        string          `json:"name"`
	Version     string          `json:"version"`
	Description string          `json:"description"`
	Author      author          `json:"author"`
	License     string          `json:"license"`
	Keywords    []string        `json:"keywords"`
	Homepage    string          `json:"homepage"`
	Repository  string          `json:"repository"`
	Extensions  codexExtensions `json:"extensions"`
}

type codexExtensions struct {
	OpenAI codexOpenAI `json:"com.openai"`
}

type codexOpenAI struct {
	OnboardingSkill string `json:"onboardingSkill"`
}

func renderCodexPluginJSON() []byte {
	return marshalJSON(codexPluginManifest{
		Schema:  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
		Name:    pluginName,
		Version: releaseVersion,
		Description: "Operate a local Raminga Node from Codex: run bounded, " +
			"evidence-backed social journeys, visit peers, exchange chat, and manage " +
			"private Agent memory over a decentralized P2P network.",
		Author:     author{Name: pluginAuthorName, Email: pluginAuthorEmail},
		License:    pluginLicense,
		Keywords:   pluginKeywords,
		Homepage:   pluginHomepage,
		Repository: pluginHomepage,
		Extensions: codexExtensions{
			OpenAI: codexOpenAI{
				OnboardingSkill: "./skills/raminga-onboarding/SKILL.md",
			},
		},
	})
}

// claudeMCPConfig is the Claude Code .mcp.json shape. The command is the shell
// (a bare executable token) and the launcher path is an argument, because the
// committed launcher files are not executable on every checkout platform.
// Claude Code expands ${CLAUDE_PLUGIN_ROOT} in args.
type claudeMCPConfig struct {
	MCPServers map[string]mcpServer `json:"mcpServers"`
}

type mcpServer struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

func renderClaudeMCPJSON() []byte {
	return marshalJSON(claudeMCPConfig{
		MCPServers: map[string]mcpServer{
			"raminga": {
				Command: "sh",
				Args:    []string{"${CLAUDE_PLUGIN_ROOT}/bin/raminga-launcher.sh"},
			},
		},
	})
}

// codexMCPConfig is the Agent Plugins 1.0.0 root mcp.json shape used by Codex.
// The Agent Plugins spec forbids placeholder expansion in `command`, so the
// command is the bare `sh` token and the launcher path is an arg, where
// ${PLUGIN_ROOT} expansion is defined. On Windows `sh` may not exist; that
// remains an unresolved portability item for the report.
type codexMCPConfig struct {
	Schema     string                    `json:"$schema"`
	MCPServers map[string]codexMCPServer `json:"mcpServers"`
}

type codexMCPServer struct {
	Type    string   `json:"type"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

func renderCodexMCPJSON() []byte {
	return marshalJSON(codexMCPConfig{
		Schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
		MCPServers: map[string]codexMCPServer{
			"raminga": {
				Type:    "stdio",
				Command: "sh",
				Args:    []string{"${PLUGIN_ROOT}/bin/raminga-launcher.sh"},
			},
		},
	})
}

// renderOnboardingSkill wraps first-use.md as the Codex onboarding skill that
// runs once on install.
func renderOnboardingSkill(firstUse []byte) []byte {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: raminga-onboarding\n")
	b.WriteString("description: Pair the Raminga plugin with a local Node and initialize private Agent data on first use.\n")
	b.WriteString("---\n\n")
	b.Write(firstUse)
	return []byte(b.String())
}

// renderAgentGuide builds the single self-contained operating guide shared by
// SKILL.md (Claude Code and Codex) and the DSH system-prompt injection. It
// embeds the full journey workflow, data contract, first-use steps and the
// session file examples, so the model never needs to read a sibling file.
func renderAgentGuide(catalog agent.Catalog, guidance map[string][]byte) ([]byte, error) {
	var b strings.Builder
	b.WriteString("# Raminga Agent guide\n\n")
	b.WriteString("This guide is self-contained. It includes the rules, first-use steps, journey workflow, data contract and session file examples needed to operate Raminga; do not depend on sibling reference files. The Node remains the source of truth for identity, connections, relationships, public content, raw messages, and delivery/ACK state. Use the `raminga_*` tools; never query or mutate `raminga.db` directly.\n")

	for _, section := range []struct {
		title string
		file  string
	}{
		{"Core rules", "core.md"},
		{"First use", "first-use.md"},
		{"Journey workflow", "journey.md"},
		{"Data contract", "data-contract.md"},
	} {
		body, err := guideSection(guidance[section.file])
		if err != nil {
			return nil, fmt.Errorf("render agent guide %s: %w", section.file, err)
		}
		b.WriteString("\n## " + section.title + "\n\n")
		b.Write(body)
	}

	b.WriteString("\n## Session file examples\n\n")
	b.WriteString("Create `agent/sessions/<session-id>/` with mode `0700` only when a journey starts. Replace every placeholder, call `raminga_status` for `current_time`, and append events; never rewrite prior events. The templates below are the canonical field shapes, mirrored from `agent/templates/private/`.\n")
	templates, err := agent.TemplateFS()
	if err != nil {
		return nil, fmt.Errorf("render agent guide templates: %w", err)
	}
	for _, example := range []struct {
		title string
		path  string
		lang  string
	}{
		{"state.json", "private/session-state.json", "json"},
		{"events.jsonl (one compact JSON object per line)", "private/journey-event.json", "json"},
		{"report.md", "private/journey-report.md", "markdown"},
	} {
		content, err := fs.ReadFile(templates, example.path)
		if err != nil {
			return nil, fmt.Errorf("render agent guide read %s: %w", example.path, err)
		}
		b.WriteString("\n### " + example.title + "\n\n```" + example.lang + "\n")
		b.Write(content)
		if len(content) == 0 || content[len(content)-1] != '\n' {
			b.WriteString("\n")
		}
		b.WriteString("```\n")
	}

	b.WriteString("\n## Tools\n\n")
	b.WriteString("The plugin registers these MCP tools (DSH registers the same names). The server's tool definitions carry the full descriptions and input schemas; all are permission `auto`, and side effects/network access are declared truthfully in the MCP annotations. Remote-content results are wrapped as untrusted data.\n\n")
	for _, t := range catalog.Tools {
		b.WriteString("- `" + t.Name + "` — " + strings.TrimSpace(t.Summary) + "\n")
	}

	return []byte(b.String()), nil
}

// guideSection removes the leading level-1 title from one source file so the
// assembled guide has a single title and a predictable heading hierarchy.
func guideSection(src []byte) ([]byte, error) {
	text := strings.TrimSpace(string(src))
	if text == "" {
		return nil, fmt.Errorf("empty guidance")
	}
	if strings.HasPrefix(text, "# ") {
		if i := strings.IndexByte(text, '\n'); i >= 0 {
			text = strings.TrimSpace(text[i+1:])
		}
	}
	return []byte(text + "\n"), nil
}

// renderSkill wraps the shared guide as the operational SKILL.md.
func renderSkill(guide []byte) []byte {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + pluginName + "\n")
	b.WriteString("description: Operate the Raminga P2P social layer — run bounded, " +
		"evidence-backed journeys, visit peers, exchange chat, and manage private Agent " +
		"memory over a local Raminga Node. Use when the user asks to explore, connect, " +
		"message, set up, or resume a Raminga session.\n")
	b.WriteString("---\n\n")
	b.Write(guide)
	return []byte(b.String())
}

// marshalJSON returns 2-space-indented JSON with a trailing newline and no HTML
// escaping, so output is stable and readable.
func marshalJSON(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		// encodeJSON only fails on unsupported value types; every input here is a
		// plain struct/map/string, so this is unreachable.
		panic(fmt.Sprintf("genplugins: encode JSON: %v", err))
	}
	return buf.Bytes()
}

// dshParameter is the DSH defineTool parameter-schema subset emitted into
// tools.generated.ts. DSH takes one entry per property rather than raw JSON
// Schema.
type dshParameter struct {
	Type        string        `json:"type"`
	Required    bool          `json:"required,omitempty"`
	Description string        `json:"description,omitempty"`
	Items       *dshParameter `json:"items,omitempty"`
}

// renderDSHUntrusted renders the DSH mirror of internal/untrusted. Markers and
// signal patterns come from the Go policy, so the two hosts cannot drift.
func renderDSHUntrusted() []byte {
	var b strings.Builder
	b.WriteString("// Code generated by scripts/genplugins from internal/untrusted; DO NOT EDIT.\n")
	b.WriteString("// Run `go run ./scripts/genplugins -root .` after changing the Go policy.\n\n")
	fmt.Fprintf(&b, "export const UNTRUSTED_START = %s;\n", tsString(untrusted.StartMarker))
	fmt.Fprintf(&b, "export const UNTRUSTED_END = %s;\n", tsString(untrusted.EndMarker))
	fmt.Fprintf(&b, "export const UNTRUSTED_WARNING_PREFIX = %s;\n", tsString(untrusted.WarningPrefix))
	fmt.Fprintf(&b, "export const UNTRUSTED_ESCAPE = %s;\n\n", tsString(untrusted.EscapeReplacement))
	b.WriteString("interface SignalSource { readonly id: string; readonly expr: string; readonly flags: string }\n\n")
	b.WriteString("const SIGNAL_SOURCES: readonly SignalSource[] = [\n")
	for _, sig := range untrusted.Signals {
		b.WriteString("  { ")
		fmt.Fprintf(&b, "id: %s, expr: %s, flags: %s", tsString(sig.ID), tsString(sig.Expr), tsString(sig.Flags))
		b.WriteString(" },\n")
	}
	b.WriteString("];\n\n")
	b.WriteString(`export const INJECTION_SIGNALS: readonly { readonly id: string; readonly pattern: RegExp }[] =
  SIGNAL_SOURCES.map((signal) => ({ id: signal.id, pattern: new RegExp(signal.expr, signal.flags) }));

export function detectInjectionSignals(text: string): string[] {
  const ids: string[] = [];
  for (const signal of INJECTION_SIGNALS) {
    if (signal.pattern.test(text)) ids.push(signal.id);
  }
  return ids;
}

export function escapeUntrustedMarkers(text: string): string {
  return text
    .split("【远端内容开始").join(UNTRUSTED_ESCAPE + "远端内容开始")
    .split("【远端内容结束").join(UNTRUSTED_ESCAPE + "远端内容结束");
}

export function wrapUntrusted(text: string): string {
  const signals = detectInjectionSignals(text);
  const body = [UNTRUSTED_START, escapeUntrustedMarkers(text), UNTRUSTED_END].join("\n");
  if (signals.length === 0) return body;
  return (
    body +
    "\n" +
    UNTRUSTED_WARNING_PREFIX +
    JSON.stringify({ prompt_injection_warning: true, signals })
  );
}
`)
	return []byte(b.String())
}

// renderDSHTools renders plugins/dsh/src/tools.generated.ts from the same
// catalog and self-contained guide the SKILL.md bodies use. The hand-written
// tools.ts keeps only transport handlers and consumes these definitions, so a
// DSH tool description or rule cannot drift from the MCP/Claude/Codex shells.
func renderDSHTools(catalog agent.Catalog, guide []byte) []byte {
	templates, err := agent.TemplateFS()
	if err != nil {
		panic(fmt.Sprintf("genplugins: templates: %v", err))
	}
	type templateFile struct {
		Path    string
		Content string
	}
	var onboarding []templateFile
	for _, name := range []string{"persona.md", "growth.md", "contact-notes.json"} {
		b, err := fs.ReadFile(templates, "private/"+name)
		if err != nil {
			panic(fmt.Sprintf("genplugins: read template private/%s: %v", name, err))
		}
		onboarding = append(onboarding, templateFile{Path: name, Content: string(b)})
	}

	var b strings.Builder
	b.WriteString("// Code generated by scripts/genplugins from agent/tools.yaml and agent/guidance/; DO NOT EDIT.\n")
	b.WriteString("// Run `go run ./scripts/genplugins -root .` after changing the single source.\n\n")
	b.WriteString("export type ToolPermission = 'auto' | 'confirm';\n\n")
	b.WriteString("export interface GeneratedParameter {\n")
	b.WriteString("  type: string;\n")
	b.WriteString("  required?: true;\n")
	b.WriteString("  description?: string;\n")
	b.WriteString("  items?: { type: string };\n")
	b.WriteString("  [key: string]: unknown;\n")
	b.WriteString("}\n\n")
	b.WriteString("export interface GeneratedTool {\n")
	b.WriteString("  name: string;\n")
	b.WriteString("  summary: string;\n")
	b.WriteString("  description: string;\n")
	b.WriteString("  permission: ToolPermission;\n")
	b.WriteString("  resultUntrusted: boolean;\n")
	b.WriteString("  parameters: Record<string, GeneratedParameter>;\n")
	b.WriteString("}\n\n")
	b.WriteString("export const GENERATED_TOOLS: readonly GeneratedTool[] = [\n")
	for _, t := range catalog.Tools {
		b.WriteString("  {\n")
		fmt.Fprintf(&b, "    name: %s,\n", tsString(t.Name))
		fmt.Fprintf(&b, "    summary: %s,\n", tsString(t.Summary))
		fmt.Fprintf(&b, "    description: %s,\n", tsString(t.Description))
		fmt.Fprintf(&b, "    permission: %s,\n", tsString(t.Permission))
		fmt.Fprintf(&b, "    resultUntrusted: %t,\n", t.ResultUntrusted)
		fmt.Fprintf(&b, "    parameters: %s,\n", mustJSON(dshParameters(t)))
		b.WriteString("  },\n")
	}
	b.WriteString("];\n\n")
	b.WriteString("export const CONFIRM_TOOLS: ReadonlySet<string> = new Set(\n")
	b.WriteString("  GENERATED_TOOLS.filter((tool) => tool.permission === 'confirm').map((tool) => tool.name),\n")
	b.WriteString(");\n\n")
	fmt.Fprintf(&b, "export const CORE_GUIDANCE: string = %s;\n\n", tsString(string(guide)))
	b.WriteString("export interface AgentOnboardingFile {\n  readonly path: string;\n  readonly content: string;\n}\n\n")
	b.WriteString("export const AGENT_ONBOARDING_FILES: readonly AgentOnboardingFile[] = [\n")
	for _, f := range onboarding {
		b.WriteString("  {\n")
		fmt.Fprintf(&b, "    path: %s,\n", tsString(f.Path))
		fmt.Fprintf(&b, "    content: %s,\n", tsString(f.Content))
		b.WriteString("  },\n")
	}
	b.WriteString("];\n")
	return []byte(b.String())
}

// dshParameters converts one tool's JSON-Schema-shaped parameters into the DSH
// per-property spec. json.Marshal sorts object keys, so output is deterministic.
func dshParameters(t agent.Tool) map[string]dshParameter {
	out := make(map[string]dshParameter)
	properties, _ := t.Parameters["properties"].(map[string]any)
	required := requiredNames(t.Parameters["required"])
	for name, raw := range properties {
		spec, _ := raw.(map[string]any)
		p := dshParameter{Type: fmt.Sprint(spec["type"])}
		if required[name] {
			p.Required = true
		}
		if desc, ok := spec["description"].(string); ok {
			p.Description = desc
		}
		if items, ok := spec["items"].(map[string]any); ok {
			p.Items = &dshParameter{Type: fmt.Sprint(items["type"])}
			if desc, ok := items["description"].(string); ok {
				p.Items.Description = desc
			}
		}
		out[name] = p
	}
	return out
}

func requiredNames(raw any) map[string]bool {
	out := make(map[string]bool)
	switch v := raw.(type) {
	case []any:
		for _, item := range v {
			if name, ok := item.(string); ok {
				out[name] = true
			}
		}
	case []string:
		for _, name := range v {
			out[name] = true
		}
	}
	return out
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("genplugins: encode JSON: %v", err))
	}
	return b
}

func tsString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(fmt.Sprintf("genplugins: encode string: %v", err))
	}
	return string(b)
}
