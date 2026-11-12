#!/bin/sh
# Raminga MCP launcher (POSIX sh) — source template.
#
# scripts/genplugins renders this into each host shell (plugins/claude/bin/...)
# after substituting the pinned release version and repository. The rendered
# copy is committed and verified by `genplugins --check`; edit this template,
# not the rendered copy.
#
# It resolves a `raminga` binary and execs `raminga mcp`:
#   0. use $RAMINGA_BIN verbatim, skipping the version check (stderr notice);
#   1. reuse a PATH-installed `raminga` whose version exactly matches the pinned release;
#   2. reuse a previously downloaded, verified binary in the shared cache;
#   3. otherwise download the pinned release asset, verify SHA-256, then exec.
#
# macOS and Linux only. Windows uses launcher.ps1.
set -eu

RAMINGA_RELEASE_VERSION="0.1.0-rc.1"
RAMINGA_RELEASE_REPO="Raminga/raminga"

# 0. Explicit override. No version comparison: the caller owns that choice.
if [ -n "${RAMINGA_BIN:-}" ]; then
    echo "raminga-launcher: RAMINGA_BIN is set; using $RAMINGA_BIN and skipping the version check" >&2
    if [ ! -x "$RAMINGA_BIN" ]; then
        echo "raminga-launcher: RAMINGA_BIN is not executable: $RAMINGA_BIN" >&2
        exit 1
    fi
    exec "$RAMINGA_BIN" mcp
fi

# 1. Reuse a PATH binary only when its reported version is exactly the pinned one.
binary_version() {
    "$1" version 2>/dev/null | awk 'NR == 1 && $1 == "raminga" { print $2; exit }'
}
if command -v raminga >/dev/null 2>&1; then
    if [ "$(binary_version raminga)" = "$RAMINGA_RELEASE_VERSION" ]; then
        exec raminga mcp
    fi
fi

# 2. Reuse the shared verified cache.
bin_dir="${RAMINGA_BIN_DIR:-$HOME/.raminga/bin/$RAMINGA_RELEASE_VERSION}"
exe="$bin_dir/raminga"
if [ -x "$exe" ]; then
    exec "$exe" mcp
fi

# 3. Download the pinned asset and verify its SHA-256.
case "$(uname -s)" in
    Darwin) goos="darwin" ;;
    Linux)  goos="linux" ;;
    *)      echo "raminga-launcher: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
    x86_64|amd64) goarch="amd64" ;;
    arm64|aarch64) goarch="arm64" ;;
    *) echo "raminga-launcher: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

base="https://github.com/$RAMINGA_RELEASE_REPO/releases/download/v$RAMINGA_RELEASE_VERSION"
asset="raminga_${goos}_${goarch}"

# Download into a private temporary directory first. Nothing under ~/.raminga
# is created until the checksum has passed, so a failed download leaves no empty
# ~/.raminga/bin/<version>/ behind.
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/raminga-launcher.XXXXXX")" || {
    echo "raminga-launcher: cannot create a temporary directory" >&2
    exit 1
}
tmp="$tmp_dir/$asset"
sums="$tmp_dir/SHA256SUMS"
created_dirs=""

cleanup() {
    rm -rf "$tmp_dir"
    if [ -n "$created_dirs" ]; then
        old_ifs=$IFS
        IFS='
'
        for dir in $created_dirs; do
            [ -n "$dir" ] && rmdir "$dir" 2>/dev/null || true
        done
        IFS=$old_ifs
    fi
}
trap cleanup EXIT HUP INT TERM

download() {
    # $1 = url, $2 = destination
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1"
    else
        echo "raminga-launcher: need curl or wget to download the binary" >&2
        exit 1
    fi
}

download "$base/$asset" "$tmp"
download "$base/SHA256SUMS" "$sums"

expected="$(awk -v a="$asset" '$2 == a { print $1 }' "$sums")"
if [ -z "$expected" ]; then
    echo "raminga-launcher: no SHA256 entry for $asset in SHA256SUMS" >&2
    exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
else
    echo "raminga-launcher: need sha256sum or shasum to verify the download" >&2
    exit 1
fi
if [ "$expected" != "$actual" ]; then
    echo "raminga-launcher: SHA-256 verification failed (want $expected, got $actual)" >&2
    exit 1
fi

# Record every directory this run creates so a partial install can be removed.
probe="$bin_dir"
while [ ! -d "$probe" ]; do
    created_dirs="$created_dirs$probe
"
    parent="$(dirname "$probe")"
    [ "$parent" = "$probe" ] && break
    probe="$parent"
done
if [ ! -d "$bin_dir" ]; then
    mkdir -p "$bin_dir" || { echo "raminga-launcher: cannot create $bin_dir" >&2; exit 1; }
fi

mv "$tmp" "$exe" || { echo "raminga-launcher: cannot install $exe" >&2; exit 1; }
chmod +x "$exe" || { echo "raminga-launcher: cannot chmod $exe" >&2; exit 1; }
mv "$sums" "$bin_dir/SHA256SUMS" || { echo "raminga-launcher: cannot install SHA256SUMS" >&2; exit 1; }

# Success: keep the cache, drop the temporary directory, and disarm cleanup.
rm -rf "$tmp_dir"
created_dirs=""
trap - EXIT HUP INT TERM
exec "$exe" mcp
