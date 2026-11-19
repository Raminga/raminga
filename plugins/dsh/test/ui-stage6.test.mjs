// Stage-6 host bridge tests: discovery evidence, relation snapshots, controlled
// local reads, profile separation and clipped Journey references.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RamingaUiBridge } from '../lib/ui-bridge.js';

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
