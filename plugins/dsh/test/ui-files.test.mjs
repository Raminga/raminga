// Host bridge tests for generic public files, peer public manifests, manual
// acquisition provenance, node information and reveal-only location.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RamingaUiBridge } from '../lib/ui-bridge.js';

const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';

function statusResponse({ peerId = PEER_B, connections = [], peers = [], peerCache = [] } = {}) {
  return {
    peerId, nodeId: 'node-self', version: 'test', protocolVersion: '1', apiVersion: '6',
    startedAtUnixMs: 1, currentTime: 'now', listenAddrs: [], connectedness: 'connected',
    connections, peers, peerCache,
    network: { relays: [], peerCache },
    maxChatTextBytes: 4096, maxStoredMessages: 1000,
  };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'raminga-ui-files-'));
}
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.isBuffer(value) ? value : Buffer.from(String(value)));
}
async function sha(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}
function post(peerId, title, body = '正文') {
  return {
    schema_version: 1, title, format: 'markdown',
    author: { peer_id: peerId, kind: 'user', display_name: 'Alice' },
    published_at: '2026-11-14T10:00:00Z', body,
  };
}
function rowFor(peerId, relative, bytes, { id, source = 'raminga_content_get', sources = null } = {}) {
  return {
    id: id ?? crypto.createHash('sha1').update(`${peerId}:${relative}`).digest('hex').slice(0, 12),
    peerId, path: relative,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length, fetchedAtUnixMs: 1000, source,
    sources: sources ?? [source],
  };
}

function makeClient({ status = statusResponse(), rows = [], manifest = [], downloadFiles = new Map(), profiles = new Map(), bootstrapPeers = [], bootstrapList = null, published = [] } = {}) {
  const downloads = [];
  const bootstrapEdits = [];
  return {
    downloads,
    bootstrapEdits,
    async status() { return status; },
    async listFriends() { return { friends: [] }; },
    async listDiscoveries() {
      return { discoveries: rows.map((row) => ({ ...row })), hasMore: false, nextBefore: '' };
    },
    async listHumanOutboundPeers() { return { peers: [], hasMore: false, nextBefore: '' }; },
    async published() {
      return {
        files: published.map((file) => ({ path: file.path, size: file.size })),
        skipped: [], generatedAtUnixMs: 1, friendsSyncedAtUnixMs: 1,
      };
    },
    async getPeerProfile(request) {
      const value = profiles.get(request.peerId);
      if (!value) throw new Error('no profile');
      return value;
    },
    async getPeerManifest(request) {
      const page = manifest.slice(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? 100));
      return {
        version: 1, peerId: request.peerId, generatedAtUnixMs: 1,
        entries: page.map((entry) => ({
          path: entry.path, size: entry.data.length,
          modifiedUnixMs: 1,
          sha256: crypto.createHash('sha256').update(entry.data).digest('hex'),
        })),
        total: manifest.length, limited: false,
      };
    },
    async downloadPeerFile(request) {
      downloads.push({ peerId: request.peerId, path: request.path, recordDiscovery: request.recordDiscovery, discoverySource: request.discoverySource });
      const entry = downloadFiles.get(request.path);
      if (!entry) {
        return (async function* frames() {
          yield { phase: 'error', path: request.path, error: 'missing' };
        })();
      }
      const target = path.join(downloadFiles.root ?? '', request.peerId, request.path);
      await write(target, entry);
      const hash = crypto.createHash('sha256').update(entry).digest('hex');
      return (async function* frames() {
        yield {
          phase: 'complete', path: request.path, localPath: target,
          sha256: hash, totalBytes: entry.length, error: '',
          discoveryRecorded: request.recordDiscovery === true,
          discoveryError: '',
        };
      })();
    },
    async dhtStatus() { return { dht: { bootstrapPeers } }; },
    async listBootstrapPeers() {
      if (bootstrapList === null) throw new Error('unimplemented: ListBootstrapPeers');
      return { peers: bootstrapList };
    },
    async addBootstrapPeer(request) {
      if (bootstrapList === null) throw new Error('unimplemented: AddBootstrapPeer');
      bootstrapEdits.push({ action: 'add', multiaddr: request.multiaddr });
      return { added: true, peer: { peerId: PEER_A, addrs: [request.multiaddr], online: false, paused: false, savedAtUnixMs: 2000 } };
    },
    async removeBootstrapPeer(request) {
      if (bootstrapList === null) throw new Error('unimplemented: RemoveBootstrapPeer');
      bootstrapEdits.push({ action: 'remove', peerId: request.peerId });
      return { removed: true };
    },
    events(_request, { signal }) {
      return (async function* stream() {
        yield { toJson: () => ({ heartbeat: true }) };
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', resolve, { once: true });
        });
      })();
    },
  };
}

function makeBridge(client, dataDir, revealPath) {
  return new RamingaUiBridge({ async ensure() { return client; }, async call(fn) { return fn(client); } }, { dataDir, revealPath });
}

