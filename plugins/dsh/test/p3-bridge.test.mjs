// P3 host boundary: persisted reads never write the human cursor; private
// contact memory merges real messages/Journey/notes and edits preserve unknown
// fields with SHA-256 conflict checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { RamingaUiBridge } from '../lib/ui-bridge.js';

const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'raminga-p3-bridge-'));
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
function message({ id, direction, origin = 'unknown', text, at }) {
  return {
    messageId: id, peerId: PEER_A, direction, text, acked: direction === 'out',
    createdAtUnixMs: at, ackedAtUnixMs: direction === 'out' ? at + 1 : 0,
    deliveryStatus: direction === 'out' ? 'acked' : 'received', deliveryError: '',
    origin, deliveryUpdatedAtUnixMs: 0, clientRequestId: '',
  };
}
function fakeApi({ dataDir, messages, calls }) {
  const client = {
    async status() { return statusResponse(); },
    async listMessages() {
      calls.messages += 1;
      return { messages, hasMore: false, nextBefore: '', retention: { retainedMessages: messages.length, maxStoredMessages: 1000 } };
    },
    async markConversationRead(request) {
      calls.markRead += 1;
      return { peerId: request.peerId, lastReadMessageId: request.throughMessageId, lastReadAtUnixMs: 3000, unreadCount: 0 };
    },
    async listFavorites() {
      calls.favorites += 1;
      return {
        favorites: [{ id: 'fav_1', peerId: PEER_A, path: 'posts/a.json', sha256: 'a'.repeat(64), title: 'A', createdAtUnixMs: 1000, available: true }],
        nextBefore: 'next', hasMore: true,
      };
    },
    async setFavorite(request) {
      calls.setFavorite += 1;
      return {
        favorite: request.favorite,
        item: request.favorite
          ? { id: 'fav_1', peerId: request.peerId, path: request.path, sha256: request.sha256, title: request.title, createdAtUnixMs: 1000, available: true }
          : null,
      };
    },
  };
  return {
    config: { dataDir },
    ensure: async () => ({}),
    call: async (fn) => fn(client),
  };
}

