// First batch B: home recent records, searchable all-records list, independent
// Journey detail, activity-to-event location and message evidence round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';
import {
  journeyDisplayTitle,
  journeyEventCategory,
  journeyEvidenceRefs,
  journeyMatches,
  journeySummary,
  journeyVisitedPeers,
} from '../src/pages/journey-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';
const MISSING_MESSAGE = 'msg-missing-0001';

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
    onLoadActivity: async () => null,
    ...options,
    viewState: options.viewState ?? { page: 'home', home: { expandedJourneys: {}, activityExpanded: false } },
  });
  app.onLeaseReady();
  return {
    dom, shadow, app,
    text(selector) { return shadow.querySelector(selector)?.textContent ?? ''; },
    click(selector) {
      const node = typeof selector === 'string' ? shadow.querySelector(selector) : selector;
      assert.ok(node, `missing ${selector}`);
      node.click();
      return node;
    },
    close() { app.destroy(); dom.window.close(); },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function event(sequence, overrides = {}) {
  return {
    sequence,
    type: 'visit_completed',
    timestamp: `2026-11-18T09:0${sequence}:00Z`,
    summary: `事件 ${sequence}`,
    peerId: PEER_A,
    sourcePeerId: '',
    messageIds: [],
    contentPaths: [],
    messageEvidence: null,
    ...overrides,
  };
}

function session(id, overrides = {}) {
  return {
    id,
    dirModifiedAt: Date.parse('2026-11-18T10:00:00Z'),
    stateRead: 'available',
    stateError: '',
    state: {
      status: 'completed',
      mode: 'exploration',
      intent: '读一读公开内容',
      startedAt: '2026-11-18T09:00:00Z',
      updatedAt: `2026-11-18T10:0${id.length % 8}:00Z`,
      completedAt: '2026-11-18T10:05:00Z',
      completionReason: '达到本次目标',
      currentPeerId: '',
      visitedPeerIds: [PEER_A],
      discoverySources: ['本地联系人'],
    },
    eventsRead: 'available',
    eventsError: '',
    events: [event(1, { type: 'session_started', summary: '开始漫游', peerId: '' })],
    eventsTruncated: false,
    badEventLines: 0,
    reportRead: 'available',
    reportError: '',
    reportMarkdown: `# 漫游报告\n\n拜访了 ${PEER_A}，读了一份公开内容。\n\n## 反思\n\n保持克制。`,
    ...overrides,
  };
}

function journey(sessions) {
  return {
    state: 'available', at: Date.now(), freshness: 'live',
    persona: { state: 'available', markdown: '# 人设\n\n简洁。', error: '', sha256: '' },
    growth: { state: 'missing', markdown: '', error: 'missing', sha256: '' },
    sessions, sessionsState: sessions.length > 0 ? 'available' : 'missing', sessionsError: '', sessionsTruncated: false,
  };
}

function activity(operations, instanceId = 'inst-current-0001') {
  return { operations, instanceId, readAt: Date.now(), truncated: false, badLines: 0, error: '' };
}

function operation(overrides = {}) {
  return {
    operationId: 'op-1763450000000-1-abcdef12',
    pluginInstanceId: 'inst-current-0001',
    panelSessionId: 'ui-test-0001',
    journeyId: 's1',
    journeyMatch: 'current_peer',
    sessionId: 'sess-plugin-test',
    tool: 'raminga_content_get',
    targetType: 'content',
    target: { peer_id: PEER_A, path: 'posts/a.json' },
    startedAt: '2026-11-18T10:00:00.000Z',
    endedAt: '2026-11-18T10:00:03.000Z',
    result: 'ok',
    state: 'finished',
    errorCode: '',
    errorSummary: '',
    evidence: { peer_id: PEER_A, path: 'posts/a.json' },
    ...overrides,
  };
}

test('model: long saved instructions get a neutral title, summaries and peer search stay real', () => {
  const long = session('long', {
    state: {
      ...session('long').state,
      intent: '请先读取全部公开内容，然后整理一份很长的总结，并且继续访问下一个对象，完成之后写报告。',
    },
  });
  assert.equal(journeyDisplayTitle(long), '11月18日 · 漫游');
  assert.match(journeySummary(long), /拜访了/);
  assert.equal(journeyMatches(long, PEER_A), true);
  assert.equal(journeyMatches(long, '不存在的关键词'), false);

  const short = session('short');
  assert.equal(journeyDisplayTitle(short), '读一读公开内容');
  assert.equal(journeyEventCategory(event(1, { type: 'message_sent' })).label, '对话');
  assert.equal(journeyEventCategory(event(2, { type: 'candidate_selected' })).label, '线索');
  assert.equal(journeyEventCategory(event(3, { type: 'visit_started' })).label, '访问');

  const supplemented = session('event-only', {
    state: { ...session('event-only').state, currentPeerId: '', visitedPeerIds: [] },
    events: [event(1, { type: 'visit_completed', peerId: PEER_B, summary: '完成了一次访问' })],
  });
  assert.deepEqual(journeyVisitedPeers(supplemented).map((row) => [row.peerId, row.source]), [[PEER_B, 'event']]);
  const currentOnly = session('current-only', {
    state: { ...session('current-only').state, currentPeerId: PEER_B, visitedPeerIds: [] },
    events: [event(1, { type: 'candidate_selected', peerId: PEER_B, summary: '只是候选' })],
  });
  assert.deepEqual(journeyVisitedPeers(currentOnly), []);
  assert.equal(journeyMatches(currentOnly, PEER_B), true);
});

test('model: message evidence dedupes refs without inventing a direction', () => {
  const evidence = journeyEvidenceRefs(session('s1', {
    events: [
      event(1, {
        type: 'message_sent',
        messageIds: ['m-1'],
        messageEvidence: { messageId: 'm-1', peerId: PEER_A, direction: 'out', summary: '发出问候', observedAt: '2026-11-18T09:10:00Z' },
      }),
      event(2, { type: 'message_received', messageIds: ['m-1'], messageEvidence: null }),
    ],
  }));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].messageId, 'm-1');
  assert.equal(evidence[0].direction, 'out');
});

