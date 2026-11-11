// Package agent embeds the single-source Raminga Agent content tree (agent/)
// into the binary. The MCP server (internal/mcp) builds its tool set from the
// embedded catalog and scripts/genplugins renders host shells from the same
// files, so tool descriptions cannot drift between hosts.
//
// The tree is hand-written here and validated by scripts/genplugins --check;
// nothing under plugins/ is a source of truth.
package agent

import (
	"embed"
	"fmt"
	"io/fs"
	"strings"

	"go.yaml.in/yaml/v3"
)

// FS is the embedded agent/ content tree (guidance/, tools.yaml,
// templates/).
//
//go:embed guidance tools.yaml templates
var FS embed.FS

// Tool is one entry of the tool catalog in tools.yaml. Parameters is the
// JSON-Schema-shaped input contract; it marshals to the MCP inputSchema and is
// the same object shell renderers print for the model.
type Tool struct {
	Name            string `yaml:"name"`
	Summary         string `yaml:"summary"`
	Description     string `yaml:"description"`
	Permission      string `yaml:"permission"` // "auto" or "confirm"
	ResultUntrusted bool   `yaml:"result_untrusted"`
	// ReadOnly and OpenWorld are MCP tool-annotation hints. They are separate
	// from Permission: an auto-permitted tool can still write locally or reach
	// the open network, and the annotation must say so truthfully.
	ReadOnly   *bool          `yaml:"read_only"`
	OpenWorld  *bool          `yaml:"open_world"`
	Parameters map[string]any `yaml:"parameters"`
}

// IsReadOnly reports the MCP readOnlyHint. Validation requires the field, so a
// missing value cannot silently become "read-only".
func (t Tool) IsReadOnly() bool { return t.ReadOnly != nil && *t.ReadOnly }

// IsOpenWorld reports the MCP openWorldHint.
func (t Tool) IsOpenWorld() bool { return t.OpenWorld != nil && *t.OpenWorld }

// ToolPermission values.
const (
	// PermissionAuto tools run without a per-call confirmation prompt. They may
	// still write locally or reach remote peers; ReadOnly and OpenWorld carry
	// that distinction for MCP annotations.
	PermissionAuto = "auto"
	// PermissionConfirm tools would require a host confirmation prompt. The
	// current catalog has none: Raminga actions are allowed without per-call
	// confirmation, while the daemon enforces the agent-origin send guard.
	PermissionConfirm = "confirm"
)

// Catalog is the parsed tools.yaml.
type Catalog struct {
	Version int    `yaml:"version"`
	Tools   []Tool `yaml:"tools"`
}

// ToolCatalog parses the embedded tools.yaml. It is the only parser for the
// catalog; callers must not re-parse the raw file.
func ToolCatalog() (Catalog, error) {
	b, err := FS.ReadFile("tools.yaml")
	if err != nil {
		return Catalog{}, fmt.Errorf("agent: read tools.yaml: %w", err)
	}
	var catalog Catalog
	if err := yaml.Unmarshal(b, &catalog); err != nil {
		return Catalog{}, fmt.Errorf("agent: parse tools.yaml: %w", err)
	}
	if catalog.Version != 1 {
		return Catalog{}, fmt.Errorf("agent: tools.yaml version %d, want 1", catalog.Version)
	}
	if len(catalog.Tools) == 0 {
		return Catalog{}, fmt.Errorf("agent: tools.yaml defines no tools")
	}
	seen := make(map[string]bool, len(catalog.Tools))
	for _, t := range catalog.Tools {
		if t.Name == "" {
			return Catalog{}, fmt.Errorf("agent: tools.yaml has a tool without a name")
		}
		if seen[t.Name] {
			return Catalog{}, fmt.Errorf("agent: tools.yaml duplicates tool %q", t.Name)
		}
		seen[t.Name] = true
		if t.Permission != PermissionAuto && t.Permission != PermissionConfirm {
			return Catalog{}, fmt.Errorf("agent: tool %q permission %q, want %q or %q",
				t.Name, t.Permission, PermissionAuto, PermissionConfirm)
		}
		if t.Parameters["type"] != "object" {
			return Catalog{}, fmt.Errorf("agent: tool %q parameters.type must be object", t.Name)
		}
		if t.ReadOnly == nil {
			return Catalog{}, fmt.Errorf("agent: tool %q must set read_only", t.Name)
		}
		if t.OpenWorld == nil {
			return Catalog{}, fmt.Errorf("agent: tool %q must set open_world", t.Name)
		}
	}
	return catalog, nil
}

// Guidance returns one embedded guidance file for the model (core.md,
// journey.md, first-use.md, data-contract.md).
func Guidance(name string) ([]byte, error) {
	return contentFile("guidance", name)
}

// TemplateFS returns the embedded templates/ subtree for first-run setup.
func TemplateFS() (fs.FS, error) {
	sub, err := fs.Sub(FS, "templates")
	if err != nil {
		return nil, fmt.Errorf("agent: templates subtree: %w", err)
	}
	return sub, nil
}

// contentFile reads one file from an embedded subtree, rejecting separators so
// callers cannot escape the tree with a crafted name.
func contentFile(dir, name string) ([]byte, error) {
	if name == "" || strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") {
		return nil, fmt.Errorf("agent: invalid %s file name %q", dir, name)
	}
	b, err := FS.ReadFile(dir + "/" + name)
	if err != nil {
		return nil, fmt.Errorf("agent: read %s/%s: %w", dir, name, err)
	}
	return b, nil
}
