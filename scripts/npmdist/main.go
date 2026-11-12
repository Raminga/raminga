// Command npmdist stages the npm release artifacts from a GoReleaser dist
// directory and the repository-root VERSION file.
//
// It produces six platform packages (@raminga/bin-<os>-<cpu>) and the DSH
// shell package (@raminga/dsh). Platform packages contain exactly one binary
// plus LICENSE and README; the shell contains no binary and locks the exact
// version of every platform package through optionalDependencies.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type platform struct {
	goos   string
	goarch string
	npmOS  string
	npmCPU string
	exe    string
}

var platforms = []platform{
	{"darwin", "arm64", "darwin", "arm64", "raminga"},
	{"darwin", "amd64", "darwin", "x64", "raminga"},
	{"linux", "arm64", "linux", "arm64", "raminga"},
	{"linux", "amd64", "linux", "x64", "raminga"},
	{"windows", "arm64", "win32", "arm64", "raminga.exe"},
	{"windows", "amd64", "win32", "x64", "raminga.exe"},
}

type options struct {
	root    string
	dist    string
	out     string
	version string
}

func main() {
	root := flag.String("root", ".", "repository root")
	dist := flag.String("dist", "dist", "GoReleaser dist directory (contains artifacts.json)")
	out := flag.String("out", "", "output directory for the staged npm packages (required)")
	version := flag.String("version", "", "release version (default: repository-root VERSION)")
	flag.Parse()

	opts := options{root: *root, dist: *dist, out: *out, version: *version}
	if opts.out == "" {
		fmt.Fprintln(os.Stderr, "npmdist: -out is required")
		os.Exit(2)
	}
	if err := run(opts); err != nil {
		fmt.Fprintln(os.Stderr, "npmdist: FAIL:", err)
		os.Exit(1)
	}
	fmt.Printf("npmdist: staged 6 platform packages and @raminga/dsh in %s\n", opts.out)
}

func run(opts options) error {
	root, err := filepath.Abs(opts.root)
	if err != nil {
		return err
	}
	out, err := filepath.Abs(opts.out)
	if err != nil {
		return err
	}
	dist, err := filepath.Abs(opts.dist)
	if err != nil {
		return err
	}
	version := strings.TrimSpace(opts.version)
	if version == "" {
		b, err := os.ReadFile(filepath.Join(root, "VERSION"))
		if err != nil {
			return fmt.Errorf("read VERSION: %w", err)
		}
		version = strings.TrimSpace(string(b))
	}
	if version == "" {
		return fmt.Errorf("version is empty")
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}

	artifacts, err := loadArtifacts(dist)
	if err != nil {
		return err
	}
	for _, p := range platforms {
		artifact, ok := findBinary(artifacts, p.goos, p.goarch)
		if !ok {
			return fmt.Errorf("no GoReleaser binary artifact for %s/%s", p.goos, p.goarch)
		}
		source, err := resolveArtifactPath(dist, artifact.Path)
		if err != nil {
			return fmt.Errorf("%s/%s: %w", p.goos, p.goarch, err)
		}
		if err := stagePlatform(root, out, version, p, source); err != nil {
			return err
		}
	}
	return stageShell(root, out, version)
}

