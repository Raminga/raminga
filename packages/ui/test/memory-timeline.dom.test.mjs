// Second-batch item 4: grouped interaction timeline, long-message previews and
// the compact private impression. All data in these tests is synthetic UI input;
// the real-host acceptance lives in scripts/ui-acceptance/batch2-04.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';
import {
  MEMORY_GROUP_PAGE,
  groupContactMemory,
  memoryDayKey,
  memoryDayLabel,
  memoryEvidenceFocusKey,
  memoryPreview,
  memorySourceKind,
  summarizeContactMemory,
} from '../src/memory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';

function mountUi(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const host = dom.window.document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = template;
  for (const dialog of shadow.querySelectorAll('dialog')) {
    if (typeof dialog.showModal === 'function') continue;
    dialog.showModal = function showModal() { if (!this.open) this.open = true; };
    dialog.close = function close() {
      if (!this.open) return;
      this.open = false;
      this.dispatchEvent(new dom.window.Event('close'));
    };
  }
  globalThis.AbortController = dom.window.AbortController;
  globalThis.document = dom.window.document;
  const app = createRamingaApp(shadow, {
    ...options,
    viewState: options.viewState ?? { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} } } },
  });
  app.onLeaseReady();
  return {
    dom, shadow, app,
    click(selector) {
      const node = typeof selector === 'string' ? shadow.querySelector(selector) : selector;
      assert.ok(node, `missing ${selector}`);
      node.click();
      return node;
    },
    text(selector) { return shadow.querySelector(selector)?.textContent ?? ''; },
    close() { app.destroy(); dom.window.close(); },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function friend(overrides = {}) {
  return { peerId: PEER_A, name: 'Alice', description: '', connection: 'connected', paused: false, addrs: [], unreadCount: 0, ...overrides };
}
function contacts(friends) {
  return { friends, at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: friends.length };
}
function conversations(items) {
  return {
    conversations: items, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    retention: { retainedMessages: 10, oldestRetainedAt: null, maxStoredMessages: 1000 },
    totalUnread: 0,
  };
}
function messagePage(peerId, messages) {
  return {
    peerId, messages, at: Date.now(), error: null, errorAt: null, freshness: 'live', hasMore: false, nextBefore: '',
    retention: { retainedMessages: messages.length, oldestRetainedAt: null, maxStoredMessages: 1000 },
  };
}
function profile(overrides = {}) {
  return {
    peerId: PEER_A, localName: 'Alice', remoteName: 'Alice', found: true,
    text: '# Alice\n\n公开资料。', files: ['profile/index.md'], at: Date.now(), error: null, freshness: 'live',
    agentCard: { state: 'available', card: null, error: '' },
    manifest: { source: 'remote', entries: [], error: '', truncated: false }, node: null, ...overrides,
  };
}

function startOfLocalDay(daysAgo, hour = 10) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, 0, 0, 0).getTime();
}

function messageItem(id, at, text, overrides = {}) {
  return {
    id: `message:${id}`, kind: 'message', at, summary: text.slice(0, 240), body: text,
    source: '对方消息', sourceKind: 'message', eventType: 'message', private: true,
    evidence: { sessionIds: [], eventIds: [], messageIds: [id], contentPaths: [], contentSha256: [] },
    direction: 'in', origin: 'unknown', ...overrides,
  };
}

