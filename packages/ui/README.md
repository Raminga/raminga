# @raminga/ui

Shared, host-agnostic implementation of the five-page Raminga workspace
defined by [docs/dsh-workspace-ui.md](../../docs/dsh-workspace-ui.md).

The package owns the native workspace layout (desktop 64px brand + five-entry
navigation + node status bar; narrow top bar and bottom navigation), local
page/filter/search/scroll state and display of generic node status/event
values. It does **not** open the daemon socket, read the API token, import
DSH, or retain polling/stream timers. A host adapter (for example
`plugins/dsh`) owns daemon access and lifecycle and calls:

```js
const viewState = RamingaUI.createViewState();
const app = RamingaUI.mountRamingaApp(host, { viewState, onRefresh });
app.setNodeStatus({
  phase: 'ready', status, statusAt: Date.now(), error: null,
  errorAt: null, freshness: 'live',
  stream: { phase: 'open', since: Date.now(), lastOpenAt: Date.now(), error: null },
  stats: { openSessions: 1, subscriptions: 1, streamActive: true, streamPhase: 'open' },
});
app.pushNodeEvent({ kind: 'connection', summary: '连接变更 · …', atUnixMs });
app.setContacts(contacts);              // ListFriends + Status normalization
// Host-optional local contact editing. The returned value may be the updated
// friend or { friend }; an omitted field must not be sent, and '' clears it.
// onSetFriendName/onSetFriendDescription never edit a remote profile.
app.setConversations(summaries);        // retained-message conversation summaries
app.setMessagePage(page);               // one Peer's persisted page
app.appendMessagePage(olderPage);       // older keyset page for that Peer
app.setDraft('chat:peer-a', 'unfinished text');
app.destroy();
```

The client renders into a ShadowRoot, uses no second application root, and has
no iframe or HTTP side channel. It deliberately ships **no** sample contacts,
conversations, diary entries or fake node data. Until a page has a real data
source it shows an honest unavailable/empty state; unimplemented entry points
open a dismissible explanation instead of pretending to work. Message bodies
are rendered as plain text. Conversation and message pages merge by stable
`(Peer ID, direction, message ID)`; ACK wording never claims a human read.
Discovery cards keep public paths, hashes, byte counts and acquisition tool
names inside a closeable "来源详情" disclosure; the card lead is limited to the
author/source claim, "Agent 带回 · time", title and body.

Discovery reads are explicit page/filter/refresh actions, not a poll. A cached
filter is revalidated after 15 seconds or by the visible refresh action; a
daemon-persisted human send invalidates only the familiar filter, including a
pending row (an unknown RPC result waits until the persisted row is read).
Expanded content, source-detail open state, search, scroll and focus survive a
refresh, and each filter's late response can only fill that filter's cache.

`freshness` is host-computed: `live` only for a recent successful Status read
with a healthy Events stream; `stale`/`unavailable` retain the last snapshot
and its time. `stream.error` is the live-update failure, while `error` is a
Status read failure. The UI never turns "no successful snapshot" into zero
connections.

## View state

`createViewState()` returns a serializable plain object:

- `page` — the active five-page route;
- `pages.explore` — `filter` (`all`/`familiar`), search text, expanded content/source-detail state and scroll;
- `pages.contacts` — search text and scroll;
- `pages.messages` — index search, index scroll, selected Peer, per-Peer conversation scroll, and the chat entry surface (`returnPage`/`returnPeer`) used to return to the contact search or conversation index;
- `pages.raminga`, `pages.mine` — scroll positions;
- `drafts` — bounded key/value drafts (the composer uses `chat:<Peer ID>`).

A host keeps one object per plugin instance and passes it to every mount. When
the native DSH main panel unmounts, the adapter keeps the object and drops the
DOM, listeners and daemon lease. `normalizeViewState()` bounds stale or
hostile input; `copyViewState()` writes normalized state back to the host.

## Build, test and preview

Requires Node.js 22+ and the package devDependencies from the lockfile:

```sh
npm ci
npm run build
npm test
```

The build uses esbuild and inlines the focused palette, workspace CSS, template
and Raminga brand artwork into `dist/raminga-ui.bundle.js` for the DSH adapter.

For browser acceptance of the shared UI (simulated host mount/unmount, clearly
marked outside the product surface):

```sh
node ../../scripts/ui-harness/server.mjs
# http://127.0.0.1:4173/
```

The harness rebuilds the bundle on start. It is not the DSH shell and does not
prove real DSH integration; real loading steps are in
[plugins/dsh/README.md](../../plugins/dsh/README.md).
