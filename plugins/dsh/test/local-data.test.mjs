// Security and schema tests for the DSH host's controlled local reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
  MAX_CONTACT_NOTES_BYTES,
  MAX_CONTACT_PROJECTION_BYTES,
  MAX_POST_BYTES,
  MAX_PRIVATE_SAVE_BYTES,
  readContactNotes,
  readContactProjection,
  readDiscoveryPost,
  readDownloadedAgentCard,
  readJourney,
  readOwnAgentCard,
  readOwnPosts,
  readOwnPublic,
  parsePublicProfile,
  saveContactImpression,
  savePrivateAgentFile,
  writeContactProjection,
  privateSaveTestHooks,
} from '../lib/local-data.js';

const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'raminga-local-data-'));
}

let generatedPeerIds;
async function manyPeerIds(count) {
  if (generatedPeerIds === undefined || generatedPeerIds.length < count) {
    generatedPeerIds = [];
    for (let index = 0; index < count; index += 1) {
      const key = await generateKeyPair('Ed25519');
      generatedPeerIds.push(peerIdFromPrivateKey(key).toString());
    }
  }
  return generatedPeerIds;
}

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.isBuffer(value) || value instanceof Uint8Array ? value : typeof value === 'string' ? value : JSON.stringify(value));
}

function post(overrides = {}) {
  return {
    schema_version: 1,
    title: '受控公开帖子',
    format: 'markdown',
    author: { peer_id: PEER_A, kind: 'user', display_name: 'Alice' },
    published_at: '2026-11-14T10:00:00Z',
    tags: ['test', 'public'],
    body: '# 标题\n\n这是**公开**正文。',
    ...overrides,
  };
}