function buildTimeline() {
  const today = startOfLocalDay(0, 10);
  const yesterday = startOfLocalDay(1, 9);
  const older = startOfLocalDay(3, 8);
  const longText = '第一段：退潮以后，石阶上留下了一层很薄的盐。\n第二段：我把没有寄出的信重新读了一遍，又把潮位记在本子上。\n第三段：如果下次风小一点，也许可以沿着海岸多走一会儿，把旧灯塔和雨声都听完。\n第四段：我把这些句子留在本机，只给下一次重逢留一个开头，不把整封信抄进任何公开内容。\n第五段：这些话只是给自己看的记录，不是对方确认过的事实。';
  const items = [
    messageItem('m-today-1', today + 1_000, '今天的第一条消息'),
    messageItem('m-today-2', today + 2_000, '今天的第二条消息'),
    messageItem('m-today-3', today + 3_000, '今天的第三条消息'),
    messageItem('m-long', yesterday + 1_000, longText, { direction: 'out', origin: 'agent', source: 'Agent 消息' }),
    messageItem('m-yesterday-2', yesterday + 2_000, '昨天的另一条消息'),
    messageItem('m-old', older + 1_000, '更早的一天'),
    {
      id: 'journey:s1:2', kind: 'journey', at: today + 4_000, summary: '完成真实访问', body: '完成真实访问',
      source: '实际访问 · Journey 记录', sourceKind: 'visit', eventType: 'visit_completed', private: true,
      evidence: { sessionIds: ['s1'], eventIds: ['s1:2'], messageIds: [], contentPaths: ['posts/a.json'], contentSha256: [] },
      direction: '', origin: '',
    },
    {
      id: 'journey-report:s1', kind: 'journey', at: today + 5_000, summary: '这次拜访从公开资料开始，聊到了潮汐和旧信。',
      body: '', source: 'Journey 报告 · 摘要（原文在漫游详情）', sourceKind: 'journeyReport', eventType: 'report', private: true,
      evidence: { sessionIds: ['s1'], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] },
      direction: '', origin: '',
    },
    {
      id: 'journey:s1:3', kind: 'journey', at: today + 6_000,
      summary: '从公开通讯录里看到一位新对象，只记下线索，没有访问。', body: '从公开通讯录里看到一位新对象，只记下线索，没有访问。',
      source: '公开线索 · 来源节点公开通讯录中的声明（未自动访问或联系）', sourceKind: 'publicClue',
      eventType: 'candidate_selected', sourcePeerId: PEER_A, subjectPeerId: PEER_B, private: true,
      evidence: { sessionIds: ['s1'], eventIds: ['s1:3'], messageIds: [], contentPaths: [], contentSha256: [] },
      direction: '', origin: '',
    },
    {
      id: 'observation:obs-1', kind: 'observation', at: older + 2_000, summary: '读过公开散步记录。', body: '读过公开散步记录。',
      source: '私有观察 · contact-notes', eventType: 'observation', private: true,
      evidence: { sessionIds: ['s1'], eventIds: [], messageIds: [], contentPaths: ['posts/a.json'], contentSha256: [] },
      direction: '', origin: '',
    },
    {
      id: 'impression:imp-1', kind: 'impression', at: older + 3_000,
      summary: '表达克制但愿意交流；这只是私有印象，不是聊天记录。', body: '表达克制但愿意交流；这只是私有印象，不是聊天记录。',
      source: '私有印象 · 确定性 中', eventType: 'impression', private: true,
      evidence: { sessionIds: ['s1'], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] },
      direction: '', origin: '',
    },
    {
      id: 'observation:no-time', kind: 'observation', at: 0, summary: '一条没有可用时间的私有观察。', body: '一条没有可用时间的私有观察。',
      source: '私有观察 · contact-notes', eventType: 'observation', private: true,
      evidence: { sessionIds: [], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] },
      direction: '', origin: '',
    },
  ];
  return { items, today, yesterday, older, longText };
}

function memoryPayload(items, overrides = {}) {
  return {
    peerId: PEER_A, state: 'available', sha256: 'f'.repeat(64), schemaVersion: 2,
    contact: {
      peerId: PEER_A, displayNameSnapshot: 'Alice', updatedAt: new Date().toISOString(),
      observations: [], curiosities: [],
      impressions: [{
        id: 'imp-1', summary: '表达克制但愿意交流；这只是私有印象，不是聊天记录。', uncertainty: 'medium',
        createdAt: new Date(startOfLocalDay(3, 8) + 3_000).toISOString(),
        updatedAt: new Date(startOfLocalDay(3, 8) + 3_000).toISOString(),
        evidenceRefs: { sessionIds: ['s1'], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] },
      }],
    },
    timeline: items, timelineTruncated: false, error: '', at: Date.now(), ...overrides,
  };
}