test('generic discoveries list only recognizable posts and disclose ignored public files', async () => {
  const dir = await tempDir();
  const md = Buffer.from('# Hello\n\n正文');
  const png = Buffer.from('PNG');
  const legacyBytes = Buffer.from(JSON.stringify(post(PEER_A, '旧帖子')));
  const secondBytes = Buffer.from(JSON.stringify(post(PEER_A, '第二篇帖子')));
  await write(path.join(dir, 'downloads', PEER_A, 'notes/hello.md'), md);
  await write(path.join(dir, 'downloads', PEER_A, 'profile/index.md'), '# 公开节点名');
  await write(path.join(dir, 'downloads', PEER_A, 'pic.png'), png);
  await write(path.join(dir, 'downloads', PEER_A, 'posts/old.json'), legacyBytes);
  await write(path.join(dir, 'downloads', PEER_A, 'posts/second.json'), secondBytes);
  const rows = [
    rowFor(PEER_A, 'notes/hello.md', md),
    rowFor(PEER_A, 'profile/index.md', Buffer.from('# 公开节点名')),
    rowFor(PEER_A, 'pic.png', png, { source: 'raminga_ui_manual' }),
    rowFor(PEER_A, 'posts/old.json', legacyBytes, { source: 'raminga_ui_manual', sources: ['raminga_content_get', 'raminga_ui_manual'] }),
    rowFor(PEER_A, 'posts/second.json', secondBytes),
  ];
  const client = makeClient({
    rows,
    profiles: new Map([[PEER_A, { peerId: PEER_A, name: '公开节点名', found: true, text: '# 公开节点名', files: ['profile/index.md'] }]]),
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-files-discovery');
    const data = await bridge.discoveries('ui-files-discovery', false, true);
    assert.equal(data.items.length, 2, 'only versioned posts enter the Feed');
    assert.equal(data.ignored, 3, 'contacts/profile/attachments are disclosed but excluded');
    assert.equal(data.scanned, 5);
    assert.equal(data.items.some((item) => item.path === 'notes/hello.md'), false);
    assert.equal(data.items.some((item) => item.path === 'pic.png'), false);
    const legacy = data.items.find((item) => item.path === 'posts/old.json');
    assert.equal(legacy.publisherName, '公开节点名');
    assert.equal(legacy.kind, 'markdown');
    assert.equal(legacy.title, '旧帖子');
    assert.equal(legacy.publishedAt, '2026-11-14T10:00:00Z');
    assert.equal(legacy.authorName, 'Alice');
    assert.deepEqual(legacy.sources, ['raminga_content_get', 'raminga_ui_manual']);

    const content = await bridge.discoveryContent('ui-files-discovery', legacy.id);
    assert.equal(content.status, 'ok');
    assert.equal(content.kind, 'markdown');
    assert.match(content.text, /正文/);

    // Overwriting the downloaded copy must not present the new bytes as the
    // old discovery version.
    await write(path.join(dir, 'downloads', PEER_A, 'posts/old.json'), Buffer.from(JSON.stringify(post(PEER_A, '新版本'))));
    const mismatch = await bridge.discoveryContent('ui-files-discovery', legacy.id);
    assert.equal(mismatch.status, 'hash-mismatch');
    assert.doesNotMatch(mismatch.text, /新版本/);
  } finally {
    bridge.dispose();
  }
});

test('peer manifest lists files, manual reads record source, and node information labels sources', async () => {
  const dir = await tempDir();
  const manifest = [
    { path: 'posts/a.json', data: Buffer.from(JSON.stringify(post(PEER_A, '对方帖子'))) },
    { path: 'notes/hello.md', data: Buffer.from('# Hello\n\n正文') },
  ];
  const downloadRoot = path.join(dir, 'downloads');
  const downloadFiles = new Map(manifest.map((entry) => [entry.path, entry.data]));
  downloadFiles.root = downloadRoot;
  const status = statusResponse({
    connections: [
      { peerId: PEER_A, direction: 'outbound', transport: 'tcp', route: 'direct', direct: true, limited: false, remoteMultiaddr: `/ip4/127.0.0.1/tcp/5001/p2p/${PEER_A}` },
    ],
    peers: [{ peerId: PEER_A, online: true, direction: 'outbound', transport: 'tcp', route: 'direct', addrs: [`/ip4/127.0.0.1/tcp/5001/p2p/${PEER_A}`, '/ip4/10.0.0.3/tcp/5001'] }],
    peerCache: [{ peerId: PEER_A, addrs: [`/ip4/10.0.0.2/tcp/5001/p2p/${PEER_A}`], source: 'manual', updatedAtUnixMs: 10, expiresAtUnixMs: 20 }],
  });
  const client = makeClient({
    status, manifest, downloadFiles,
    profiles: new Map([[PEER_A, { peerId: PEER_A, name: '远端节点', found: true, text: '# 远端节点', files: manifest.map((entry) => entry.path) }]]),
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-files-peer');
    const profile = await bridge.peerProfile('ui-files-peer', PEER_A, true);
    assert.equal(profile.remoteName, '远端节点');
    assert.equal(profile.manifest.entries.length, 2);
    assert.equal(profile.node.connectionState, 'connected');
    assert.equal(profile.node.directConnections, 1);
    assert.equal(profile.node.currentAddresses[0].source, 'connection');
    assert.equal(profile.node.knownAddresses.some((address) => address.source === 'cache' && address.reachability === 'unverified'), true);

    const manifestData = await bridge.peerManifest('ui-files-peer', PEER_A, true);
    assert.equal(manifestData.publisherName, '远端节点');
    const hello = manifestData.entries.find((entry) => entry.path === 'notes/hello.md');
    assert.equal(hello.kind, 'markdown');
    const content = await bridge.peerFilePreview('ui-files-peer', PEER_A, 'notes/hello.md', hello.sha256, hello.sizeBytes);
    assert.equal(content.status, 'ok');
    assert.equal(content.discoveryRecorded, true);
    assert.equal(content.source, 'raminga_ui_manual');
    assert.match(content.text, /正文/);
    assert.equal(client.downloads.at(-1).recordDiscovery, true);
    assert.equal(client.downloads.at(-1).discoverySource, 'raminga_ui_manual');
    assert.equal(client.downloads.at(-1).path, 'notes/hello.md');

    const downloadsBeforeReRead = client.downloads.length;
    const localAgain = await bridge.peerFilePreview('ui-files-peer', PEER_A, 'notes/hello.md', hello.sha256, hello.sizeBytes);
    assert.equal(localAgain.status, 'ok');
    assert.equal(localAgain.acquisition, 'local-copy');
    assert.equal(localAgain.source, 'raminga_ui_manual');
    assert.equal(localAgain.fetchedAt, content.fetchedAt);
    assert.equal(client.downloads.length, downloadsBeforeReRead, 'a verified local copy is read without a second download');

    const node = await bridge.peerNodeInfo('ui-files-peer', PEER_A, true);
    assert.equal(node.connectionState, 'connected');
    assert.equal(node.currentAddresses.length, 1);
    assert.equal(node.knownAddresses.length, 2);

    const bootstrap = await bridge.bootstrap('ui-files-peer');
    assert.equal(bootstrap.source, 'dht-status');
    assert.deepEqual(bootstrap.peers, []);
  } finally {
    bridge.dispose();
  }
});

test('mine lists every public file, including Agent-authored posts, and reads previews on demand', async () => {
  const dir = await tempDir();
  const agentPost = {
    ...post(PEER_B, 'Agent 帖子', '公开正文'),
    author: { peer_id: PEER_B, kind: 'agent', display_name: 'Agent One' },
  };
  await write(path.join(dir, 'public', 'posts', 'agent.json'), JSON.stringify(agentPost));
  await write(path.join(dir, 'public', 'hello.md'), '# Hello\n\nBody');
  await write(path.join(dir, 'public', 'pic.png'), 'PNG');
  await write(path.join(dir, 'public', 'profile', 'index.md'), '# 我的节点\n\n资料');
  await write(path.join(dir, 'public', 'friends.json'), '{"version":1,"friends":[]}');
  const publicPaths = ['posts/agent.json', 'hello.md', 'pic.png', 'profile/index.md'];
  const published = [];
  for (const relative of publicPaths) {
    const stat = await fs.stat(path.join(dir, 'public', relative));
    published.push({ path: relative, size: stat.size });
  }
  const client = makeClient({ status: statusResponse({ peerId: PEER_B }), published });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-files-mine');
    const mine = await bridge.mine('ui-files-mine', true);
    assert.equal(mine.files.some((file) => file.path === 'posts/agent.json'), true, 'Agent-authored public content is listed');
    assert.equal(mine.files.some((file) => file.path === 'profile/index.md'), true);
    assert.equal(mine.files.find((file) => file.path === 'posts/agent.json').authorKind, 'agent');
    assert.equal(mine.filesTruncated, false);
    const file = mine.files.find((entry) => entry.path === 'posts/agent.json');
    const preview = await bridge.mineFilePreview('ui-files-mine', file.path, file.sha256, file.sizeBytes);
    assert.equal(preview.status, 'ok');
    assert.equal(preview.post.authorKind, 'agent');
    assert.match(preview.text, /公开正文/);
  } finally {
    bridge.dispose();
  }
});

test('a checksum-failed peer file is reported instead of being re-downloaded over', async () => {
  const dir = await tempDir();
  const original = Buffer.from('valid public attachment');
  const replacement = Buffer.from(original);
  replacement[0] = 0x21;
  await write(path.join(dir, 'downloads', PEER_A, 'notes/checksum.txt'), original);
  const client = makeClient({ manifest: [{ path: 'notes/checksum.txt', data: original }] });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-peer-checksum');
    const manifest = await bridge.peerManifest('ui-peer-checksum', PEER_A, true);
    const entry = manifest.entries.find((item) => item.path === 'notes/checksum.txt');
    assert.equal(entry.contentState, 'available');
    await write(path.join(dir, 'downloads', PEER_A, 'notes/checksum.txt'), replacement);
    const preview = await bridge.peerFilePreview(
      'ui-peer-checksum', PEER_A, entry.path, entry.sha256, entry.sizeBytes,
    );
    assert.equal(preview.status, 'hash-mismatch');
    assert.match(preview.error, /SHA-256|哈希|大小/);
    assert.doesNotMatch(preview.text, /invalid/);
    assert.equal(client.downloads.length, 0, 'a mismatched local copy must not be replaced by a fresh download');
  } finally {
    bridge.dispose();
  }
});

