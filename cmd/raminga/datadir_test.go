package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDetectForeignDataDir(t *testing.T) {
	t.Run("missing dir is safe", func(t *testing.T) {
		foreign, err := detectForeignDataDir(filepath.Join(t.TempDir(), "nope"))
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if foreign {
			t.Fatal("missing dir must not be foreign")
		}
	})

	t.Run("empty dir is safe", func(t *testing.T) {
		dir := t.TempDir()
		foreign, err := detectForeignDataDir(dir)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if foreign {
			t.Fatal("empty dir must not be foreign")
		}
	})

	t.Run("raminga-owned dir is safe", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.Mkdir(filepath.Join(dir, "identity"), 0o700); err != nil {
			t.Fatal(err)
		}
		foreign, err := detectForeignDataDir(dir)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if foreign {
			t.Fatal("dir with identity/ must not be foreign")
		}
	})

	t.Run("non-empty foreign dir is flagged", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		foreign, err := detectForeignDataDir(dir)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if !foreign {
			t.Fatal("non-empty dir without identity/ or config.toml must be foreign")
		}
	})
}

func writeNodeIdentity(t *testing.T, dir string) {
	t.Helper()
	identityDir := filepath.Join(dir, "identity")
	if err := os.MkdirAll(identityDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(identityDir, "key"), []byte("test-key"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestOtherNodeDataDirs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("RAMINGA_DATA_DIR", "")

	t.Run("default node is found when the target is elsewhere", func(t *testing.T) {
		writeNodeIdentity(t, filepath.Join(home, ".raminga"))
		target := filepath.Join(home, "target")
		found, err := otherNodeDataDirs(target)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		want := filepath.Join(home, ".raminga")
		if len(found) != 1 || found[0] != want {
			t.Fatalf("found = %v, want [%s]", found, want)
		}
	})

	t.Run("documented nested legacy node is found under the default dir", func(t *testing.T) {
		// Reset HOME so this subtest does not see the identity above.
		home = t.TempDir()
		t.Setenv("HOME", home)
		writeNodeIdentity(t, filepath.Join(home, ".raminga", "raminga-test"))
		found, err := otherNodeDataDirs(filepath.Join(home, ".raminga"))
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if len(found) != 1 || found[0] != filepath.Join(home, ".raminga", "raminga-test") {
			t.Fatalf("found = %v", found)
		}
	})

	t.Run("env and default locations are cross-checked", func(t *testing.T) {
		home = t.TempDir()
		t.Setenv("HOME", home)
		envDir := filepath.Join(home, "custom-node")
		t.Setenv("RAMINGA_DATA_DIR", envDir)
		writeNodeIdentity(t, envDir)
		found, err := otherNodeDataDirs(filepath.Join(home, ".raminga"))
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if len(found) != 1 || found[0] != envDir {
			t.Fatalf("found = %v, want [%s]", found, envDir)
		}
	})

	t.Run("identity directory without a key is not a node", func(t *testing.T) {
		home = t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("RAMINGA_DATA_DIR", "")
		if err := os.MkdirAll(filepath.Join(home, ".raminga", "identity"), 0o700); err != nil {
			t.Fatal(err)
		}
		found, err := otherNodeDataDirs(filepath.Join(home, "target"))
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if len(found) != 0 {
			t.Fatalf("found = %v, want none", found)
		}
	})
}

func TestDetectForeignDataDirIgnoresRamingaOwnedEntries(t *testing.T) {
	cases := []struct {
		name        string
		setup       func(t *testing.T, dir string)
		wantForeign bool
	}{
		{
			name: "only launcher binary cache",
			setup: func(t *testing.T, dir string) {
				t.Helper()
				if err := os.MkdirAll(filepath.Join(dir, "bin", "0.1.0"), 0o700); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "cache plus runtime files",
			setup: func(t *testing.T, dir string) {
				t.Helper()
				if err := os.MkdirAll(filepath.Join(dir, "bin", "0.1.0"), 0o700); err != nil {
					t.Fatal(err)
				}
				for _, name := range []string{"raminga.lock", "daemon.log", "daemon.log.1", "api.token", "api.endpoint.json"} {
					if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
			},
		},
		{
			name: "cache plus identity",
			setup: func(t *testing.T, dir string) {
				t.Helper()
				if err := os.MkdirAll(filepath.Join(dir, "bin", "0.1.0"), 0o700); err != nil {
					t.Fatal(err)
				}
				writeNodeIdentity(t, dir)
			},
		},
		{
			name: "cache plus unknown file",
			setup: func(t *testing.T, dir string) {
				t.Helper()
				if err := os.MkdirAll(filepath.Join(dir, "bin", "0.1.0"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			wantForeign: true,
		},
		{
			name: "cache plus unknown agent directory",
			setup: func(t *testing.T, dir string) {
				t.Helper()
				if err := os.MkdirAll(filepath.Join(dir, "bin", "0.1.0"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(dir, "agent"), 0o700); err != nil {
					t.Fatal(err)
				}
			},
			wantForeign: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			dir := filepath.Join(home, ".raminga")
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			tc.setup(t, dir)
			foreign, err := detectForeignDataDir(dir)
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if foreign != tc.wantForeign {
				t.Fatalf("foreign = %v, want %v", foreign, tc.wantForeign)
			}
		})
	}
}

func TestAutoStartWarningIsSharedByTUIAndMCP(t *testing.T) {
	t.Run("foreign non-empty target", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		warning, err := autoStartWarning(dir)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if !strings.Contains(warning, "疑似旧版") || !strings.Contains(warning, "raminga init") {
			t.Fatalf("warning = %q", warning)
		}
	})

	t.Run("target lacks identity but another known node exists", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("RAMINGA_DATA_DIR", "")
		other := filepath.Join(home, ".raminga")
		writeNodeIdentity(t, other)
		target := filepath.Join(home, "empty-target")
		warning, err := autoStartWarning(target)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if !strings.Contains(warning, "尚无身份") || !strings.Contains(warning, other) {
			t.Fatalf("warning = %q", warning)
		}
	})

	t.Run("initialized target is allowed even when another node exists", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("RAMINGA_DATA_DIR", "")
		writeNodeIdentity(t, filepath.Join(home, ".raminga"))
		target := filepath.Join(home, "target")
		writeNodeIdentity(t, target)
		warning, err := autoStartWarning(target)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if warning != "" {
			t.Fatalf("warning = %q, want empty", warning)
		}
	})

	t.Run("launcher cache only is allowed", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("RAMINGA_DATA_DIR", "")
		dir := filepath.Join(home, ".raminga")
		if err := os.MkdirAll(filepath.Join(dir, "bin", "0.1.0"), 0o700); err != nil {
			t.Fatal(err)
		}
		warning, err := autoStartWarning(dir)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if warning != "" {
			t.Fatalf("warning = %q, want empty", warning)
		}
	})
}