async function discoveryFixture(dir, { peer = PEER_A, body = post(), relative = 'posts/a.json' } = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  const file = path.join(dir, 'downloads', peer, relative);
  await write(file, bytes);
  return {
    peerId: peer,
    path: relative,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

test('reads a versioned public post only from the verified downloaded copy', async () => {
  const dir = await tempDir();
  const meta = await discoveryFixture(dir);
  const parsed = await readDiscoveryPost(dir, meta);
  assert.equal(parsed.title, '受控公开帖子');
  assert.equal(parsed.authorPeerId, PEER_A);
  assert.match(parsed.bodyMarkdown, /公开/);

  const changed = Buffer.from('{}');
  await fs.writeFile(path.join(dir, 'downloads', PEER_A, 'posts/a.json'), changed);
  await assert.rejects(() => readDiscoveryPost(dir, { ...meta, sizeBytes: changed.length }), /哈希/);
});

test('rejects traversal, absolute paths, symlinks and oversized downloaded content', async () => {
  const dir = await tempDir();
  const meta = await discoveryFixture(dir);
  for (const bad of ['../secret.json', '/etc/passwd', 'posts/../secret.json', 'posts\\a.json']) {
    await assert.rejects(() => readDiscoveryPost(dir, { ...meta, path: bad }), /路径|公开帖子/);
  }

  const outside = path.join(dir, 'outside.json');
  await write(outside, post());
  const link = path.join(dir, 'downloads', PEER_A, 'posts', 'link.json');
  await fs.symlink(outside, link);
  await assert.rejects(
    () => readDiscoveryPost(dir, { ...meta, path: 'posts/link.json' }),
    /符号链接|越过/,
  );

  const huge = Buffer.alloc(200 * 1024, 0x20);
  const hugeFile = path.join(dir, 'downloads', PEER_A, 'posts', 'huge.json');
  await fs.writeFile(hugeFile, huge);
  await assert.rejects(
    () => readDiscoveryPost(dir, {
      peerId: PEER_A,
      path: 'posts/huge.json',
      sha256: crypto.createHash('sha256').update(huge).digest('hex'),
      sizeBytes: huge.length,
    }),
    /超过/,
  );
});

test('bounded reads stop at maxBytes+1 when a file grows during the read', async () => {
  const dir = await tempDir();
  const meta = await discoveryFixture(dir);
  const target = path.join(dir, 'downloads', PEER_A, 'posts', 'a.json');
  const originalOpen = fs.open;
  let grew = false;
  let readCalls = 0;
  let readFileCalls = 0;
  let totalRead = 0;
  const grow = async () => {
    if (grew) return;
    grew = true;
    const append = await originalOpen(target, 'a');
    try {
      await append.write(Buffer.alloc(MAX_POST_BYTES * 2, 0x20));
    } finally {
      await append.close();
    }
  };
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    const originalReadFile = handle.readFile.bind(handle);
    handle.read = async (...readArgs) => {
      await grow();
      const result = await originalRead(...readArgs);
      readCalls += 1;
      totalRead += result.bytesRead;
      return result;
    };
    handle.readFile = async (...readArgs) => {
      readFileCalls += 1;
      await grow();
      return originalReadFile(...readArgs);
    };
    return handle;
  };
  try {
    await assert.rejects(() => readDiscoveryPost(dir, meta), /超过/);
    assert.equal(grew, true);
    assert.equal(readFileCalls, 0, 'must not call an unbounded readFile');
    assert.ok(readCalls > 0, 'the bounded read path must be used');
    assert.ok(totalRead > MAX_POST_BYTES, 'the concurrent growth crossed the limit');
    assert.ok(
      totalRead <= MAX_POST_BYTES + 1,
      `read ${totalRead} bytes; a bounded read must stop at ${MAX_POST_BYTES + 1}`,
    );
  } finally {
    fs.open = originalOpen;
  }
});

test('rejects a public/download root symlink instead of following it', async () => {
  const dir = await tempDir();
  const outside = await tempDir();
  await write(path.join(outside, 'posts', 'a.json'), post());
  await fs.mkdir(path.join(dir, 'downloads'), { recursive: true });
  await fs.symlink(outside, path.join(dir, 'public'));
  const own = await readOwnPosts(dir, PEER_A);
  assert.equal(own.state, 'error');
  assert.match(own.error, /符号链接/);

  const downloads = path.join(dir, 'downloads');
  await fs.rm(downloads, { recursive: true, force: true });
  await fs.symlink(outside, downloads);
  await assert.rejects(
    () => readDiscoveryPost(dir, {
      peerId: PEER_A, path: 'posts/a.json',
      sha256: crypto.createHash('sha256').update(Buffer.from(JSON.stringify(post()))).digest('hex'),
      sizeBytes: Buffer.byteLength(JSON.stringify(post())),
    }),
    /符号链接|不存在/,
  );
});

test('rejects spoofed author mappings and template placeholders', async () => {
  const dir = await tempDir();
  const spoofed = await discoveryFixture(dir, {
    body: post({ author: { peer_id: PEER_B, kind: 'user', display_name: 'Mallory' } }),
  });
  await assert.rejects(() => readDiscoveryPost(dir, spoofed), /作者声明/);

  const placeholder = await discoveryFixture(dir, {
    relative: 'posts/placeholder.json',
    body: post({ title: 'replace-with-title' }),
  });
  await assert.rejects(() => readDiscoveryPost(dir, placeholder), /占位/);
});

test('mine only includes explicit user-authored posts and discloses other files', async () => {
  const dir = await tempDir();
  await write(path.join(dir, 'public', 'profile', 'index.md'), '# Alice\n\n公开资料。');
  await write(path.join(dir, 'public', 'posts', 'user.json'), post());
  await write(path.join(dir, 'public', 'posts', 'agent.json'), post({
    title: 'Agent 内容', author: { peer_id: PEER_A, kind: 'agent', display_name: 'Nova' },
  }));
  await write(path.join(dir, 'public', 'posts', 'other.json'), post({
    title: '他人内容', author: { peer_id: PEER_B, kind: 'user', display_name: 'Mallory' },
  }));
  await write(path.join(dir, 'public', 'posts', 'broken.json'), '{not json');
  const own = await readOwnPublic(dir, PEER_A);
  assert.equal(own.profile.state, 'available');
  assert.equal(own.profile.displayName, 'Alice');
  assert.equal(own.posts.state, 'available');
  assert.deepEqual(own.posts.posts.map((item) => item.title), ['Agent 内容', '受控公开帖子']);
  assert.equal(own.posts.agentAuthored, 1);
  assert.equal(own.posts.unattributed, 1);
  assert.equal(own.posts.invalid, 1);
  assert.equal(own.posts.posts.find((item) => item.title === '受控公开帖子').authorKind, 'user');
  assert.equal(own.posts.posts.find((item) => item.title === 'Agent 内容').authorKind, 'agent');

  const agentOnly = await readOwnPosts(dir, PEER_B);
  assert.deepEqual(agentOnly.posts.map((item) => item.title), ['他人内容']);
  assert.equal(agentOnly.unattributed, 2, 'PEER_A user and agent posts are not PEER_B authorship');
  assert.equal(agentOnly.agentAuthored, 0);
});

test('missing profile and public directory are distinct states', async () => {
  const dir = await tempDir();
  const own = await readOwnPublic(dir, PEER_A);
  assert.equal(own.profile.state, 'missing');
  assert.equal(own.posts.state, 'missing');
  assert.equal(own.posts.posts.length, 0);
});

test('public Agent card is separately parsed and placeholder content is rejected', async () => {
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
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const read = await readDownloadedAgentCard(dir, PEER_A, 'profile/agent-card.json', sha, bytes.length);
  assert.equal(read.state, 'available');
  assert.equal(read.card.displayName, 'Nova');

  const bad = Buffer.from(JSON.stringify({ ...card, display_name: 'replace-with-name' }));
  await fs.writeFile(path.join(dir, 'downloads', PEER_A, 'profile', 'agent-card.json'), bad);
  const badRead = await readDownloadedAgentCard(dir, PEER_A, 'profile/agent-card.json', '', bad.length);
  assert.equal(badRead.state, 'error');
  assert.match(badRead.error, /占位/);
});

test('profile.json v2 parses an Agent avatar and a human avatar independently', () => {
  const agentSha = 'a'.repeat(64);
  const humanSha = 'b'.repeat(64);
  const profile = parsePublicProfile(Buffer.from(JSON.stringify({
    schema_version: 2,
    agent: {
      name: 'Nova', description: 'Agent 介绍', interests: ['天文'], conversation_style: '简洁',
      avatar: `avatar-${agentSha.slice(0, 8)}.png`, avatar_sha256: agentSha, avatar_mime: 'image/png',
    },
    human: {
      name: 'JO JO', bio_markdown: '关联人类介绍。',
      avatar: `human-avatar-${humanSha.slice(0, 8)}.jpg`, avatar_sha256: humanSha, avatar_mime: 'image/jpeg',
    },
    updated_at: '2026-11-18T10:00:00Z',
  })));
  assert.equal(profile.avatarPath, `profile/avatar-${agentSha.slice(0, 8)}.png`);
  assert.equal(profile.avatarSha256, agentSha);
  assert.equal(profile.avatarMime, 'image/png');
  assert.equal(profile.humanAvatarPath, `profile/human-avatar-${humanSha.slice(0, 8)}.jpg`);
  assert.equal(profile.humanAvatarSha256, humanSha);
  assert.equal(profile.humanAvatarMime, 'image/jpeg');
});

test('old profile.json v2 without a human avatar parses unchanged', () => {
  const agentSha = 'c'.repeat(64);
  const profile = parsePublicProfile(Buffer.from(JSON.stringify({
    schema_version: 2,
    agent: {
      name: 'Nova', description: '', interests: [], conversation_style: '',
      avatar: `avatar-${agentSha.slice(0, 8)}.png`, avatar_sha256: agentSha, avatar_mime: 'image/png',
    },
    human: { name: 'Alice', bio_markdown: '旧资料。' },
    updated_at: '2026-11-18T10:00:00Z',
  })));
  assert.equal(profile.humanName, 'Alice');
  assert.equal(profile.avatarPath, `profile/avatar-${agentSha.slice(0, 8)}.png`);
  assert.equal(profile.humanAvatarPath, '');
  assert.equal(profile.humanAvatarSha256, '');
  assert.equal(profile.humanAvatarMime, '');
});

test('invalid human-avatar filenames, hashes and MIME are rejected', () => {
  const sha = 'd'.repeat(64);
  const human = {
    name: 'JO JO', bio_markdown: '',
    avatar: `human-avatar-${sha.slice(0, 8)}.png`, avatar_sha256: sha, avatar_mime: 'image/png',
  };
  const build = (value) => Buffer.from(JSON.stringify({
    schema_version: 2,
    agent: { name: 'Nova', description: '', interests: [], conversation_style: '' },
    human: value,
    updated_at: '2026-11-18T10:00:00Z',
  }));
  assert.throws(() => parsePublicProfile(build({ ...human, avatar: `avatar-${sha.slice(0, 8)}.png` })), /人类头像文件名/);
  assert.throws(() => parsePublicProfile(build({ ...human, avatar: `human-avatar-${'e'.repeat(8)}.png` })), /文件名与哈希/);
  assert.throws(() => parsePublicProfile(build({ ...human, avatar_mime: '' })), /缺少哈希或 MIME/);
  assert.throws(() => parsePublicProfile(build({ ...human, avatar_mime: 'image/jpeg' })), /扩展名与 MIME/);
  assert.throws(() => parsePublicProfile(build({ ...human, avatar: `profile/human-avatar-${sha.slice(0, 8)}.png` })), /人类头像文件名/);
});

test('Journey reads existing schemas, preserves historical message evidence and reports damage', async () => {
  const dir = await tempDir();
  await write(path.join(dir, 'agent', 'persona.md'), '# 稳定人格\n\n简洁。');
  await write(path.join(dir, 'agent', 'growth.md'), '## 提案\n\n保持好奇。');
  const session = path.join(dir, 'agent', 'sessions', 'session-1');
  await write(path.join(session, 'state.json'), {
    schema_version: 1,
    session_id: 'session-1',
    status: 'running',
    mode: 'exploration',
    intent: '读一份公开内容',
    limits: {},
    discovery_sources: ['raminga_friends'],
    current_peer_id: PEER_A,
    visited_peer_ids: [PEER_A],
    skipped_peer_ids: [],
    curiosity: [],
    started_at: '2026-11-14T10:00:00Z',
    updated_at: '2026-11-14T10:01:00Z',
    completed_at: null,
    completion_reason: null,
  });
  await write(path.join(session, 'events.jsonl'), [
    JSON.stringify({ schema_version: 1, event_id: 'e1', sequence: 1, timestamp: '2026-11-14T10:00:01Z', type: 'visit_started', peer_id: PEER_A, summary: '开始访问', evidence_refs: { message_ids: [], content_paths: ['posts/a.json'], event_ids: [] } }),
    '{bad line',
    JSON.stringify({ schema_version: 1, event_id: 'e2', sequence: 2, timestamp: '2026-11-14T10:00:02Z', type: 'message_sent', peer_id: PEER_A, summary: '发送了一条消息', evidence_refs: { message_ids: ['m1'], content_paths: [], event_ids: [] }, message_evidence: { message_id: 'm1', peer_id: PEER_A, direction: 'out', created_at_unix_ms: '1760000000000', acked: true, acked_at_unix_ms: null, content_sha256: null, summary: '历史摘要', observed_at: '2026-11-14T10:00:02Z' } }),
  ].join('\n') + '\n');
  await write(path.join(session, 'report.md'), '# Journey Report\n\n完成。');
  await write(path.join(dir, 'agent', 'sessions', 'bad-state', 'state.json'), '{bad');
  await write(path.join(dir, 'agent', 'sessions', 'bad-state', 'events.jsonl'), '');
  const journey = await readJourney(dir);
  assert.equal(journey.state, 'available');
  assert.equal(journey.persona.state, 'available');
  assert.equal(journey.sessions.length, 2);
  const good = journey.sessions.find((item) => item.id === 'session-1');
  assert.equal(good.state.status, 'running');
  assert.equal(good.events.length, 2);
  assert.equal(good.badEventLines, 1);
  assert.equal(good.events[1].messageEvidence.summary, '历史摘要');
  assert.equal(good.reportRead, 'available');
  const bad = journey.sessions.find((item) => item.id === 'bad-state');
  assert.equal(bad.stateRead, 'error');
});

test('missing Agent root is unavailable rather than an invented empty journey', async () => {
  const dir = await tempDir();
  const journey = await readJourney(dir);
  assert.equal(journey.state, 'missing');
  assert.deepEqual(journey.sessions, []);
  assert.match(journey.sessionsError, /不存在/);
});

test('Journey root that is a regular file or symlink is an error, not missing', async () => {
  const dir = await tempDir();
  await write(path.join(dir, 'agent'), 'not a directory');
  const fileRoot = await readJourney(dir);
  assert.equal(fileRoot.state, 'error');
  assert.match(fileRoot.sessionsError, /不是目录/);
  assert.deepEqual(fileRoot.sessions, []);

  await fs.rm(path.join(dir, 'agent'));
  const outside = await tempDir();
  await write(path.join(outside, 'persona.md'), '# outside');
  await fs.symlink(outside, path.join(dir, 'agent'));
  const linked = await readJourney(dir);
  assert.equal(linked.state, 'error');
  assert.match(linked.sessionsError, /符号链接/);
  assert.deepEqual(linked.sessions, []);
});

test('Journey classifies an unusable data directory as an error', async () => {
  const base = await tempDir();
  const dataFile = path.join(base, 'data-file');
  await fs.writeFile(dataFile, 'not a directory');
  const journey = await readJourney(dataFile);
  assert.equal(journey.state, 'error');
  assert.match(journey.sessionsError, /数据目录不是目录/);

  const nonDirectoryParent = await readJourney(path.join(dataFile, 'nested-data'));
  assert.equal(nonDirectoryParent.state, 'error');
  assert.match(nonDirectoryParent.sessionsError, /不是目录/);
  assert.doesNotMatch(nonDirectoryParent.sessionsError, /不存在/);

  const absent = await readJourney(path.join(base, 'absent'));
  assert.equal(absent.state, 'missing');
  assert.match(absent.sessionsError, /不存在/);
});

test('Journey reports a permission failure instead of missing', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root bypasses directory permissions');
    return;
  }
  const dir = await tempDir();
  await write(path.join(dir, 'agent', 'persona.md'), '# permission probe');
  const agent = path.join(dir, 'agent');
  await fs.chmod(agent, 0o000);
  try {
    const journey = await readJourney(dir);
    assert.equal(journey.state, 'error');
    assert.match(journey.sessionsError, /权限|无法读取|不能读取/);
    assert.doesNotMatch(journey.sessionsError, /不存在/);
  } finally {
    await fs.chmod(agent, 0o700);
  }
});

