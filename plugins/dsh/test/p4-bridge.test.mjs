// P4 host boundary: passive activity reads, lease labels, closing a panel never
// writes a terminal, instance changes are visible, and activityDetail exposes
// only an operation plus a bounded Journey state summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RamingaUiBridge } from '../lib/ui-bridge.js';
import { AgentActivityStore } from '../lib/activity.js';

const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'raminga-p4-bridge-'));
}
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function fakeStream() {
  return {
    subscribe(_api, _onEvent, _onError, onState) {
      onState('open');
      return () => {};
    },
  };
}
function statusResponse() {
  return {
    peerId: PEER_A, nodeId: 'node-a', version: 'test', protocolVersion: '1',
    apiVersion: '6', startedAtUnixMs: 1, currentTime: 'now',
    listenAddrs: [], advertisedAddrs: [], connections: [], peers: [],
  };
}
function fakeApi(dataDir) {
  return {
    config: { dataDir },
    ensure: async () => ({}),
    call: async (fn) => fn({ status: async () => statusResponse() }),
  };
}
function storeFor(dir, instance = 'inst-test-00000011') {
  return new AgentActivityStore({ dataDir: dir, pluginInstanceId: instance });
}
async function journey(dir, id, { status = 'running', current = PEER_A, visited = [] } = {}) {
  await write(path.join(dir, 'agent', 'sessions', id, 'state.json'), {
    schema_version: 1,
    status,
    mode: 'exploration',
    intent: 'SECRET INTENT TEXT',
    started_at: '2026-11-18T10:00:00Z',
    updated_at: '2026-11-18T10:00:02Z',
    completed_at: null,
    completion_reason: null,
    current_peer_id: current || null,
    visited_peer_ids: visited,
    discovery_sources: [],
  });
  await write(path.join(dir, 'agent', 'sessions', id, 'report.md'), '# SECRET REPORT TEXT\n\nprivate narrative');
}