test('reveal resolves only downloaded discovery originals through the host callback', async () => {
  const dir = await tempDir();
  const bytes = Buffer.from(JSON.stringify(post(PEER_A, '可定位的帖子')));
  await write(path.join(dir, 'downloads', PEER_A, 'posts/reveal.json'), bytes);
  const row = rowFor(PEER_A, 'posts/reveal.json', bytes);
  const client = makeClient({ rows: [row] });
  let revealed = '';
  const bridge = makeBridge(client, dir, async (absolute) => { revealed = absolute; });
  try {
    await bridge.open('ui-files-reveal');
    await bridge.discoveries('ui-files-reveal', false, true);
    const result = await bridge.revealDiscovery('ui-files-reveal', row.id);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'revealed');
    assert.equal(result.path, undefined, 'the browser never receives the absolute path');
    assert.equal(revealed, await fs.realpath(path.join(dir, 'downloads', PEER_A, 'posts/reveal.json')));

    await fs.rm(path.join(dir, 'downloads', PEER_A, 'posts/reveal.json'));
    const missing = await bridge.revealDiscovery('ui-files-reveal', row.id);
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 'missing');
  } finally {
    bridge.dispose();
  }
});

test('offline peer homepage recovers persisted discovery copies after a bridge restart', async () => {
  const dir = await tempDir();
  const hello = Buffer.from('# Hello offline\n\n仍然可读');
  await write(path.join(dir, 'downloads', PEER_A, 'notes/hello.md'), hello);
  await write(path.join(dir, 'downloads', PEER_A, 'profile/index.md'), '# 离线节点\n\n历史资料');
  const row = rowFor(PEER_A, 'notes/hello.md', hello);
  const client = makeClient({ rows: [row] });
  client.getPeerManifest = async () => { throw new Error('peer offline'); };
  client.getPeerProfile = async () => { throw new Error('peer offline'); };
  const revealed = [];
  const firstBridge = makeBridge(client, dir, async (absolute) => { revealed.push(absolute); });
  try {
    await firstBridge.open('ui-offline-1');
    const profile = await firstBridge.peerProfile('ui-offline-1', PEER_A, true);
    assert.equal(profile.source, 'local-copy');
    assert.equal(profile.found, true);
    assert.match(profile.text, /历史资料/);
    assert.equal(profile.manifest.source, 'local-history');
    assert.match(profile.manifest.error, /不是当前远端完整清单/);
    const helloEntry = profile.manifest.entries.find((entry) => entry.path === 'notes/hello.md');
    assert.ok(helloEntry);
    assert.equal(helloEntry.contentState, 'available');
    assert.equal(helloEntry.sources[0], 'raminga_content_get');
    assert.equal(client.downloads.length, 0, 'building the local history does not download');

    const preview = await firstBridge.peerFilePreview('ui-offline-1', PEER_A, 'notes/hello.md', helloEntry.sha256, helloEntry.sizeBytes);
    assert.equal(preview.status, 'ok');
    assert.equal(preview.acquisition, 'local-copy');
    assert.equal(preview.localCopy, 'available');
    assert.equal(preview.source, 'raminga_content_get');
    assert.match(preview.text, /仍然可读/);
    assert.equal(client.downloads.length, 0, 'local reading never pretends to be a new network download');

    const revealedResult = await firstBridge.revealFile('ui-offline-1', 'peer', PEER_A, 'notes/hello.md', helloEntry.sha256, helloEntry.sizeBytes);
    assert.equal(revealedResult.status, 'revealed');
    assert.equal(revealed[0], await fs.realpath(path.join(dir, 'downloads', PEER_A, 'notes/hello.md')));

    const missingReveal = await firstBridge.revealFile('ui-offline-1', 'peer', PEER_A, 'notes/no-such.md', 'f'.repeat(64), 10);
    assert.equal(missingReveal.status, 'not-downloaded');
    assert.equal(revealed.length, 1, 'offline missing files are not located');
  } finally {
    firstBridge.dispose();
  }

  // A new bridge (and therefore a new panel lease) has no session cache. It
  // must recover the same list/version from ListDiscoveries and the verified
  // local bytes, not from the previous bridge's memory.
  const secondBridge = makeBridge(client, dir, async (absolute) => { revealed.push(absolute); });
  try {
    await secondBridge.open('ui-offline-2');
    const profile = await secondBridge.peerProfile('ui-offline-2', PEER_A, true);
    assert.equal(profile.manifest.source, 'local-history');
    const entry = profile.manifest.entries.find((item) => item.path === 'notes/hello.md');
    assert.ok(entry);
    assert.equal(entry.sha256, row.sha256);
    const preview = await secondBridge.peerFilePreview('ui-offline-2', PEER_A, 'notes/hello.md', entry.sha256, entry.sizeBytes);
    assert.equal(preview.status, 'ok');
    assert.match(preview.text, /仍然可读/);
    assert.equal(client.downloads.length, 0);
  } finally {
    secondBridge.dispose();
  }
});