test('Journey rejects a session directory symlink instead of following it', async () => {
  const dir = await tempDir();
  await write(path.join(dir, 'agent', 'persona.md'), '# x');
  const outside = path.join(dir, 'outside-session');
  await write(path.join(outside, 'state.json'), {
    schema_version: 1, status: 'completed', mode: 'x', intent: 'outside',
    started_at: '2026-11-14T10:00:00Z', updated_at: '2026-11-14T10:00:00Z',
  });
  await fs.mkdir(path.join(dir, 'agent', 'sessions'), { recursive: true });
  await fs.symlink(outside, path.join(dir, 'agent', 'sessions', 'escape'));
  const journey = await readJourney(dir);
  assert.equal(journey.sessions.length, 0);
  assert.equal(journey.sessionsState, 'missing');
});


test('private Agent saves are local-only, atomic, backed up and conflict checked', async () => {
  const dir = await tempDir();
  const result = await savePrivateAgentFile(dir, 'persona', '# 人格\n\n只在本机。', '');
  assert.equal(result.saved, true);
  assert.equal(result.field, 'persona');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.backupName, '');
  const target = path.join(dir, 'agent', 'persona.md');
  assert.equal(await fs.readFile(target, 'utf8'), '# 人格\n\n只在本机。');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(dir, 'agent'))).mode & 0o777, 0o700);
  await assert.rejects(fs.stat(path.join(dir, 'public')), /ENOENT/, 'private save never creates public/');

  const sha = result.sha256;
  const second = await savePrivateAgentFile(dir, 'persona', '# 人格\n\n第二版。', sha);
  assert.equal(second.saved, true);
  assert.ok(second.backupName.startsWith('persona.md.bak-'));
  assert.equal((await fs.stat(path.join(dir, 'agent', second.backupName))).mode & 0o777, 0o600);
  assert.match(await fs.readFile(path.join(dir, 'agent', second.backupName), 'utf8'), /只在本机/);

  await assert.rejects(
    savePrivateAgentFile(dir, 'persona', '# 冲突', sha),
    /已在别处修改/,
    'stale SHA-256 must not overwrite the newer file',
  );
  assert.match(await fs.readFile(target, 'utf8'), /第二版/);
  await assert.rejects(savePrivateAgentFile(dir, 'persona', '# 太大', 'x'.repeat(64)), /格式无效/);
  await assert.rejects(savePrivateAgentFile(dir, 'persona', 'x'.repeat(MAX_PRIVATE_SAVE_BYTES + 1), second.sha256), /超过/);
  assert.match(await fs.readFile(target, 'utf8'), /第二版/);
});

