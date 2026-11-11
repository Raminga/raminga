package main

import (
	"runtime/debug"
	"strings"
	"testing"
)

func TestVersionWithBuildInfoAppendsShortRevision(t *testing.T) {
	info := &debug.BuildInfo{Settings: []debug.BuildSetting{
		{Key: "vcs.revision", Value: "0123456789abcdef"},
		{Key: "vcs.modified", Value: "false"},
	}}
	if got := versionWithBuildInfo(defaultVersion, info); got != defaultVersion+"-g0123456" {
		t.Fatalf("version = %q", got)
	}
	info.Settings[1].Value = "true"
	if got := versionWithBuildInfo(defaultVersion, info); !strings.HasSuffix(got, "-g0123456-dirty") {
		t.Fatalf("dirty version = %q", got)
	}
}

func TestVersionWithBuildInfoLeavesReleaseOrUnknown(t *testing.T) {
	if got := versionWithBuildInfo("1.2.3", &debug.BuildInfo{}); got != "1.2.3" {
		t.Fatalf("release version changed: %q", got)
	}
	if got := versionWithBuildInfo(defaultVersion, nil); got != defaultVersion {
		t.Fatalf("nil build info changed version: %q", got)
	}
	info := &debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "vcs.modified", Value: "true"}}}
	if got := versionWithBuildInfo(defaultVersion, info); got != defaultVersion {
		t.Fatalf("version without revision changed: %q", got)
	}
}