test('unsupported peer files can be manually acquired, verified and revealed without a fake preview', async () => {
  const dir = await tempDir();
  const pdf = Buffer.from('%PDF-1.4\nhello');
  const manifest = [{ path: 'docs/guide.pdf', data: pdf }];
  const downloadFiles = new Map([['docs/guide.pdf', pdf]]);
  downloadFiles.root = path.join(dir, 'downloads');
  const client = makeClient({
    manifest, downloadFiles,
    profiles: new Map([[PEER_A, { peerId: PEER_A, name: '远端节点', found: true, text: '# 远端节点', files: ['docs/guide.pdf'] }]]),
  });
  const revealed = [];
  const bridge = makeBridge(client, dir, async (absolute) => { revealed.push(absolute); });
  try {
    await bridge.open('ui-pdf-manual');
    const profile = await bridge.peerProfile('ui-pdf-manual', PEER_A, true);
    const entry = profile.manifest.entries.find((item) => item.path === 'docs/guide.pdf');
    assert.ok(entry);
    assert.equal(entry.contentState, 'not-downloaded');

    const before = await bridge.revealFile('ui-pdf-manual', 'peer', PEER_A, entry.path, entry.sha256, entry.sizeBytes);
    assert.equal(before.status, 'not-downloaded');
    assert.equal(revealed.length, 0);

    const preview = await bridge.peerFilePreview('ui-pdf-manual', PEER_A, entry.path, entry.sha256, entry.sizeBytes);
    assert.equal(preview.status, 'unsupported');
    assert.equal(preview.localCopy, 'available');
    assert.equal(preview.acquisition, 'downloaded');
    assert.equal(preview.discoveryRecorded, true);
    assert.match(preview.error, /已手动获取/);
    assert.equal(client.downloads.length, 1);
    assert.equal(client.downloads[0].recordDiscovery, true);

    const after = await bridge.revealFile('ui-pdf-manual', 'peer', PEER_A, entry.path, entry.sha256, entry.sizeBytes);
    assert.equal(after.status, 'revealed');
    assert.equal(revealed.at(-1), await fs.realpath(path.join(dir, 'downloads', PEER_A, 'docs/guide.pdf')));

    // Same size, different bytes: locating must fail with an explicit mismatch
    // rather than silently reveal a different version.
    const replaced = Buffer.from('%PDF-1.4\nHELLO');
    assert.equal(replaced.length, pdf.length);
    await write(path.join(dir, 'downloads', PEER_A, 'docs/guide.pdf'), replaced);
    const mismatch = await bridge.revealFile('ui-pdf-manual', 'peer', PEER_A, entry.path, entry.sha256, entry.sizeBytes);
    assert.equal(mismatch.status, 'hash-mismatch');
    assert.match(mismatch.error, /不一致/);
    assert.equal(revealed.length, 1);

    // The same unsupported original is still locatable offline, without a
    // second download, when its discovery evidence survives a bridge restart.
    await write(path.join(dir, 'downloads', PEER_A, 'docs/guide.pdf'), pdf);
    const offlineClient = makeClient({ rows: [rowFor(PEER_A, entry.path, pdf)] });
    offlineClient.getPeerManifest = async () => { throw new Error('peer offline'); };
    offlineClient.getPeerProfile = async () => { throw new Error('peer offline'); };
    const offlineBridge = makeBridge(offlineClient, dir);
    try {
      await offlineBridge.open('ui-pdf-offline');
      const offlineProfile = await offlineBridge.peerProfile('ui-pdf-offline', PEER_A, true);
      const offlineEntry = offlineProfile.manifest.entries.find((item) => item.path === entry.path);
      assert.ok(offlineEntry);
      const offlinePreview = await offlineBridge.peerFilePreview('ui-pdf-offline', PEER_A, entry.path, offlineEntry.sha256, offlineEntry.sizeBytes);
      assert.equal(offlinePreview.status, 'unsupported');
      assert.equal(offlinePreview.localCopy, 'available');
      assert.equal(offlinePreview.acquisition, 'local-copy');
      assert.equal(offlineClient.downloads.length, 0);
    } finally {
      offlineBridge.dispose();
    }
  } finally {
    bridge.dispose();
  }
});

