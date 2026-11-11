// Command genplugins renders the single-source Raminga Agent content (agent/)
// into each host plugin shell (plugins/claude/...) and verifies the committed
// output matches. It replaces scripts/agentskillcheck.
//
// Without flags it writes the generated tree in place. With --check it renders
// in memory and diffs byte-for-byte against the committed files, failing on any
// difference or stale generated file, so CI can reject hand-edited or stale
// shells.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

func main() {
	root := flag.String("root", ".", "repository root")
	check := flag.Bool("check", false, "render in memory and diff against committed files; exit nonzero on any difference")
	flag.Parse()

	if err := run(*root, *check); err != nil {
		fmt.Fprintln(os.Stderr, "genplugins: FAIL:", err)
		os.Exit(1)
	}
	if *check {
		fmt.Println("genplugins --check: PASS")
	} else {
		fmt.Println("genplugins: wrote plugins/claude, plugins/codex and plugins/dsh")
	}
}

func run(root string, check bool) error {
	abs, err := filepath.Abs(root)
	if err != nil {
		return err
	}

	sh, err := os.ReadFile(filepath.Join(abs, "plugins", "shared", "launcher", "launcher.sh"))
	if err != nil {
		return fmt.Errorf("read launcher template: %w", err)
	}
	ps1, err := os.ReadFile(filepath.Join(abs, "plugins", "shared", "launcher", "launcher.ps1"))
	if err != nil {
		return fmt.Errorf("read launcher template: %w", err)
	}

	files, err := render(sh, ps1)
	if err != nil {
		return err
	}

	if check {
		return checkFiles(abs, files)
	}
	return writeFiles(abs, files)
}

// writeFiles writes every generated file and removes any stale file under a
// generated root that is no longer produced.
func writeFiles(root string, files map[string][]byte) error {
	for path, content := range files {
		target := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("mkdir for %s: %w", path, err)
		}
		mode := fileMode(path)
		if err := os.WriteFile(target, content, mode); err != nil {
			return fmt.Errorf("write %s: %w", path, err)
		}
		// os.WriteFile does not change the mode of an existing file, so an
		// existing launcher would keep its old 0644 bits. Chmod explicitly so
		// every generated .sh is executable in the working tree.
		if err := os.Chmod(target, mode); err != nil {
			return fmt.Errorf("chmod %s: %w", path, err)
		}
	}
	return removeStale(root, files)
}

// checkFiles renders are already in memory; it compares each generated file
// against the committed copy (CRLF-normalized) and fails on any missing,
// differing, or stale file.
func checkFiles(root string, files map[string][]byte) error {
	var problems []string
	for _, path := range sortedKeys(files) {
		target := filepath.Join(root, filepath.FromSlash(path))
		onDisk, err := os.ReadFile(target)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: missing on disk (%v)", path, err))
			continue
		}
		if !bytes.Equal(normalizeLF(onDisk), normalizeLF(files[path])) {
			problems = append(problems, fmt.Sprintf("%s: differs from generated output", path))
		}
	}
	stale, err := staleFiles(root, files)
	if err != nil {
		return err
	}
	for _, p := range stale {
		problems = append(problems, fmt.Sprintf("%s: stale generated file (not produced by genplugins)", p))
	}
	if len(problems) > 0 {
		return fmt.Errorf("generated plugin shell tree is out of date:\n  %s\n\nrun `go run ./scripts/genplugins -root .` and commit the result", joinLines(problems))
	}
	return nil
}

func removeStale(root string, files map[string][]byte) error {
	stale, err := staleFiles(root, files)
	if err != nil {
		return err
	}
	for _, p := range stale {
		if err := os.Remove(filepath.Join(root, filepath.FromSlash(p))); err != nil {
			return fmt.Errorf("remove stale %s: %w", p, err)
		}
	}
	return nil
}

// staleFiles returns files on disk under a generated root that are neither
// generated nor hand-authored.
func staleFiles(root string, files map[string][]byte) ([]string, error) {
	onDisk, err := listGeneratedFiles(root)
	if err != nil {
		return nil, err
	}
	var stale []string
	for p := range onDisk {
		if _, ok := files[p]; ok {
			continue
		}
		if handAuthoredFiles[p] {
			continue
		}
		stale = append(stale, p)
	}
	sort.Strings(stale)
	return stale, nil
}

// listGeneratedFiles walks each generated root and returns repo-relative
// forward-slash paths of every regular file under them.
func listGeneratedFiles(root string) (map[string]bool, error) {
	found := make(map[string]bool)
	for _, gen := range generatedRoots {
		base := filepath.Join(root, filepath.FromSlash(gen))
		err := filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(base, path)
			if err != nil {
				return err
			}
			found[gen+"/"+filepath.ToSlash(rel)] = true
			return nil
		})
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	return found, nil
}

func fileMode(path string) fs.FileMode {
	if filepath.Ext(path) == ".sh" {
		return 0o755
	}
	return 0o644
}

func normalizeLF(b []byte) []byte {
	return bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n"))
}

func sortedKeys(m map[string][]byte) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func joinLines(lines []string) string {
	out := ""
	for _, l := range lines {
		out += "  " + l + "\n"
	}
	return out
}