test('DOM: home keeps one activity card, compact recent tiles and collapsed read notes', async () => {
  const first = session('s1', {
    events: [
      event(1, { type: 'visit_completed', summary: '拜访了 Alice，读到一份公开笔记。' }),
      event(2, { type: 'message_sent', summary: '发出问候', messageIds: ['m-1'], peerId: PEER_A }),
    ],
  });
  const second = session('s2', { state: { ...session('s2').state, intent: '一段很长的旧任务指令，请继续访问并整理所有公开内容。' }, reportRead: 'missing', reportMarkdown: '' });
  const third = session('s3');
  const ui = mountUi({
    onLoadJourney: async () => journey([first, second, third]),
    onLoadActivity: async () => activity([]),
  });
  try {
    await settle();
    ui.app.setActivity(activity([]));
    await settle();
    assert.equal(ui.shadow.querySelector('#homeActivityEmpty').hidden, false);
    assert.match(ui.text('#homeActivityEmpty'), /暂无工具活动/);
    assert.equal(ui.shadow.querySelectorAll('#homeActivityLive:not([hidden])').length + ui.shadow.querySelectorAll('#homeActivityRecent:not([hidden])').length, 0);
    const tiles = ui.shadow.querySelectorAll('#ramingaSessionList .rm-journey-tile');
    assert.equal(tiles.length, 3);
    assert.match(tiles[1].textContent, /11月18日 · 漫游/, 'long instruction uses a neutral title');
    assert.doesNotMatch(tiles[1].textContent, /请继续访问/);
    assert.equal(ui.shadow.querySelectorAll('#ramingaSessionList img').length, 0, 'no invented cover image');
    assert.equal(ui.shadow.querySelector('#homeJourneyDetails').open, false);
    assert.match(ui.text('#homeJourneyDetails'), /读取于/);
    assert.equal(ui.shadow.querySelector('#homeJourneysAll').hidden, false);
  } finally {
    ui.close();
  }
});