async function openProfile(ui) {
  ui.app.setContacts(contacts([friend()]));
  await settle();
  ui.click('button[data-nav="contacts"]');
  await settle();
  ui.click('#contactList button[data-contact-peer]');
  await settle();
  await settle();
}

test('memory grouping uses real dates, separates clue/report/private sources and keeps an unknown bucket', () => {
  const { items, today, yesterday, older } = buildTimeline();
  const grouped = groupContactMemory(items, { now: today });
  assert.equal(grouped.days.length, 4);
  assert.equal(grouped.days[0].key, memoryDayKey(today));
  assert.match(memoryDayLabel(today, today), /^今天/);
  assert.match(memoryDayLabel(yesterday, today), /^昨天/);
  assert.notEqual(memoryDayLabel(older, today), memoryDayLabel(today, today));
  assert.equal(grouped.days.at(-1).label, '日期未知');
  const summary = summarizeContactMemory(grouped, { now: today });
  assert.equal(summary.total, items.length);
  assert.equal(summary.counts.message, 6);
  assert.equal(summary.counts.visit, 1);
  assert.equal(summary.counts.journeyReport, 1);
  assert.equal(summary.counts.publicClue, 1);
  assert.equal(summary.counts.observation, 2);
  assert.equal(summary.counts.impression, 1);
  assert.equal(summary.unknown, 1);
  const clue = items.find((item) => item.id === 'journey:s1:3');
  assert.equal(memorySourceKind(clue), 'publicClue');
  assert.match(memoryPreview('a'.repeat(200)), /…$/);
  const textGroup = grouped.days[0].groups.find((group) => group.title === '对话片段');
  assert.ok(textGroup);
  assert.equal(textGroup.items[0].id, 'message:m-today-3');
});

test('memory dates reject out-of-range values and use local calendar days across DST', () => {
  const invalid = [
    8_640_000_000_000_001,
    Number.MAX_SAFE_INTEGER,
    Number.POSITIVE_INFINITY,
    -1,
    Number.NaN,
    'not-a-date',
  ];
  for (const value of invalid) {
    assert.equal(memoryDayKey(value), 'unknown', String(value));
    assert.equal(memoryDayLabel(value), '日期未知', String(value));
  }
  // Both ends of the representable Date range stay local and never throw.
  assert.notEqual(memoryDayKey(1), 'unknown');
  assert.doesNotThrow(() => memoryDayLabel(1, Date.now()));
  const maxDate = 8_640_000_000_000_000;
  assert.notEqual(memoryDayKey(maxDate), 'unknown');
  assert.doesNotThrow(() => memoryDayLabel(maxDate, maxDate));
  // Saved view states from before item-specific keys remain readable.
  assert.equal(memoryEvidenceFocusKey(PEER_A, '', 'm-legacy'), `profile-evidence:${PEER_A}:m-legacy`);

  const today = startOfLocalDay(0, 10);
  const items = [
    messageItem('valid', today + 1_000, '时间有效的消息'),
    messageItem('huge', 8_640_000_000_000_001, '超出 Date 范围的消息'),
    messageItem('maxsafe', Number.MAX_SAFE_INTEGER, '无法解析的消息'),
  ];
  const grouped = groupContactMemory(items, { now: today });
  assert.equal(grouped.days.length, 2);
  assert.equal(grouped.days.at(-1).label, '日期未知');
  const summary = summarizeContactMemory(grouped, { now: today });
  assert.equal(summary.unknown, 2);
  assert.equal(summary.earliest, today + 1_000);
  assert.equal(summary.latest, today + 1_000);
  assert.match(summary.firstLabel, /^今天/);

  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const springNow = new Date(2026, 2, 9, 12).getTime();
    const springYesterday = new Date(2026, 2, 8, 12).getTime();
    assert.match(memoryDayLabel(springYesterday, springNow), /^昨天/);
    const fallNow = new Date(2026, 10, 2, 12).getTime();
    const fallYesterday = new Date(2026, 10, 1, 12).getTime();
    assert.match(memoryDayLabel(fallYesterday, fallNow), /^昨天/);
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
});