function notesV2() {
  return {
    schema_version: 2,
    unknown_top: 'keep',
    peer_id: PEER_A,
    display_name_snapshot: 'Alice',
    updated_at: '2026-11-18T10:00:00Z',
    unknown_contact: 'keep-contact',
    observations: [{
      id: 'obs-1', summary: '读过一份公开散步记录。', observed_at: '2026-11-18T09:50:00Z',
      unknown_observation: 'keep-observation',
      evidence_refs: { session_ids: ['s1'], event_ids: ['evt-1'], message_ids: [], content_paths: ['posts/p1/post.json'], content_sha256: ['a'.repeat(64)] },
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
  };
}

async function makeMemoryDir() {
  const dir = await tempDir();
  await write(path.join(dir, 'agent', 'contacts', PEER_A, 'memory.json'), JSON.stringify(notesV2()));
  const session = path.join(dir, 'agent', 'sessions', 's1');
  await write(path.join(session, 'state.json'), {
    schema_version: 1, session_id: 's1', status: 'completed', mode: 'exploration', intent: 'x',
    limits: {}, discovery_sources: [], current_peer_id: PEER_A, visited_peer_ids: [PEER_A],
    skipped_peer_ids: [], curiosity: [], started_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T10:00:00Z', completed_at: '2026-11-18T10:00:00Z', completion_reason: 'goal',
  });
  await write(path.join(session, 'events.jsonl'), [
    JSON.stringify({ schema_version: 1, event_id: 'e1', sequence: 1, timestamp: '2026-11-18T09:40:00Z', type: 'message_received', peer_id: PEER_A, summary: '收到真实消息', evidence_refs: { message_ids: ['m-in'], content_paths: [], event_ids: [] }, message_evidence: { message_id: 'm-in', peer_id: PEER_A, direction: 'in', created_at_unix_ms: '1760000000000', acked: false, acked_at_unix_ms: null, content_sha256: null, summary: '摘要', observed_at: '2026-11-18T09:40:00Z' } }),
    JSON.stringify({ schema_version: 1, event_id: 'e2', sequence: 2, timestamp: '2026-11-18T09:41:00Z', type: 'observation', peer_id: PEER_B, summary: '与这个联系人无关', evidence_refs: { message_ids: [], content_paths: [], event_ids: [] } }),
    JSON.stringify({ schema_version: 1, event_id: 'e3', sequence: 3, timestamp: '2026-11-18T09:42:00Z', type: 'visit_completed', source_peer_id: PEER_A, summary: '完成真实访问', evidence_refs: { message_ids: [], content_paths: ['posts/p1/post.json'], event_ids: [] } }),
  ].join('\n') + '\n');
  return dir;
}

test('contact memory merges persisted messages, related Journey events and notes; reads never write the cursor', async () => {
  const dir = await makeMemoryDir();
  const calls = { messages: 0, markRead: 0, favorites: 0, setFavorite: 0 };
  const messages = [
    message({ id: 'm-in', direction: 'in', text: '你好，最近在读什么？', at: 1000 }),
    message({ id: 'm-human', direction: 'out', origin: 'human', text: '在看地图。', at: 2000 }),
    message({ id: 'm-agent', direction: 'out', origin: 'agent', text: '我也注意到一条散步记录。', at: 2500 }),
  ];
  const api = fakeApi({ dataDir: dir, messages, calls });
  const bridge = new RamingaUiBridge(api, { dataDir: dir, subscribe: fakeStream().subscribe });
  const sid = 'p3-memory-0001';
  try {
    await bridge.open(sid);
    const memory = await bridge.contactMemory(sid, PEER_A);
    assert.equal(memory.state, 'available');
    assert.equal(memory.schemaVersion, 2);
    assert.equal(memory.contact.impressions[0].id, 'imp-1');
    assert.equal(memory.contact.impressions[0].evidenceRefs.eventIds[0], 'evt-2');
    assert.equal(calls.markRead, 0, 'contact-memory reads must not advance the human cursor');
    assert.equal(calls.messages, 1);

    const kinds = memory.timeline.map((item) => item.kind);
    assert.equal(kinds.filter((kind) => kind === 'message').length, 3);
    assert.equal(kinds.filter((kind) => kind === 'journey').length, 2, 'unrelated Journey peer must be excluded');
    assert.equal(kinds.filter((kind) => kind === 'observation').length, 1);
    assert.equal(kinds.filter((kind) => kind === 'impression').length, 1);
    assert.equal(kinds.filter((kind) => kind === 'curiosity').length, 1);
    const human = memory.timeline.find((item) => item.id === 'message:m-human');
    const agent = memory.timeline.find((item) => item.id === 'message:m-agent');
    const inbound = memory.timeline.find((item) => item.id === 'message:m-in');
    const impression = memory.timeline.find((item) => item.kind === 'impression');
    assert.match(impression.source, /确定性 中/);
    assert.doesNotMatch(impression.source, /medium/);
    assert.match(human.source, /本人/);
    assert.match(agent.source, /Agent/);
    assert.match(inbound.source, /对方/);
    for (const item of memory.timeline) {
      assert.ok(item.at > 0, `${item.id} must carry a real time`);
      assert.equal(item.private, true);
      assert.ok(item.summary.length > 0);
    }
    assert.ok(memory.timeline.every((item) => item.kind !== 'message' || item.evidence.messageIds.length === 1));

    // The bridge's read path must not call markConversationRead.
    const before = calls.markRead;
    await bridge.messages(sid, PEER_A);
    await bridge.messages(sid, PEER_A);
    assert.equal(calls.markRead, before);
    const read = await bridge.markRead(sid, PEER_A, 'm-agent');
    assert.equal(read.unreadCount, 0);
    assert.equal(calls.markRead, before + 1);
  } finally {
    bridge.dispose();
  }
});

test('contact memory keeps undated private entries at time zero without inferring dates', async () => {
  const dir = await makeMemoryDir();
  const notes = notesV2();
  notes.observations = [
    { id: 'obs-omitted', summary: '没有日期的旧观察。', evidence_refs: {} },
    { id: 'obs-null', summary: '时间为空的旧观察。', observed_at: null, evidence_refs: {} },
    {
      id: 'obs-dated', summary: '有明确日期的观察。', observed_at: '2026-11-18T09:50:00Z',
      evidence_refs: { session_ids: ['s1'], event_ids: [], message_ids: [], content_paths: [], content_sha256: [] },
    },
  ];
  notes.impressions = [{
    id: 'imp-undated', summary: '没有日期的旧印象。', uncertainty: 'low', evidence_refs: {},
  }];
  notes.curiosities = [{
    id: 'cur-undated', question: '没有日期的旧好奇。', evidence_refs: {},
  }];
  await write(path.join(dir, 'agent', 'contacts', PEER_A, 'memory.json'), notes);
  const calls = { messages: 0, markRead: 0, favorites: 0, setFavorite: 0 };
  const api = fakeApi({ dataDir: dir, messages: [], calls });
  const bridge = new RamingaUiBridge(api, { dataDir: dir, subscribe: fakeStream().subscribe });
  const sid = 'p3-memory-undated-0001';
  try {
    await bridge.open(sid);
    const memory = await bridge.contactMemory(sid, PEER_A);
    const undated = [
      memory.timeline.find((item) => item.id === 'observation:obs-omitted'),
      memory.timeline.find((item) => item.id === 'observation:obs-null'),
      memory.timeline.find((item) => item.id === 'impression:imp-undated'),
      memory.timeline.find((item) => item.id === 'curiosity:cur-undated'),
    ];
    for (const item of undated) {
      assert.ok(item, 'undated private entry must stay in the timeline');
      assert.equal(item.at, 0);
      assert.equal(item.private, true);
      assert.ok(item.body.length > 0);
    }
    assert.match(undated[0].source, /私有观察/);
    assert.match(undated[1].source, /私有观察/);
    assert.match(undated[2].source, /私有印象/);
    assert.match(undated[3].source, /私有好奇/);

    const dated = memory.timeline.find((item) => item.id === 'observation:obs-dated');
    assert.equal(dated.at, Date.parse('2026-11-18T09:50:00Z'));
    assert.equal(memory.timeline.filter((item) => item.kind === 'message').length, 0);
    assert.equal(memory.timeline.filter((item) => item.kind === 'journey').length, 2);
  } finally {
    bridge.dispose();
  }
});

test('favorites stay public-post-only in the host mapping and are idempotent', async () => {
  const dir = await tempDir();
  const calls = { messages: 0, markRead: 0, favorites: 0, setFavorite: 0 };
  const api = fakeApi({ dataDir: dir, messages: [], calls });
  const bridge = new RamingaUiBridge(api, { dataDir: dir, subscribe: fakeStream().subscribe });
  const sid = 'p3-favorites-0001';
  try {
    await bridge.open(sid);
    const page = await bridge.favorites(sid);
    assert.equal(page.favorites.length, 1);
    assert.equal(page.favorites[0].available, true);
    assert.equal(page.favorites[0].local, true);
    assert.equal('kind' in page.favorites[0], false);
    assert.equal(page.hasMore, true);
    const saved = await bridge.setFavorite(sid, PEER_A, 'posts/a.json', 'a'.repeat(64), 'A', true);
    assert.equal(saved.favorite, true);
    assert.equal(saved.item.path, 'posts/a.json');
    const removed = await bridge.setFavorite(sid, PEER_A, 'posts/a.json', 'a'.repeat(64), 'A', false);
    assert.equal(removed.favorite, false);
    assert.equal(removed.item, null);
    assert.equal(calls.setFavorite, 2);
    assert.equal(calls.markRead, 0);
  } finally {
    bridge.dispose();
  }
});

test('exact local favorite versions read without a manifest/dial and mismatches never masquerade', async () => {
  const dir = await tempDir();
  const calls = { messages: 0, markRead: 0, favorites: 0, setFavorite: 0 };
  const body = JSON.stringify({ schema_version: 1, title: '离线的本机副本', format: 'markdown', body: '# 离线的本机副本\n\n只按请求版本读取。', tags: [] });
  const digest = createHash('sha256').update(body).digest('hex');
  await write(path.join(dir, 'downloads', PEER_B, 'posts', 'a.json'), body);
  await write(path.join(dir, 'public', 'posts', 'self.json'), body);
  const api = fakeApi({ dataDir: dir, messages: [], calls });
  const bridge = new RamingaUiBridge(api, { dataDir: dir, subscribe: fakeStream().subscribe });
  const sid = 'p3-exact-local-0001';
  try {
    await bridge.open(sid);
    // Remote offline/no current manifest: the exact retained hash is readable
    // even though the caller does not know its size.
    const remote = await bridge.peerFilePreview(sid, PEER_B, 'posts/a.json', digest, 0);
    assert.equal(remote.status, 'ok');
    assert.equal(remote.sha256, digest);
    assert.equal(remote.localCopy, 'available');
    assert.match(remote.text, /离线的本机副本/);

    const wrongRemote = await bridge.peerFilePreview(sid, PEER_B, 'posts/a.json', 'f'.repeat(64), 0);
    assert.notEqual(wrongRemote.status, 'ok');
    assert.equal(wrongRemote.text, '');
    assert.doesNotMatch(wrongRemote.error || '', /离线的本机副本/);

    // The local public path is read directly; it does not require the mine
    // list to be loaded and never goes through a peer manifest.
    const local = await bridge.mineFilePreview(sid, 'posts/self.json', digest, 0);
    assert.equal(local.status, 'ok');
    assert.equal(local.sha256, digest);
    assert.match(local.text, /离线的本机副本/);
    const wrongLocal = await bridge.mineFilePreview(sid, 'posts/self.json', 'e'.repeat(64), 0);
    assert.equal(wrongLocal.status, 'hash-mismatch');
    assert.equal(wrongLocal.text, '');
  } finally {
    bridge.dispose();
  }
});

test('private impression save preserves unknown fields and surfaces stale hash conflicts', async () => {
  const dir = await makeMemoryDir();
  const calls = { messages: 0, markRead: 0, favorites: 0, setFavorite: 0 };
  const api = fakeApi({ dataDir: dir, messages: [], calls });
  const bridge = new RamingaUiBridge(api, { dataDir: dir, subscribe: fakeStream().subscribe });
  const sid = 'p3-impression-0001';
  try {
    await bridge.open(sid);
    const memory = await bridge.contactMemory(sid, PEER_A);
    const saved = await bridge.saveContactImpression(sid, {
      peerId: PEER_A, impressionId: 'imp-1', summary: '仍然克制，但更愿意交流。',
      uncertainty: 'low', expectedSha256: memory.sha256,
    });
    assert.equal(saved.saved, true);
    assert.equal(saved.conflict, false);
    assert.equal(saved.memory.contact.impressions[0].summary, '仍然克制，但更愿意交流。');
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'agent', 'contacts', PEER_A, 'memory.json'), 'utf8'));
    assert.equal(raw.unknown_top, 'keep');
    assert.equal(raw.unknown_contact, 'keep-contact');
    assert.equal(raw.observations[0].unknown_observation, 'keep-observation');
    assert.equal(raw.impressions[0].unknown_impression, 'keep-impression');
    assert.equal(raw.curiosities[0].unknown_curiosity, 'keep-curiosity');
    assert.deepEqual(raw.impressions[0].evidence_refs.event_ids, ['evt-2']);

    const conflict = await bridge.saveContactImpression(sid, {
      peerId: PEER_A, impressionId: 'imp-1', summary: '并发覆盖', uncertainty: 'high', expectedSha256: memory.sha256,
    });
    assert.equal(conflict.saved, false);
    assert.equal(conflict.conflict, true);
    assert.match(conflict.error, /已在别处修改|未覆盖/);
    assert.equal(calls.markRead, 0);
    assert.equal(calls.messages >= 1, true);
  } finally {
    bridge.dispose();
  }
});