test('DOM: all records search by journey and peer, clear, open older and restore query/scroll/focus', async () => {
  const sessions = [session('s1'), session('s2'), session('s3')];
  const ui = mountUi({
    onLoadJourney: async () => journey(sessions),
    onLoadActivity: async () => activity([]),
  });
  try {
    await settle();
    ui.app.setActivity(activity([]));
    await settle();
    ui.click('#homeJourneysAll');
    await settle();
    assert.equal(ui.shadow.querySelector('#page-journeys').hidden, false);
    assert.equal(ui.shadow.querySelectorAll('#journeyList .rm-journey-tile').length, 3);
    assert.match(ui.text('#journeysCount'), /共 3 条/);

    ui.shadow.querySelector('#journeyQuery').value = PEER_A;
    ui.shadow.querySelector('#journeyQuery').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    assert.equal(ui.shadow.querySelectorAll('#journeyList .rm-journey-tile').length, 3);
    assert.equal(ui.shadow.querySelector('#journeysClear').hidden, false);

    ui.shadow.querySelector('#journeyQuery').value = '读一读公开内容';
    ui.shadow.querySelector('#journeyQuery').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    assert.equal(ui.shadow.querySelectorAll('#journeyList .rm-journey-tile').length, 3);
    ui.shadow.querySelector('#journeyQuery').value = session('s1').state.intent;
    ui.shadow.querySelector('#journeyQuery').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();

    ui.shadow.querySelector('#journeyQuery').value = 's3';
    ui.shadow.querySelector('#journeyQuery').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    const filtered = ui.shadow.querySelectorAll('#journeyList .rm-journey-tile');
    assert.equal(filtered.length, 1);
    ui.shadow.querySelector('#page-journeys').scrollTop = 123;
    filtered[0].click();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-journey').hidden, false);
    assert.equal(ui.shadow.querySelector('#journeyDetail').hidden, false);
    assert.match(ui.text('#journeyDetail'), /读一读公开内容/);
    ui.click('#journeyBack');
    await settle();
    assert.equal(ui.shadow.querySelector('#page-journeys').hidden, false);
    assert.equal(ui.shadow.querySelector('#journeyQuery').value, 's3');
    assert.equal(ui.shadow.querySelector('#journeyList .rm-journey-tile').dataset.focusKey, 'journey-list:s3');

    ui.click('#journeysClear');
    await settle();
    assert.equal(ui.shadow.querySelector('#journeyQuery').value, '');
    assert.equal(ui.shadow.querySelectorAll('#journeyList .rm-journey-tile').length, 3);
  } finally {
    ui.close();
  }
});