test('out-of-range timestamps stay in the unknown bucket without breaking the interaction panel', async () => {
  const today = startOfLocalDay(0, 10);
  const items = [
    messageItem('m-valid', today + 1_000, '仍然可见的有效消息'),
    messageItem('m-huge', 8_640_000_000_000_001, '超出 Date 范围的消息'),
    {
      id: 'journey:s-invalid:4', kind: 'journey', at: Number.MAX_SAFE_INTEGER,
      summary: '无法解析时间的漫游事件', body: '无法解析时间的漫游事件',
      source: '实际访问 · Journey 记录', sourceKind: 'visit', eventType: 'visit_completed', private: true,
      evidence: { sessionIds: ['s-invalid'], eventIds: ['s-invalid:4'], messageIds: [], contentPaths: [], contentSha256: [] },
      direction: '', origin: '',
    },
  ];
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend()]),
    onLoadConversations: async () => conversations([]),
    onLoadPeerProfile: async () => profile(),
    onLoadContactMemory: async () => memoryPayload(items, { contact: null }),
  });
  try {
    await openProfile(ui);
    const timeline = ui.shadow.querySelector('#profileTimeline');
    assert.equal(timeline.hidden, false);
    const headers = [...ui.shadow.querySelectorAll('#profileTimeline .rm-memory-day-head h3')]
      .map((node) => node.textContent);
    assert.ok(headers.some((value) => value === '日期未知'), headers);
    assert.match(ui.text('#profileMemorySummary'), /本轮读取到 3 条/);
    assert.match(ui.text('#profileMemoryKinds'), /时间未记录 2/);
    assert.match(timeline.textContent, /仍然可见的有效消息/);
    assert.match(timeline.textContent, /超出 Date 范围的消息/);
    assert.match(timeline.textContent, /无法解析时间的漫游事件/);
    const unknownTime = timeline.querySelector('.rm-memory-event[data-memory-item-id="message:m-huge"] time');
    assert.equal(unknownTime.textContent, '时间未知');
    assert.equal(unknownTime.hasAttribute('datetime'), false);
  } finally {
    ui.close();
  }
});

