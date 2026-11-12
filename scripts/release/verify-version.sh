#!/bin/sh
# Validate that the release tag, VERSION, generated Go fallback and GoReleaser
# snapshot template all describe the same release. The tag check runs when a
# tag is supplied (CI passes GITHUB_REF_NAME; local runs may omit it).
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
version=$(tr -d '[:space:]' < "$root/VERSION")
[ -n "$version" ] || { echo "release-version: VERSION is empty" >&2; exit 1; }

tag=${1:-${GITHUB_REF_NAME:-}}
# workflow_dispatch runs from a branch; only a tag ref is version-checked.
if [ "${GITHUB_REF_TYPE:-tag}" != "tag" ]; then
    tag=
fi
if [ -n "$tag" ]; then
    [ "$tag" = "v$version" ] || {
        echo "release-version: tag $tag does not match v$version from VERSION" >&2
        exit 1
    }
fi

grep -Fq "const defaultVersion = \"$version\"" "$root/cmd/raminga/version_default.go" || {
    echo "release-version: cmd/raminga/version_default.go is not generated from VERSION $version" >&2
    exit 1
}
grep -Fq "version_template: \"$version-snapshot-{{ .ShortCommit }}\"" "$root/.goreleaser.yaml" || {
    echo "release-version: .goreleaser.yaml snapshot version is not aligned with VERSION $version" >&2
    exit 1
}
grep -Fq 'owner: Raminga' "$root/.goreleaser.yaml" || {
    echo "release-version: .goreleaser.yaml has no release.github owner" >&2
    exit 1
}
grep -Fq 'name: raminga' "$root/.goreleaser.yaml" || {
    echo "release-version: .goreleaser.yaml has no release.github name" >&2
    exit 1
}

echo "release-version: PASS version=$version tag=${tag:-<none>}"