test('DOM: independent detail orders summary, route, events, sources and evidence; long tasks stay in source', async () => {
  const item = session('s1', {
    state: {
      ...session('s1').state,
      intent: '请先读取公开内容，然后整理成很长的总结并继续访问下一个对象，最后写报告。',
      currentPeerId: PEER_B,
      visitedPeerIds: [PEER_A],
    },
    events: [
      event(1, { type: 'visit_started', summary: '开始访问 Alice', peerId: PEER_A }),
      event(2, { type: 'message_sent', summary: '发出问候', messageIds: ['m-1'], peerId: PEER_A }),
      event(3, { type: 'curiosity_added', summary: '想知道 Bob 的公开笔记', peerId: PEER_B }),
    ],
  });
  const ui = mountUi(
    { onLoadJourney: async () => journey([item]), onLoadActivity: async () => activity([]) },
  );
  try {
    await settle();
    ui.app.setActivity(activity([]));
    await settle();
    ui.click('#ramingaSessionList .rm-journey-tile');
    await settle();
    const text = ui.text('#journeyDetail');
    assert.match(text, /11月18日 · 漫游/);
    assert.doesNotMatch(ui.text('#journeyDetail .rm-journey-summary-text'), /请先读取公开内容/);
    assert.match(ui.text('#journeyDetail .rm-journey-summary'), /摘要 · Agent 生成的报告内容，不是传输证据/);
    assert.match(text, /实际路线/);
    assert.match(text, /访问|线索|对话/);
    assert.match(text, /消息证据/);
    assert.match(text, /核对当前保留消息/);
    assert.doesNotMatch(ui.text('#journeyDetail .rm-journey-detail-head'), /记录 s1/);
    assert.doesNotMatch(ui.text('#journeyDetail .rm-journey-detail-head'), /state\.json/);
    const route = ui.shadow.querySelector('#journeyDetail .rm-journey-route');
    assert.doesNotMatch(route.textContent, /state\.json/);
    const routeNodes = [...route.querySelectorAll('.rm-journey-route-line [data-journey-route-peer]')];
    assert.equal(routeNodes.length, 1, 'only the recorded visit is on the arrow chain');
    assert.equal(routeNodes[0].dataset.journeyRoutePeer, PEER_A);
    assert.equal(route.querySelectorAll('.rm-journey-route-arrow').length, 1,
      'the unvisited current candidate does not get its own arrow');
    const currentAside = route.querySelector('[data-journey-route-aside="current"]');
    assert.ok(currentAside, 'current candidate is labelled next to the route');
    assert.match(currentAside.textContent, /未记录为已访问/);
    assert.equal(currentAside.closest('.rm-journey-route-line'), null, 'current candidate is not a route node');
    assert.equal(route.querySelectorAll('[data-journey-route-aside="clue"]').length, 0,
      'the current candidate is not repeated as a clue');
    const source = ui.shadow.querySelector('#journeyDetail .rm-journey-source');
    assert.equal(source.open, false);
    assert.match(source.textContent, /任务说明原文/);
    assert.match(source.textContent, /请先读取公开内容/);
    assert.match(source.textContent, /记录标识/);
    assert.match(source.textContent, /s1/);
    assert.match(source.textContent, /events\.jsonl/);
    assert.match(source.textContent, /路线只来自本机 state\.json/);
    const eventKinds = [...ui.shadow.querySelectorAll('#journeyDetail [data-category]')].map((node) => node.dataset.category);
    assert.deepEqual(eventKinds, ['visit', 'chat', 'clue']);
  } finally {
    ui.close();
  }
});

test('DOM: a current-only candidate stays off the route and searchable by peer', async () => {
  const item = session('s-current', {
    state: {
      ...session('s-current').state,
      intent: '先看看线索里的新朋友',
      currentPeerId: PEER_B,
      visitedPeerIds: [],
    },
    events: [
      event(1, { type: 'candidate_selected', summary: '在公开线索里看到了 Bob，还没有开始访问。', peerId: PEER_B }),
    ],
    reportRead: 'missing',
    reportMarkdown: '',
  });
  assert.deepEqual(journeyVisitedPeers(item), [], 'a current candidate is not a visit');
  assert.equal(journeyMatches(item, PEER_B), true, 'the current candidate stays searchable');
  assert.equal(journeyMatches(item, PEER_A), false);

  const ui = mountUi({ onLoadJourney: async () => journey([item]), onLoadActivity: async () => activity([]) });
  try {
    await settle();
    ui.app.setActivity(activity([]));
    await settle();
    const tile = ui.shadow.querySelector('#ramingaSessionList .rm-journey-tile');
    assert.doesNotMatch(tile.textContent, /访问 1 个对象/);
    tile.click();
    await settle();
    const route = ui.shadow.querySelector('#journeyDetail .rm-journey-route');
    const routeLine = route.querySelector('.rm-journey-route-line');
    assert.equal(routeLine.querySelectorAll('[data-journey-route-peer]').length, 0,
      'no candidate is drawn as a visited route node');
    assert.equal(routeLine.querySelectorAll('.rm-journey-route-arrow').length, 0);
    assert.match(routeLine.textContent, /记录中没有访问对象/);
    const current = route.querySelector('[data-journey-route-aside="current"]');
    assert.ok(current);
    assert.equal(current.dataset.journeyRoutePeer, PEER_B);
    assert.match(current.textContent, /当前对象/);
    assert.match(current.textContent, /未记录为已访问，不计入路线/);
    assert.equal(current.closest('.rm-journey-route-line'), null);
    assert.equal(route.querySelectorAll('[data-journey-route-aside="clue"]').length, 0,
      'the current candidate is annotated once, not as a separate clue');
    assert.doesNotMatch(ui.text('#journeyDetail .rm-journey-detail-head'), /s-current/);
    assert.match(ui.shadow.querySelector('#journeyDetail .rm-journey-source').textContent, /s-current/);
  } finally {
    ui.close();
  }
});