type artifact struct {
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

func loadArtifacts(dist string) ([]artifact, error) {
	b, err := os.ReadFile(filepath.Join(dist, "artifacts.json"))
	if err != nil {
		return nil, fmt.Errorf("read artifacts.json (run GoReleaser first): %w", err)
	}
	var artifacts []artifact
	if err := json.Unmarshal(b, &artifacts); err != nil {
		return nil, fmt.Errorf("parse artifacts.json: %w", err)
	}
	return artifacts, nil
}

func findBinary(artifacts []artifact, goos, goarch string) (artifact, bool) {
	for _, a := range artifacts {
		if a.Type != "Binary" || a.Goos != goos || a.Goarch != goarch {
			continue
		}
		if a.Extra.ID == "raminga" || a.Extra.Binary == "raminga" {
			return a, true
		}
	}
	return artifact{}, false
}

// resolveArtifactPath accepts absolute paths, paths relative to the current
// directory (GoReleaser's default), and paths relative to the dist parent when
// GoReleaser was configured with an absolute temporary dist directory.
func resolveArtifactPath(dist, path string) (string, error) {
	if filepath.IsAbs(path) {
		if isFile(path) {
			return path, nil
		}
		return "", fmt.Errorf("artifact %s does not exist", path)
	}
	candidates := []string{
		path,
		filepath.Join(filepath.Dir(dist), path),
		filepath.Join(dist, filepath.Base(path)),
	}
	for _, candidate := range candidates {
		if isFile(candidate) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("artifact %s does not exist (tried %s)", path, strings.Join(candidates, ", "))
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

type repository struct {
	Type      string `json:"type"`
	URL       string `json:"url"`
	Directory string `json:"directory"`
}

type publishConfig struct {
	Access string `json:"access"`
}

type platformPackage struct {
	Name            string        `json:"name"`
	Version         string        `json:"version"`
	Description     string        `json:"description"`
	License         string        `json:"license"`
	Repository      repository    `json:"repository"`
	OS              []string      `json:"os"`
	CPU             []string      `json:"cpu"`
	Files           []string      `json:"files"`
	PreferUnplugged bool          `json:"preferUnplugged"`
	PublishConfig   publishConfig `json:"publishConfig"`
}

func stagePlatform(root, out, version string, p platform, binary string) error {
	name := fmt.Sprintf("@raminga/bin-%s-%s", p.npmOS, p.npmCPU)
	dir := filepath.Join(out, fmt.Sprintf("bin-%s-%s", p.npmOS, p.npmCPU))
	if err := os.MkdirAll(filepath.Join(dir, "bin"), 0o755); err != nil {
		return fmt.Errorf("%s: create package directory: %w", name, err)
	}
	target := filepath.Join(dir, "bin", p.exe)
	if err := copyFile(binary, target, 0o755); err != nil {
		return fmt.Errorf("%s: copy binary: %w", name, err)
	}
	if err := copyFile(filepath.Join(root, "LICENSE"), filepath.Join(dir, "LICENSE"), 0o644); err != nil {
		return fmt.Errorf("%s: copy LICENSE: %w", name, err)
	}
	readme := fmt.Sprintf("# %s\n\nRaminga binary for %s/%s; installed by @raminga/dsh.\n", name, p.npmOS, p.npmCPU)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte(readme), 0o644); err != nil {
		return fmt.Errorf("%s: write README: %w", name, err)
	}
	pkg := platformPackage{
		Name:        name,
		Version:     version,
		Description: fmt.Sprintf("Raminga node binary for %s/%s.", p.npmOS, p.npmCPU),
		License:     "Apache-2.0",
		Repository: repository{
			Type:      "git",
			URL:       "git+https://github.com/Raminga/raminga.git",
			Directory: "plugins/dsh",
		},
		OS:              []string{p.npmOS},
		CPU:             []string{p.npmCPU},
		Files:           []string{"bin/" + p.exe, "LICENSE", "README.md"},
		PreferUnplugged: true,
		PublishConfig:   publishConfig{Access: "public"},
	}
	if err := writeJSON(filepath.Join(dir, "package.json"), pkg); err != nil {
		return fmt.Errorf("%s: write package.json: %w", name, err)
	}
	return nil
}

// stageShell copies the built DSH shell into a publishable directory. It
// deliberately does not copy any binary: the shell only resolves the matching
// platform package through optionalDependencies.
func stageShell(root, out, version string) error {
	src := filepath.Join(root, "plugins", "dsh")
	dir := filepath.Join(out, "dsh")
	if !isFile(filepath.Join(src, "lib", "index.js")) {
		return fmt.Errorf("plugins/dsh/lib/index.js is missing; run `npm run build` in plugins/dsh first")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("@raminga/dsh: create package directory: %w", err)
	}
	for _, item := range []struct {
		path string
		dir  bool
	}{
		{"lib", true},
		{"locale", true},
		{"icon.svg", false},
		{"cordis.patch.yml", false},
		{"README.md", false},
		{"package.json", false},
	} {
		from := filepath.Join(src, item.path)
		to := filepath.Join(dir, item.path)
		if item.dir {
			if err := copyTree(from, to); err != nil {
				return fmt.Errorf("@raminga/dsh: copy %s: %w", item.path, err)
			}
			continue
		}
		if err := copyFile(from, to, 0o644); err != nil {
			return fmt.Errorf("@raminga/dsh: copy %s: %w", item.path, err)
		}
	}
	pkgPath := filepath.Join(dir, "package.json")
	raw, err := os.ReadFile(pkgPath)
	if err != nil {
		return err
	}
	var pkg map[string]json.RawMessage
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return fmt.Errorf("@raminga/dsh: parse package.json: %w", err)
	}
	encodedVersion, _ := json.Marshal(version)
	pkg["version"] = encodedVersion
	deps := make(map[string]string, len(platforms))
	for _, p := range platforms {
		deps[fmt.Sprintf("@raminga/bin-%s-%s", p.npmOS, p.npmCPU)] = version
	}
	encodedDeps, _ := json.Marshal(deps)
	pkg["optionalDependencies"] = encodedDeps
	if err := writeJSON(pkgPath, pkg); err != nil {
		return fmt.Errorf("@raminga/dsh: write package.json: %w", err)
	}
	return rejectBinaries(dir)
}

func rejectBinaries(dir string) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "bin" && path != dir {
				return fmt.Errorf("@raminga/dsh must not contain a bin/ directory: %s", path)
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		base := strings.ToLower(d.Name())
		if info.Mode().Perm()&0o111 != 0 && (base == "raminga" || base == "raminga.exe") {
			return fmt.Errorf("@raminga/dsh must not contain a binary: %s", path)
		}
		return nil
	})
}

func copyTree(from, to string) error {
	return filepath.WalkDir(from, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		target := filepath.Join(to, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target, 0o644)
	})
}

func copyFile(from, to string, mode fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	dst, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		return err
	}
	if err := dst.Close(); err != nil {
		return err
	}
	return os.Chmod(to, mode)
}

func writeJSON(path string, v any) error {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}
