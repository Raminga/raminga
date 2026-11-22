// P4 activity store contract: private append-only format, unique operations,
// rotation/bad-line handling, timeout/dispose semantics and Journey association.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  ACTIVITY_MAX_BAD_LINES,
  ActivityTimeoutError,
  AgentActivityStore,
  associateJourney,
  describeActivityCall,
  evidenceFromResult,
  runWithActivity,
  safeActivityPath,
} from '../lib/activity.js';

const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';
const SHA = 'a'.repeat(64);

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'raminga-activity-'));
}
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}
async function journey(dir, id, { status = 'running', current = '', visited = [] } = {}) {
  await write(path.join(dir, 'agent', 'sessions', id, 'state.json'), {
    schema_version: 1,
    status,
    mode: 'exploration',
    intent: 'private intent must not enter activity',
    started_at: '2026-11-18T10:00:00Z',
    updated_at: '2026-11-18T10:00:02Z',
    completed_at: status === 'completed' ? '2026-11-18T10:00:03Z' : null,
    completion_reason: null,
    current_peer_id: current || null,
    visited_peer_ids: visited,
    discovery_sources: [],
  });
}
function storeFor(dir, overrides = {}) {
  return new AgentActivityStore({
    dataDir: dir,
    pluginInstanceId: 'inst-test-00000001',
    sessionId: 'sess-plugin-test-00000001',
    ...overrides,
  });
}
async function readEvents(dir) {
  const raw = await fs.readFile(path.join(dir, 'agent', 'activity.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
async function lineCount(dir) {
  try {
    return (await readEvents(dir)).length;
  } catch {
    return 0;
  }
}

test('activity format is private, bounded and keeps only safe target/evidence fields', async () => {
  const dir = await tempDir();
  try {
    await journey(dir, 'session-01', { current: PEER_A, visited: [] });
    const store = storeFor(dir);
    store.attachPanelSession('ui-test-00000001');
    const op = await store.begin({
      tool: 'raminga_content_get',
      args: {
        peer_id: PEER_A,
        path: 'posts/p1/post.json',
        text: 'SECRET CHAT BODY',
        token: 'SECRET_TOKEN_VALUE',
        local_path: '/Users/me/private/agent/persona.md',
      },
    });
    await op.finish('ok', {
      evidence: {
        peer_id: PEER_A,
        path: 'posts/p1/post.json',
        sha256: SHA,
        discovery_id: 42,
        local_path: '/Users/me/private/download.bin',
        message_ids: ['m-1'],
        content_state: 'complete',
      },
    });

    const raw = await fs.readFile(path.join(dir, 'agent', 'activity.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /SECRET|private\/agent|local_path|\/Users/);
    assert.equal(raw.trim().split('\n').length, 2);
    const events = await readEvents(dir);
    assert.deepEqual(events.map((event) => event.event), ['started', 'finished']);
    const started = events[0];
    assert.match(started.operation_id, /^op-\d{10,16}-\d+-[a-f0-9]{8}$/);
    assert.equal(started.plugin_instance_id, 'inst-test-00000001');
    assert.equal(started.panel_session_id, 'ui-test-00000001');
    assert.equal(started.journey_id, 'session-01');
    assert.equal(started.journey_match, 'current_peer');
    assert.equal(started.target_type, 'content');
    assert.deepEqual(started.target, { peer_id: PEER_A, path: 'posts/p1/post.json' });
    assert.equal(events[1].result, 'ok');
    assert.equal(events[1].evidence.discovery_id, 42);
    assert.equal(events[1].evidence.local_path, undefined);
    assert.deepEqual(events[1].evidence.message_ids, ['m-1']);
    for (const line of raw.trim().split('\n')) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 8 * 1024, 'one line stays <= 8 KiB');
    }
    const agentStat = await fs.stat(path.join(dir, 'agent'));
    const fileStat = await fs.stat(path.join(dir, 'agent', 'activity.jsonl'));
    assert.equal(agentStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);

    const read = await store.read();
    assert.equal(read.instanceId, 'inst-test-00000001');
    assert.equal(read.operations.length, 1);
    assert.equal(read.operations[0].state, 'finished');
    assert.equal(read.operations[0].result, 'ok');
    assert.equal(read.operations[0].journeyMatch, 'current_peer');
    assert.equal(read.operations[0].target.path, 'posts/p1/post.json');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('each concurrent call gets an independent operation id and terminal result', async () => {
  const dir = await tempDir();
  try {
    const store = storeFor(dir);
    const handles = await Promise.all(Array.from({ length: 16 }, (_, index) => store.begin({
      tool: 'raminga_peer_manifest',
      args: { peer_id: index % 2 === 0 ? PEER_A : PEER_B },
    })));
    const ids = handles.map((handle) => handle.operationId);
    assert.equal(new Set(ids).size, ids.length);
    await Promise.all(handles.map((handle, index) => handle.finish(index % 3 === 0 ? 'error' : 'ok', {
      errorCode: index % 3 === 0 ? 'tool_error' : undefined,
      errorSummary: index % 3 === 0 ? 'expected failure' : undefined,
    })));
    const read = await store.read(100);
    assert.equal(read.operations.length, 16);
    assert.equal(new Set(read.operations.map((operation) => operation.operationId)).size, 16);
    assert.ok(read.operations.every((operation) => operation.state === 'finished'));
    assert.equal(read.operations.filter((operation) => operation.result === 'error').length, 6);
    const starts = read.operations.map((operation) => Date.parse(operation.startedAt));
    assert.deepEqual(starts, [...starts].sort((left, right) => left - right));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the 120s wrapper timeout is a wrapper fact and never retries or reports underlying failure', async () => {
  const dir = await tempDir();
  try {
    const store = storeFor(dir);
    const started = Date.now();
    await assert.rejects(
      () => runWithActivity(store, { tool: 'raminga_status', args: {} }, () => new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true }), 80);
      }), { timeoutMs: 15 }),
      (error) => error instanceof ActivityTimeoutError && /结果未知/.test(error.message),
    );
    assert.ok(Date.now() - started < 75, 'wrapper returns without waiting for the slow operation');
    const first = await store.read();
    assert.equal(first.operations[0].result, 'timeout');
    assert.equal(first.operations[0].errorCode, 'wrapper_timeout');
    assert.match(first.operations[0].errorSummary, /结果未知/);
    // A late underlying result must not append a second terminal or become ok.
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(await lineCount(dir), 2);
    assert.equal((await store.read()).operations[0].result, 'timeout');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('plugin dispose writes interrupted (not failed), and a later real finish wins', async () => {
  const dir = await tempDir();
  try {
    const store = storeFor(dir, { disposeWaitMs: 5 });
    const slow = await store.begin({ tool: 'raminga_content_get', args: { peer_id: PEER_A, path: 'posts/p1/post.json' } });
    const other = await store.begin({ tool: 'raminga_chat_send', args: { peer_id: PEER_B } });
    await store.dispose();
    let read = await store.read();
    assert.equal(read.operations.length, 2);
    assert.ok(read.operations.every((operation) => operation.result === 'interrupted'));
    assert.ok(read.operations.every((operation) => operation.errorCode === 'plugin_unloaded'));
    assert.ok(read.operations.every((operation) => !/failed|error/.test(operation.result)));

    await slow.finish('ok', { evidence: { peer_id: PEER_A, path: 'posts/p1/post.json', sha256: SHA } });
    read = await store.read();
    const final = read.operations.find((operation) => operation.operationId === slow.operationId);
    const otherFinal = read.operations.find((operation) => operation.operationId === other.operationId);
    assert.equal(final?.result, 'ok');
    assert.equal(final?.state, 'finished');
    assert.equal(otherFinal?.result, 'interrupted');
    const events = await readEvents(dir);
    assert.equal(events.filter((event) => event.operation_id === slow.operationId).length, 3);
    assert.equal(events.filter((event) => event.operation_id === slow.operationId).at(-1).result, 'ok');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a new plugin instance marks an orphaned started operation unknown, not running', async () => {
  const dir = await tempDir();
  try {
    const first = storeFor(dir, { pluginInstanceId: 'inst-test-00000001' });
    const orphan = await first.begin({ tool: 'raminga_peer_profile', args: { peer_id: PEER_A } });
    assert.equal(await lineCount(dir), 1);
    const second = storeFor(dir, { pluginInstanceId: 'inst-test-00000002' });
    await second.initialize();
    const read = await second.read();
    assert.equal(read.instanceId, 'inst-test-00000002');
    assert.equal(read.operations.length, 1);
    assert.equal(read.operations[0].operationId, orphan.operationId);
    assert.equal(read.operations[0].state, 'finished');
    assert.equal(read.operations[0].result, 'unknown');
    assert.equal(read.operations[0].errorCode, 'host_restart');
    assert.equal(read.operations[0].errorSummary, '上次插件实例已退出，结果未知。');
    assert.equal((await readEvents(dir)).at(-1).result, 'unknown');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rotation keeps one previous file and reads report truncation', async () => {
  const dir = await tempDir();
  try {
    const store = storeFor(dir, { maxFileBytes: 1400 });
    for (let index = 0; index < 24; index += 1) {
      const handle = await store.begin({
        tool: 'raminga_peer_manifest',
        args: { peer_id: PEER_A, offset: index },
      });
      await handle.finish('ok', { evidence: { peer_id: PEER_A, manifest_generated_at_unix_ms: 1700000000000 } });
    }
    const current = await fs.stat(path.join(dir, 'agent', 'activity.jsonl'));
    const previous = await fs.stat(path.join(dir, 'agent', 'activity.1.jsonl'));
    assert.ok(previous.size > 0, 'previous file exists');
    assert.ok(current.size <= 1400, `current file stays bounded (${current.size})`);
    const read = await store.read(1000);
    assert.equal(read.truncated, true, 'rotation means older records are not all in view');
    assert.ok(read.operations.length > 0);
    assert.ok(read.operations.every((operation) => operation.state === 'finished'));
    assert.ok(read.operations.every((operation) => operation.result === 'ok'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('bad lines are skipped; excessive bad lines are an error, never an empty list', async () => {
  const dir = await tempDir();
  try {
    const store = storeFor(dir);
    const handle = await store.begin({ tool: 'raminga_friends', args: {} });
    await handle.finish('ok');
    const file = path.join(dir, 'agent', 'activity.jsonl');
    await fs.appendFile(file, '{not-json}\n{"schema_version":1,"event":"started"}\n');
    let read = await store.read();
    assert.equal(read.operations.length, 1);
    assert.equal(read.badLines, 2);
    assert.equal(read.error, '');
    const bad = Array.from({ length: ACTIVITY_MAX_BAD_LINES + 1 }, () => '{broken}').join('\n');
    await fs.appendFile(file, `${bad}\n`);
    read = await store.read();
    assert.equal(read.operations.length, 1, 'valid records remain available for diagnosis');
    assert.match(read.error, /无法解析/);

    const missingDir = await tempDir();
    try {
      const missing = storeFor(missingDir);
      const empty = await missing.read();
      assert.deepEqual(empty.operations, []);
      assert.equal(empty.error, '');
    } finally {
      await fs.rm(missingDir, { recursive: true, force: true });
    }

    const brokenDir = await tempDir();
    try {
      await fs.mkdir(path.join(brokenDir, 'agent', 'activity.jsonl'), { recursive: true });
      const broken = storeFor(brokenDir);
      const failed = await broken.read();
      assert.deepEqual(failed.operations, []);
      assert.match(failed.error, /不是常规文件|读取失败/);
    } finally {
      await fs.rm(brokenDir, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tool target mapping keeps connect multiaddr peer IDs and marks agent_init as agent', () => {
  const connect = describeActivityCall('raminga_connect', {
    multiaddr: `/ip4/127.0.0.1/tcp/1234/p2p/${PEER_A}`,
    text: 'SECRET',
  });
  assert.equal(connect.targetType, 'connect');
  assert.deepEqual(connect.target, { peer_id: PEER_A });
  const init = describeActivityCall('raminga_agent_init', {});
  assert.equal(init.targetType, 'agent');
  assert.deepEqual(init.target, {});
  const chat = describeActivityCall('raminga_chat_send', { peer_id: PEER_B, text: 'SECRET BODY' });
  assert.equal(chat.targetType, 'chat');
  assert.deepEqual(chat.target, { peer_id: PEER_B });
});

test('Journey association covers current, visited, active, none and ambiguous', async () => {
  const cases = [
    { name: 'current', setup: (dir) => journey(dir, 's1', { current: PEER_A, visited: [PEER_B] }), tool: 'raminga_peer_profile', args: { peer_id: PEER_A }, journeyId: 's1', match: 'current_peer' },
    { name: 'visited', setup: (dir) => journey(dir, 's1', { current: PEER_A, visited: [PEER_B] }), tool: 'raminga_content_get', args: { peer_id: PEER_B, path: 'posts/a.json' }, journeyId: 's1', match: 'visited_peer' },
    { name: 'unvisited candidate', setup: (dir) => journey(dir, 's1', { current: PEER_A, visited: [] }), tool: 'raminga_content_get', args: { peer_id: PEER_B, path: 'posts/a.json' }, journeyId: 's1', match: 'active_journey' },
    { name: 'paused', setup: (dir) => journey(dir, 's1', { status: 'paused', current: PEER_A }), tool: 'raminga_peer_profile', args: { peer_id: PEER_A }, journeyId: '', match: 'none' },
    { name: 'status is not attributed', setup: (dir) => journey(dir, 's1', { current: PEER_A }), tool: 'raminga_status', args: {}, journeyId: '', match: 'none' },
    { name: 'chat history is social', setup: (dir) => journey(dir, 's1', { current: PEER_A }), tool: 'raminga_chat_history', args: { limit: 5 }, journeyId: 's1', match: 'active_journey' },
  ];
  for (const entry of cases) {
    const dir = await tempDir();
    try {
      await entry.setup(dir);
      const store = storeFor(dir);
      const handle = await store.begin({ tool: entry.tool, args: entry.args });
      await handle.finish('ok');
      const read = await store.read();
      assert.equal(read.operations[0].journeyId, entry.journeyId, entry.name);
      assert.equal(read.operations[0].journeyMatch, entry.match, entry.name);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  const ambiguousDir = await tempDir();
  try {
    await journey(ambiguousDir, 's1', { current: PEER_A });
    await journey(ambiguousDir, 's2', { current: PEER_B });
    const store = storeFor(ambiguousDir);
    const handle = await store.begin({ tool: 'raminga_peer_profile', args: { peer_id: PEER_A } });
    await handle.finish('ok');
    const read = await store.read();
    assert.equal(read.operations[0].journeyId, '');
    assert.equal(read.operations[0].journeyMatch, 'ambiguous');
    assert.equal(associateJourney('raminga_status', {}, [{ id: 's1', currentPeerId: PEER_A, visitedPeerIds: [] }]).match, 'none');
  } finally {
    await fs.rm(ambiguousDir, { recursive: true, force: true });
  }
});

test('evidence projection and error redaction never leak bodies, tokens or local paths', async () => {
  const evidence = evidenceFromResult('raminga_content_get', { peer_id: PEER_A, path: 'posts/p1/post.json' }, {
    final: {
      peerId: PEER_A,
      path: 'posts/p1/post.json',
      sha256: SHA,
      discoveryId: 7,
      phase: 'complete',
      localPath: '/Users/me/private/file',
    },
  });
  assert.deepEqual(evidence, {
    peer_id: PEER_A,
    path: 'posts/p1/post.json',
    sha256: SHA,
    discovery_id: 7,
    content_state: 'complete',
  });
  assert.equal(safeActivityPath('/Users/me/file'), '');
  assert.equal(safeActivityPath('posts/../agent/persona.md'), '');

  const dir = await tempDir();
  try {
    const store = storeFor(dir);
    await assert.rejects(() => runWithActivity(store, { tool: 'raminga_peer_profile', args: { peer_id: PEER_A } }, async () => {
      throw new Error('failed at /Users/me/private/agent/persona.md token=abc123 SECRET_BODY');
    }));
    const raw = await fs.readFile(path.join(dir, 'agent', 'activity.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /\/Users|abc123|SECRET_BODY|persona\.md/);
    const read = await store.read();
    assert.equal(read.operations[0].result, 'error');
    assert.match(read.operations[0].errorSummary, /工具执行失败/);
    assert.match(read.operations[0].errorSummary, /详情未写入/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('panel lease labels calls but closing it never changes an operation result', async () => {
  const dir = await tempDir();
  try {
    const store = storeFor(dir);
    const before = await store.begin({ tool: 'raminga_status', args: {} });
    await before.finish('ok');
    assert.equal((await store.read()).operations[0].panelSessionId, '');
    store.attachPanelSession('ui-test-00000002');
    const during = await store.begin({ tool: 'raminga_friends', args: {} });
    assert.equal((await store.read()).operations[1].panelSessionId, 'ui-test-00000002');
    store.detachPanelSession('ui-test-00000002');
    await during.finish('ok');
    assert.equal((await store.read()).operations[1].panelSessionId, 'ui-test-00000002');
    assert.equal((await store.read()).operations[1].result, 'ok');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
