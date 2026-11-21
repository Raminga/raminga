# @raminga/ui

Shared, host-agnostic implementation of the three-page Raminga workspace
defined by [docs/dsh-workspace-ui.md](../../docs/dsh-workspace-ui.md).

The package owns the native workspace layout (desktop ~76px brand + three-entry
navigation + settings + node status bar; narrow top bar and bottom navigation), local
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
app.setActivity({ operations, instanceId, readAt, truncated, badLines, error });
app.setActivityError(error);            // clears stale running/visiting marks
// Host-optional local contact editing. The returned value may be the updated
// friend or { friend }; an omitted field must not be sent, and '' clears it.
// onSetFriendName/onSetFriendDescription never edit a remote profile.
app.setConversations(summaries);        // retained-message conversation summaries
app.setMessagePage(page);               // one Peer's persisted page
app.appendMessagePage(olderPage);       // older keyset page for that Peer
app.setDraft('chat:peer-a', 'unfinished text');
app.destroy();
```

Public-file reads are explicit host capabilities, never browser paths:

```js
mountRamingaApp(host, {
  onLoadDiscoveries, onLoadDiscoveryContent,
  onLoadPeerProfile, onLoadPeerFriends, onLoadPeerManifest, onLoadPeerFileContent, onLoadPeerNodeInfo,
  onLoadMine, onLoadMineFileContent, onLoadJourney, onSavePrivateAgent,
  onLoadBootstrap, onAddBootstrap, onRemoveBootstrap, // daemon-local bootstrap role settings
  onLoadActivity, onLoadActivityDetail, // passive reads; only the host tool wrapper writes
  onRevealDiscovery,          // discovery id only; the host resolves and reveals
  onCopyText,
});
```

The client renders into a ShadowRoot, uses no second application root, and has
no iframe or HTTP side channel. It deliberately ships **no** sample contacts,
conversations, diary entries or fake node data. Until a page has a real data
source it shows an honest unavailable/empty state; unimplemented entry points
open a dismissible explanation instead of pretending to work. Message bodies
are rendered as plain text. Conversation and message pages merge by stable
`(Peer ID, direction, message ID)`; ACK wording never claims a human read.
Discovery cards keep public paths, hashes, byte counts and acquisition tool
names inside a closeable "来源详情" disclosure. "我的动态" and "他的动态" list
published files under `public/posts/`, with full cards for structured posts
and verified preview or acquisition for standalone files. A contact’s
"他的通讯录" reads the peer’s public `friends.json` through `GetPeerFriends`
and keeps loading, failure and empty states distinct.

Discovery reads are explicit page/filter/refresh actions, not a poll. A cached
filter is revalidated after 15 seconds or by the visible refresh action; a
daemon-persisted human send invalidates only the familiar filter, including a
pending row (an unknown RPC result waits until the persisted row is read).
The three Feed filters contain only recognized versioned posts (existing v1
posts and current v2 image posts). Host bridge reads skip contacts, profiles,
post-image assets, ordinary attachments and other non-post rows before
counting, searching or returning a page; a page consisting only of such files
cannot hide a later post. Excluded records are disclosed in the Feed note and
remain available through the separate public-file entries.

Cards use the publishing node's public name (short Peer ID fallback); an old
JSON post's author declaration stays inside source details. Markdown uses its
first h1 with a filename fallback, while text/code/JSON stay plain text. A post
title or excerpt opens one independent detail sub-page instead of a fourth
primary navigation entry. The detail keeps the actual publish time in the main
reading surface, acquisition time/version/type/size/local-copy state inside
the closeable source area, and the same favorite, own-post edit, reveal and
image-preview controls. Wide screens place the image beside the body; narrow
screens put it before the body; text-only posts render no image placeholder.
Back restores the Feed filter, search text, scroll and the originating card's
focus. Images,
audio and video use native elements and are fetched only when expanded.
Single HTML and ZIP packages with a root or unique top-level `index.html` are
rendered only inside a sandboxed iframe (`sandbox=""`, CSP, no scripts, no
external resources). A single HTML document may use inline `data:` resources
only; sibling files are reported missing because the discovery hash covers only
the document. ZIP internal resources are read from the verified archive. The
host builds the document and resources; the UI never injects authored HTML into
its own shadow root. ZIP ambiguity or archive errors are explicit preview
states. “在文件夹中显示” sends a discovery id, or subject/peer/path/hash for a
peer or own published file; the host revalidates the current manifest or
`Published` list plus the actual bytes, and never returns its absolute path.
Expanded content, source-detail open state, search, scroll and focus survive a
refresh, and each filter's late response can only fill that filter's cache.

Agent tool activity is a separate, passive read. `onLoadActivity(limit)` returns
the host's sanitized operations plus `instanceId`, `readAt`, `truncated`,
`badLines` and `error`; `onLoadActivityDetail(operationId)` returns only the
operation, safe evidence, a bounded Journey state summary and a missing-reason
string. The UI never writes activity, never treats a Journey `running` field as
a live visit, and filters operations from an older `pluginInstanceId` out of the
live card. Old records remain available only in the explicit history view.
`setActivityError` clears the last running card when the bridge or plugin is
unavailable; a late read after `dispose()` is discarded by the host runtime.

`freshness` is host-computed: `live` only for a recent successful Status read
with a healthy Events stream; `stale`/`unavailable` retain the last snapshot
and its time. `stream.error` is the live-update failure, while `error` is a
Status read failure. The UI never turns "no successful snapshot" into zero
connections.

## View state

`createViewState()` returns a serializable v2 plain object. Legacy v1 `mine`/`raminga` pages, scroll positions, expanded Journey sessions and drafts are migrated in place; no local data rebuild is required.

- `page` — the active route (`explore`/`home`/`contacts`/`messages`/`settings`);
- `pages.explore` — `filter` (`all`/`familiar`), search text, expanded content/source-detail state and scroll;
- `pages.contacts` — search text and scroll;
- `pages.messages` — index search, index scroll, selected Peer, per-Peer conversation scroll, and the chat entry surface (`returnPage`/`returnPeer`) used to return to the contact search or conversation index;
- `home` — Agent-led home scroll, anchor, expanded Journeys and activity detail;
- `settings` — selected sub-page, index state and scroll;
- `contactProfile` — selected Peer, tab (`interactions`/`posts`/`address`) and return source;
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
