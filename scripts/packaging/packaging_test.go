package packaging

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	path := filepath.Join("..", "..", rel)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestReleaseArtifactsShipEditableBootstrapPreset(t *testing.T) {
	goreleaser := readRepoFile(t, ".goreleaser.yaml")
	preset := strings.Index(goreleaser, "src: internal/config/bootstrap-preset.toml")
	if preset < 0 {
		t.Fatal(".goreleaser.yaml archives do not ship internal/config/bootstrap-preset.toml")
	}
	presetBlock := goreleaser[preset:]
	if next := strings.Index(presetBlock, "\n      - src:"); next >= 0 {
		presetBlock = presetBlock[:next]
	}
	if !strings.Contains(presetBlock, "strip_parent: true") {
		t.Fatal(".goreleaser.yaml does not place bootstrap-preset.toml at the archive root")
	}
	makefile := readRepoFile(t, "Makefile")
	if !strings.Contains(makefile, "cp internal/config/bootstrap-preset.toml bin/bootstrap-preset.toml") {
		t.Fatal("Makefile build does not stage bootstrap-preset.toml next to bin/raminga")
	}
	npmdist := readRepoFile(t, "scripts/npmdist/main.go")
	for _, want := range []string{
		`filepath.Join(root, "internal", "config", "bootstrap-preset.toml")`,
		`filepath.Join(dir, "bin", "bootstrap-preset.toml")`,
		`"bin/bootstrap-preset.toml"`,
	} {
		if !strings.Contains(npmdist, want) {
			t.Fatalf("npmdist does not package the bootstrap sidecar: missing %q", want)
		}
	}
	unix := readRepoFile(t, "scripts/install.sh")
	for _, want := range []string{"bootstrap-preset.toml", "PRESET_SRC", "未覆盖"} {
		if !strings.Contains(unix, want) {
			t.Fatalf("install.sh lacks %q", want)
		}
	}
	windows := readRepoFile(t, "scripts/install.ps1")
	for _, want := range []string{"bootstrap-preset.toml", "未覆盖"} {
		if !strings.Contains(windows, want) {
			t.Fatalf("install.ps1 lacks %q", want)
		}
	}
}

func TestInstallScriptNeverClobbersEditedSidecar(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("install.sh is the Unix installer")
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	archive := t.TempDir()
	installer, err := os.ReadFile(filepath.Join(root, "scripts", "install.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(archive, "install.sh"), installer, 0o755); err != nil {
		t.Fatal(err)
	}
	fakeBinary := `#!/bin/sh
case "${1:-}" in
version) echo "raminga test-version" ;;
status) exit 0 ;;
*) exit 0 ;;
esac
`
	if err := os.WriteFile(filepath.Join(archive, "raminga"), []byte(fakeBinary), 0o755); err != nil {
		t.Fatal(err)
	}
	originalPreset := "bootstrap_peers = []\n"
	if err := os.WriteFile(filepath.Join(archive, "bootstrap-preset.toml"), []byte(originalPreset), 0o644); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()

	editedPrefix := t.TempDir()
	editedPath := filepath.Join(editedPrefix, "bootstrap-preset.toml")
	if err := os.WriteFile(editedPath, []byte("bootstrap_peers = [\"edited\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runInstaller(t, archive, editedPrefix, home)
	after, err := os.ReadFile(editedPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != "bootstrap_peers = [\"edited\"]\n" {
		t.Fatalf("installer clobbered edited sidecar: %q", after)
	}

	freshPrefix := t.TempDir()
	runInstaller(t, archive, freshPrefix, home)
	fresh, err := os.ReadFile(filepath.Join(freshPrefix, "bootstrap-preset.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(fresh) != originalPreset {
		t.Fatalf("fresh install sidecar = %q, want %q", fresh, originalPreset)
	}
}

func runInstaller(t *testing.T, archive, prefix, home string) {
	t.Helper()
	cmd := exec.Command("sh", filepath.Join(archive, "install.sh"), "--prefix", prefix, "--no-modify-path")
	cmd.Env = append(os.Environ(), "HOME="+home)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
}