test('Mine uses the Published manifest and detects a same-size replacement from real bytes', async () => {
  const dir = await tempDir();
  const original = Buffer.from('# Hello\n\nAAAA');
  const replacement = Buffer.from('# Hello\n\nBBBB');
  assert.equal(replacement.length, original.length);
  await write(path.join(dir, 'public', 'hello.md'), original);
  await write(path.join(dir, 'public', 'not-published.md'), '# 未发布\n\n不应出现');
  await write(path.join(dir, 'public', 'profile', 'index.md'), '# 未发布档案');
  await write(path.join(dir, 'public', 'posts', 'hidden.json'), JSON.stringify(post(PEER_B, '未发布帖子')));
  const helloStat = await fs.stat(path.join(dir, 'public', 'hello.md'));
  const client = makeClient({
    status: statusResponse({ peerId: PEER_B }),
    published: [{ path: 'hello.md', size: helloStat.size }],
  });
  const revealed = [];
  const bridge = makeBridge(client, dir, async (absolute) => { revealed.push(absolute); });
  try {
    await bridge.open('ui-mine-bytes');
    const mine = await bridge.mine('ui-mine-bytes', true);
    assert.deepEqual(mine.files.map((file) => file.path), ['hello.md']);
    assert.equal(mine.files.some((file) => file.path === 'not-published.md'), false, 'unpublished disk files stay out of the list');
    assert.equal(mine.posts.posts.length, 0, 'unpublished posts stay out of the posts section');
    assert.equal(mine.profile.state, 'missing', 'an unpublished profile is not presented as public');
    const entry = mine.files[0];
    assert.equal(entry.sha256, crypto.createHash('sha256').update(original).digest('hex'));

    const first = await bridge.mineFilePreview('ui-mine-bytes', 'hello.md', entry.sha256, entry.sizeBytes);
    assert.equal(first.status, 'ok');
    assert.match(first.text, /AAAA/);

    await write(path.join(dir, 'public', 'hello.md'), replacement);
    const sameSize = await bridge.mineFilePreview('ui-mine-bytes', 'hello.md', entry.sha256, entry.sizeBytes);
    assert.equal(sameSize.status, 'hash-mismatch');
    assert.doesNotMatch(sameSize.text, /BBBB/);
    const staleReveal = await bridge.revealFile('ui-mine-bytes', 'mine', PEER_B, 'hello.md', entry.sha256, entry.sizeBytes);
    assert.equal(staleReveal.status, 'hash-mismatch');
    assert.equal(revealed.length, 0);

    const refreshed = await bridge.mine('ui-mine-bytes', true);
    const current = refreshed.files.find((file) => file.path === 'hello.md');
    assert.notEqual(current.sha256, entry.sha256);
    const currentPreview = await bridge.mineFilePreview('ui-mine-bytes', 'hello.md', current.sha256, current.sizeBytes);
    assert.equal(currentPreview.status, 'ok');
    assert.match(currentPreview.text, /BBBB/);
    const located = await bridge.revealFile('ui-mine-bytes', 'mine', PEER_B, 'hello.md', current.sha256, current.sizeBytes);
    assert.equal(located.status, 'revealed');
    assert.equal(revealed.at(-1), await fs.realpath(path.join(dir, 'public', 'hello.md')));
  } finally {
    bridge.dispose();
  }
});

