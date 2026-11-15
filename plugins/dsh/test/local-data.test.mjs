// Security and schema tests for the DSH host's controlled local reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MAX_POST_BYTES,
  readDiscoveryPost,
  readDownloadedAgentCard,
  readJourney,
  readOwnPosts,
  readOwnPublic,
} from '../lib/local-data.js';

const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'raminga-local-data-'));
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
  assert.deepEqual(own.posts.posts.map((item) => item.title), ['受控公开帖子']);
  assert.equal(own.posts.agentAuthored, 1);
  assert.equal(own.posts.unattributed, 1);
  assert.equal(own.posts.invalid, 1);
  assert.equal(own.posts.posts[0].authorKind, 'user');

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