test('panel lease labels calls; closing and reopening never changes the tool result', async () => {
  const dir = await tempDir();
  const store = storeFor(dir);
  const bridge = new RamingaUiBridge(fakeApi(dir), { dataDir: dir, activity: store, subscribe: fakeStream().subscribe });
  const first = 'p4-lease-00000001';
  const second = 'p4-lease-00000002';
  try {
    await journey(dir, 's1', { current: PEER_A });
    await bridge.open(first);
    assert.equal(store.panelSessionId, first);
    const handle = await store.begin({ tool: 'raminga_content_get', args: { peer_id: PEER_A, path: 'posts/p1/post.json' } });
    let read = await bridge.activity(first, 10);
    assert.equal(read.instanceId, 'inst-test-00000011');
    assert.equal(read.operations.length, 1);
    assert.equal(read.operations[0].state, 'running');
    assert.equal(read.operations[0].result, null);
    assert.equal(read.operations[0].panelSessionId, first);
    assert.equal(read.operations[0].journeyId, 's1');
    assert.equal(read.operations[0].journeyMatch, 'current_peer');
    assert.ok(read.readAt > 0);
    assert.equal(read.error, '');

    // Closing the panel only releases the lease and unbinds the label.
    await bridge.close(first);
    assert.equal(store.panelSessionId, '');
    let direct = await store.read();
    assert.equal(direct.operations[0].state, 'running', 'close did not write a terminal');
    assert.equal(direct.operations[0].result, null);

    // The real tool result arrives while no panel is open.
    await handle.finish('ok', { evidence: { peer_id: PEER_A, path: 'posts/p1/post.json', sha256: 'b'.repeat(64) } });
    await bridge.open(second);
    read = await bridge.activity(second, 10);
    assert.equal(read.operations[0].result, 'ok');
    assert.equal(read.operations[0].state, 'finished');
    assert.equal(read.operations[0].panelSessionId, first);
  } finally {
    await bridge.close(second).catch(() => {});
    bridge.dispose();
    await store.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('activityDetail attaches only a Journey state summary, never private narrative', async () => {
  const dir = await tempDir();
  const store = storeFor(dir);
  const bridge = new RamingaUiBridge(fakeApi(dir), { dataDir: dir, activity: store, subscribe: fakeStream().subscribe });
  const sid = 'p4-detail-00000001';
  try {
    await bridge.open(sid);
    await journey(dir, 's1', { current: PEER_A, visited: [PEER_B] });
    const handle = await store.begin({ tool: 'raminga_content_get', args: { peer_id: PEER_A, path: 'posts/p1/post.json' } });
    await handle.finish('ok', {
      evidence: { peer_id: PEER_A, path: 'posts/p1/post.json', sha256: 'c'.repeat(64), discovery_id: 9, content_state: 'complete', message_ids: ['m-1'] },
    });
    const detail = await bridge.activityDetail(handle.operationId);
    assert.ok(detail.operation);
    assert.equal(detail.operation.result, 'ok');
    assert.equal(detail.evidence.sha256, 'c'.repeat(64));
    assert.equal(detail.journey?.exists, true);
    assert.equal(detail.journey?.sessionId, 's1');
    assert.equal(detail.journey?.status, 'running');
    assert.equal(detail.journey?.currentPeerId, PEER_A);
    assert.equal(detail.missingReason, '');
    const serialized = JSON.stringify(detail);
    assert.doesNotMatch(serialized, /SECRET INTENT|SECRET REPORT|private narrative/);
    assert.equal('reportMarkdown' in (detail.journey || {}), false);
    assert.equal('intent' in (detail.journey || {}), false);

    // The Journey record is deleted/damaged: report the missing association but
    // keep the Peer fallback instead of silently changing it to "none".
    await fs.rm(path.join(dir, 'agent', 'sessions', 's1'), { recursive: true, force: true });
    const missing = await bridge.activityDetail(handle.operationId);
    assert.equal(missing.journey?.exists, false);
    assert.match(missing.missingReason, /已不在本机/);
    assert.equal(missing.evidence.peer_id, PEER_A);

    const noTarget = await store.begin({ tool: 'raminga_status', args: {} });
    await noTarget.finish('ok');
    const noTargetDetail = await bridge.activityDetail(noTarget.operationId);
    assert.equal(noTargetDetail.journey, null);
    assert.match(noTargetDetail.missingReason, /本机没有可跳转证据/);

    const peerOnly = await store.begin({ tool: 'raminga_peer_profile', args: { peer_id: PEER_B } });
    await peerOnly.finish('ok');
    const peerDetail = await bridge.activityDetail(peerOnly.operationId);
    assert.equal(peerDetail.journey, null);
    assert.equal(peerDetail.missingReason, '');
    assert.equal(peerDetail.evidence.peer_id, PEER_B);

    const absent = await bridge.activityDetail('op-1763450000000-1-abcdef12');
    assert.equal(absent.operation, null);
    assert.match(absent.missingReason, /没有找到/);
  } finally {
    await bridge.close(sid).catch(() => {});
    bridge.dispose();
    await store.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a new plugin instance is reported separately and old running marks are terminal', async () => {
  const dir = await tempDir();
  const first = storeFor(dir, 'inst-test-00000021');
  const second = storeFor(dir, 'inst-test-00000022');
  const bridge = new RamingaUiBridge(fakeApi(dir), { dataDir: dir, activity: second, subscribe: fakeStream().subscribe });
  const sid = 'p4-instance-00000001';
  try {
    const handle = await first.begin({ tool: 'raminga_peer_manifest', args: { peer_id: PEER_A } });
    await first.dispose();
    await second.initialize();
    await bridge.open(sid);
    const read = await bridge.activity(sid, 10);
    assert.equal(read.instanceId, 'inst-test-00000022');
    assert.equal(read.operations.length, 1);
    assert.equal(read.operations[0].operationId, handle.operationId);
    assert.notEqual(read.operations[0].pluginInstanceId, read.instanceId);
    assert.equal(read.operations[0].state, 'finished');
    assert.equal(read.operations[0].result, 'interrupted');
  } finally {
    await bridge.close(sid).catch(() => {});
    bridge.dispose();
    await second.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('activity failures are explicit errors, never an empty list', async () => {
  const dir = await tempDir();
  const bridge = new RamingaUiBridge(fakeApi(dir), { dataDir: dir, activity: null, subscribe: fakeStream().subscribe });
  const sid = 'p4-errors-00000001';
  try {
    await bridge.open(sid);
    const unavailable = await bridge.activity(sid, 10);
    assert.equal(unavailable.operations.length, 0);
    assert.match(unavailable.error, /没有提供/);

    const store = storeFor(dir);
    const second = new RamingaUiBridge(fakeApi(dir), { dataDir: dir, activity: store, subscribe: fakeStream().subscribe });
    const sid2 = 'p4-errors-00000002';
    try {
      await fs.mkdir(path.join(dir, 'agent', 'activity.jsonl'), { recursive: true });
      await second.open(sid2);
      const failed = await second.activity(sid2, 10);
      assert.equal(failed.operations.length, 0);
      assert.match(failed.error, /不是常规文件|读取失败/);
      assert.equal(failed.instanceId, 'inst-test-00000011');
    } finally {
      await second.close(sid2).catch(() => {});
      second.dispose();
      await store.dispose();
    }
  } finally {
    await bridge.close(sid).catch(() => {});
    bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