test('peer node addresses use components for direct/relay suffixes and stale snapshots never look verified', async () => {
  const dir = await tempDir();
  const relayAddr = `/ip4/127.0.0.1/tcp/6001/p2p/${PEER_B}/p2p-circuit`;
  const wrongRelay = `/ip4/127.0.0.1/tcp/6002/p2p/${PEER_B}/p2p-circuit/p2p/${PEER_B}`;
  const wrongDirect = `/ip4/127.0.0.1/tcp/5002/p2p/${PEER_B}`;
  const status = statusResponse({
    connections: [
      { peerId: PEER_A, direction: 'outbound', transport: 'tcp', route: 'direct', direct: true, limited: false, remoteMultiaddr: '/ip4/127.0.0.1/tcp/5001' },
      { peerId: PEER_A, direction: 'outbound', transport: 'tcp', route: 'relay', direct: false, limited: true, remoteMultiaddr: relayAddr },
      { peerId: PEER_A, direction: 'outbound', transport: 'tcp', route: 'direct', direct: true, limited: false, remoteMultiaddr: wrongDirect },
      { peerId: PEER_A, direction: 'outbound', transport: 'tcp', route: 'relay', direct: false, limited: true, remoteMultiaddr: wrongRelay },
    ],
    peers: [{
      peerId: PEER_A, online: true, direction: 'outbound', transport: 'tcp', route: 'direct',
      addrs: ['/ip4/10.0.0.9/tcp/5001', wrongDirect],
    }],
    peerCache: [{ peerId: PEER_A, addrs: ['/ip4/10.0.0.8/tcp/5001', wrongDirect], source: 'manual', updatedAtUnixMs: 10, expiresAtUnixMs: 20 }],
  });
  const client = makeClient({ status });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-addresses');
    const node = await bridge.peerNodeInfo('ui-addresses', PEER_A, true);
    assert.equal(node.freshness, 'live');
    assert.equal(node.currentAddresses.length, 2);
    for (const address of node.currentAddresses) {
      assert.equal(address.multiaddr.endsWith(`/p2p/${PEER_A}`), true);
      assert.equal(address.reachability, 'verified');
    }
    assert.equal(node.currentAddresses.some((address) => address.multiaddr === `/ip4/127.0.0.1/tcp/5001/p2p/${PEER_A}`), true);
    assert.equal(node.currentAddresses.some((address) => address.multiaddr === `${relayAddr}/p2p/${PEER_A}`), true);
    assert.equal(node.knownAddresses.some((address) => address.source === 'peerstore' && address.multiaddr === `/ip4/10.0.0.9/tcp/5001/p2p/${PEER_A}`), true);
    assert.equal(node.knownAddresses.some((address) => address.source === 'cache' && address.multiaddr === `/ip4/10.0.0.8/tcp/5001/p2p/${PEER_A}`), true);
    assert.equal([...node.currentAddresses, ...node.knownAddresses].some((address) => address.multiaddr.endsWith(`/p2p/${PEER_B}`)), false);

    client.status = async () => { throw new Error('status offline'); };
    const stale = await bridge.peerNodeInfo('ui-addresses', PEER_A, true);
    assert.notEqual(stale.freshness, 'live');
    assert.equal(stale.connectionState, 'unknown');
    assert.equal(stale.directConnections, 0);
    assert.equal(stale.relayConnections, 0);
    assert.equal(stale.currentAddresses.every((address) => address.reachability === 'unverified'), true);
    assert.equal(stale.knownAddresses.every((address) => address.reachability === 'unverified'), true);
  } finally {
    bridge.dispose();
  }
});