test('private Agent save rechecks the original hash immediately before commit', async () => {
  const dir = await tempDir();
  const first = await savePrivateAgentFile(dir, 'persona', '# 第一版\n', '');
  const target = path.join(dir, 'agent', 'persona.md');
  const external = '# 外部编辑\n';
  privateSaveTestHooks.beforeCommit = async () => {
    await fs.writeFile(target, external, { mode: 0o600 });
  };
  try {
    await assert.rejects(
      savePrivateAgentFile(dir, 'persona', '# 本地第二版\n', first.sha256),
      /准备写入期间/,
      'an edit between the first hash check and commit must not be overwritten',
    );
  } finally {
    privateSaveTestHooks.beforeCommit = null;
  }
  assert.equal(await fs.readFile(target, 'utf8'), external);
  const leftovers = (await fs.readdir(path.join(dir, 'agent'))).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'failed save leaves no temporary file');
});

test('private Agent saves reject symlinks and unknown fields', async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'agent'), { recursive: true, mode: 0o700 });
  const outside = path.join(dir, 'outside.md');
  await fs.writeFile(outside, '# outside');
  await fs.symlink(outside, path.join(dir, 'agent', 'growth.md'));
  await assert.rejects(savePrivateAgentFile(dir, 'growth', '# no', ''), /符号链接/);
  assert.equal(await fs.readFile(outside, 'utf8'), '# outside');
  await assert.rejects(savePrivateAgentFile(dir, 'other', 'x', ''), /只允许保存/);
});