test('contact memory carries full message bodies, Journey reports and public-clue provenance', async () => {
  const dir = await makeMemoryDir();
  const session = path.join(dir, 'agent', 'sessions', 's1');
  await write(path.join(session, 'report.md'), [
    '# Journey Report',
    '',
    '- **Session ID:** s1',
    '- **Status:** completed',
    '',
    '## 1. Journey overview',
    '',
    '这次拜访从公开资料开始，聊到了潮汐和旧信；公开通讯录里的一条线索只做了记录。',
    '',
  ].join('\n'));
  const eventsFile = path.join(session, 'events.jsonl');
  const existing = await fs.readFile(eventsFile, 'utf8');
  await write(eventsFile, `${existing}${JSON.stringify({
    schema_version: 1, event_id: 'e4', sequence: 4, timestamp: '2026-11-18T09:43:00Z',
    type: 'candidate_selected', peer_id: PEER_B, source_peer_id: PEER_A,
    summary: '从公开通讯录看到一位新对象，只记录线索，没有访问。',
    evidence_refs: { message_ids: [], content_paths: [], event_ids: [] },
  })}\n`);
  const api = fakeApi({ dataDir: dir, messages: [message({ id: 'm-in', direction: 'in', text: '这是一条真实的长消息正文。', at: 1000 })], calls: { messages: 0, markRead: 0, favorites: 0, setFavorite: 0 } });
  const bridge = new RamingaUiBridge(api, { dataDir: dir, subscribe: fakeStream().subscribe });
  const sid = 'p3-memory-provenance-0001';
  try {
    await bridge.open(sid);
    const memory = await bridge.contactMemory(sid, PEER_A);
    const messageItem = memory.timeline.find((item) => item.kind === 'message');
    assert.equal(messageItem.body, '这是一条真实的长消息正文。');
    assert.equal(messageItem.sourceKind, 'message');
    const visit = memory.timeline.find((item) => item.eventType === 'visit_completed');
    assert.equal(visit.sourceKind, 'visit');
    assert.match(visit.source, /实际访问/);
    const report = memory.timeline.find((item) => item.sourceKind === 'journeyReport');
    assert.ok(report);
    assert.match(report.summary, /潮汐和旧信/);
    assert.equal(report.body, '');
    assert.match(report.source, /报告/);
    const clue = memory.timeline.find((item) => item.sourceKind === 'publicClue');
    assert.ok(clue);
    assert.equal(clue.subjectPeerId, PEER_B);
    assert.equal(clue.sourcePeerId, PEER_A);
    assert.match(clue.source, /公开线索/);
    assert.match(clue.source, /未自动访问或联系/);
    assert.doesNotMatch(clue.source, /已联系|已访问/);
  } finally {
    bridge.dispose();
  }
});

