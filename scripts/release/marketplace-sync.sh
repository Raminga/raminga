#!/bin/sh
# Sync the Claude Code and Codex plugin trees to the Raminga/raminga-plugins
# marketplace repository, preserving the source paths used by both manifests.
#
# DRY_RUN=1 writes the exact tree to MARKETPLACE_DIR and does not touch git.
# Real runs initialize the repository when it is empty, commit with the
# release version, create the same vX.Y.Z tag and push main + tag.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
version=$(tr -d '[:space:]' < "$root/VERSION")
dry_run=${DRY_RUN:-0}
work=${MARKETPLACE_DIR:-}
repo=${MARKETPLACE_REPO:-git@github.com:Raminga/raminga-plugins.git}

if [ -z "$work" ]; then
    work=$(mktemp -d "${TMPDIR:-/tmp}/raminga-marketplace.XXXXXX")
    cleanup_work=1
else
    cleanup_work=0
fi
cleanup() {
    if [ "$cleanup_work" = 1 ]; then
        rm -rf "$work"
    fi
}
trap cleanup EXIT HUP INT TERM

write_readme() {
    cat > "$work/README.md" <<'EOF'
# Raminga plugins

Claude Code and Codex plugin marketplace for
[Raminga](https://github.com/Raminga/raminga).

## Claude Code

```sh
claude plugin marketplace add Raminga/raminga-plugins
claude plugin install raminga@raminga-plugins
```

## Codex

```sh
codex plugin marketplace add Raminga/raminga-plugins
codex plugin add raminga@raminga-plugins
```

Full install, upgrade and troubleshooting instructions:
<https://github.com/Raminga/raminga/blob/main/docs/install.md>
EOF
}

sync_tree() {
    rm -rf "$work/.claude-plugin" "$work/.agents" "$work/plugins" "$work/LICENSE" "$work/README.md"
    mkdir -p "$work/.claude-plugin" "$work/.agents/plugins" "$work/plugins"
    cp "$root/.claude-plugin/marketplace.json" "$work/.claude-plugin/marketplace.json"
    cp "$root/.agents/plugins/marketplace.json" "$work/.agents/plugins/marketplace.json"
    cp -R "$root/plugins/claude" "$work/plugins/claude"
    cp -R "$root/plugins/codex" "$work/plugins/codex"
    cp "$root/LICENSE" "$work/LICENSE"
    write_readme
}

mkdir -p "$work"

if [ "$dry_run" = 1 ]; then
    sync_tree
    echo "marketplace-sync: DRY_RUN staged v$version tree in $work"
    exit 0
fi

cd "$work"
git init -q -b main
if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$repo"
else
    git remote add origin "$repo"
fi

if git ls-remote --heads origin main | grep -q .; then
    git fetch -q --depth=1 origin main
    git reset -q --hard FETCH_HEAD
fi
if git ls-remote --tags origin "refs/tags/v$version" | grep -q .; then
    echo "marketplace-sync: tag v$version already exists in $repo" >&2
    exit 1
fi

sync_tree
git add -A
if git diff --cached --quiet; then
    echo "marketplace-sync: no changes for v$version" >&2
    exit 1
fi
git -c user.name='Raminga Release' \
    -c user.email='raminga-release@users.noreply.github.com' \
    commit -q -m "Release v$version"
git tag "v$version"
git push origin HEAD:main
git push origin "v$version"
echo "marketplace-sync: pushed v$version to $repo"