test('own public Agent card is optional and never fabricated', async () => {
  const dir = await tempDir();
  const missing = await readOwnAgentCard(dir, PEER_A);
  assert.equal(missing.state, 'missing');
  assert.equal(missing.card, null);
  await write(path.join(dir, 'public', 'profile', 'agent-card.json'), {
    schema_version: 1,
    display_name: 'Nova',
    description: '公开介绍',
    interests: ['地图'],
    conversation_style: '简短',
    updated_at: '2026-11-14T10:00:00Z',
  });
  const available = await readOwnAgentCard(dir, PEER_A);
  assert.equal(available.state, 'available');
  assert.equal(available.card.displayName, 'Nova');
  assert.equal(available.card.path, 'profile/agent-card.json');
  assert.match(available.card.sha256, /^[a-f0-9]{64}$/);
});


function contactNotesV2(overrides = {}) {
  return {
    schema_version: 2,
    unknown_top: { keep: true },
    contacts: [{
      peer_id: PEER_A,
      display_name_snapshot: 'Alice',
      updated_at: '2026-11-18T10:00:00Z',
      unknown_contact: 'keep-contact',
      observations: [{
        id: 'obs-1', summary: '读过公开散步记录。', observed_at: '2026-11-18T09:50:00Z',
        unknown_observation: 'keep-observation',
        evidence_refs: {
          session_ids: ['s1'], event_ids: ['evt-1'], message_ids: [],
          content_paths: ['posts/p1/post.json'],
          content_sha256: ['a'.repeat(64)],
        },
      }],
      impressions: [{
        id: 'imp-1', summary: '表达克制。', uncertainty: 'medium',
        created_at: '2026-11-18T09:55:00Z', updated_at: '2026-11-18T09:55:00Z',
        unknown_impression: 'keep-impression',
        evidence_refs: { session_ids: ['s1'], event_ids: ['evt-2'], message_ids: [], content_paths: [], content_sha256: [] },
      }],
      curiosities: [{
        id: 'cur-1', question: '下次问问城市声音。', created_at: '2026-11-18T09:56:00Z',
        unknown_curiosity: 'keep-curiosity',
        evidence_refs: { session_ids: ['s1'], event_ids: [], message_ids: [], content_paths: [], content_sha256: [] },
      }],
    }],
    ...overrides,
  };
}