test('profile first screen shows the impression, summary and collapsed real groups; long text expands', async () => {
  const { items, longText } = buildTimeline();
  const memory = memoryPayload(items);
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend()]),
    onLoadConversations: async () => conversations([]),
    onLoadPeerProfile: async () => profile(),
    onLoadContactMemory: async () => memory,
  });
  try {
    await openProfile(ui);
    const card = ui.shadow.querySelector('#profileImpressionCard');
    assert.ok(card);
    assert.match(card.textContent, /仅本机可见/);
    assert.match(ui.text('#profileMemorySummary'), /历史摘要/);
    assert.match(ui.text('#profileMemoryKinds'), /消息 6/);
    assert.match(ui.text('#profileMemoryKinds'), /公开线索 1/);
    assert.match(ui.text('#profileMemoryKinds'), /私有记忆 3/);
    assert.match(ui.text('#profileMemorySource'), /持久消息、Journey 事件\/报告与私有记忆/);
    assert.equal(ui.shadow.querySelectorAll('#profileTimeline .rm-memory-day').length, 2, 'only the newest two days are revealed first');
    assert.equal(ui.shadow.querySelector('#profileMemoryMore').hidden, false);
    const todayGroup = [...ui.shadow.querySelectorAll('#profileTimeline details[data-memory-group]')]
      .find((node) => node.dataset.memoryGroup.startsWith('messages:'));
    assert.ok(todayGroup);
    assert.equal(todayGroup.open, false, 'a multi-message group is collapsed by default');
    assert.match(todayGroup.textContent, /3 条/);
    todayGroup.querySelector('summary').click();
    await settle();
    assert.equal(todayGroup.open, true);
    assert.match(todayGroup.textContent, /今天的第一条消息/);

    // Reveal older days and the long message's real original text.
    ui.click('#profileMemoryMore');
    await settle();
    assert.equal(ui.shadow.querySelectorAll('#profileTimeline .rm-memory-day').length, 4);
    assert.equal(ui.shadow.querySelector('#profileMemoryMore').hidden, true);
    const longGroup = [...ui.shadow.querySelectorAll('#profileTimeline details[data-memory-group]')]
      .find((node) => node.textContent.includes('退潮以后'));
    assert.ok(longGroup);
    assert.equal(longGroup.open, false);
    longGroup.querySelector('summary').click();
    await settle();
    assert.equal(longGroup.open, true);
    const longTextNode = longGroup.querySelector('details.rm-memory-text');
    assert.ok(longTextNode);
    assert.equal(longTextNode.open, false);
    const longRow = longTextNode.closest('.rm-memory-event');
    assert.ok(longRow);
    assert.match(longRow.querySelector('.rm-memory-summary').textContent, /…$/);
    longTextNode.querySelector('summary').click();
    await settle();
    assert.equal(longTextNode.open, true);
    assert.equal(longTextNode.querySelector('.rm-memory-body').textContent, longText);

    // Evidence remains attached to the exact persisted message inside the group.
    const evidence = longGroup.querySelector('[data-memory-message="m-long"]');
    assert.ok(evidence);
    const focusKey = memoryEvidenceFocusKey(PEER_A, 'message:m-long', 'm-long');
    assert.equal(evidence.dataset.focusKey, focusKey);

    // The clue is labelled as a claim, not a visit or a contact.
    const clue = [...ui.shadow.querySelectorAll('#profileTimeline .rm-memory-event')]
      .find((node) => node.dataset.memorySource === 'publicClue');
    assert.ok(clue);
    assert.match(clue.textContent, /公开线索/);
    assert.match(clue.textContent, /未自动访问或联系/);
    assert.doesNotMatch(clue.textContent, /已建立联系/);
    const report = [...ui.shadow.querySelectorAll('#profileTimeline .rm-memory-event')]
      .find((node) => node.dataset.memorySource === 'journeyReport');
    assert.ok(report);
    assert.match(report.textContent, /Journey 报告/);
  } finally {
    ui.close();
  }
});

test('message evidence from a collapsed group returns to the same expanded group, scroll and focus', async () => {
  const { items } = buildTimeline();
  const memory = memoryPayload(items);
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend()]),
    onLoadConversations: async () => conversations([]),
    onLoadPeerProfile: async () => profile(),
    onLoadContactMemory: async () => memory,
    onLoadMessages: async (peerId) => messagePage(peerId, [{
      messageId: 'm-long', peerId, direction: 'in', text: '更早的真实消息', acked: false,
      createdAt: Date.now() - 86_400_000, ackedAt: 0, deliveryStatus: 'received', deliveryError: '', origin: 'unknown',
    }]),
  });
  try {
    await openProfile(ui);
    ui.click('#profileMemoryMore');
    await settle();
    const group = [...ui.shadow.querySelectorAll('#profileTimeline details[data-memory-group]')]
      .find((node) => node.querySelector('[data-memory-message="m-long"]'));
    assert.ok(group);
    group.querySelector('summary').click();
    await settle();
    const profileView = ui.shadow.querySelector('#profileView');
    profileView.scrollTop = 120;
    const evidence = group.querySelector('[data-memory-message="m-long"]');
    evidence.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false);
    assert.equal(ui.shadow.querySelector('#messageList [data-message-id="m-long"]') !== null, true);
    ui.click('#conversationBack');
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.equal(group.open, true, 'the expanded group survives the chat round trip');
    assert.equal(profileView.scrollTop, 120);
    assert.equal(ui.shadow.activeElement?.dataset?.focusKey, memoryEvidenceFocusKey(PEER_A, 'message:m-long', 'm-long'));
  } finally {
    ui.close();
  }
});

