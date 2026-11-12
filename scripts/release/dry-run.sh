#!/bin/sh
# Local release dry-run: GoReleaser snapshot into a temporary dist, stage and
# pack every npm package, and render the marketplace tree. Nothing is pushed.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
version=$(tr -d '[:space:]' < "$root/VERSION")
tmp=$(mktemp -d "${TMPDIR:-/tmp}/raminga-release.XXXXXX")
cleanup() {
    rm -rf "$tmp"
}
trap cleanup EXIT HUP INT TERM

echo "release-dry-run: version=$version tmp=$tmp"
sh "$root/scripts/release/verify-version.sh"

cfg="$tmp/goreleaser.yaml"
cp "$root/.goreleaser.yaml" "$cfg"
printf '\ndist: "%s"\n' "$tmp/dist" >> "$cfg"
echo "release-dry-run: GoReleaser snapshot"
(
    cd "$root"
    GOPROXY=${DIST_GOPROXY:-file://${GOMODCACHE:-$root/.local/go-mod}/cache/download|https://proxy.golang.org,direct} \
    GOCACHE=${GOCACHE:-$root/.local/go-cache} \
    GOMODCACHE=${GOMODCACHE:-$root/.local/go-mod} \
    GOPATH=${GOPATH:-$root/.local/go} \
    GOFLAGS=${GOFLAGS:--mod=readonly} \
    CGO_ENABLED=0 \
        go run github.com/goreleaser/goreleaser/v2@v2.19.0 release --snapshot --clean -f "$cfg"
)
test -f "$tmp/dist/SHA256SUMS" || {
    echo "release-dry-run: SHA256SUMS missing" >&2
    exit 1
}

echo "release-dry-run: npm staging, pack and publish --dry-run"
DIST_DIR="$tmp/dist" NPM_OUT="$tmp/npm" PACK_DIR="$tmp/packs" DRY_RUN=1 \
    sh "$root/scripts/release/npm-publish.sh"

echo "release-dry-run: marketplace dry-run"
DRY_RUN=1 MARKETPLACE_DIR="$tmp/marketplace" \
    sh "$root/scripts/release/marketplace-sync.sh"

echo "release-dry-run: PASS"
echo "  dist:        $tmp/dist"
echo "  npm packs:   $tmp/packs"
echo "  marketplace: $tmp/marketplace"
echo "  (the temporary tree is removed when this script exits)"