test('one corrupt memory leaves persisted messages and the HTML report summary available', async () => {
  const dir = await makeMemoryDir();
  const statePath = path.join(dir, 'agent', 'sessions', 's1', 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.summary = '可以检索的 HTML 报告摘要';
  await write(statePath, state);
  await write(path.join(dir, 'agent', 'contacts', PEER_A, 'memory.json'), '{broken');
  const bridge = new RamingaUiBridge(fakeApi({ dataDir: dir, messages: [], calls: {} }), { dataDir: dir, subscribe: fakeStream().subscribe });
  const sid = 'per-peer-memory-regression';
  try {
    await bridge.open(sid);
    const first = await bridge.contactMemory(sid, PEER_A);
    assert.equal(first.sources.memory.state, 'error');
    assert.equal(first.sources.messages.state, 'available');
    assert.equal(first.sources.journey.state, 'available');
    assert.ok(first.timeline.some((item) => item.kind === 'journey'));
    assert.ok(first.timeline.some((item) => item.summary === state.summary));
    assert.equal((await bridge.contactMemory(sid, PEER_B)).sources.memory.state, 'missing');
    assert.equal((await bridge.saveContactImpression(sid, {
      peerId: PEER_B, impressionId: '', summary: '另一位联系人的印象', uncertainty: 'low', expectedSha256: '',
    })).saved, true);
  } finally {
    bridge.dispose();
  }
});

test('Journey HTML is loaded by session with offline assets and sandbox restrictions', async () => {
  const dir = await makeMemoryDir();
  const reportDir = path.join(dir, 'agent', 'sessions', 's1');
  await write(path.join(reportDir, 'report.html'), '<html><head><title>自由日志</title><link rel="stylesheet" href="assets/style.css"></head><body><p>正文</p><script>alert(1)</script><img src="../../persona.md"><img src="https://example.invalid/a.png"></body></html>');
  await write(path.join(reportDir, 'assets', 'style.css'), 'body { color: teal; }');
  const bridge = new RamingaUiBridge(fakeApi({ dataDir: dir, messages: [], calls: {} }), { dataDir: dir, subscribe: fakeStream().subscribe });
  const sid = 'journey-html-regression';
  try {
    await bridge.open(sid);
    const report = await bridge.journeyReport(sid, 's1');
    assert.equal(report.state, 'available');
    assert.equal(report.title, '自由日志');
    assert.match(report.html, /color:\s*teal/);
    assert.match(report.html, /Content-Security-Policy/i);
    assert.doesNotMatch(report.html, /<script|example\.invalid|persona\.md/);
    assert.equal((await bridge.journeyReport(sid, '../s1')).state, 'error');
    assert.equal((await bridge.journeyReport(sid, 'missing')).state, 'missing');
  } finally {
    bridge.dispose();
  }
});