test('HTML public files stay out of the Feed and are read as peer files', async () => {
  const dir = await tempDir();
  const html = Buffer.from('<html><head><title>Old</title></head><body><img src="pic.png"></body></html>');
  const oldImage = Buffer.from('OLD');
  await write(path.join(dir, 'downloads', PEER_A, 'site/index.html'), html);
  await write(path.join(dir, 'downloads', PEER_A, 'site/pic.png'), oldImage);
  const row = rowFor(PEER_A, 'site/index.html', html);
  const client = makeClient({
    rows: [row],
    manifest: [{ path: 'site/index.html', data: html }],
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-html-file');
    const feed = await bridge.discoveries('ui-html-file', false, true);
    assert.equal(feed.items.length, 0);
    assert.equal(feed.ignored, 1);
    // A newer, unrelated file in the same downloaded directory must not be
    // read: the declaration hash covers only index.html.
    await write(path.join(dir, 'downloads', PEER_A, 'site/pic.png'), Buffer.from('NEW-IMAGE-BYTES'));
    const content = await bridge.peerFilePreview(
      'ui-html-file', PEER_A, 'site/index.html',
      crypto.createHash('sha256').update(html).digest('hex'), html.length,
    );
    assert.equal(content.status, 'resource-error');
    assert.equal(content.missingResources.includes('pic.png'), true);
    assert.doesNotMatch(content.html, /TkVXLUlNQUdFLUJZVEVT/);
    assert.doesNotMatch(content.html, /data:image\/png/);
    assert.doesNotMatch(content.html, /src="pic\.png"/);
  } finally {
    bridge.dispose();
  }
});

test('v2 post images are parsed for Mine/remote metadata and read through the controlled preview path', async () => {
  const dir = await tempDir();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const imageSha = crypto.createHash('sha256').update(png).digest('hex');
  const imagePath = `images/${imageSha}.png`;
  const postPath = 'posts/post-image-real/post.json';
  const postValue = {
    schema_version: 2,
    id: 'post-image-real',
    title: '带图动态',
    format: 'markdown',
    author: { peer_id: PEER_A, kind: 'agent', display_name: 'Nebula' },
    published_at: '2026-11-18T10:00:00Z',
    updated_at: '2026-11-18T10:00:00Z',
    tags: ['图'],
    body: '# 带图动态\n\n真实配图正文。',
    images: [{
      path: imagePath, sha256: imageSha, mime: 'image/png',
      width: 1, height: 1, size_bytes: png.length,
    }],
    revision: 1,
  };
  const postBytes = Buffer.from(JSON.stringify(postValue));
  const manifest = [
    { path: postPath, data: postBytes },
    { path: `${postPath.slice(0, postPath.lastIndexOf('/'))}/${imagePath}`, data: png },
  ];
  const publicImagePath = `${postPath.slice(0, postPath.lastIndexOf('/'))}/${imagePath}`;
  const downloadFiles = new Map(manifest.map((entry) => [entry.path, entry.data]));
  downloadFiles.root = path.join(dir, 'downloads');
  const client = makeClient({
    manifest,
    downloadFiles,
    profiles: new Map([[PEER_A, { peerId: PEER_A, name: '远端节点', found: true, text: '# 远端节点', files: manifest.map((entry) => entry.path) }]]),
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-files-post-images');
    const remote = await bridge.peerManifest('ui-files-post-images', PEER_A, true);
    const postEntry = remote.entries.find((entry) => entry.path === postPath);
    assert.ok(postEntry);
    const meta = await bridge.peerPostMeta('ui-files-post-images', PEER_A, postPath, postEntry.sha256, postEntry.sizeBytes);
    assert.equal(meta.found, true, meta.error);
    assert.equal(meta.images.length, 1);
    assert.equal(meta.images[0].publicPath, publicImagePath);
    assert.equal(meta.images[0].mime, 'image/png');
    assert.equal(meta.images[0].sha256, imageSha);
    assert.equal(meta.images[0].sizeBytes, png.length);
    assert.equal(meta.images[0].manifestState, 'available');
    assert.equal(client.downloads.at(-1).path, postPath);
    assert.equal(client.downloads.at(-1).recordDiscovery, false, 'card metadata must not create a discovery row');

    const imagePreview = await bridge.peerFilePreview(
      'ui-files-post-images', PEER_A, publicImagePath, imageSha, png.length,
    );
    assert.equal(imagePreview.status, 'ok', imagePreview.error);
    assert.equal(imagePreview.kind, 'image');
    assert.equal(imagePreview.discoveryRecorded, false, 'embedded image reads must not create discovery rows');
    assert.equal(imagePreview.discoveryError, '');
    assert.match(imagePreview.dataUrl, /^data:image\/png;base64,/);
    assert.equal(client.downloads.at(-1).path, publicImagePath);
    assert.equal(client.downloads.at(-1).recordDiscovery, false);

    const mismatch = await bridge.peerFilePreview(
      'ui-files-post-images', PEER_A, publicImagePath, '0'.repeat(64), png.length,
    );
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /版本|哈希|大小/);

    // A published Mine post and its image must expose the same image metadata.
    const minePostPath = 'posts/post-image-mine/post.json';
    const minePublicImagePath = 'posts/post-image-mine/' + imagePath;
    const minePostBytes = Buffer.from(JSON.stringify({
      ...postValue,
      id: 'post-image-mine',
      author: { peer_id: PEER_B, kind: 'agent', display_name: 'Nebula' },
      images: [{ ...postValue.images[0], path: imagePath }],
    }));
    await write(path.join(dir, 'public', minePostPath), minePostBytes);
    await write(path.join(dir, 'public', minePublicImagePath), png);
    await write(path.join(dir, 'public', 'profile', 'index.md'), '# 本机节点\n\n资料');
    await write(path.join(dir, 'public', 'profile', 'profile.json'), JSON.stringify({
      schema_version: 2,
      agent: { name: 'Nebula', description: '', interests: [], conversation_style: '' },
      human: { name: '本机节点', bio_markdown: '资料' },
      updated_at: '2026-11-18T10:00:00Z',
    }));
    const published = [];
    for (const relative of ['profile/index.md', 'profile/profile.json', minePostPath, minePublicImagePath]) {
      const stat = await fs.stat(path.join(dir, 'public', relative));
      published.push({ path: relative, size: stat.size });
    }
    const mineClient = makeClient({ status: statusResponse({ peerId: PEER_B }), published });
    const mineBridge = makeBridge(mineClient, dir);
    try {
      await mineBridge.open('ui-files-mine-images');
      const mine = await mineBridge.mine('ui-files-mine-images', true);
      const minePost = mine.files.find((entry) => entry.path === minePostPath);
      assert.ok(minePost);
      assert.equal(minePost.images.length, 1);
      assert.equal(minePost.images[0].publicPath, minePublicImagePath);
      const mineImage = await mineBridge.mineFilePreview('ui-files-mine-images', minePublicImagePath, imageSha, png.length);
      assert.equal(mineImage.status, 'ok', mineImage.error);
      assert.equal(mineImage.kind, 'image');
      assert.match(mineImage.dataUrl, /^data:image\/png;base64,/);
    } finally {
      mineBridge.dispose();
    }
  } finally {
    bridge.dispose();
  }
});

test('offline card metadata and images can be read from verified local copies without discovery rows', async () => {
  const dir = await tempDir();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const imageSha = crypto.createHash('sha256').update(png).digest('hex');
  const postPath = 'posts/post-offline-card/post.json';
  const imagePath = `posts/post-offline-card/images/${imageSha}.png`;
  const postValue = {
    schema_version: 2, id: 'post-offline-card', title: '离线卡片', format: 'markdown',
    author: { peer_id: PEER_A, kind: 'user', display_name: 'Alice' },
    published_at: '2026-11-18T10:00:00Z', body: '# 离线卡片\n\n本机已验证副本。',
    images: [{ path: `images/${imageSha}.png`, sha256: imageSha, mime: 'image/png', width: 1, height: 1, size_bytes: png.length }],
    revision: 1,
  };
  const postBytes = Buffer.from(JSON.stringify(postValue));
  await write(path.join(dir, 'downloads', PEER_A, postPath), postBytes);
  await write(path.join(dir, 'downloads', PEER_A, imagePath), png);
  // No ListDiscoveries rows: automatic card reads intentionally do not create
  // discovery evidence, but verified local bytes must remain readable offline.
  const client = makeClient({ rows: [] });
  client.getPeerManifest = async () => { throw new Error('peer offline'); };
  client.getPeerProfile = async () => { throw new Error('peer offline'); };
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-offline-card');
    const postSha = crypto.createHash('sha256').update(postBytes).digest('hex');
    const meta = await bridge.peerPostMeta('ui-offline-card', PEER_A, postPath, postSha, postBytes.length);
    assert.equal(meta.found, true, meta.error);
    assert.equal(meta.images.length, 1);
    assert.equal(meta.images[0].publicPath, imagePath);
    assert.equal(meta.images[0].manifestState, 'unknown');
    const image = await bridge.peerFilePreview('ui-offline-card', PEER_A, imagePath, imageSha, png.length);
    assert.equal(image.status, 'ok', image.error);
    assert.equal(image.kind, 'image');
    assert.match(image.dataUrl, /^data:image\/png;base64,/);
    assert.equal(client.downloads.length, 0, 'offline local reading must not retry the network');
    const missing = await bridge.peerFilePreview('ui-offline-card', PEER_A, imagePath, 'f'.repeat(64), png.length);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /历史下载副本|不在本机|离线/);
  } finally {
    bridge.dispose();
  }
});


