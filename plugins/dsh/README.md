# @raminga/dsh

Operate a local [Raminga](https://github.com/Raminga/raminga) node from DSH.
The plugin registers the `raminga_*` tools, injects the Raminga operating
guide, and starts the local daemon on first use.

## Install

```sh
# Prerelease
dsh plugin --profile <name> add @raminga/dsh@next

# Stable release
dsh plugin --profile <name> add @raminga/dsh
```

The matching `@raminga/bin-<os>-<cpu>` package is installed automatically for
macOS, Linux and Windows on arm64 or x64. The shell never bundles a binary.

## Binary selection

The plugin uses, in order:

1. the `ramingaBin` plugin config option;
2. `$RAMINGA_BIN`;
3. the installed `@raminga/bin-<os>-<cpu>` package;
4. `raminga` on `PATH`.

If no bundled package is available, the plugin falls back to `PATH` and reports
a diagnostic when it cannot start the daemon. The node data directory is
`$RAMINGA_DATA_DIR`, else `~/.raminga`; it is shared by every host.


## Local API transport

The default remains the Unix socket `<data-dir>/api.sock` with
`<data-dir>/api.token` (0600). For environments that need a loopback TCP
control channel (for example a host that cannot map the Unix socket), opt in
explicitly:

```jsonc
// DSH plugin config
{ "apiTcp": true }
```

or set `RAMINGA_API_TCP=1` before auto-start. The daemon then serves only
literal `127.0.0.1` on an ephemeral port, with a per-run bearer token and a
per-run self-signed certificate pinned by SHA-256. Discovery lives in
`<data-dir>/api.endpoint.json` (0600, atomically written under the daemon data
directory lock and removed on stop). The plugin re-reads the endpoint and
reconnects after a daemon restart; a stale/unreachable endpoint is a clear
error and **never** falls back to the Unix socket. Hostname/chain verification
stays enabled, the per-run certificate is pinned, and no environment proxy is
used. The token and endpoint stay in the Host process: they are not sent to
the renderer, logged, or included in tool output. Restarting the daemon
rotates the port, token and certificate.

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

### Real DSH loading

Published install:

```sh
dsh plugin --profile <name> add @raminga/dsh@next
dsh --profile <name>
```

Open the **Raminga** entry in the native left sidebar. For a local checkout and
an isolated acceptance profile that does not modify the user's DSH config or
node data:

```sh
export DSH_HOME=$(mktemp -d)
dsh plugin --profile web add "$PWD/plugins/dsh"
RAMINGA_DATA_DIR=$(mktemp -d) dsh --profile web --no-open --port 4321
```

The printed URL contains a local token. A fresh DSH profile may show DSH's own
welcome and API-key onboarding overlays first; acknowledge or dismiss those
before interacting with Raminga. Switching to another native main panel must
remove the Raminga host; reopening it must restore the view and produce one new
lease. This was verified against DSH `0.2.2-rc.2` with the isolated
profile flow above.

## Links

- [Install guide](https://github.com/Raminga/raminga/blob/main/docs/install.md)
- [Security boundaries](https://github.com/Raminga/raminga/blob/main/docs/security.md)
- [Issues](https://github.com/Raminga/raminga/issues)
