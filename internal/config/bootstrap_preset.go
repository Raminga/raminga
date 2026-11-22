package config

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	ma "github.com/multiformats/go-multiaddr"
	"github.com/pelletier/go-toml/v2"
)

// BootstrapPresetFileName is the release sidecar copied next to the resolved
// executable. The same file is embedded so a bare binary or a binary-only
// marketplace package still has an official preset.
const BootstrapPresetFileName = "bootstrap-preset.toml"

//go:embed bootstrap-preset.toml
var embeddedBootstrapPreset []byte

type bootstrapPresetFile struct {
	// Pointer distinguishes an explicit empty list (off) from a missing key
	// (invalid selected preset).
	BootstrapPeers *[]string `toml:"bootstrap_peers"`
}

// resolveBootstrapPeers applies the first-initialization priority:
// explicit --bootstrap custom list > --no-bootstrap-preset opt out > sidecar
// next to the resolved executable > embedded copy of the same TOML file.
// A selected but invalid or unreadable sidecar fails; it never silently falls
// back to the embedded copy. An explicit empty list disables the preset.
func resolveBootstrapPeers(custom []string, disabled bool, executable string) ([]string, bool, string, error) {
	if len(custom) > 0 {
		return append([]string(nil), custom...), false, "custom", nil
	}
	if disabled {
		return nil, false, "disabled", nil
	}
	peers, source, err := loadOfficialBootstrapPeers(executable)
	if err != nil {
		return nil, false, "", err
	}
	if len(peers) == 0 {
		return nil, false, source, nil
	}
	return peers, true, source, nil
}

// loadOfficialBootstrapPeers reads the sidecar next to the resolved executable.
// Only a missing file falls back to the embedded copy; permission, directory,
// or parse errors are returned so a broken selected preset cannot be ignored.
func loadOfficialBootstrapPeers(executable string) ([]string, string, error) {
	path, err := bootstrapPresetSidecarPath(executable)
	if err != nil {
		return nil, "", err
	}
	raw, err := os.ReadFile(path)
	if err == nil {
		peers, parseErr := parseBootstrapPreset(raw, path)
		if parseErr != nil {
			return nil, "", parseErr
		}
		return peers, path, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, "", fmt.Errorf("read bootstrap preset %q: %w", path, err)
	}
	peers, parseErr := parseBootstrapPreset(embeddedBootstrapPreset, "embedded "+BootstrapPresetFileName)
	if parseErr != nil {
		return nil, "", parseErr
	}
	return peers, "embedded " + BootstrapPresetFileName, nil
}

func bootstrapPresetSidecarPath(executable string) (string, error) {
	if executable == "" {
		resolved, err := os.Executable()
		if err != nil {
			return "", fmt.Errorf("resolve executable for bootstrap preset: %w", err)
		}
		executable = resolved
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("resolve executable path %q for bootstrap preset: %w", executable, err)
	}
	return filepath.Join(filepath.Dir(resolved), BootstrapPresetFileName), nil
}

func parseBootstrapPreset(raw []byte, source string) ([]string, error) {
	var file bootstrapPresetFile
	dec := toml.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&file); err != nil {
		return nil, fmt.Errorf("invalid bootstrap preset %q: %w", source, err)
	}
	if file.BootstrapPeers == nil {
		return nil, fmt.Errorf("invalid bootstrap preset %q: missing bootstrap_peers list", source)
	}
	values := *file.BootstrapPeers
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for index, rawAddr := range values {
		if err := validateBootstrapAddr(rawAddr); err != nil {
			return nil, fmt.Errorf("bootstrap preset %q entry %d: %w", source, index+1, err)
		}
		m, err := ma.NewMultiaddr(rawAddr)
		if err != nil {
			return nil, fmt.Errorf("bootstrap preset %q entry %d: %w", source, index+1, err)
		}
		addr := m.String()
		if _, exists := seen[addr]; exists {
			continue
		}
		seen[addr] = struct{}{}
		out = append(out, addr)
	}
	return out, nil
}
