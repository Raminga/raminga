#!/bin/sh
# Build the DSH shell, stage the six platform packages and publish them.
#
# DRY_RUN=1 builds and runs `npm pack` plus `npm publish --dry-run` only; it
# never contacts the registry to write. Real runs publish platform packages
# first, then @raminga/dsh, and fail if the exact version already exists.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
version=$(tr -d '[:space:]' < "$root/VERSION")
# Keep npm's cache inside the workspace on sandboxed/local runs. CI may set a
# different writable cache; the value is never printed.
export NPM_CONFIG_CACHE=${NPM_CONFIG_CACHE:-$root/.local/npm-cache}
dist=${DIST_DIR:-$root/dist}
dry_run=${DRY_RUN:-0}
npm_out=${NPM_OUT:-}
if [ -z "$npm_out" ]; then
    npm_out=$(mktemp -d "${TMPDIR:-/tmp}/raminga-npm.XXXXXX")
    cleanup_npm_out=1
else
    cleanup_npm_out=0
fi
pack_dir=${PACK_DIR:-$npm_out/packs}

cleanup() {
    if [ "$cleanup_npm_out" = 1 ]; then
        rm -rf "$npm_out"
    fi
}
trap cleanup EXIT HUP INT TERM

case "$version" in
    *-*) dist_tag=next ;;
    *) dist_tag=latest ;;
esac

[ -f "$dist/artifacts.json" ] || {
    echo "npm-publish: missing $dist/artifacts.json; run GoReleaser first" >&2
    exit 1
}

echo "npm-publish: version=$version tag=$dist_tag dry_run=$dry_run"
echo "npm-publish: building @raminga/dsh"
(
    cd "$root/plugins/dsh"
    if [ "${SKIP_NPM_INSTALL:-0}" != 1 ]; then
        npm install --no-save --no-package-lock --omit=optional --ignore-scripts
    fi
    npm run build
)

mkdir -p "$pack_dir"
echo "npm-publish: staging packages"
GOCACHE=${GOCACHE:-$root/.local/go-cache} \
GOMODCACHE=${GOMODCACHE:-$root/.local/go-mod} \
GOPATH=${GOPATH:-$root/.local/go} \
GOFLAGS=${GOFLAGS:--mod=readonly} \
    go run "$root/scripts/npmdist" -root "$root" -dist "$dist" -out "$npm_out" -version "$version"

publish_one() {
    dir=$1
    name=$(node -p "require('$dir/package.json').name")
    if [ "$dry_run" = 1 ]; then
        echo "npm-publish: [dry-run] $name@$version"
        npm pack --pack-destination "$pack_dir" "$dir" >/dev/null
        npm publish --dry-run --access public --tag "$dist_tag" "$dir" >/dev/null
        return
    fi
    existing=$(npm view "$name@$version" version 2>/dev/null || true)
    if [ -n "$existing" ]; then
        echo "npm-publish: $name@$version already exists; refusing to overwrite" >&2
        exit 1
    fi
    echo "npm-publish: publishing $name@$version ($dist_tag)"
    npm publish --access public --provenance --tag "$dist_tag" "$dir"
}

# Platform packages must exist before the shell advertises them.
for dir in "$npm_out"/bin-*; do
    [ -d "$dir" ] || continue
    publish_one "$dir"
done
publish_one "$npm_out/dsh"

if [ "$dry_run" = 1 ]; then
    echo "npm-publish: DRY_RUN PASS; tarballs in $pack_dir"
    ls -1 "$pack_dir"
fi