test('bootstrap settings use the write-capable API and keep online/paused separate', async () => {
  const dir = await tempDir();
  const client = makeClient({
    bootstrapList: [{ peerId: PEER_A, addrs: [`/ip4/127.0.0.1/tcp/44001/p2p/${PEER_A}`], online: false, paused: true, savedAtUnixMs: 1234 }],
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-bootstrap-edit');
    const info = await bridge.bootstrap('ui-bootstrap-edit');
    assert.equal(info.source, 'bootstrap-api');
    assert.equal(info.editable, true);
    assert.equal(info.requiresUpgrade, false);
    assert.equal(info.entries.length, 1);
    assert.equal(info.entries[0].paused, true);
    assert.equal(info.entries[0].online, false);
    assert.equal(info.entries[0].savedAt, 1234);
    const added = await bridge.addBootstrap('ui-bootstrap-edit', `/ip4/127.0.0.1/tcp/44002/p2p/${PEER_A}`);
    assert.equal(added.ok, true);
    assert.equal(added.changed, true);
    const removed = await bridge.removeBootstrap('ui-bootstrap-edit', PEER_A);
    assert.equal(removed.ok, true);
    assert.deepEqual(client.bootstrapEdits, [
      { action: 'add', multiaddr: `/ip4/127.0.0.1/tcp/44002/p2p/${PEER_A}` },
      { action: 'remove', peerId: PEER_A },
    ]);
  } finally {
    bridge.dispose();
  }
});

test('old daemon bootstrap is readable but writes fail with an upgrade message', async () => {
  const dir = await tempDir();
  const client = makeClient({ bootstrapPeers: [`/ip4/127.0.0.1/tcp/44001/p2p/${PEER_A}`] });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-bootstrap-old');
    const info = await bridge.bootstrap('ui-bootstrap-old');
    assert.equal(info.source, 'dht-status');
    assert.equal(info.editable, false);
    assert.equal(info.requiresUpgrade, true);
    assert.deepEqual(info.peers, [`/ip4/127.0.0.1/tcp/44001/p2p/${PEER_A}`]);
    await assert.rejects(
      () => bridge.addBootstrap('ui-bootstrap-old', `/ip4/127.0.0.1/tcp/44002/p2p/${PEER_A}`),
      /升级|不支持/,
    );
    assert.equal(client.bootstrapEdits.length, 0, 'old daemon must not report a false save');
  } finally {
    bridge.dispose();
  }
});