test('contact-notes reads v2, keeps v1 empty read-only and never invents missing data', async () => {
  const dir = await tempDir();
  const missing = await readContactNotes(dir);
  assert.equal(missing.state, 'missing');
  assert.deepEqual(missing.contacts, []);

  const v1 = path.join(dir, 'agent', 'contact-notes.json');
  await write(v1, '{"schema_version":1,"contacts":[]}\n');
  const legacy = await readContactNotes(dir);
  assert.equal(legacy.state, 'available');
  assert.equal(legacy.schemaVersion, 1);
  assert.deepEqual(legacy.contacts, []);
  await assert.rejects(() => saveContactImpression(dir, {
    peerId: PEER_A, impressionId: '', summary: '不能自动改写', uncertainty: 'low', expectedSha256: legacy.sha256,
  }), /只读/);

  const v2 = contactNotesV2();
  const body = JSON.stringify(v2);
  await write(v1, body);
  const notes = await readContactNotes(dir);
  assert.equal(notes.state, 'available');
  assert.equal(notes.schemaVersion, 2);
  assert.equal(notes.contacts[0].impressions[0].summary, '表达克制。');
  assert.match(notes.sha256, /^[a-f0-9]{64}$/);

  await write(v1, '{not json');
  assert.equal((await readContactNotes(dir)).state, 'error');
  await write(v1, JSON.stringify({ schema_version: 99, contacts: [] }));
  assert.equal((await readContactNotes(dir)).state, 'error');
  await write(v1, Buffer.alloc(MAX_CONTACT_NOTES_BYTES + 1, 0x20));
  const tooLarge = await readContactNotes(dir);
  assert.equal(tooLarge.state, 'error');
  assert.match(tooLarge.error, /超过|1 MiB|1048576/i);
});

test('contact impression edits preserve unknown fields, evidence and detect SHA-256 conflicts', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'agent', 'contact-notes.json');
  await write(file, JSON.stringify(contactNotesV2()));
  const before = await readContactNotes(dir);

  const saved = await saveContactImpression(dir, {
    peerId: PEER_A,
    impressionId: 'imp-1',
    summary: '更新后的私有印象。',
    uncertainty: 'high',
    expectedSha256: before.sha256,
  });
  assert.equal(saved.saved, true);
  assert.notEqual(saved.sha256, before.sha256);
  const after = await readContactNotes(dir);
  const contact = after.contacts.find((item) => item.peerId === PEER_A);
  assert.equal(contact.impressions[0].id, 'imp-1');
  assert.equal(contact.impressions[0].summary, '更新后的私有印象。');
  assert.equal(contact.impressions[0].uncertainty, 'high');
  assert.equal(contact.impressions[0].createdAt, '2026-11-18T09:55:00Z');
  assert.deepEqual(contact.impressions[0].evidenceRefs.eventIds, ['evt-2']);

  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(raw.unknown_top, { keep: true });
  assert.equal(raw.contacts[0].unknown_contact, 'keep-contact');
  assert.equal(raw.contacts[0].observations[0].unknown_observation, 'keep-observation');
  assert.equal(raw.contacts[0].impressions[0].unknown_impression, 'keep-impression');
  assert.equal(raw.contacts[0].curiosities[0].unknown_curiosity, 'keep-curiosity');

  // A stale expected hash must not overwrite the file.
  const stale = await fs.readFile(file, 'utf8');
  await assert.rejects(() => saveContactImpression(dir, {
    peerId: PEER_A,
    impressionId: 'imp-1',
    summary: '并发覆盖',
    uncertainty: 'low',
    expectedSha256: before.sha256,
  }), (error) => error.code === 'conflict');
  assert.equal(await fs.readFile(file, 'utf8'), stale);

  // Adding a new impression keeps the existing ones and requires the current hash.
  const second = await saveContactImpression(dir, {
    peerId: PEER_A,
    impressionId: '',
    summary: '另一个印象。',
    uncertainty: 'low',
    expectedSha256: after.sha256,
  });
  assert.equal(second.saved, true);
  assert.equal(second.contact.impressions.length, 2);
  assert.equal(second.contact.observations.length, 1);
  assert.equal(second.contact.curiosities.length, 1);

  // Creating a missing file is explicit and starts from schema v2.
  const freshDir = await tempDir();
  const created = await saveContactImpression(freshDir, {
    peerId: PEER_A,
    impressionId: '',
    summary: '第一条印象。',
    uncertainty: 'medium',
    expectedSha256: '',
  });
  assert.equal(created.saved, true);
  const fresh = await readContactNotes(freshDir);
  assert.equal(fresh.schemaVersion, 2);
  assert.equal(fresh.contacts[0].impressions.length, 1);
});

