#!/bin/sh
# Verify SHA256SUMS for both release archives and the bare plugin binaries.
#
# GoReleaser's snapshot build keeps the `binary`-format artifacts in
# dist/<target>/ instead of copying them to dist/, while SHA256SUMS records the
# published name (raminga_<os>_<arch>). Link each published name to its built
# file in a temporary directory, then run the normal checksum verifier.
set -eu

dir=${1:-dist}
cd "$dir"
test -f SHA256SUMS || { echo "verify-dist: SHA256SUMS missing in $dir" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/raminga-dist-verify.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

missing=0
while read -r sum name; do
    [ -n "${sum:-}" ] || continue
    [ -n "${name:-}" ] || continue
    if [ -f "$name" ]; then
        ln -s "$PWD/$name" "$tmp/$name"
        continue
    fi

    base=$name
    exe=raminga
    case "$name" in
        *.exe)
            base=${name%.exe}
            exe=raminga.exe
            ;;
    esac

    found=
    for candidate in "${base}"_*/"$exe"; do
        if [ -f "$candidate" ]; then
            found=$candidate
            break
        fi
    done
    if [ -z "$found" ]; then
        echo "verify-dist: no built artifact for $name" >&2
        missing=1
        continue
    fi
    ln -s "$PWD/$found" "$tmp/$name"
done < SHA256SUMS

if [ "$missing" -ne 0 ]; then
    exit 1
fi

cp SHA256SUMS "$tmp/SHA256SUMS"
cd "$tmp"
shasum -a 256 -c SHA256SUMS