test('a message id cited by several rows returns to the clicked citation and keeps the draft', async () => {
  const today = startOfLocalDay(0, 10);
  const shared = 'm-shared-reference';
  const items = [
    messageItem(shared, today + 3_000, '共享的真实消息正文'),
    messageItem('m-same-group', today + 4_000, '同一对话组里的另一条消息'),
    {
      id: 'journey:s-duplicate:4', kind: 'journey', at: today + 5_000,
      summary: '收到共享消息的漫游事件', body: '收到共享消息的漫游事件',
      source: '实际访问 · Journey 记录', sourceKind: 'journeyEvent', eventType: 'message_received', private: true,
      evidence: { sessionIds: ['s-duplicate'], eventIds: ['s-duplicate:4'], messageIds: [shared], contentPaths: [], contentSha256: [] },
      direction: '', origin: '',
    },
    {
      id: 'journey:s-duplicate:7', kind: 'journey', at: today + 6_000,
      summary: '结束访问并再次引用共享消息', body: '结束访问并再次引用共享消息',
      source: '实际访问 · Journey 记录', sourceKind: 'visit', eventType: 'visit_completed', private: true,
      evidence: { sessionIds: ['s-duplicate'], eventIds: ['s-duplicate:7'], messageIds: [shared], contentPaths: [], contentSha256: [] },
      direction: '', origin: '',
    },
  ];
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend()]),
    onLoadConversations: async () => conversations([]),
    onLoadPeerProfile: async () => profile(),
    onLoadContactMemory: async () => memoryPayload(items, { contact: null }),
    onLoadMessages: async (peerId) => messagePage(peerId, [{
      messageId: shared, peerId, direction: 'in', text: '共享的真实消息正文', acked: false,
      createdAt: today, ackedAt: 0, deliveryStatus: 'received', deliveryError: '', origin: 'unknown',
    }]),
  });
  try {
    await openProfile(ui);
    const groups = [...ui.shadow.querySelectorAll('#profileTimeline details[data-memory-group]')];
    const messageGroup = groups.find((group) => group.textContent.includes('共享的真实消息正文'));
    const journeyGroup = groups.find((group) => group.textContent.includes('收到共享消息的漫游事件'));
    assert.ok(messageGroup);
    assert.ok(journeyGroup);
    assert.equal(messageGroup.open, false);
    assert.equal(journeyGroup.open, false);
    journeyGroup.querySelector('summary').click();
    await settle();

    const e4Row = journeyGroup.querySelector('[data-memory-item-id="journey:s-duplicate:4"]');
    const e7Row = journeyGroup.querySelector('[data-memory-item-id="journey:s-duplicate:7"]');
    assert.ok(e4Row);
    assert.ok(e7Row);
    const e4 = e4Row.querySelector(`[data-memory-message="${shared}"]`);
    const e7 = e7Row.querySelector(`[data-memory-message="${shared}"]`);
    assert.ok(e4);
    assert.ok(e7);
    assert.notEqual(e4.dataset.focusKey, e7.dataset.focusKey);
    assert.equal(e4.dataset.focusKey, memoryEvidenceFocusKey(PEER_A, 'journey:s-duplicate:4', shared));

    const profileView = ui.shadow.querySelector('#profileView');
    profileView.scrollTop = 180;
    e4.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false);
    assert.equal(ui.shadow.querySelector(`#messageList [data-message-id="${shared}"]`) !== null, true);
    const input = ui.shadow.querySelector('#messageInput');
    input.value = '重复引用往返草稿';
    input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.shadow.querySelector('#conversationBack').click();
    await settle();
    assert.equal(profileView.hidden, false);
    assert.equal(messageGroup.open, false, 'another group citing the same message must stay closed');
    assert.equal(journeyGroup.open, true);
    assert.equal(profileView.scrollTop, 180);
    assert.equal(ui.shadow.activeElement, e4);
    assert.equal(ui.shadow.activeElement.closest('[data-memory-item-id]').dataset.memoryItemId, 'journey:s-duplicate:4');
    assert.notEqual(ui.shadow.activeElement.closest('[data-memory-item-id]').dataset.memoryItemId, 'journey:s-duplicate:7');

    e4.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#messageInput').value, '重复引用往返草稿');
    ui.shadow.querySelector('#conversationBack').click();
    await settle();
    assert.equal(ui.shadow.activeElement, e4);
  } finally {
    ui.close();
  }
});

