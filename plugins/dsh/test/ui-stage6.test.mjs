// Stage-6 host bridge tests: discovery evidence, relation snapshots, controlled
// local reads, profile separation and clipped Journey references.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RamingaUiBridge } from '../lib/ui-bridge.js';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { readContactProjection, writeContactProjection } from '../lib/local-data.js';

const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';
const PEER_C = '12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';

function statusResponse(peerId = PEER_A) {
  return {
    peerId,
    nodeId: 'node-test',
    version: 'test',
    protocolVersion: '1',
    apiVersion: '6',
    startedAtUnixMs: 1,
    currentTime: 'now',
    listenAddrs: [],
    connections: [],
    peers: [],
    relays: [],
    maxChatTextBytes: 4096,
    maxStoredMessages: 1000,
  };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'raminga-ui-stage6-'));
}

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.isBuffer(value) || value instanceof Uint8Array ? value : typeof value === 'string' ? value : JSON.stringify(value));
}

function post(peerId, title = '公开帖子') {
  return {
    schema_version: 1,
    title,
    format: 'markdown',
    author: { peer_id: peerId, kind: 'user', display_name: peerId === PEER_A ? 'Alice' : 'Bob' },
    published_at: '2026-11-14T10:00:00Z',
    tags: ['stage6'],
    body: `# ${title}\n\n**受控**正文。`,
  };
}

