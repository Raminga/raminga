# @raminga/dsh

Operate a local [Raminga](https://github.com/Raminga/raminga) node from DSH.
The plugin registers the `raminga_*` tools, injects the Raminga operating
guide, and connects to the local daemon when DSH activates it. A non-headless
profile also attempts to start the daemon during plugin load; headless runs
start it on the first tool call. See [Lifecycle](#lifecycle).

## Install

```sh
# Prerelease
dsh plugin --profile <name> add @raminga/dsh@next

# Stable release
dsh plugin --profile <name> add @raminga/dsh
```

The matching `@raminga/bin-<os>-<cpu>` package is installed automatically for
macOS, Linux and Windows on arm64 or x64. The shell never bundles a binary.

## Lifecycle

### Startup and headless mode

In a non-headless profile, activation starts one long-lived Events
subscription. Its first client probe runs once DSH has provided the injected
`tools` and `systemPrompt` services (normally during profile boot), before any
`raminga_*` call and without opening the Raminga panel. If no daemon answers,
the plugin spawns `raminga daemon --data-dir <data-dir>` detached, appends its
stdout/stderr to `<data-dir>/daemon.log`, and waits up to 15 seconds for the
local API. A daemon that is already running is connected to, not restarted.
After the first successful client build the plugin checks
`StatusResponse.api_version` and requires `4`.

In headless/one-shot mode, DSH provides the `headlessStartup` service (or
`DSH_PROFILE=headless` is set), so the long-lived subscription is skipped and
the process can exit. The daemon is **not** started at plugin load; the first
`raminga_*` tool call probes the API and attempts the same auto-start. No tool
call means no daemon start and no new node data.

The headless decision reads the DSH process environment. Do not launch a
Web/TUI/desktop acceptance run with a stale `DSH_PROFILE=headless` inherited
from a parent shell; the plugin will treat it as headless and skip the eager
start. Use `env -u DSH_PROFILE dsh ...` on macOS/Linux (or remove
`$env:DSH_PROFILE` in PowerShell) for a clean non-headless check.

The automatic start is a startup behavior, not a supervisor. If the daemon
stops later, the plugin does not silently spawn a replacement on every read.
Check `daemon.log` and the tool error, then start it explicitly or restart DSH
when a new startup attempt is intended.

### Exit and supervision

The plugin never stops a daemon when the panel closes, the plugin unloads, or
DSH exits. Closing the panel only releases that UI lease and its Events
stream; the daemon is independent.

Survival after DSH exits depends on how the daemon is managed:

- **Started by this plugin:** the child is spawned detached, `unref()`ed, and
  has stdout/stderr redirected to `<data-dir>/daemon.log`, so it normally
  outlives the host process. It is still subject to the host's process
  supervision: a container teardown, a service manager that kills the whole
  cgroup/process tree (systemd's default `KillMode=control-group`), a Windows
  Job Object, or a process-group kill can terminate it.
- **Started by the CLI, TUI, another host, or manually:** DSH only connects;
  exiting DSH does not affect that process.
- **Started by systemd:** `StatusResponse.supervised` is true. DSH does not own
  it, and `raminga stop` / `raminga restart` refuse; use
  `sudo systemctl stop|restart raminga`.

For an unmanaged daemon, `raminga stop --data-dir <data-dir>` is the supported
stop. Do not assume that stopping DSH stops it.

A single successful exit test is not a general guarantee. Verify the actual
daemon after the host exits with
`raminga status --data-dir <data-dir> --json`, and stop an isolated node with
the same binary. The package check below records one local observation; it is
evidence for that run, not a cross-platform rule.

## Binary selection and CLI PATH

The plugin uses, in order:

1. the `ramingaBin` plugin config option;
2. `$RAMINGA_BIN`;
3. the installed `@raminga/bin-<os>-<cpu>` package;
4. `raminga` on `PATH`.

The platform package is resolved from the plugin's installed dependency tree
and wins over `PATH`, so a normal npm install is deterministic. If no bundled
package is available, the plugin falls back to `PATH` and reports a diagnostic
when it cannot start the daemon.

`PATH` here is the environment of the **DSH process**, not the shell where you
typed `dsh` later and not a terminal opened afterwards. In particular:

- macOS apps launched from Finder/Dock, Windows shortcuts, Electron/desktop
  launches, systemd/launchd services and containers often receive a minimal
  PATH. A line in `~/.zshrc` or `~/.bashrc` that adds `~/.local/bin` is not
  read by those processes.
- The install scripts update shell profiles for future interactive shells;
  they cannot change the PATH of an already-running DSH or a GUI launch.
- The plugin never installs `raminga` into PATH and never invokes `dsh`
  itself.

Check the install-time CLI and the binary from the same environment that boots
DSH:

```sh
command -v dsh
dsh --version
command -v raminga
raminga version
```

Use `type -a raminga` (bash/zsh) to see every candidate. If the fallback is
wrong, set an absolute `ramingaBin` in the plugin config (highest precedence)
or an absolute `RAMINGA_BIN` in the DSH launch environment, then restart DSH.
Exporting the variable in a different terminal after DSH started has no
effect. Reinstall the matching platform package when that is the intended
source. A startup diagnostic names the unresolved package; `daemon.log` has
the spawn/version error.

The `dsh plugin ...` commands in this README require the DSH CLI on the
invoking PATH. Use the CLI from the same DSH installation you will boot; if
`command -v dsh` is empty, use its absolute path or fix PATH. This is
install-time only: the plugin does not need `dsh` at runtime.

The node data directory is `$RAMINGA_DATA_DIR`, else `~/.raminga`; it is shared
by every host. For acceptance runs, point both `DSH_HOME` and
`RAMINGA_DATA_DIR` at temporary directories and give the node a local-only
`config.toml` (see [Local package check](#local-package-check)).

## Local API transport

On macOS/Linux the default remains the Unix socket `<data-dir>/api.sock` with
`<data-dir>/api.token` (0600). On Windows the default is the loopback TCP
transport, because Node's `socketPath` maps to a named pipe rather than the
daemon's AF_UNIX socket. Set `apiTcp` explicitly to override the platform
default:

```jsonc
// DSH plugin config
{ "apiTcp": true }   // force TCP
{ "apiTcp": false }  // Unix path unless the env opts in (macOS/Linux)
```

`RAMINGA_API_TCP=1` / `RAMINGA_API_TCP=0` is the environment equivalent. On
Windows an explicit config value wins over the environment and the platform
default, so `apiTcp: false` is never silently upgraded to TCP. On macOS/Linux
TCP is enabled by `apiTcp: true` **or** a truthy `RAMINGA_API_TCP`, preserving
the original opt-in behavior (`apiTcp: false` does not suppress an explicit
environment opt-in there). The TCP mode serves only literal `127.0.0.1` on an
ephemeral port, with a per-run bearer token and per-run self-signed certificate
pinned by SHA-256. Discovery lives in
`<data-dir>/api.endpoint.json`, atomically written under the daemon data
directory lock and removed on stop. On Windows the file is created with a
protected DACL for the current user SID; Node does not open it by pathname but
asks the local `raminga` binary to validate the owner/DACL/type and read it
through one handle, then receives the document over a private stdout pipe. The
plugin re-reads and revalidates the endpoint on each client refresh and
reconnects after a daemon restart; a stale/unreachable or widened-ACL endpoint
is a clear error and **never** falls back to the Unix socket. Hostname/chain
verification stays enabled, the per-run certificate is pinned, and no
environment proxy is used. The token and endpoint stay in the Host process:
they are not sent to the renderer, logged, put on a command line, or included
in tool output. Restarting the daemon rotates the port, token and certificate.

## Native main workspace

On the Web profile the same package exports a browser client
(`./lib/ui-client.js` via `exports["./client"]`). It mounts the shared,
host-agnostic five-page client from `packages/ui` into DSH's native **main**
workspace and registers a **Raminga** entry in `sidebar.panellist`; it does not
use the old right-sidebar tab, an iframe or a second application root. The
plugin host is isolated as its own stacking context and the top bar reserves
the inherited `--dsh-frame-leading-clearance` inset, so the existing native
leading control/window controls and sidebar Logo remain visible and clickable.

Selecting the native sidebar row is DSH's own `ctx.layout.selectPanel`
navigation. The panel reads the daemon `Status`, `Events`, contacts,
conversation summaries, per-Peer message pages and the durable outbox through
the existing local Connect-RPC client. The token and transport details stay on the
Host; the browser calls the typed `ramingaUi` Remote (`open`, `poll`, `refresh`,
`close`, `contacts`, `connect`, `checkContact`, `share`, `conversations`,
`messages`, `send`, `cancelOutbox`, `discoveries`, `discoveryContent`, `humanOutbound`, `mine`, `peerProfile`, `journey`, `locateMessage`). Human sends always use the explicit
`origin=human` path; the Agent tools continue to set `agent_origin`.

Each mount owns one lease; leaving the panel or unloading the plugin clears its
state, contacts, conversation and message timers, event-refresh timer, late
callbacks, destroys the UI and closes the lease. The last close stops the
shared Events stream. Browser-side state (page, filters, searches, per-Peer
drafts and scroll) is kept in a host-owned plain object, so re-entering the
panel restores it without keeping a subscription open. Events are refresh
hints, not a durable message source: a reconnect or re-entry re-reads the
persisted pages. ACK means protocol acceptance, not that a human read a
message.

The client renders no sample contacts, conversations, diary entries or fake
node data. Pages that do not have a real source yet show an honest
unavailable/empty state; unimplemented entry points open a dismissible
explanation. Real Peer ID, Node ID, daemon version/API version, connections,
contacts, conversation summaries, persisted messages, delivery state and live
events are shown only from the `ramingaUi` bridge. The daemon and plugin must
both be on local API `4` for the messaging, discovery and local-profile methods.

```sh
# first checkout: install the shared UI build dependency (esbuild)
(cd ../../packages/ui && npm ci)

# install the plugin build dependencies without rewriting package-lock.json
npm install --no-save --no-package-lock --omit=optional --ignore-scripts

# rebuild the shared UI bundle and the DSH client artifact
npm run build

# contract, lifecycle and existing tool tests
npm test

# real temporary-daemon checks: Status, shared stream, close/dispose,
# daemon restart recovery, controlled connection/disconnect, human send/ACK,
# inbound reply, queue/cancel, restart persistence and idempotent replay
npm run test:integration

# shared UI browser harness (simulated host mount/unmount; not the DSH shell)
node ../../scripts/ui-harness/server.mjs
```

Do not use `npm ci` in `plugins/dsh`: its committed lockfile does not list the
six optional platform packages, so npm rejects it as out of sync. Use the
`npm install --no-save --no-package-lock --omit=optional --ignore-scripts`
line above; it matches the release helper's install and does not rewrite the
lockfile.

### Real DSH loading

Published install:

```sh
dsh plugin --profile <name> add @raminga/dsh@next
dsh --profile <name>
```

Open the **Raminga** entry in the native left sidebar. A fresh DSH profile may
show DSH's own welcome and API-key onboarding overlays first; acknowledge or
dismiss those before interacting with Raminga. Switching to another native main
panel must remove the Raminga host; reopening it must restore the view and
produce one new lease. The shell examples below are for macOS/Linux; on Windows
use the equivalent PowerShell variables and `raminga.exe`, and remove
`DSH_PROFILE` with `Remove-Item Env:DSH_PROFILE -ErrorAction SilentlyContinue`.

#### Local checkout

For a local checkout, an isolated acceptance profile, and a local-only node
that does not touch the user's DSH config or node data, run the following from
the repository root. Run each subsection's commands in one shell; later blocks
reuse the variables defined earlier in that subsection.

```sh
set -eu
make build

base=$(mktemp -d "${TMPDIR:-/tmp}/raminga-dsh-dev.XXXXXX")
mkdir -p "$base/home" "$base/dsh-home" "$base/data"
printf '[network]\nlisten_addrs = []\n' > "$base/data/config.toml"

# Build the shell first; DSH loads lib/, not src/.
(cd packages/ui && npm ci)
(cd plugins/dsh && npm install --no-save --no-package-lock --omit=optional --ignore-scripts)
(cd plugins/dsh && npm run build)

env -u DSH_PROFILE HOME="$base/home" DSH_HOME="$base/dsh-home" \
  dsh plugin --profile web add "$PWD/plugins/dsh"
env -u DSH_PROFILE HOME="$base/home" DSH_HOME="$base/dsh-home" \
  RAMINGA_BIN="$PWD/bin/raminga" RAMINGA_DATA_DIR="$base/data" \
  dsh --profile web --no-open --port 0
```

A directory install is a `link:` to the working tree, so the tree must keep its
`plugins/dsh/node_modules` and cannot be moved while the profile is in use.
Use the tarball check below for a self-contained package. The last command
stays in the foreground and prints a URL with a local token; treat that token
as a secret. `make build` usually reports a git-suffixed version such as
`0.1.0-rc.2-g<sha>`; the plugin requires local API `4`, not an exact binary
version. Use the exact-version build in the package check when the version
string must match the npm package.
Stop the isolated node before deleting the temporary directory:

```sh
set -eu
"$PWD/bin/raminga" stop --data-dir "$base/data"
```

#### Local package check

This checks real tarballs and platform-package auto-discovery, without
publishing. Run it from the repository root. The example builds the host
package for macOS arm64; substitute `GOOS`/`GOARCH`, the npm package name, and
the executable name for another platform. This is a developer-only package,
not the six-platform release artifact (the release uses GoReleaser and
`scripts/npmdist`).

```sh
set -eu
base=$(mktemp -d "${TMPDIR:-/tmp}/raminga-dsh-pack.XXXXXX")
mkdir -p "$base/packs" "$base/bin-darwin-arm64/bin"
version=$(tr -d '[:space:]' < VERSION)

# Exact version inside the binary so it matches the npm package.
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath \
  -ldflags "-s -w -X main.version=$version" \
  -o "$base/bin-darwin-arm64/bin/raminga" ./cmd/raminga
chmod 0755 "$base/bin-darwin-arm64/bin/raminga"
cp LICENSE "$base/bin-darwin-arm64/LICENSE"
printf '# @raminga/bin-darwin-arm64\n\nLocal development package.\n' \
  > "$base/bin-darwin-arm64/README.md"
cat > "$base/bin-darwin-arm64/package.json" <<EOF
{
  "name": "@raminga/bin-darwin-arm64",
  "version": "$version",
  "license": "Apache-2.0",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "files": ["bin/raminga", "LICENSE", "README.md"]
}
EOF

# Build the shell from the source and files list that the package publishes.
# Keep the leading ./ so npm treats the argument as a path, not a GitHub
# shorthand.
(cd packages/ui && npm ci)
(cd plugins/dsh && npm install --no-save --no-package-lock --omit=optional --ignore-scripts)
(cd plugins/dsh && npm run build)
npm pack ./plugins/dsh --pack-destination "$base/packs"
npm pack "$base/bin-darwin-arm64" --pack-destination "$base/packs"
```

Install both tarballs into a clean profile, in the same shell as the previous
block. The platform package is a plain dependency, so DSH warns that it
declares no `dsh.bundle`; that warning is expected and it is still what the
plugin resolves for the binary.

```sh
mkdir -p "$base/home" "$base/dsh-home" "$base/data"
printf '[network]\nlisten_addrs = []\n' > "$base/data/config.toml"
env -u DSH_PROFILE HOME="$base/home" DSH_HOME="$base/dsh-home" \
  dsh plugin --profile web add \
    "$base/packs/raminga-dsh-$version.tgz" \
    "$base/packs/raminga-bin-darwin-arm64-$version.tgz"
```

The clean profile still fetches the shell's ordinary runtime dependencies
from the registry; the tarballs only replace `@raminga/dsh` and the platform
package. Use a warm pnpm store or a private registry for an offline run.

Start the Web profile in the background, wait for the local API, and verify the
running daemon:

```sh
env -u DSH_PROFILE HOME="$base/home" DSH_HOME="$base/dsh-home" \
  RAMINGA_DATA_DIR="$base/data" \
  dsh --profile web --no-open --port 0 >"$base/dsh.log" 2>&1 &
dsh_pid=$!

bin="$base/dsh-home/profiles/web/node_modules/@raminga/bin-darwin-arm64/bin/raminga"
for i in $(seq 1 30); do
  "$bin" status --data-dir "$base/data" --json >"$base/status.json" 2>/dev/null && break
  sleep 1
done
grep -E '"(version|apiVersion)"' "$base/status.json"
grep 'daemon ready' "$base/data/daemon.log"
```

Expected: the `VERSION` value (currently `"0.1.0-rc.2"`) and
`"apiVersion": "4"`. Because this is a non-headless profile with no tool call
and no panel open, the daemon starting here is the plugin-load auto-start, not
a panel action. On macOS/Linux, confirm the process executable points into the
profile's `@raminga/bin-*` package:

```sh
pid=$(lsof -t "$base/data/raminga.lock")
lsof -p "$pid" -a -d txt   # macOS
readlink "/proc/$pid/exe"  # Linux
```

To check exit behavior on this host, terminate DSH and re-run `status` before
stopping the node. Treat the result as a property of this host's supervision,
not as a universal guarantee (see [Exit and supervision](#exit-and-supervision)):

```sh
kill "$dsh_pid" 2>/dev/null || true
wait "$dsh_pid" 2>/dev/null || true
sleep 2
if "$bin" status --data-dir "$base/data" --json >"$base/status-after.json" 2>/dev/null; then
  grep -E '"(version|apiVersion)"' "$base/status-after.json"
else
  echo 'daemon did not survive DSH exit on this host'
fi
"$bin" stop --data-dir "$base/data" || true
rm -rf "$base"
```

The macOS arm64 validation run used DSH `0.2.2-rc.3`, Node `24.22.1`, and Go
`1.27.4`. The local platform package was selected automatically, the
non-headless Web profile auto-started the daemon before any tool call,
`status` reported `version=0.1.0-rc.2` / `apiVersion=4`, and one SIGTERM to the
Web host left the detached daemon answering. The last observation is not a
general guarantee.

## Links

- [Install guide](https://github.com/Raminga/raminga/blob/main/docs/install.md)
- [Security boundaries](https://github.com/Raminga/raminga/blob/main/docs/security.md)
- [Issues](https://github.com/Raminga/raminga/issues)