test('group paging reveals older real messages inside one expanded group', async () => {
  const today = startOfLocalDay(0, 10);
  const items = Array.from({ length: MEMORY_GROUP_PAGE + 3 }, (_, index) => messageItem(
    `m-page-${index}`, today + index * 1_000, `第 ${index + 1} 条真实消息`,
  ));
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend()]),
    onLoadConversations: async () => conversations([]),
    onLoadPeerProfile: async () => profile(),
    onLoadContactMemory: async () => memoryPayload(items, { contact: null }),
  });
  try {
    await openProfile(ui);
    const group = ui.shadow.querySelector('#profileTimeline details[data-memory-group]');
    group.querySelector('summary').click();
    await settle();
    assert.equal(group.querySelectorAll('.rm-memory-event').length, MEMORY_GROUP_PAGE);
    const more = group.querySelector('.rm-memory-group-more');
    assert.ok(more);
    more.click();
    await settle();
    const refreshed = ui.shadow.querySelector('#profileTimeline details[data-memory-group]');
    assert.equal(refreshed.querySelectorAll('.rm-memory-event').length, MEMORY_GROUP_PAGE + 3);
    assert.equal(refreshed.querySelector('.rm-memory-group-more'), null);
  } finally {
    ui.close();
  }
});

test('private impression validates empty input, shows the save receipt and expands long text', async () => {
  const { items } = buildTimeline();
  const memory = memoryPayload(items);
  memory.contact.impressions[0].summary = '这是一段很长的私有印象。'.repeat(20);
  let savedInput = null;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend()]),
    onLoadConversations: async () => conversations([]),
    onLoadPeerProfile: async () => profile(),
    onLoadContactMemory: async () => memory,
    onSaveContactImpression: async (input) => {
      savedInput = input;
      const updated = {
        ...memory,
        sha256: 'e'.repeat(64),
        contact: {
          ...memory.contact,
          impressions: [{ ...memory.contact.impressions[0], summary: input.summary, uncertainty: input.uncertainty }],
        },
      };
      return { saved: true, conflict: false, sha256: updated.sha256, savedAt: Date.now(), contact: updated.contact, memory: updated, error: '' };
    },
  });
  try {
    await openProfile(ui);
    assert.equal(ui.shadow.querySelector('#profileImpressionToggle').hidden, false);
    assert.equal(ui.shadow.querySelector('#profileImpressionSummary').classList.contains('is-expanded'), false);
    ui.click('#profileImpressionToggle');
    assert.equal(ui.shadow.querySelector('#profileImpressionSummary').classList.contains('is-expanded'), true);
    ui.click('#profileImpressionEdit');
    assert.equal(ui.shadow.querySelector('#impressionDialog').open, true);
    const textarea = ui.shadow.querySelector('#impressionSummary');
    textarea.value = '   ';
    ui.shadow.querySelector('#impressionForm').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.match(ui.text('#impressionDialogNote'), /不能为空/);
    assert.equal(savedInput, null);
    textarea.value = '仅本机唯一标记 UI-ITEM4-MARKER';
    ui.shadow.querySelector('#impressionForm').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(savedInput.expectedSha256, 'f'.repeat(64));
    assert.equal(savedInput.impressionId, 'imp-1');
    assert.equal(ui.shadow.querySelector('#impressionDialog').open, false);
    assert.match(ui.text('#profileImpressionSummary'), /UI-ITEM4-MARKER/);
    assert.match(ui.text('#profileImpressionStatus'), /已保存到本机私有记忆/);
    assert.match(ui.text('#profileImpressionStatus'), /friends\.json/);
  } finally {
    ui.close();
  }
});