function makeClient({ status = statusResponse(), rows = [], relations = [], profile = null, card = null, messagePages = [], sendChat = null, published = [], peerFriends = null, peerManifest = null } = {}) {
  const relationPages = Array.isArray(relations) ? relations : [];
  let messageIndex = 0;
  return {
    async status() { return status; },
    async listFriends() { return { friends: [] }; },
    async listDiscoveries(request) {
      const relationPeers = new Set();
      for (const entry of relationPages) for (const peer of entry.peers ?? []) relationPeers.add(peer.peerId);
      const page = rows.filter((row) => !request.before || row.id < request.before)
        .filter((row) => request.familiarOnly !== true || relationPeers.has(row.peerId))
        .filter((row) => request.postCandidatesOnly !== true
          || /^posts\/(?:[A-Za-z0-9._-]+\.json|[A-Za-z0-9._-]+\/post\.json)$/.test(row.path));
      return {
        discoveries: page,
        hasMore: false,
        nextBefore: '',
      };
    },
    async listHumanOutboundPeers(request) {
      const entry = relationPages.find((item) => item.cursor === (request.before ?? ''));
      if (!entry) return { peers: [], hasMore: false, nextBefore: '' };
      return { peers: entry.peers, hasMore: entry.hasMore === true, nextBefore: entry.next ?? '' };
    },
    async published() {
      return { files: published.map((file) => ({ path: file.path, size: file.size })), skipped: [], generatedAtUnixMs: 1, friendsSyncedAtUnixMs: 1 };
    },
    async listMessages() {
      const page = messagePages[messageIndex] ?? { messages: [], hasMore: false, nextBefore: '', retention: { retainedMessages: 0, oldestRetainedAtUnixMs: 0, maxStoredMessages: 1000 } };
      messageIndex += 1;
      return page;
    },
    async getPeerProfile() {
      if (!profile) throw new Error('no profile');
      return profile;
    },
    async getPeerFriends() {
      if (peerFriends instanceof Error) throw peerFriends;
      return peerFriends ?? { peerId: PEER_A, friends: [], limited: false };
    },
    async getPeerManifest() {
      if (!peerManifest) throw new Error('no manifest');
      return peerManifest;
    },
    async downloadPeerFile() {
      return (async function* frames() {
        yield card ?? { phase: 'error', path: 'profile/agent-card.json', error: 'missing' };
      })();
    },
    async sendChat(request) {
      if (typeof sendChat === 'function') return sendChat(request);
      return { messageId: 'm-test', deliveryStatus: 'pending', outboxStatus: 'pending', acked: false };
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

function makeBridge(client, dataDir) {
  return new RamingaUiBridge({ async ensure() { return client; }, async call(fn) { return fn(client); } }, { dataDir });
}

async function seedDiscovery(dir, peerId, relative, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  await write(path.join(dir, 'downloads', peerId, relative), bytes);
  return {
    id: crypto.createHash('sha1').update(`${peerId}:${relative}`).digest('hex').slice(0, 12),
    peerId,
    path: relative,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    fetchedAtUnixMs: 1000,
    source: 'raminga_content_get',
  };
}

test('discoveries parse only verified versioned posts and familiar uses complete relation pages', async () => {
  const dir = await tempDir();
  const rowA = await seedDiscovery(dir, PEER_A, 'posts/a.json', post(PEER_A));
  const rowB = await seedDiscovery(dir, PEER_B, 'posts/b.json', post(PEER_B));
  const rowC = await seedDiscovery(dir, PEER_C, 'posts/c.json', post(PEER_C));
  // A file left in downloads without an evidence row must not become a Feed
  // recommendation merely because a directory scan can see it.
  await write(path.join(dir, 'downloads', PEER_C, 'posts', 'old-unknown.json'), JSON.stringify(post(PEER_C, '旧未知文件')));
  const client = makeClient({
    rows: [rowA, rowB, rowC],
    relations: [
      { cursor: '', peers: [{ peerId: PEER_B }], hasMore: true, next: 'next' },
      { cursor: 'next', peers: [{ peerId: PEER_A }], hasMore: false },
    ],
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-stage6-discovery');
    const all = await bridge.discoveries('ui-stage6-discovery', false, true);
    assert.equal(all.items.length, 3);
    assert.equal(all.items.some((item) => item.title === '旧未知文件'), false, 'unattributed old downloads stay unknown');
    assert.equal(all.items[0].contentState, 'available');
    assert.equal(all.truncated, false);

    const familiar = await bridge.discoveries('ui-stage6-discovery', true, true);
    assert.equal(familiar.relationComplete, true);
    assert.deepEqual(familiar.items.map((item) => item.peerId).sort(), [PEER_A, PEER_B].sort());
    const relations = await bridge.humanOutbound('ui-stage6-discovery', true);
    assert.deepEqual([...relations.peers].sort(), [PEER_A, PEER_B].sort());
    assert.equal(relations.complete, true);

    const content = await bridge.discoveryContent('ui-stage6-discovery', rowA.id);
    assert.equal(content.ok, true);
    assert.match(content.post.bodyMarkdown, /受控/);
  } finally {
    bridge.dispose();
  }
});

test('a full page of non-post files does not hide later posts or inflate counts', async () => {
  const dir = await tempDir();
  const later = await seedDiscovery(dir, PEER_A, 'posts/later.json', post(PEER_A, '一整页之后'));
  const filler = Array.from({ length: 100 }, (_, index) => ({
    id: `note-${String(index).padStart(3, '0')}`,
    peerId: PEER_A,
    path: `notes/note-${String(index).padStart(3, '0')}.md`,
    sha256: 'a'.repeat(64),
    sizeBytes: 10,
    fetchedAtUnixMs: 2000 - index,
    source: 'raminga_ui_manual',
  }));
  const client = makeClient({ rows: [] });
  client.listDiscoveries = async (request) => {
    assert.equal(request.postCandidatesOnly, true, 'the Feed asks the daemon to filter before its cursor LIMIT');
    if ((request.before ?? '') === '') {
      return { discoveries: filler, hasMore: true, nextBefore: 'page-2' };
    }
    return { discoveries: [later], hasMore: false, nextBefore: '' };
  };
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-stage6-post-page');
    const all = await bridge.discoveries('ui-stage6-post-page', false, true);
    assert.equal(all.items.length, 1, 'the later post is found after a whole non-post page');
    assert.equal(all.items[0].path, 'posts/later.json');
    assert.equal(all.items[0].title, '一整页之后');
    assert.equal(all.scanned, 101);
    assert.equal(all.ignored, 100, 'non-posts are counted as excluded, never rendered');
    assert.equal(all.truncated, false);
  } finally {
    bridge.dispose();
  }
});

test('a persisted pending human send invalidates the familiar and relation caches', async () => {
  const dir = await tempDir();
  const rowA = await seedDiscovery(dir, PEER_A, 'posts/a.json', post(PEER_A));
  const relationPages = [];
  let sendCount = 0;
  const client = makeClient({
    rows: [rowA],
    relations: relationPages,
    sendChat: async (request) => {
      sendCount += 1;
      // The daemon records the relation in the same transaction; a pending
      // outbox row is enough and no ACK is required.
      relationPages.splice(0, relationPages.length, {
        cursor: '', peers: [{ peerId: PEER_A }], hasMore: false,
      });
      return {
        messageId: 'm-human-pending', deliveryStatus: 'pending', outboxStatus: 'pending',
        acked: false, requestId: request.requestId,
      };
    },
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-stage6-send-invalidates');
    const before = await bridge.discoveries('ui-stage6-send-invalidates', true, true);
    assert.deepEqual(before.items, []);
    const relationBefore = await bridge.humanOutbound('ui-stage6-send-invalidates', true);
    assert.deepEqual(relationBefore.peers, []);

    const sent = await bridge.send('ui-stage6-send-invalidates', PEER_A, 'hello', 'req-pending');
    assert.equal(sent.ok, true);
    assert.equal(sent.deliveryStatus, 'pending');
    assert.equal(sendCount, 1);

    // No force: the send invalidated the bridge caches itself. If it only
    // refreshed on ACK (or required a remount) this would still be empty.
    const familiar = await bridge.discoveries('ui-stage6-send-invalidates', true, false);
    assert.deepEqual(familiar.items.map((item) => item.id), [rowA.id]);
    const relation = await bridge.humanOutbound('ui-stage6-send-invalidates', false);
    assert.deepEqual([...relation.peers], [PEER_A]);
    assert.equal(relation.complete, true);
  } finally {
    bridge.dispose();
  }
});

test('a non-advancing relation cursor is an error, not a complete familiar set', async () => {
  const dir = await tempDir();
  const row = await seedDiscovery(dir, PEER_A, 'posts/a.json', post(PEER_A));
  const client = makeClient({
    rows: [row],
    relations: [
      { cursor: '', peers: [{ peerId: PEER_A }], hasMore: true, next: 'same' },
      { cursor: 'same', peers: [{ peerId: PEER_B }], hasMore: true, next: 'same' },
    ],
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-stage6-relation-stall');
    const familiar = await bridge.discoveries('ui-stage6-relation-stall', true, true);
    assert.equal(familiar.relationComplete, false);
    assert.match(familiar.error, /游标没有前进/);
  } finally {
    bridge.dispose();
  }
});

test('mine reads the local public profile and only explicit user authorship', async () => {
  const dir = await tempDir();
  await write(path.join(dir, 'public', 'profile', 'index.md'), '# Alice\n\n公开资料。');
  await write(path.join(dir, 'public', 'posts', 'user.json'), post(PEER_A));
  await write(path.join(dir, 'public', 'posts', 'agent.json'), {
    ...post(PEER_A, 'Agent 内容'),
    author: { peer_id: PEER_A, kind: 'agent', display_name: 'Nova' },
  });
  // A public file exists but does not prove this user wrote it.
  await write(path.join(dir, 'public', 'posts', 'other.json'), post(PEER_B, '他人内容'));
  const published = [];
  for (const relative of ['profile/index.md', 'posts/user.json', 'posts/agent.json', 'posts/other.json']) {
    const stat = await fs.stat(path.join(dir, 'public', relative));
    published.push({ path: relative, size: stat.size });
  }
  const client = makeClient({ published });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-stage6-mine');
    const mine = await bridge.mine('ui-stage6-mine', true);
    assert.equal(mine.profile.state, 'available');
    assert.equal(mine.posts.posts.length, 2, 'mine includes explicit user and Agent posts');
    const userPosts = mine.posts.posts.filter((item) => item.authorKind === 'user');
    assert.equal(userPosts.length, 1);
    assert.equal(userPosts[0].title, '公开帖子');
    assert.equal(mine.posts.unattributed, 1);
    assert.equal(mine.posts.agentAuthored, 1, 'agent file is explicit agent authorship');
  } finally {
    bridge.dispose();
  }
});

test('peer profile keeps the user profile separate from an optional public Agent card', async () => {
  const dir = await tempDir();
  const card = {
    schema_version: 1,
    display_name: 'Nova',
    description: '公开 Agent 介绍',
    interests: ['测试'],
    conversation_style: '简洁',
    updated_at: '2026-11-14T11:00:00Z',
  };
  const bytes = Buffer.from(JSON.stringify(card));
  await write(path.join(dir, 'downloads', PEER_A, 'profile', 'agent-card.json'), bytes);
  const client = makeClient({
    profile: { peerId: PEER_A, name: 'Alice', text: '# Alice\n\n远端声明。', files: ['profile/index.md', 'profile/agent-card.json'], found: true },
    card: {
      phase: 'complete', path: 'profile/agent-card.json', localPath: path.join(dir, 'downloads', PEER_A, 'profile', 'agent-card.json'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), totalBytes: bytes.length, error: '',
    },
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-stage6-profile');
    const profile = await bridge.peerProfile('ui-stage6-profile', PEER_A, true);
    assert.equal(profile.found, true);
    assert.equal(profile.remoteName, 'Alice');
    assert.match(profile.text, /远端声明/);
    assert.equal(profile.agentCard.state, 'available');
    assert.equal(profile.agentCard.card.displayName, 'Nova');
  } finally {
    bridge.dispose();
  }
});

test('peer address book returns GetPeerFriends claims without treating them as local contacts', async () => {
  const dir = await tempDir();
  const bridge = makeBridge(makeClient({
    peerFriends: {
      peerId: PEER_A,
      limited: true,
      friends: [
        { name: 'Claimed', peerId: PEER_B, addrs: ['/ip4/127.0.0.1/tcp/4001'], description: '公开条目' },
        { name: 'invalid', peerId: 'not-a-peer', addrs: [], description: '' },
      ],
    },
  }), dir);
  try {
    await bridge.open('ui-stage6-friends');
    const friends = await bridge.peerFriends('ui-stage6-friends', PEER_A, true);
    assert.equal(friends.source, 'remote');
    assert.equal(friends.limited, true);
    assert.equal(friends.error, null);
    assert.equal(friends.friends.length, 1);
    assert.equal(friends.friends[0].name, 'Claimed');
    assert.equal(friends.friends[0].peerId, PEER_B);
    assert.equal(friends.friends[0].description, '公开条目');
  } finally {
    bridge.dispose();
  }

  const unavailable = makeBridge(makeClient({ peerFriends: new Error('peer offline') }), dir);
  try {
    await unavailable.open('ui-stage6-friends-offline');
    const friends = await unavailable.peerFriends('ui-stage6-friends-offline', PEER_A, true);
    assert.equal(friends.source, 'unavailable');
    assert.equal(friends.friends.length, 0);
    assert.match(friends.error, /peer offline/);
  } finally {
    unavailable.dispose();
  }
});

test('journey reads controlled files and reports missing records honestly', async () => {
  const dir = await tempDir();
  await write(path.join(dir, 'agent', 'persona.md'), '# 稳定人格\n\n简洁。');
  await write(path.join(dir, 'agent', 'sessions', 's1', 'state.json'), {
    schema_version: 1, session_id: 's1', status: 'running', mode: 'exploration', intent: '读内容',
    started_at: '2026-11-14T10:00:00Z', updated_at: '2026-11-14T10:01:00Z',
  });
  await write(path.join(dir, 'agent', 'sessions', 's1', 'events.jsonl'), '');
  const client = makeClient();
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-stage6-journey');
    const journey = await bridge.journey('ui-stage6-journey', true);
    assert.equal(journey.state, 'available');
    assert.equal(journey.persona.state, 'available');
    assert.equal(journey.sessions.length, 1);
    assert.equal(journey.sessions[0].state.status, 'running');
  } finally {
    bridge.dispose();
  }

  const missingDir = await tempDir();
  const missingBridge = makeBridge(makeClient(), missingDir);
  try {
    await missingBridge.open('ui-stage6-journey-missing');
    const journey = await missingBridge.journey('ui-stage6-journey-missing', true);
    assert.equal(journey.state, 'missing');
    assert.deepEqual(journey.sessions, []);
  } finally {
    missingBridge.dispose();
  }
});

test('journey force bypasses the bridge cache after external growth and report updates', async () => {
  const dir = await tempDir();
  await write(path.join(dir, 'agent', 'persona.md'), '# 稳定人格\n\n简洁。');
  await write(path.join(dir, 'agent', 'growth.md'), '# 成长\n\n第一次记录。');
  await write(path.join(dir, 'agent', 'sessions', 's1', 'state.json'), {
    schema_version: 1, session_id: 's1', status: 'completed', mode: 'explore', intent: '初次记录',
    started_at: '2026-11-14T10:00:00Z', updated_at: '2026-11-14T10:01:00Z',
  });
  await write(path.join(dir, 'agent', 'sessions', 's1', 'events.jsonl'), '');
  await write(path.join(dir, 'agent', 'sessions', 's1', 'report.md'), '# 报告\n\n第一次报告。');
  const bridge = makeBridge(makeClient(), dir);
  try {
    await bridge.open('ui-stage6-journey-refresh');
    const first = await bridge.journey('ui-stage6-journey-refresh', true);
    assert.equal(first.state, 'available');
    assert.match(first.growth.markdown, /第一次记录/);
    assert.equal(first.sessions.length, 1);
    assert.match(first.sessions[0].reportMarkdown, /第一次报告/);

    await write(path.join(dir, 'agent', 'growth.md'), '# 成长\n\n第二次记录。');
    await write(path.join(dir, 'agent', 'sessions', 's1', 'report.md'), '# 报告\n\n第二次报告。');
    await write(path.join(dir, 'agent', 'sessions', 's2', 'state.json'), {
      schema_version: 1, session_id: 's2', status: 'completed', mode: 'explore', intent: '新记录',
      started_at: '2026-11-14T11:00:00Z', updated_at: '2026-11-14T11:01:00Z',
    });
    await write(path.join(dir, 'agent', 'sessions', 's2', 'events.jsonl'), '');

    const cached = await bridge.journey('ui-stage6-journey-refresh', false);
    assert.match(cached.growth.markdown, /第一次记录/,
      'an ordinary read within the TTL keeps the bridge cache');
    assert.equal(cached.sessions.length, 1);

    const forced = await bridge.journey('ui-stage6-journey-refresh', true);
    assert.match(forced.growth.markdown, /第二次记录/);
    assert.equal(forced.sessions.length, 2);
    const updated = forced.sessions.find((session) => session.id === 's1');
    assert.ok(updated);
    assert.match(updated.reportMarkdown, /第二次报告/);
  } finally {
    bridge.dispose();
  }
});

test('locateMessage finds only the exact retained row and never substitutes a clipped one', async () => {
  const dir = await tempDir();
  const foundPage = {
    messages: [{ messageId: 'm-found', peerId: PEER_A, direction: 'out', text: 'hello', acked: true, createdAtUnixMs: 10, deliveryStatus: 'acked', origin: 'human' }],
    hasMore: false, nextBefore: '', retention: { retainedMessages: 1, oldestRetainedAtUnixMs: 10, maxStoredMessages: 1000 },
  };
  const client = makeClient({ messagePages: [foundPage] });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-stage6-locate');
    const found = await bridge.locateMessage('ui-stage6-locate', PEER_A, 'm-found');
    assert.equal(found.found, true);
    assert.equal(found.message.messageId, 'm-found');
    const clipped = await bridge.locateMessage('ui-stage6-locate', PEER_A, 'm-clipped');
    assert.equal(clipped.found, false);
    assert.equal(clipped.complete, true);
    assert.equal(clipped.message, null);
  } finally {
    bridge.dispose();
  }
});

test('a missing local data root is an explicit error, not an empty feed', async () => {
  const bridge = makeBridge(makeClient({ rows: [] }), '');
  try {
    await bridge.open('ui-stage6-no-dir');
    const result = await bridge.discoveries('ui-stage6-no-dir', false, true);
    assert.match(result.error, /受控数据目录/);
    assert.deepEqual(result.items, []);
    const mine = await bridge.mine('ui-stage6-no-dir', true);
    assert.match(mine.error, /受控数据目录/);
  } finally {
    bridge.dispose();
  }
});

test('savePrivateAgent writes only the fixed private files and reports conflicts', async () => {
  const dir = await tempDir();
  const bridge = makeBridge(makeClient(), dir);
  try {
    await bridge.open('ui-stage6-private-save');
    const saved = await bridge.savePrivateAgent('ui-stage6-private-save', 'persona', '# 人格\n\n只在本机。', '');
    assert.equal(saved.saved, true);
    assert.equal(saved.field, 'persona');
    assert.match(saved.sha256, /^[a-f0-9]{64}$/);
    assert.equal(await fs.readFile(path.join(dir, 'agent', 'persona.md'), 'utf8'), '# 人格\n\n只在本机。');
    assert.equal((await fs.stat(path.join(dir, 'agent', 'persona.md'))).mode & 0o777, 0o600);
    await assert.rejects(fs.stat(path.join(dir, 'public')), /ENOENT/);

    const conflict = await bridge.savePrivateAgent('ui-stage6-private-save', 'persona', '# 覆盖', 'f'.repeat(64));
    assert.equal(conflict.saved, false);
    assert.equal(conflict.conflict, true);
    assert.match(conflict.error, /已在别处修改/);
    assert.equal(await fs.readFile(path.join(dir, 'agent', 'persona.md'), 'utf8'), '# 人格\n\n只在本机。');

    await assert.rejects(
      bridge.savePrivateAgent('ui-stage6-private-save', 'other', 'x', ''),
      /只允许保存/,
    );
  } finally {
    bridge.dispose();
  }
});


test('verified profile and directory claims survive a new host bridge without another read', async () => {
  const dir = await tempDir();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const avatarSha = crypto.createHash('sha256').update(png).digest('hex');
  const avatarPath = `profile/avatar-${avatarSha.slice(0, 8)}.png`;
  await write(path.join(dir, 'downloads', PEER_B, avatarPath), png);
  const profileResponse = {
    peerId: PEER_B,
    name: 'Lin An',
    text: '# Lin An\n\n公开主页。',
    files: ['profile/index.md', 'profile/profile.json', avatarPath],
    found: true,
    profile: {
      agentName: '潮汐线旁的林岸',
      agentDescription: '慢一点回信，先把海边的事看完。',
      agentInterests: ['潮汐', '旧信'],
      agentConversationStyle: '不急着追问。',
      humanName: '林岸',
      humanBioMarkdown: '住在潮汐线附近。',
      avatarPath,
      avatarSha256: avatarSha,
      avatarMime: 'image/png',
    },
  };
  const calls = { profile: 0, friends: 0, manifest: 0 };
  const client = makeClient({
    profile: profileResponse,
    peerFriends: {
      peerId: PEER_B,
      limited: false,
      friends: [{ name: '星云收集者', peerId: PEER_C, addrs: [], description: '喜欢收集星云与天文影像。' }],
    },
    peerManifest: {
      peerId: PEER_B,
      total: 1,
      limited: false,
      entries: [{ path: avatarPath, sha256: avatarSha, size: png.length, modifiedUnixMs: 1 }],
    },
  });
  for (const method of ['getPeerProfile', 'getPeerFriends', 'getPeerManifest']) {
    const original = client[method];
    client[method] = async (...args) => {
      calls[method === 'getPeerProfile' ? 'profile' : method === 'getPeerFriends' ? 'friends' : 'manifest'] += 1;
      return original.apply(client, args);
    };
  }
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-stage6-projection');
    const profile = await bridge.peerProfile('ui-stage6-projection', PEER_B, true);
    assert.equal(profile.agentCard.card.displayName, '潮汐线旁的林岸');
    const friends = await bridge.peerFriends('ui-stage6-projection', PEER_B, true);
    assert.equal(friends.friends.length, 1);
    const first = await bridge.contactProjection('ui-stage6-projection');
    assert.equal(first.state, 'available');
    const saved = first.profiles.find((item) => item.peerId === PEER_B);
    assert.equal(saved.displayName, '潮汐线旁的林岸');
    assert.equal(saved.avatarState, 'ready');
    assert.match(saved.avatarUrl, /^data:image\/png;base64,/);
    assert.equal(saved.avatarSha256, avatarSha);
    assert.equal(first.clues.length, 1);
    assert.equal(first.clues[0].sourcePeerId, PEER_B);
    assert.equal(first.clues[0].peerId, PEER_C);
    assert.match(first.clues[0].sourceName, /潮汐线旁的林岸/);
  } finally {
    bridge.dispose();
  }

  // A new bridge simulates the next DSH application run. Reading its
  // projection must not re-read either the profile or the directory.
  let remoteReads = 0;
  const offlineClient = makeClient();
  offlineClient.getPeerProfile = async () => { remoteReads += 1; throw new Error('peer offline'); };
  offlineClient.getPeerFriends = async () => { remoteReads += 1; throw new Error('peer offline'); };
  offlineClient.getPeerManifest = async () => { remoteReads += 1; throw new Error('peer offline'); };
  const reopened = makeBridge(offlineClient, dir);
  try {
    await reopened.open('ui-stage6-projection-reopen');
    const after = await reopened.contactProjection('ui-stage6-projection-reopen');
    assert.equal(after.state, 'available');
    const saved = after.profiles.find((item) => item.peerId === PEER_B);
    assert.equal(saved.displayName, '潮汐线旁的林岸');
    assert.equal(saved.avatarState, 'ready');
    assert.match(saved.avatarUrl, /^data:image\/png;base64,/);
    assert.equal(after.clues.length, 1);
    assert.equal(after.clues[0].name, '星云收集者');
    assert.equal(remoteReads, 0, 'projection reads are local-only');
  } finally {
    reopened.dispose();
  }

  // A missing local avatar is not shown under the saved version; the name and
  // clue remain available for an offline source.
  await fs.rm(path.join(dir, 'downloads', PEER_B, avatarPath));
  const missingBridge = makeBridge(makeClient(), dir);
  try {
    await missingBridge.open('ui-stage6-projection-missing-avatar');
    const after = await missingBridge.contactProjection('ui-stage6-projection-missing-avatar');
    const saved = after.profiles.find((item) => item.peerId === PEER_B);
    assert.equal(saved.displayName, '潮汐线旁的林岸');
    assert.equal(saved.avatarState, 'missing');
    assert.equal(saved.avatarUrl, '');
    assert.equal(after.clues[0].name, '星云收集者');
  } finally {
    missingBridge.dispose();
  }
});

const FEED_PNG_HUMAN = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGsAAAAASUVORK5CYII=', 'base64');
const FEED_PNG_HUMAN_V2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAABFaP0WAAAADUlEQVR42mNk+M/wHwAEAQH/2VZqNwAAAABJRU5ErkJggg==', 'base64');
const FEED_PNG_AGENT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function writeFeedProfile(dir, peerId, { humanName, agentName, humanPng, agentPng, humanNameOnDisk = '阿岸' }) {
  const humanSha = crypto.createHash('sha256').update(humanPng).digest('hex');
  const agentSha = crypto.createHash('sha256').update(agentPng).digest('hex');
  const humanPath = `profile/human-avatar-${humanSha.slice(0, 8)}.png`;
  const agentPath = `profile/avatar-${agentSha.slice(0, 8)}.png`;
  await write(path.join(dir, 'downloads', peerId, humanPath), humanPng);
  await write(path.join(dir, 'downloads', peerId, agentPath), agentPng);
  await write(path.join(dir, 'downloads', peerId, 'profile', 'index.md'), `# ${humanNameOnDisk}\n\n公开的人类页头。\n`);
  await write(path.join(dir, 'downloads', peerId, 'profile', 'profile.json'), `${JSON.stringify({
    schema_version: 2,
    agent: {
      name: agentName, description: '', interests: [], conversation_style: '',
      avatar: agentPath.slice('profile/'.length), avatar_sha256: agentSha, avatar_mime: 'image/png',
    },
    human: {
      name: humanName, bio_markdown: '',
      avatar: humanPath.slice('profile/'.length), avatar_sha256: humanSha, avatar_mime: 'image/png',
    },
    updated_at: '2026-11-22T00:00:00Z',
  })}\n`);
  const now = new Date(Date.now() + Math.random() * 1000);
  await fs.utimes(path.join(dir, 'downloads', peerId, 'profile', 'profile.json'), now, now);
  return {
    humanUrl: `data:image/png;base64,${humanPng.toString('base64')}`,
    agentUrl: `data:image/png;base64,${agentPng.toString('base64')}`,
    humanPath,
    agentPath,
  };
}

function feedAvatarUrl(page, item) {
  const shared = item?.publisherAvatarKey ? page?.avatars?.[item.publisherAvatarKey]?.url : '';
  return shared || item?.publisherAvatarUrl || '';
}

test('feed uses the publishing Agent for both original authors and shares the verified avatar', async () => {
  const dir = await tempDir();
  const agentPost = {
    ...post(PEER_A, 'Agent 署名的公开帖子'),
    author: { peer_id: PEER_A, kind: 'agent', display_name: '小澜' },
  };
  const row = await seedDiscovery(dir, PEER_A, 'posts/agent-avatar.json', agentPost);
  const row2 = await seedDiscovery(dir, PEER_A, 'posts/agent-avatar-2.json', {
    ...agentPost, title: '同一个节点的人类署名帖',
    author: { peer_id: PEER_A, kind: 'user', display_name: '阿岸' },
  });
  let remoteReads = 0;
  const client = makeClient({ rows: [row, row2] });
  const originalProfile = client.getPeerProfile.bind(client);
  const originalManifest = client.getPeerManifest.bind(client);
  const originalDownload = client.downloadPeerFile.bind(client);
  client.getPeerProfile = async (...args) => { remoteReads += 1; return originalProfile(...args); };
  client.getPeerManifest = async (...args) => { remoteReads += 1; return originalManifest(...args); };
  client.downloadPeerFile = async (...args) => { remoteReads += 1; return originalDownload(...args); };
  const bridge = makeBridge(client, dir);
  const sid = 'ui-stage6-feed-avatars';
  try {
    await bridge.open(sid);
    const first = await writeFeedProfile(dir, PEER_A, {
      humanName: '阿岸', agentName: '小澜', humanPng: FEED_PNG_HUMAN, agentPng: FEED_PNG_AGENT,
    });
    let page = await bridge.discoveries(sid, false, true);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].publisherName, '阿岸');
    assert.equal(page.items[0].publisherAgentName, '小澜');
    assert.equal(feedAvatarUrl(page, page.items[0]), first.agentUrl, 'uses the published Agent avatar');
    assert.deepEqual(page.items.map((item) => item.authorKind).sort(), ['agent', 'user']);
    assert.ok(page.items.every((item) => item.publisherAgentName === '小澜'));
    assert.equal(feedAvatarUrl(page, page.items[1]), first.agentUrl, 'same peer/version shares one verified avatar result');
    assert.equal(page.items[0].publisherAvatarKey, page.items[1].publisherAvatarKey);
    assert.equal(page.items.every((item) => item.publisherAvatarUrl === ''), true, 'list items only carry the avatar key, not repeated data URLs');
    assert.equal(JSON.stringify(page).split(first.agentUrl).length - 1, 1, 'one publisher avatar is serialized exactly once');
    assert.equal(bridge.feedAgentAvatarCache.get(PEER_A)?.key, page.items[0].publisherAvatarKey, 'the verified cache key matches the version exposed to the UI, so later reads are hits');
    assert.equal(remoteReads, 0, 'painting a feed avatar must not add a remote read');

    // The contact "他的动态" list is built from the same local identity and
    // keeps the same avatar for the detail route selected from that item.
    const peerItems = await bridge.peerDiscoveries(sid, PEER_A, true);
    assert.equal(peerItems.items.length, 2);
    assert.equal(feedAvatarUrl(peerItems, peerItems.items[0]), first.agentUrl);
    assert.equal(JSON.stringify(peerItems).split(first.agentUrl).length - 1, 1, 'the peer list shares the same avatar payload');
    assert.equal(remoteReads, 0);

    // Changing the published Agent name does not replace the node name.
    const second = await writeFeedProfile(dir, PEER_A, {
      humanName: '另一个人', agentName: '阿岸', humanPng: FEED_PNG_HUMAN_V2, agentPng: FEED_PNG_AGENT,
    });
    page = await bridge.discoveries(sid, false, true);
    assert.equal(feedAvatarUrl(page, page.items[0]), second.agentUrl);
    assert.equal(page.items[0].publisherAgentName, '阿岸');
    assert.equal(remoteReads, 0);

    // A different verified Agent image replaces the cached version.
    const third = await writeFeedProfile(dir, PEER_A, {
      humanName: '阿岸', agentName: '小澜', humanPng: FEED_PNG_HUMAN, agentPng: FEED_PNG_HUMAN_V2,
    });
    page = await bridge.discoveries(sid, false, true);
    assert.equal(feedAvatarUrl(page, page.items[0]), third.agentUrl);
    assert.notEqual(third.agentUrl, first.agentUrl);
    assert.equal(remoteReads, 0);

    // A warmed cache must not survive same-size damage to the file. The
    // modified time belongs to the identity, so this read re-verifies, fails
    // the SHA check and falls back to the initial instead of the old URL.
    const damaged = Buffer.alloc(FEED_PNG_HUMAN_V2.length, 0x41);
    await write(path.join(dir, 'downloads', PEER_A, third.agentPath), damaged);
    const bumped = new Date(Date.now() + 5000);
    await fs.utimes(path.join(dir, 'downloads', PEER_A, third.agentPath), bumped, bumped);
    page = await bridge.discoveries(sid, false, true);
    assert.equal(feedAvatarUrl(page, page.items[0]), '', 'same-size damaged avatar is re-read and falls back');
    assert.equal(page.items[0].publisherName, '阿岸');

    // Missing or corrupt Agent bytes fall back without borrowing the human avatar.
    await fs.rm(path.join(dir, 'downloads', PEER_A, third.agentPath));
    page = await bridge.discoveries(sid, false, true);
    assert.equal(feedAvatarUrl(page, page.items[0]), '');
    assert.equal(page.items[0].publisherName, '阿岸');

    const corrupt = Buffer.from('not a png');
    const fourth = await writeFeedProfile(dir, PEER_A, {
      humanName: '阿岸', agentName: '小澜', humanPng: FEED_PNG_HUMAN, agentPng: corrupt,
    });
    page = await bridge.discoveries(sid, false, true);
    assert.equal(feedAvatarUrl(page, page.items[0]), '', 'MIME/signature validation rejects a corrupt avatar');
    assert.notEqual(feedAvatarUrl(page, page.items[0]), fourth.agentUrl);
  } finally {
    bridge.dispose();
  }
});