test('DOM: state.json diagnostics stay in the collapsed source, not the header or route', async () => {
  const item = session('s-error', {
    stateRead: 'error',
    stateError: 'Unexpected token < in JSON at position 0',
    state: {
      ...session('s-error').state,
      status: 'running',
      currentPeerId: '',
      visitedPeerIds: [],
    },
  });
  const ui = mountUi({ onLoadJourney: async () => journey([item]), onLoadActivity: async () => activity([]) });
  try {
    await settle();
    ui.app.setActivity(activity([]));
    await settle();
    ui.click('#homeJourneysAll');
    await settle();
    ui.click('#journeyList .rm-journey-tile');
    await settle();
    const head = ui.text('#journeyDetail .rm-journey-detail-head');
    assert.doesNotMatch(head, /state\.json|Unexpected token|状态记录为运行中/);
    const chip = ui.shadow.querySelector('#journeyDetail .rm-journey-status');
    assert.match(chip.title, /Journey 文件字段不是工具调用证据/);
    const route = ui.text('#journeyDetail .rm-journey-route');
    assert.doesNotMatch(route, /state\.json/);
    assert.doesNotMatch(route, /状态记录为运行中/);
    const source = ui.shadow.querySelector('#journeyDetail .rm-journey-source');
    assert.equal(source.open, false);
    assert.match(source.textContent, /状态说明：状态记录为运行中/);
    assert.match(source.textContent, /state\.json 无法解析/);
    assert.match(source.textContent, /路线只来自本机 state\.json/);
    assert.ok(source.querySelector('.rm-journey-check[data-tone="error"]'));
    assert.equal(ui.shadow.querySelector('#journeyDetail > .rm-journey-check[data-tone="error"]'), null);
    assert.match(ui.text('#journeyDetail .rm-journey-summary'), /Agent 生成的报告内容/);
  } finally {
    ui.close();
  }
});

test('DOM: activity click opens the exact Journey detail and highlights the matching event or explains a miss', async () => {
  const item = session('s1', {
    events: [
      event(1, { type: 'visit_started', summary: '开始访问 Alice', peerId: PEER_A }),
      event(2, { type: 'content_read', summary: '读取 posts/a.json', peerId: PEER_A, contentPaths: ['posts/a.json'] }),
    ],
  });
  const ui = mountUi({
    onLoadJourney: async () => journey([item]),
    onLoadActivity: async () => activity([operation()]),
    onLoadActivityDetail: async (operationId) => ({
      operation: operation({ operationId }),
      evidence: { peer_id: PEER_A, path: 'posts/a.json' },
      journey: { sessionId: 's1', exists: true, status: 'completed', mode: 'exploration', startedAt: '', updatedAt: '', completedAt: '', currentPeerId: PEER_A, visitedPeerIds: [PEER_A] },
      missingReason: '',
    }),
  });
  try {
    await settle();
    ui.app.setActivity(activity([operation()]));
    await settle();
    assert.equal(ui.shadow.querySelector('#homeActivityRecent').hidden, false);
    assert.equal(ui.shadow.querySelectorAll('#ramingaSessionList [data-journey-open="s1"]').length, 1,
      'a completed activity Journey is also reachable from the home recent grid');
    ui.click('#homeActivityRecent');
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-journey').hidden, false);
    assert.equal(ui.shadow.querySelector('[data-journey-event="2"]').dataset.highlight, 'true');
    assert.match(ui.text('#journeyDetail'), /已从本机工具活动定位/);

    // A journey id that is no longer present must not silently select another.
    const missing = mountUi({
      onLoadJourney: async () => journey([item]),
      onLoadActivity: async () => activity([operation()]),
      onLoadActivityDetail: async (operationId) => ({
        operation: operation({ operationId }),
        evidence: { peer_id: PEER_A, path: 'posts/a.json', message_ids: ['m-1'] },
        journey: { sessionId: 'gone', exists: false, status: '', mode: '', startedAt: '', updatedAt: '', completedAt: '', currentPeerId: '', visitedPeerIds: [] },
        missingReason: '关联的 Journey 记录已不在本机。',
      }),
    });
    try {
      await settle();
      missing.app.setActivity(activity([operation({ journeyId: 'gone' })]));
      await settle();
      missing.click('#homeActivityRecent');
      await settle();
      await settle();
      assert.match(missing.text('#journeyDetail'), /漫游记录已不在本机/);
      assert.match(missing.text('#journeyDetail'), /关联的工具调用/);
      assert.ok(missing.shadow.querySelector('[data-journey-fallback-peer]'));
    } finally {
      missing.close();
    }
  } finally {
    ui.close();
  }
});