test('contact-notes save rejects malformed input and symlinked private storage', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'agent', 'contact-notes.json');
  await write(file, JSON.stringify(contactNotesV2()));
  const notes = await readContactNotes(dir);
  for (const input of [
    { peerId: 'not-a-peer', impressionId: '', summary: 'x', uncertainty: 'low', expectedSha256: notes.sha256 },
    { peerId: PEER_A, impressionId: '', summary: '', uncertainty: 'low', expectedSha256: notes.sha256 },
    { peerId: PEER_A, impressionId: '', summary: 'x', uncertainty: 'certain', expectedSha256: notes.sha256 },
    { peerId: PEER_A, impressionId: '../bad', summary: 'x', uncertainty: 'low', expectedSha256: notes.sha256 },
    { peerId: PEER_A, impressionId: 'imp-1', summary: 'x', uncertainty: 'low', expectedSha256: 'bad-hash' },
    { peerId: PEER_A, impressionId: 'missing', summary: 'x', uncertainty: 'low', expectedSha256: notes.sha256 },
  ]) {
    await assert.rejects(() => saveContactImpression(dir, input));
  }

  const linkDir = await tempDir();
  const outside = path.join(linkDir, 'outside.json');
  await write(outside, JSON.stringify(contactNotesV2()));
  await fs.mkdir(path.join(linkDir, 'agent'), { recursive: true });
  await fs.symlink(outside, path.join(linkDir, 'agent', 'contact-notes.json'));
  const linked = await readContactNotes(linkDir);
  assert.equal(linked.state, 'error');
  assert.match(linked.error, /符号链接/);
});


test('contact projection stores only validated public metadata and re-verifies local avatar bytes', async () => {
  const dir = await tempDir();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  const avatarPath = `profile/avatar-${sha.slice(0, 8)}.png`;
  await write(path.join(dir, 'downloads', PEER_A, avatarPath), png);
  const now = Date.now();
  await writeContactProjection(dir, {
    schemaVersion: 1,
    updatedAt: now,
    profiles: [
      {
        peerId: PEER_A,
        displayName: '潮汐线旁的林岸',
        description: '公开简介。',
        interests: ['潮汐'],
        conversationStyle: '慢一点回信。',
        avatar: { path: avatarPath, sha256: sha, mime: 'image/png', sizeBytes: png.length },
        source: 'remote-profile',
        verifiedAt: now,
      },
      {
        peerId: PEER_B,
        displayName: '无头像的长名字联系人',
        description: '',
        interests: [],
        conversationStyle: '',
        avatar: null,
        source: 'remote-profile',
        verifiedAt: now - 1,
      },
    ],
    clues: [{
      peerId: PEER_B,
      name: '星云收集者',
      description: '公开声明',
      sourcePeerId: PEER_A,
      sourceName: '潮汐线旁的林岸',
      readAt: now - 2,
    }],
  });

  const file = path.join(dir, 'agent', 'host', 'dsh', 'contact-list.json');
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(Buffer.byteLength(raw) <= MAX_CONTACT_PROJECTION_BYTES);
  assert.doesNotMatch(raw, /data:|blob:|avatarUrl|avatar_url/);
  assert.doesNotMatch(raw, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, 'the projection is private to the local user');
  await assert.rejects(() => fs.stat(path.join(dir, 'public', 'contact-list.json')), /ENOENT/);

  const read = await readContactProjection(dir);
  assert.equal(read.state, 'available');
  assert.equal(read.profiles.length, 2);
  const avatarProfile = read.profiles.find((item) => item.peerId === PEER_A);
  assert.equal(avatarProfile.displayName, '潮汐线旁的林岸');
  assert.equal(avatarProfile.avatarState, 'ready');
  assert.match(avatarProfile.avatarUrl, /^data:image\/png;base64,/);
  assert.equal(avatarProfile.avatarSha256, sha);
  assert.equal(read.clues.length, 1);
  assert.equal(read.clues[0].peerId, PEER_B);
  assert.equal(read.clues[0].sourcePeerId, PEER_A);

  // A damaged or replaced avatar is never shown under the recorded version.
  await fs.writeFile(path.join(dir, 'downloads', PEER_A, avatarPath), Buffer.from('not a png'));
  const damaged = await readContactProjection(dir);
  const damagedProfile = damaged.profiles.find((item) => item.peerId === PEER_A);
  assert.equal(damagedProfile.avatarState, 'hash-mismatch');
  assert.equal(damagedProfile.avatarUrl, undefined);

  // A missing avatar has no URL either; the name remains readable.
  await fs.rm(path.join(dir, 'downloads', PEER_A, avatarPath));
  const missingAvatar = await readContactProjection(dir);
  const missingProfile = missingAvatar.profiles.find((item) => item.peerId === PEER_A);
  assert.equal(missingProfile.avatarState, 'missing');
  assert.equal(missingProfile.avatarUrl, undefined);
  assert.equal(missingProfile.displayName, '潮汐线旁的林岸');
});