test('feed and Mine accept an avatar above 2 MiB while the contact list keeps 512 KiB', async () => {
  const dir = await tempDir();
  // Mirrors the desktop case: a legal published avatar above the old 2 MiB
  // Feed budget but below the 4 MiB publication contract. This layer verifies
  // the PNG signature, so the fixture only needs a real signature and size.
  const png = Buffer.alloc(2_589_021, 0x5a);
  FEED_PNG_HUMAN.copy(png, 0, 0, 8);
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  const avatarPath = `profile/avatar-${sha.slice(0, 8)}.png`;

  const row = await seedDiscovery(dir, PEER_A, 'posts/large-avatar.json', {
    ...post(PEER_A, '大图头像'),
    author: { peer_id: PEER_A, kind: 'user', display_name: '阿岸' },
  });
  const feed = await writeFeedProfile(dir, PEER_A, {
    humanName: '阿岸', agentName: '小澜', humanPng: FEED_PNG_HUMAN, agentPng: png,
  });
  assert.equal(feed.agentPath, avatarPath);

  const publicProfile = Buffer.from(JSON.stringify({
    schema_version: 2,
    agent: {
      name: '小澜', description: '', interests: [], conversation_style: '',
      avatar: avatarPath.slice('profile/'.length), avatar_sha256: sha, avatar_mime: 'image/png',
    },
    human: {
      name: '阿岸', bio_markdown: '公开的人类页头。',
    },
    updated_at: '2026-11-22T00:00:00Z',
  }));
  const publicIndex = Buffer.from('# 阿岸\n\n公开的人类页头。\n');
  await write(path.join(dir, 'public', 'profile', 'profile.json'), publicProfile);
  await write(path.join(dir, 'public', 'profile', 'index.md'), publicIndex);
  await write(path.join(dir, 'public', avatarPath), png);
  const published = [
    { path: 'profile/index.md', size: publicIndex.length },
    { path: 'profile/profile.json', size: publicProfile.length },
    { path: avatarPath, size: png.length },
  ];

  const bridge = makeBridge(makeClient({ rows: [row], published }), dir);
  try {
    await bridge.open('ui-stage6-large-avatar');
    const page = await bridge.discoveries('ui-stage6-large-avatar', false, true);
    assert.equal(page.items.length, 1);
    const feedUrl = feedAvatarUrl(page, page.items[0]);
    const feedBytes = Buffer.from(feedUrl.split(',')[1] ?? '', 'base64');
    assert.equal(feedBytes.length, png.length, 'Feed must expose the complete >2 MiB avatar');
    assert.equal(crypto.createHash('sha256').update(feedBytes).digest('hex'), sha);

    const mine = await bridge.mine('ui-stage6-large-avatar', true);
    assert.equal(mine.publisherAvatarKey.includes(sha), true, 'Mine resolves the same >2 MiB published avatar');
    const mineBytes = Buffer.from(mine.publisherAvatarUrl.split(',')[1] ?? '', 'base64');
    assert.equal(mineBytes.length, png.length, 'Mine must expose the complete >2 MiB avatar');
    assert.equal(crypto.createHash('sha256').update(mineBytes).digest('hex'), sha);

    // The dynamic paths above were widened; the contact projection keeps its
    // separate 512 KiB metadata cap and never stores this larger avatar.
    const now = Date.now();
    await writeContactProjection(dir, {
      schemaVersion: 1,
      updatedAt: now,
      profiles: [{
        peerId: PEER_B,
        displayName: '大图联系人',
        description: '',
        interests: [],
        conversationStyle: '',
        avatar: { path: avatarPath, sha256: sha, mime: 'image/png', sizeBytes: png.length },
        source: 'remote-profile',
        verifiedAt: now,
      }],
      clues: [],
    });
    const projection = await readContactProjection(dir);
    assert.equal(projection.profiles[0].avatar, null, 'the contact projection keeps its 512 KiB avatar cap');
  } finally {
    bridge.dispose();
  }
});