test('DOM: message evidence opens the retained message and returns to the exact Journey evidence', async () => {
  const item = session('s1', {
    events: [
      event(1, {
        type: 'message_sent',
        summary: '发出问候',
        messageIds: ['m-1'],
        peerId: PEER_A,
        messageEvidence: { messageId: 'm-1', peerId: PEER_A, direction: 'out', summary: '发出问候', observedAt: '2026-11-18T09:10:00Z' },
      }),
    ],
  });
  const locateCalls = [];
  const ui = mountUi({
    onLoadJourney: async () => journey([item]),
    onLoadActivity: async () => activity([]),
    onLoadMessages: async (peerId) => ({
      peerId,
      messages: [{
        messageId: 'm-1', peerId, direction: 'out', origin: 'agent', text: '你好', createdAt: '2026-11-18T09:10:00Z',
        deliveryStatus: 'acked', acked: true, ackedAt: '2026-11-18T09:10:01Z', outboxStatus: '', errorCode: '', error: '',
      }],
      at: Date.now(), retention: null, hasMore: false, nextBefore: '', freshness: 'live', error: '',
    }),
    onLocateMessage: async (peerId, messageId) => {
      locateCalls.push([peerId, messageId]);
      return {
        found: true,
        peerId,
        messageId,
        message: { messageId, peerId, direction: 'out', origin: 'agent', text: '你好', createdAt: '2026-11-18T09:10:00Z' },
        error: null,
        scanned: 1,
        complete: true,
      };
    },
  });
  try {
    await settle();
    ui.app.setActivity(activity([]));
    await settle();
    ui.click('#ramingaSessionList .rm-journey-tile');
    await settle();
    ui.click('#journeyDetail [data-journey-locate-peer]');
    await settle();
    await settle();
    assert.deepEqual(locateCalls, [[PEER_A, 'm-1']]);
    assert.equal(ui.shadow.querySelector('#page-messages').hidden, false);
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false);
    assert.match(ui.text('#conversationBack'), /返回漫游/);
    ui.click('#conversationBack');
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-journey').hidden, false);
    assert.match(ui.text('#journeyDetail'), /当前保留记录中存在这条消息/);
    const focused = ui.shadow.activeElement;
    assert.ok(focused);
    assert.equal(focused.dataset.focusKey, 'journey-evidence:s1:1:m-1');
  } finally {
    ui.close();
  }
});

test('DOM: a cleared message shows a short missing note and does not open a substitute chat', async () => {
  const item = session('s1', {
    events: [
      event(2, {
        type: 'message_sent',
        summary: '发出问候',
        messageIds: [MISSING_MESSAGE],
        peerId: PEER_A,
      }),
    ],
  });
  const ui = mountUi({
    onLoadJourney: async () => journey([item]),
    onLoadActivity: async () => activity([]),
    onLocateMessage: async (peerId, messageId) => ({ found: false, peerId, messageId, message: null, error: null, scanned: 20, complete: true }),
  });
  try {
    await settle();
    ui.app.setActivity(activity([]));
    await settle();
    ui.click('#ramingaSessionList .rm-journey-tile');
    await settle();
    ui.click('#journeyDetail [data-journey-locate-peer]');
    await settle();
    await settle();
    assert.match(ui.text('#journeyDetail'), /已不在当前保留消息中/);
    assert.equal(ui.shadow.querySelector('#page-messages').hidden, true);
  } finally {
    ui.close();
  }
});
