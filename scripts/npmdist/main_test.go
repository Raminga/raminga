package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type testArtifact struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Type   string `json:"type"`
	Goos   string `json:"goos"`
	Goarch string `json:"goarch"`
	Extra  struct {
		ID     string `json:"ID"`
		Binary string `json:"Binary"`
	} `json:"extra"`
}

func fixtureRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "VERSION"), []byte("0.1.0-rc.1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "LICENSE"), []byte("Apache-2.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dsh := filepath.Join(root, "plugins", "dsh")
	for _, dir := range []string{"lib", "locale"} {
		if err := os.MkdirAll(filepath.Join(dsh, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"lib/index.js":     "export const name = 'raminga';\n",
		"locale/en.json":   "{}\n",
		"icon.svg":         "<svg/>\n",
		"cordis.patch.yml": "plugins: []\n",
		"README.md":        "# @raminga/dsh\n",
		"package.json":     `{"name":"@raminga/dsh","version":"0.0.0","files":["lib"]}`,
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dsh, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func fixtureDist(t *testing.T) (string, []testArtifact) {
	t.Helper()
	dist := filepath.Join(t.TempDir(), "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	var artifacts []testArtifact
	for _, p := range platforms {
		path := filepath.Join(dist, p.goos+"_"+p.goarch, p.exe)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		a := testArtifact{Name: p.exe, Path: path, Type: "Binary", Goos: p.goos, Goarch: p.goarch}
		a.Extra.ID = "raminga"
		a.Extra.Binary = "raminga"
		artifacts = append(artifacts, a)
	}
	b, err := json.Marshal(artifacts)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "artifacts.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	return dist, artifacts
}

func TestRunStagesSixPlatformPackagesAndShell(t *testing.T) {
	root := fixtureRoot(t)
	dist, _ := fixtureDist(t)
	out := filepath.Join(t.TempDir(), "npm")
	if err := run(options{root: root, dist: dist, out: out, version: "0.1.0-rc.1"}); err != nil {
		t.Fatalf("run: %v", err)
	}

	for _, p := range platforms {
		dir := filepath.Join(out, "bin-"+p.npmOS+"-"+p.npmCPU)
		var pkg platformPackage
		readJSON(t, filepath.Join(dir, "package.json"), &pkg)
		wantName := "@raminga/bin-" + p.npmOS + "-" + p.npmCPU
		if pkg.Name != wantName || pkg.Version != "0.1.0-rc.1" {
			t.Errorf("%s name/version = %q/%q", p.npmOS+"-"+p.npmCPU, pkg.Name, pkg.Version)
		}
		if len(pkg.OS) != 1 || pkg.OS[0] != p.npmOS || len(pkg.CPU) != 1 || pkg.CPU[0] != p.npmCPU {
			t.Errorf("%s os/cpu = %v/%v", pkg.Name, pkg.OS, pkg.CPU)
		}
		if pkg.License != "Apache-2.0" || pkg.Repository.URL == "" {
			t.Errorf("%s missing license/repository: %+v", pkg.Name, pkg)
		}
		info, err := os.Stat(filepath.Join(dir, "bin", p.exe))
		if err != nil {
			t.Fatalf("%s binary: %v", pkg.Name, err)
		}
		if info.Mode().Perm() != 0o755 {
			t.Errorf("%s binary mode = %o, want 0755", pkg.Name, info.Mode().Perm())
		}
		if !isFile(filepath.Join(dir, "LICENSE")) || !isFile(filepath.Join(dir, "README.md")) {
			t.Errorf("%s missing LICENSE or README", pkg.Name)
		}
	}

	var shell struct {
		Name                 string            `json:"name"`
		Version              string            `json:"version"`
		OptionalDependencies map[string]string `json:"optionalDependencies"`
	}
	shellDir := filepath.Join(out, "dsh")
	readJSON(t, filepath.Join(shellDir, "package.json"), &shell)
	if shell.Name != "@raminga/dsh" || shell.Version != "0.1.0-rc.1" {
		t.Fatalf("shell name/version = %q/%q", shell.Name, shell.Version)
	}
	if len(shell.OptionalDependencies) != 6 {
		t.Fatalf("shell optionalDependencies = %v", shell.OptionalDependencies)
	}
	for _, p := range platforms {
		name := "@raminga/bin-" + p.npmOS + "-" + p.npmCPU
		if shell.OptionalDependencies[name] != "0.1.0-rc.1" {
			t.Errorf("%s = %q", name, shell.OptionalDependencies[name])
		}
	}
	if _, err := os.Stat(filepath.Join(shellDir, "bin")); !os.IsNotExist(err) {
		t.Fatalf("shell must not contain bin/: %v", err)
	}
	if !isFile(filepath.Join(shellDir, "lib", "index.js")) {
		t.Fatal("shell is missing lib/index.js")
	}
}

func TestRunFailsWhenPlatformArtifactIsMissing(t *testing.T) {
	root := fixtureRoot(t)
	dist, artifacts := fixtureDist(t)
	var kept []testArtifact
	for _, a := range artifacts {
		if a.Goos == "windows" && a.Goarch == "amd64" {
			continue
		}
		kept = append(kept, a)
	}
	b, _ := json.Marshal(kept)
	if err := os.WriteFile(filepath.Join(dist, "artifacts.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	err := run(options{root: root, dist: dist, out: filepath.Join(t.TempDir(), "npm"), version: "0.1.0-rc.1"})
	if err == nil || !strings.Contains(err.Error(), "windows/amd64") {
		t.Fatalf("run error = %v, want missing windows/amd64", err)
	}
}

func TestResolveArtifactPathUsesDistParent(t *testing.T) {
	base := t.TempDir()
	dist := filepath.Join(base, "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	artifact := filepath.Join(dist, "raminga_linux_arm64_v8.0", "raminga")
	if err := os.MkdirAll(filepath.Dir(artifact), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := resolveArtifactPath(dist, "dist/raminga_linux_arm64_v8.0/raminga")
	if err != nil {
		t.Fatalf("resolveArtifactPath: %v", err)
	}
	if got != artifact {
		t.Fatalf("got %q, want %q", got, artifact)
	}
}

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}