test('explicit refresh sorts by modifiedAt, skips a page of verified posts and keeps exact path+SHA versions', async () => {
  const dir = await tempDir();
  const peer = PEER_A;
  const rows = [];
  const bodies = new Map();
  const entries = [];
  for (let index = 0; index < 13; index += 1) {
    const filePath = `posts/old-${String(index).padStart(2, '0')}.json`;
    const row = await seedDiscovery(dir, peer, filePath, post(peer, `已收录旧帖 ${index}`));
    rows.push(row);
    entries.push({
      path: row.path, sha256: row.sha256, size: row.sizeBytes, modifiedUnixMs: 100 + index,
    });
  }
  const failPath = 'posts/zz-fail/post.json';
  const newPath = 'posts/zz-new/post.json';
  const v2 = (filePath, title) => ({
    ...post(peer, title), schema_version: 2, id: filePath.split('/')[1], images: [], revision: 1,
  });
  const failBody = Buffer.from(JSON.stringify(v2(failPath, '这个文件读取失败')));
  const newBody = Buffer.from(JSON.stringify(v2(newPath, '路径靠后的新帖')));
  bodies.set(newPath, newBody);
  entries.push({
    path: failPath,
    sha256: crypto.createHash('sha256').update(failBody).digest('hex'),
    size: failBody.length,
    modifiedUnixMs: 2,
  });
  entries.push({
    path: newPath,
    sha256: crypto.createHash('sha256').update(newBody).digest('hex'),
    size: newBody.length,
    modifiedUnixMs: 1,
  });
  const client = makeClient({ status: statusResponse(), rows });
  let downloadCalls = 0;
  client.listDiscoveryRefreshPeers = async () => ({
    peers: [{ peerId: peer, fromDiscovery: true, fromOutbound: false }],
    total: 1,
    truncated: false,
  });
  client.getPeerManifest = async (request) => ({
    version: 1,
    peerId: request.peerId,
    total: entries.length,
    limited: false,
    entries: entries.slice(request.offset, request.offset + request.limit).map((entry) => ({
      path: entry.path, sha256: entry.sha256, size: entry.size, modifiedUnixMs: entry.modifiedUnixMs,
    })),
  });
  client.downloadPeerFile = async (request) => {
    downloadCalls += 1;
    if (request.path === failPath) throw new Error('单节点文件获取失败');
    const bytes = bodies.get(request.path);
    if (!bytes) throw new Error('missing body');
    await write(path.join(dir, 'downloads', request.peerId, request.path), bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    rows.push({
      id: String(rows.length + 1), peerId: request.peerId, path: request.path,
      sha256: sha, sizeBytes: bytes.length, fetchedAtUnixMs: Date.now(),
      source: 'raminga_ui_refresh', sources: ['raminga_ui_refresh'],
    });
    return (async function* frames() {
      yield {
        phase: 'complete', path: request.path, sha256: sha, totalBytes: bytes.length,
        localPath: '', error: '', discoveryRecorded: true, discoveryError: '',
      };
    })();
  };
  const bridge = makeBridge(client, dir);
  const sid = 'ui-stage6-refresh-order';
  try {
    await bridge.open(sid);
    let refreshed = await bridge.refreshDiscoveries(sid, false);
    assert.equal(refreshed.refresh.imported, 1, 'the older-but-new post is reached after 13 verified posts');
    assert.equal(refreshed.items.some((item) => item.path === newPath), true);
    assert.equal(downloadCalls, 2, 'one failed file and one imported file consume only actual attempts');
    const peerResult = refreshed.refresh.peers.find((item) => item.peerId === peer);
    assert.equal(peerResult.status, 'partial', 'a later success is a distinct partial result, not a failed node');
    assert.match(peerResult.error, /单节点文件获取失败/);
    assert.equal(refreshed.refresh.failed, 0);
    assert.equal(refreshed.refresh.partial, 1);

    // Same path and a newer version: both index rows stay, and the exact
    // path+SHA+size identity means the next refresh does not download again.
    const changedBody = Buffer.from(JSON.stringify(v2(newPath, '同路径的新版本')));
    bodies.set(newPath, changedBody);
    const failedIndex = entries.findIndex((entry) => entry.path === failPath);
    entries.splice(failedIndex, 1);
    const changedSha = crypto.createHash('sha256').update(changedBody).digest('hex');
    const changedEntry = entries.find((entry) => entry.path === newPath);
    changedEntry.sha256 = changedSha;
    changedEntry.size = changedBody.length;
    changedEntry.modifiedUnixMs = 300;
    refreshed = await bridge.refreshDiscoveries(sid, false);
    assert.equal(refreshed.refresh.imported, 1);
    assert.equal(downloadCalls, 3);
    const versions = rows.filter((row) => row.path === newPath);
    assert.equal(versions.length, 2, 'the index keeps both same-path versions');
    // Newest index row first, so a path-keyed map would incorrectly choose the
    // older SHA and re-download; exact path+SHA must skip both known versions.
    versions.sort((left, right) => right.fetchedAtUnixMs - left.fetchedAtUnixMs);
    const firstVersionIndex = rows.findIndex((row) => row.path === newPath);
    rows.splice(firstVersionIndex, versions.length, ...versions);
    const downloadsBeforeRepeat = downloadCalls;
    refreshed = await bridge.refreshDiscoveries(sid, false);
    assert.equal(downloadCalls, downloadsBeforeRepeat, 'both known same-path versions are skipped');
    assert.equal(refreshed.refresh.imported, 0);
    assert.equal(refreshed.refresh.skipped >= 1, true);
  } finally {
    bridge.dispose();
  }
});

test('explicit refresh checks only local candidates, skips verified versions and continues after partial failures', async () => {
  const dir = await tempDir();
  const peer = PEER_A;
  const other = PEER_B;
  const rows = [];
  const bodies = new Map();
  const entries = [];
  const manifestTruncated = { value: false };
  const candidateTruncated = { value: false };
  let downloadCalls = 0;
  let forcedRace = null;
  let failManifestFor = '';

  function v2Post(filePath, title) {
    return {
      ...post(peer, title),
      schema_version: 2,
      id: filePath.split('/')[1],
      images: [],
      revision: 1,
    };
  }
  function addPost(filePath, title) {
    const bytes = Buffer.from(JSON.stringify(v2Post(filePath, title)));
    bodies.set(filePath, bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    entries.push({ path: filePath, sha256: sha, size: bytes.length, modifiedUnixMs: 1 });
  }
  addPost('posts/new/post.json', '刷新发现的新动态');

  const client = makeClient({ status: statusResponse(), rows });
  client.listDiscoveryRefreshPeers = async () => ({
    peers: [
      { peerId: peer, fromDiscovery: true, fromOutbound: true },
      { peerId: other, fromDiscovery: false, fromOutbound: true },
    ],
    total: 5,
    truncated: candidateTruncated.value,
  });
  client.getPeerManifest = async (request) => {
    if (request.peerId === failManifestFor) throw new Error('peer offline');
    if (request.peerId !== peer) return { version: 1, peerId: request.peerId, total: 0, limited: false, entries: [] };
    const page = entries.slice(request.offset, request.offset + request.limit).map((entry) => ({
      path: entry.path, sha256: entry.sha256, size: entry.size, modifiedUnixMs: entry.modifiedUnixMs,
    }));
    return { version: 1, peerId: request.peerId, total: entries.length, limited: manifestTruncated.value, entries: page };
  };
  client.downloadPeerFile = async (request) => {
    downloadCalls += 1;
    const forced = forcedRace !== null && forcedRace.path === request.path ? forcedRace : null;
    if (forced !== null) forcedRace = null;
    const bytes = forced?.bytes ?? bodies.get(request.path);
    if (!bytes) throw new Error('missing body');
    await write(path.join(dir, 'downloads', request.peerId, request.path), bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    rows.push({
      id: String(rows.length + 1), peerId: request.peerId, path: request.path,
      sha256: sha, sizeBytes: bytes.length, fetchedAtUnixMs: Date.now(),
      source: 'raminga_ui_refresh', sources: ['raminga_ui_refresh'],
    });
    return (async function* frames() {
      yield {
        phase: 'complete', path: request.path, sha256: sha, totalBytes: bytes.length,
        localPath: '', error: '', discoveryRecorded: true, discoveryError: '',
      };
    })();
  };
  const bridge = makeBridge(client, dir);
  const sid = 'ui-stage6-manual-refresh';
  try {
    await bridge.open(sid);
    let initial = await bridge.discoveries(sid, false, true);
    assert.equal(initial.items.length, 0);

    let refreshed = await bridge.refreshDiscoveries(sid, false);
    assert.equal(refreshed.refresh.imported, 1);
    assert.equal(refreshed.refresh.checkedPeers, 2);
    assert.equal(refreshed.refresh.failed, 0);
    assert.equal(refreshed.refresh.notCovered, 3, 'candidate list truncation is disclosed');
    assert.equal(refreshed.refresh.truncated, true);
    assert.equal(refreshed.items.length, 1);
    assert.equal(refreshed.items[0].path, 'posts/new/post.json');
    assert.equal(refreshed.items[0].source, 'raminga_ui_refresh');
    assert.equal(downloadCalls, 1);

    // The same verified Peer+path+SHA is skipped, including its local copy check.
    refreshed = await bridge.refreshDiscoveries(sid, false);
    assert.equal(refreshed.refresh.imported, 0);
    assert.equal(refreshed.refresh.skipped, 1);
    assert.equal(downloadCalls, 1);

    // A same-path version change is a new version and is fetched.
    const changedBody = Buffer.from(JSON.stringify(v2Post('posts/new/post.json', '同路径的新版本')));
    bodies.set('posts/new/post.json', changedBody);
    entries[0] = {
      path: 'posts/new/post.json',
      sha256: crypto.createHash('sha256').update(changedBody).digest('hex'),
      size: changedBody.length,
      modifiedUnixMs: 2,
    };
    refreshed = await bridge.refreshDiscoveries(sid, false);
    assert.equal(refreshed.refresh.imported, 1);
    assert.equal(downloadCalls, 2);
    assert.equal(refreshed.items.some((item) => item.title === '同路径的新版本'), true);

    // Manifest/response race: the daemon fetched a newer valid version than the
    // manifest page used for this decision. It is still verified and disclosed.
    addPost('posts/race/post.json', '竞态里的旧清单项');
    const raceBody = Buffer.from(JSON.stringify(v2Post('posts/race/post.json', '竞态后的新字节')));
    forcedRace = { path: 'posts/race/post.json', bytes: raceBody };
    refreshed = await bridge.refreshDiscoveries(sid, false);
    const race = refreshed.refresh.peers.find((item) => item.peerId === peer);
    assert.equal(race.manifestChanged, true);
    assert.equal(refreshed.refresh.imported >= 1, true);
    assert.equal(refreshed.items.some((item) => item.title === '竞态后的新字节'), true);

    // One peer failing its manifest must not stop another online peer.
    addPost('posts/after-failure/post.json', '失败后仍然前进');
    failManifestFor = other;
    refreshed = await bridge.refreshDiscoveries(sid, false);
    assert.equal(refreshed.refresh.failed, 1);
    assert.equal(refreshed.refresh.checkedPeers, 2);
    assert.equal(refreshed.refresh.imported >= 1, true);
    assert.equal(refreshed.items.some((item) => item.title === '失败后仍然前进'), true);
    assert.equal(refreshed.items.some((item) => item.title === '同路径的新版本'), true, 'old items survive a partial failure');
    failManifestFor = '';

    // Two concurrent explicit clicks share one bounded remote run.
    addPost('posts/coalesced/post.json', '连续点击只检查一次');
    const [first, second] = await Promise.all([
      bridge.refreshDiscoveries(sid, false),
      bridge.refreshDiscoveries(sid, false),
    ]);
    assert.equal(first.refresh.imported >= 1, true);
    assert.equal(second.refresh.coalesced, true, 'the second overlapping request is marked as coalesced');
    const coalescedDownloads = downloadCalls;
    await bridge.refreshDiscoveries(sid, false);
    assert.equal(downloadCalls, coalescedDownloads, 'the new post was already recorded and is skipped next time');

    // Fetched bytes that are not a valid versioned post are recorded as
    // invalid content, not shown, and not counted as a successful import.
    const invalidPath = 'posts/invalid/post.json';
    const invalidBytes = Buffer.from('{not-json');
    bodies.set(invalidPath, invalidBytes);
    entries.push({
      path: invalidPath,
      sha256: crypto.createHash('sha256').update(invalidBytes).digest('hex'),
      size: invalidBytes.length,
      modifiedUnixMs: 3,
    });
    refreshed = await bridge.refreshDiscoveries(sid, false);
    assert.equal(refreshed.refresh.invalid >= 1, true);
    assert.equal(refreshed.refresh.failed, 0, 'invalid content is not a peer/network failure');
    assert.equal(refreshed.items.some((item) => item.path === invalidPath), false, 'invalid content is never displayed');

    // An older daemon reports Unimplemented. Existing local content stays and
    // the summary explains that only a local re-read happened.
    const unsupported = makeClient({ status: statusResponse(), rows });
    unsupported.listDiscoveryRefreshPeers = async () => { throw new Error('unimplemented method'); };
    const unsupportedBridge = makeBridge(unsupported, dir);
    try {
      await unsupportedBridge.open('ui-stage6-manual-unsupported');
      const retained = await unsupportedBridge.refreshDiscoveries('ui-stage6-manual-unsupported', false);
      assert.equal(retained.refresh.unsupported, true);
      assert.match(retained.refresh.error, /不支持远端动态检查/);
      assert.equal(retained.items.length > 0, true, 'local content survives an unsupported remote refresh');
    } finally {
      unsupportedBridge.dispose();
    }
  } finally {
    bridge.dispose();
  }
});


test('Feed public time comes only from an observed matching manifest version, never the local copy mtime', async () => {
  const dir = await tempDir();
  const peer = PEER_A;
  const row = await seedDiscovery(dir, peer, 'posts/time.json', post(peer, '带远端时间'));
  row.fetchedAtUnixMs = 1000;
  const localMtime = new Date('2020-01-02T03:04:05Z');
  await fs.utimes(path.join(dir, 'downloads', peer, row.path), localMtime, localMtime);
  const remoteModified = Date.parse('2026-11-21T10:20:30Z');
  const entries = [{ path: row.path, sha256: row.sha256, size: row.sizeBytes, modifiedUnixMs: remoteModified }];
  const client = makeClient({ rows: [row], relations: [{ cursor: '', peers: [{ peerId: peer }], hasMore: false }] });
  client.getPeerManifest = async (request) => ({
    version: 1, peerId: request.peerId, total: entries.length, limited: false,
    entries: entries.slice(request.offset, request.offset + request.limit),
  });
  const bridge = makeBridge(client, dir);
  const sid = 'ui-stage6-manifest-time';
  try {
    await bridge.open(sid);
    const beforeManifest = await bridge.discoveries(sid, false, true);
    assert.equal(beforeManifest.items.length, 1);
    assert.equal(beforeManifest.items[0].modifiedAt, 0, 'an offline copy alone has no public original time');
    await bridge.peerManifest(sid, peer, true);
    const afterManifest = await bridge.discoveries(sid, false, true);
    assert.equal(afterManifest.items[0].modifiedAt, remoteModified, 'the exact matching manifest observation supplies the time');
    assert.notEqual(afterManifest.items[0].modifiedAt, localMtime.getTime(), 'local download mtime is never conflated with public time');
  } finally {
    bridge.dispose();
  }

  // A new panel session has only the copy and evidence rows; public time must
  // be absent again until a manifest is actually observed.
  const fresh = makeBridge(makeClient({ rows: [row], relations: [{ cursor: '', peers: [{ peerId: peer }], hasMore: false }] }), dir);
  try {
    await fresh.open('ui-stage6-manifest-time-restart');
    const restarted = await fresh.discoveries('ui-stage6-manifest-time-restart', false, true);
    assert.equal(restarted.items[0].modifiedAt, 0, 'time stays absent across a bridge restart without a manifest');
  } finally {
    fresh.dispose();
  }

  // The explicit refresh observes the manifest even when the verified local
  // version is skipped, so the card gains the same exact public time.
  const refreshClient = makeClient({ rows: [row], relations: [{ cursor: '', peers: [{ peerId: peer }], hasMore: false }] });
  refreshClient.listDiscoveryRefreshPeers = async () => ({
    peers: [{ peerId: peer, fromDiscovery: true, fromOutbound: false }], total: 1, truncated: false, hasMore: false, nextAfter: '',
  });
  refreshClient.getPeerManifest = async (request) => ({
    version: 1, peerId: request.peerId, total: entries.length, limited: false,
    entries: entries.slice(request.offset, request.offset + request.limit),
  });
  const refreshBridge = makeBridge(refreshClient, dir);
  const refreshSid = 'ui-stage6-manifest-time-refresh';
  try {
    await refreshBridge.open(refreshSid);
    const refreshed = await refreshBridge.refreshDiscoveries(refreshSid, false);
    assert.equal(refreshed.refresh.skipped, 1);
    assert.equal(refreshed.items[0].modifiedAt, remoteModified);
  } finally {
    refreshBridge.dispose();
  }
});

test('same peer/path versions collapse to one readable card and keep honest newest diagnostics', async () => {
  const dir = await tempDir();
  const peer = PEER_A;
  const relative = 'posts/revised/post.json';
  const oldBody = Buffer.from(JSON.stringify({ ...post(peer, '旧版本'), schema_version: 2, id: 'revised', images: [], revision: 1 }));
  const oldRow = await seedDiscovery(dir, peer, relative, { ...post(peer, '旧版本'), schema_version: 2, id: 'revised', images: [], revision: 1 });
  oldRow.id = 'rev-1';
  oldRow.fetchedAtUnixMs = 1000;
  const newBody = Buffer.from(JSON.stringify({ ...post(peer, '新版本'), schema_version: 2, id: 'revised', images: [], revision: 2 }));
  await write(path.join(dir, 'downloads', peer, relative), newBody);
  const newRow = {
    ...oldRow,
    id: 'rev-2',
    sha256: crypto.createHash('sha256').update(newBody).digest('hex'),
    sizeBytes: newBody.length,
    fetchedAtUnixMs: 2000,
  };
  const client = makeClient({
    rows: [oldRow, newRow],
    relations: [{ cursor: '', peers: [{ peerId: peer }], hasMore: false }],
  });
  const bridge = makeBridge(client, dir);
  const sid = 'ui-stage6-revision-collapse';
  try {
    await bridge.open(sid);
    for (const familiar of [false, true]) {
      const page = await bridge.discoveries(sid, familiar, true);
      const cards = page.items.filter((item) => item.path === relative);
      assert.equal(cards.length, 1, `one card per same peer/path (${familiar ? 'familiar' : 'all'})`);
      assert.equal(cards[0].id, 'rev-2');
      assert.equal(cards[0].title, '新版本');
      assert.equal(cards[0].contentState, 'available');
    }

    // Older evidence bytes on disk must still win over a newer corrupt row.
    await write(path.join(dir, 'downloads', peer, relative), oldBody);
    const olderUsable = await bridge.discoveries(sid, false, true);
    assert.equal(olderUsable.items.length, 1);
    assert.equal(olderUsable.items[0].id, 'rev-1', 'newer broken evidence cannot hide a usable card');
    assert.equal(olderUsable.items[0].title, '旧版本');
    assert.equal(olderUsable.items[0].contentState, 'available');

    // Missing latest copy: one card with the newest version's explicit state
    // instead of several generic broken cards.
    await fs.rm(path.join(dir, 'downloads', peer, relative));
    const missing = await bridge.discoveries(sid, false, true);
    assert.equal(missing.items.length, 1);
    assert.equal(missing.items[0].id, 'rev-2');
    assert.equal(missing.items[0].contentState, 'copy-missing');
    assert.equal(missing.items[0].title, 'post', 'no title is invented for a version whose bytes are gone');
  } finally {
    bridge.dispose();
  }
});

test('repeated bounded refresh advances through the complete candidate set beyond the first page', async () => {
  const dir = await tempDir();
  const peers = [];
  for (let index = 0; index < 9; index += 1) {
    peers.push(peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString());
  }
  const client = makeClient({ rows: [] });
  const pageSize = 3;
  const requests = [];
  client.listDiscoveryRefreshPeers = async (request) => {
    requests.push({ after: request.after, limit: request.limit });
    const after = String(request.after ?? '');
    const start = after === '' ? 0 : peers.indexOf(after) + 1;
    const page = peers.slice(start, start + pageSize);
    const hasMore = start + page.length < peers.length;
    return {
      peers: page.map((peerId) => ({ peerId, fromDiscovery: true, fromOutbound: false })),
      total: peers.length,
      truncated: hasMore,
      hasMore,
      nextAfter: hasMore ? page[page.length - 1] : '',
    };
  };
  const checked = [];
  const bridge = makeBridge(client, dir);
  const sid = 'ui-stage6-refresh-fairness';
  try {
    await bridge.open(sid);
    let page = await bridge.refreshDiscoveries(sid, false);
    checked.push(...page.refresh.peers.map((peer) => peer.peerId));
    assert.equal(requests[0].after, '');
    assert.equal(page.refresh.checkedPeers, 3, 'the first server page is bounded');
    assert.equal(page.refresh.notCovered, 6, 'remaining candidates are disclosed');

    page = await bridge.refreshDiscoveries(sid, false);
    checked.push(...page.refresh.peers.map((peer) => peer.peerId));
    assert.equal(requests[1].after, peers[2], 'the repeat refresh resumes after the last checked candidate');
    assert.equal(page.refresh.checkedPeers, 3);

    page = await bridge.refreshDiscoveries(sid, false);
    checked.push(...page.refresh.peers.map((peer) => peer.peerId));
    assert.equal(requests[2].after, peers[5]);
    assert.deepEqual(new Set(checked), new Set(peers), 'all eligible peers are reachable across repeats');
    assert.equal(page.refresh.notCovered, 6);
    const lastPeer = page.refresh.peers[page.refresh.peers.length - 1];
    assert.equal(typeof lastPeer.peerName, 'string', 'every per-node result carries a display-name field');
  } finally {
    bridge.dispose();
  }
});

test('a timed-out refresh resumes with peers it did not attempt before advancing the cursor', async () => {
  const dir = await tempDir();
  const followingPeer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
  const client = makeClient();
  const requests = [];
  let now = 100_000;
  let consumeBudget = true;
  client.listDiscoveryRefreshPeers = async (request) => {
    requests.push(request.after);
    const ids = request.after === 'following' ? [followingPeer] : [PEER_A, PEER_B, PEER_C];
    return {
      peers: ids.map((peerId) => ({ peerId })),
      total: 4,
      truncated: true,
      hasMore: request.after === '',
      nextAfter: request.after === '' ? 'following' : '',
    };
  };
  client.getPeerManifest = async () => {
    if (consumeBudget) {
      consumeBudget = false;
      now += 26_000;
    }
    return { entries: [], total: 0 };
  };
  const bridge = new RamingaUiBridge(
    { async ensure() { return client; }, async call(fn) { return fn(client); } },
    { dataDir: dir, now: () => now },
  );
  const session = 'refresh-resumes-after-timeout';
  try {
    await bridge.open(session);
    const first = await bridge.refreshDiscoveries(session);
    assert.equal(first.refresh.checkedPeers, 2);
    assert.equal(first.refresh.peers.find((peer) => peer.peerId === PEER_C)?.status, 'not-covered');
    const second = await bridge.refreshDiscoveries(session);
    assert.deepEqual(second.refresh.peers.map((peer) => peer.peerId), [PEER_C]);
    assert.equal(second.refresh.checkedPeers, 1);
    assert.deepEqual(requests, [''], 'the next click checks the remainder of the same page');
    const third = await bridge.refreshDiscoveries(session);
    assert.deepEqual(third.refresh.peers.map((peer) => peer.peerId), [followingPeer]);
    assert.deepEqual(requests, ['', 'following']);
  } finally {
    bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
