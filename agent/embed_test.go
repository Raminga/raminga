package agent

import (
	"testing"
)

func TestToolCatalog(t *testing.T) {
	catalog, err := ToolCatalog()
	if err != nil {
		t.Fatalf("ToolCatalog: %v", err)
	}
	if catalog.Version != 1 {
		t.Fatalf("version = %d, want 1", catalog.Version)
	}
	if len(catalog.Tools) != 12 {
		t.Fatalf("got %d tools, want 12", len(catalog.Tools))
	}
	names := make(map[string]bool)
	for _, tool := range catalog.Tools {
		if tool.Name == "" {
			t.Fatal("tool without name")
		}
		if names[tool.Name] {
			t.Fatalf("duplicate tool %q", tool.Name)
		}
		names[tool.Name] = true
		if tool.Permission != PermissionAuto && tool.Permission != PermissionConfirm {
			t.Fatalf("tool %q has bad permission %q", tool.Name, tool.Permission)
		}
		if tool.Parameters["type"] != "object" {
			t.Fatalf("tool %q parameters.type = %v, want object", tool.Name, tool.Parameters["type"])
		}
	}
	for _, want := range []string{"raminga_status", "raminga_chat_send"} {
		if !names[want] {
			t.Errorf("missing tool %q", want)
		}
	}
}

func TestTemplateFS(t *testing.T) {
	if _, err := TemplateFS(); err != nil {
		t.Fatalf("TemplateFS: %v", err)
	}
	if _, err := Guidance("core.md"); err != nil {
		t.Fatalf("Guidance(core.md): %v", err)
	}
	if _, err := Guidance("../tools.yaml"); err == nil {
		t.Error("Guidance must reject a name that escapes the tree")
	}
}