test('contact projection fits the legal Chinese maximum and keeps a newer record', async () => {
  const dir = await tempDir();
  const ids = await manyPeerIds(129);
  const baseTime = Date.now();
  const interests = Array.from({ length: 10 }, (_, index) => '趣'.repeat(79) + String.fromCharCode(0x4e00 + index));
  const profiles = ids.slice(0, 128).map((peerId, index) => ({
    peerId,
    displayName: '名'.repeat(80),
    description: '介'.repeat(400),
    interests,
    conversationStyle: '风'.repeat(300),
    avatar: null,
    source: '源'.repeat(40),
    verifiedAt: baseTime - index,
  }));
  const clues = Array.from({ length: 80 }, (_, index) => ({
    peerId: ids[index],
    name: '名'.repeat(120),
    description: '介'.repeat(280),
    sourcePeerId: ids[127],
    sourceName: '源'.repeat(80),
    readAt: baseTime - index,
  }));
  await writeContactProjection(dir, { schemaVersion: 1, updatedAt: baseTime, profiles, clues });

  const file = path.join(dir, 'agent', 'host', 'dsh', 'contact-list.json');
  const firstBytes = await fs.readFile(file);
  assert.ok(firstBytes.length > 512 * 1024, `the boundary fixture must exceed the old 512 KiB limit, got ${firstBytes.length}`);
  assert.ok(firstBytes.length <= MAX_CONTACT_PROJECTION_BYTES);
  const first = await readContactProjection(dir);
  assert.equal(first.state, 'available');
  assert.equal(first.profiles.length, 128);
  assert.equal(first.clues.length, 80);
  assert.equal(first.profiles[0].peerId, ids[0]);
  assert.equal(first.clues[0].peerId, ids[0]);

  // A full legal projection must still accept a newer profile and clue: the
  // writer sorts by the recorded time before applying the fixed count limit.
  const newerProfile = {
    ...profiles[0],
    peerId: ids[128],
    displayName: '新'.repeat(80),
    verifiedAt: baseTime + 1000,
  };
  await writeContactProjection(dir, { schemaVersion: 1, updatedAt: baseTime + 1000, profiles: [newerProfile, ...profiles], clues });
  const withProfile = await readContactProjection(dir);
  assert.equal(withProfile.profiles.length, 128);
  assert.equal(withProfile.profiles[0].peerId, ids[128]);
  assert.equal(withProfile.profiles.some((item) => item.peerId === ids[127]), false, 'the oldest profile should be evicted');
  assert.ok((await fs.stat(file)).size <= MAX_CONTACT_PROJECTION_BYTES);

  const newerClue = {
    peerId: ids[80],
    name: '新'.repeat(120),
    description: '新'.repeat(280),
    sourcePeerId: ids[126],
    sourceName: '新'.repeat(80),
    readAt: baseTime + 1000,
  };
  await writeContactProjection(dir, {
    schemaVersion: 1, updatedAt: baseTime + 1000, profiles: [newerProfile, ...profiles], clues: [newerClue, ...clues],
  });
  const withClue = await readContactProjection(dir);
  assert.equal(withClue.clues.length, 80);
  assert.ok(withClue.clues.some((item) => item.sourcePeerId === ids[126] && item.peerId === ids[80]));
  assert.equal(withClue.clues.some((item) => item.sourcePeerId === ids[127] && item.peerId === ids[79]), false,
    'the oldest clue should be evicted');
  assert.ok((await fs.stat(file)).size <= MAX_CONTACT_PROJECTION_BYTES);
});

test('contact projection rejects wrong schema, corrupt JSON and symlinks', async () => {
  const dir = await tempDir();
  await write(path.join(dir, 'agent', 'host', 'dsh', 'contact-list.json'), '{bad json');
  const corrupt = await readContactProjection(dir);
  assert.equal(corrupt.state, 'error');
  assert.equal(corrupt.profiles.length, 0);

  await write(path.join(dir, 'agent', 'host', 'dsh', 'contact-list.json'), JSON.stringify({
    schema_version: 2,
    profiles: [],
    clues: [],
  }));
  assert.equal((await readContactProjection(dir)).state, 'error');

  const outside = path.join(dir, 'outside.json');
  await write(outside, JSON.stringify({ schema_version: 1, profiles: [], clues: [] }));
  await fs.rm(path.join(dir, 'agent', 'host', 'dsh', 'contact-list.json'));
  await fs.symlink(outside, path.join(dir, 'agent', 'host', 'dsh', 'contact-list.json'));
  const linked = await readContactProjection(dir);
  assert.equal(linked.state, 'error');
  assert.match(linked.error, /符号链接|越过/);

  // A symlinked target must never be silently replaced through the link.
  await assert.rejects(
    () => writeContactProjection(dir, { schemaVersion: 1, updatedAt: Date.now(), profiles: [], clues: [] }),
    /符号链接/,
  );
  assert.equal((await fs.readFile(outside, 'utf8')).includes('schema_version'), true);
});
