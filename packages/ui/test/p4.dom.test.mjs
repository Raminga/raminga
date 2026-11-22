// P4 home activity: real tool-call card, outcomes, stale instance invalidation,
// evidence jumps and the explicit separator between Journey summaries and facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';
import { buildHomeActivity } from '../src/components/activity-strip.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';
const SHA = 'a'.repeat(64);

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

function operation(overrides = {}) {
  const started = overrides.startedAt || '2026-11-18T10:00:00.000Z';
  return {
    operationId: 'op-1763450000000-1-abcdef12',
    pluginInstanceId: 'inst-current-0001',
    panelSessionId: 'ui-test-0001',
    journeyId: '',
    journeyMatch: 'none',
    sessionId: 'sess-plugin-test',
    tool: 'raminga_peer_profile',
    targetType: 'peer_profile',
    target: { peer_id: PEER_A },
    startedAt: started,
    endedAt: '',
    result: null,
    state: 'running',
    errorCode: '',
    errorSummary: '',
    evidence: {},
    ...overrides,
  };
}
function activity(operations, instanceId = 'inst-current-0001', extra = {}) {
  return { operations, instanceId, readAt: Date.now(), truncated: false, badLines: 0, error: '', ...extra };
}
function journeySession(overrides = {}) {
  return {
    id: 's1', dirModifiedAt: 1, stateRead: 'available', stateError: '',
    state: {
      status: 'running', mode: 'exploration', intent: '读一读公开内容',
      startedAt: '2026-11-18T09:00:00Z', updatedAt: '2026-11-18T10:00:00Z',
      completedAt: '', completionReason: '', currentPeerId: PEER_A, visitedPeerIds: [PEER_A],
      discoverySources: [],
    },
    eventsRead: 'available', eventsError: '', events: [], eventsTruncated: false, badEventLines: 0,
    reportRead: 'missing', reportError: '', reportMarkdown: '', ...overrides,
  };
}
function journey(sessions = [journeySession()]) {
  return {
    state: 'available', at: Date.now(), freshness: 'live',
    persona: { state: 'available', markdown: '# 人设\n\n简洁。', error: '', sha256: '' },
    growth: { state: 'missing', markdown: '', error: 'missing', sha256: '' },
    sessions, sessionsState: 'available', sessionsError: '', sessionsTruncated: false,
  };
}

test('model: running activity wins, keeps the prototype live card and never shows Journey current_peer as a visit', () => {
  const running = operation({ tool: 'raminga_content_get', targetType: 'content', target: { peer_id: PEER_A, path: 'posts/p1/post.json' }, journeyId: 's1', journeyMatch: 'current_peer' });
  const model = buildHomeActivity({
    activity: activity([running]),
    activityCapable: true,
    journey: journey([journeySession({ state: { ...journeySession().state, status: 'running', currentPeerId: PEER_A } })]),
    peerLabel: (peerId) => (peerId === PEER_A ? 'Alice' : 'Bob'),
    now: Date.parse('2026-11-18T10:00:10Z'),
  });
  assert.equal(model.kind, 'running');
  assert.match(model.title, /正在访问：Alice/);
  assert.equal(model.statusLabel, '进行中');
  assert.equal(model.operation.operationId, running.operationId);
  assert.equal(model.target.journeyId, 's1');
  assert.equal(model.target.kind, 'journey');
  assert.doesNotMatch(model.body, /正在访问/);
  assert.doesNotMatch(model.body, /聊天正文/);

  const journeyOnly = buildHomeActivity({
    activity: activity([], 'inst-current-0001'),
    activityCapable: true,
    journey: journey([journeySession()]),
    peerLabel: () => 'Alice',
    now: Date.parse('2026-11-18T10:00:10Z'),
  });
  assert.equal(journeyOnly.kind, 'journey-live');
  assert.equal(journeyOnly.title, 'Journey 进行中');
  assert.doesNotMatch(journeyOnly.title, /正在访问/);
  assert.match(journeyOnly.body, /不是工具访问证据/);
  assert.equal(journeyOnly.operation, null);
});

test('model: result labels sort by started_at and no evidence never invents a link', () => {
  const earlier = operation({
    operationId: 'op-1763450000000-1-aaaaaaaa', tool: 'raminga_status', target: {}, targetType: 'status',
    startedAt: '2026-11-18T10:00:00Z', endedAt: '2026-11-18T10:00:05Z', state: 'finished', result: 'ok',
  });
  const later = operation({
    operationId: 'op-1763450000000-2-bbbbbbbb', tool: 'raminga_chat_history', target: {}, targetType: 'chat_history',
    startedAt: '2026-11-18T10:00:02Z', endedAt: '2026-11-18T10:00:03Z', state: 'finished', result: 'timeout',
    errorCode: 'wrapper_timeout', errorSummary: '包装层超时，结果未知。',
  });
  const model = buildHomeActivity({
    activity: activity([later, earlier]),
    activityCapable: true,
    journey: journey([]),
    now: Date.parse('2026-11-18T10:01:00Z'),
  });
  assert.equal(model.kind, 'recent');
  assert.equal(model.operation.operationId, later.operationId, 'latest startedAt wins, not completion order');
  assert.equal(model.statusLabel, '超时');
  assert.equal(model.target.kind, 'none');
  assert.equal(model.showDetail, true);
  assert.equal(model.history[0].operationId, later.operationId);
  assert.match(model.title, /最近活动/);
  assert.doesNotMatch(model.body, /已送达|已回复/);
});

test('model: instance change filters old running marks out of the live strip', () => {
  const oldRunning = operation({ pluginInstanceId: 'inst-old-0001', startedAt: '2026-11-18T09:59:00Z' });
  const model = buildHomeActivity({
    activity: activity([oldRunning], 'inst-new-0002'),
    activityCapable: true,
    previousInstanceId: 'inst-old-0001',
    journey: journey([journeySession()]),
    now: Date.parse('2026-11-18T10:01:00Z'),
  });
  assert.notEqual(model.kind, 'running');
  assert.equal(model.operation, null);
  assert.match(model.body, /旧实例|实例已更换/);
  assert.equal(model.history[0].historical, true);
  const oldOnly = buildHomeActivity({
    activity: activity([], 'inst-new-0002'),
    activityCapable: true,
    journey: journey([]),
    now: Date.parse('2026-11-18T10:01:00Z'),
  });
  assert.equal(oldOnly.kind, 'empty');
  assert.match(oldOnly.title, /暂无工具活动/);
  assert.match(oldOnly.body, /不等于 Agent 未运行/);
  assert.doesNotMatch(oldOnly.body, /Agent 正在休息|Agent 已暂停/);
});

test('DOM: running card preserves orb, status badge and chevron; completion updates in place', async () => {
  const ui = mountUi({ onLoadJourney: async () => journey([journeySession()]) });
  try {
    await settle();
    ui.app.setActivity(activity([operation()], 'inst-current-0001'));
    await settle();
    const live = ui.shadow.querySelector('#homeActivityLive');
    assert.equal(live.hidden, false);
    assert.equal(ui.shadow.querySelector('#homeActivityRecent').hidden, true);
    assert.ok(live.querySelector('.rm-home-live-orb'));
    assert.ok(live.querySelector('.rm-journey-status'));
    assert.equal(live.querySelector('.rm-journey-status').textContent, '进行中');
    assert.ok(live.querySelector('.rm-home-live-arrow'));
    assert.equal(live.querySelector('.rm-home-live-arrow').textContent, '›');
    assert.match(ui.text('#homeAgentStatusText'), /正在执行工具调用/);
    assert.match(ui.text('#homeActivityDisclosure'), /工具调用记录/);

    ui.app.setActivity(activity([{ ...operation(), state: 'finished', result: 'ok', endedAt: '2026-11-18T10:00:03Z', evidence: { peer_id: PEER_A, sha256: SHA } }], 'inst-current-0001'));
    await settle();
    assert.equal(ui.shadow.querySelector('#homeActivityLive').hidden, true);
    const recent = ui.shadow.querySelector('#homeActivityRecent');
    assert.equal(recent.hidden, false);
    assert.match(recent.textContent, /最近活动/);
    assert.match(recent.textContent, /完成/);
    assert.doesNotMatch(ui.text('#homeAgentStatusText'), /正在执行/);
    assert.ok(recent.querySelector('.rm-home-live-orb'));
    assert.ok(recent.querySelector('.rm-journey-status'));
    assert.ok(recent.querySelector('.rm-home-live-arrow'));
  } finally {
    ui.close();
  }
});

test('DOM: all five terminal results render distinct honest badges', async () => {
  for (const [result, label] of [['ok', '完成'], ['error', '失败'], ['timeout', '超时'], ['interrupted', '已中断'], ['unknown', '结果未知']]) {
    const ui = mountUi({ onLoadJourney: async () => journey([]) });
    try {
      await settle();
      ui.app.setActivity(activity([{
        ...operation(), state: 'finished', result, endedAt: '2026-11-18T10:00:03Z',
        errorCode: result === 'ok' ? '' : 'tool_error', errorSummary: result === 'ok' ? '' : '记录摘要',
      }], 'inst-current-0001'));
      await settle();
      const recent = ui.shadow.querySelector('#homeActivityRecent');
      assert.equal(recent.hidden, false, result);
      assert.match(recent.textContent, new RegExp(label), result);
      assert.equal(recent.querySelector('.rm-journey-status').textContent, label, result);
    } finally {
      ui.close();
    }
  }
});

test('DOM: a failed activity read clears the previous running card instead of keeping it live', async () => {
  const ui = mountUi({ onLoadJourney: async () => journey([]) });
  try {
    await settle();
    ui.app.setActivity(activity([operation()], 'inst-current-0001'));
    await settle();
    assert.equal(ui.shadow.querySelector('#homeActivityLive').hidden, false);
    ui.app.setActivityError('Raminga 插件不可用/已卸载');
    await settle();
    assert.equal(ui.shadow.querySelector('#homeActivityLive').hidden, true);
    assert.equal(ui.shadow.querySelector('#homeActivityRecent').hidden, true);
    const empty = ui.shadow.querySelector('#homeActivityEmpty');
    assert.equal(empty.hidden, false);
    assert.match(empty.textContent, /插件不可用/);
    assert.doesNotMatch(ui.text('#homeAgentStatusText'), /正在执行|正在访问/);
  } finally {
    ui.close();
  }
});

test('DOM: no tool record does not claim rest, pause or a continuous Journey visit', async () => {
  const ui = mountUi({ onLoadJourney: async () => journey([journeySession()]) });
  try {
    await settle();
    ui.app.setActivity(activity([], 'inst-current-0001'));
    await settle();
    assert.equal(ui.shadow.querySelector('#homeActivityEmpty').hidden, true);
    // A running Journey without tool activity is shown as a Journey record,
    // never as a live "visiting" card.
    assert.equal(ui.shadow.querySelector('#homeActivityLive').hidden, false);
    assert.match(ui.text('#homeActivityLive'), /Journey 进行中/);
    assert.doesNotMatch(ui.text('#homeActivityLive'), /正在访问/);
    assert.match(ui.text('#homeActivityLive'), /不是工具访问证据/);
    assert.doesNotMatch(ui.text('#homeAgentStatusText'), /休息|暂停/);
  } finally {
    ui.close();
  }
});

test('DOM: evidence jump prefers Journey, then peer, then an explicit missing reason', async () => {
  const detailCalls = [];
  const locateCalls = [];
  const ui = mountUi({
    onLoadJourney: async () => journey([journeySession({ state: { ...journeySession().state, status: 'completed' } })]),
    onLoadPeerProfile: async (peerId) => ({ peerId, localName: 'Alice', remoteName: 'Alice', found: true, text: '', files: [], at: Date.now(), error: null, freshness: 'live' }),
    onLoadActivityDetail: async (operationId) => {
      detailCalls.push(operationId);
      return {
        operation: operation({ operationId, state: 'finished', result: 'ok', endedAt: '2026-11-18T10:00:03Z', journeyId: 's1', journeyMatch: 'current_peer' }),
        evidence: { peer_id: PEER_A, sha256: SHA, message_ids: ['m-1'] },
        journey: { sessionId: 's1', exists: true, status: 'completed', mode: 'exploration', startedAt: '2026-11-18T09:00:00Z', updatedAt: '2026-11-18T10:00:00Z', completedAt: '2026-11-18T10:00:03Z', currentPeerId: PEER_A, visitedPeerIds: [PEER_A] },
        missingReason: '',
      };
    },
    onLocateMessage: async (peerId, messageId) => {
      locateCalls.push([peerId, messageId]);
      return { found: false, peerId, messageId, message: null, error: null, scanned: 5, complete: true };
    },
  });
  try {
    await settle();
    ui.app.setActivity(activity([{
      ...operation(), state: 'finished', result: 'ok', journeyId: 's1', journeyMatch: 'current_peer',
      endedAt: '2026-11-18T10:00:03Z', evidence: { peer_id: PEER_A, message_ids: ['m-1'] },
    }], 'inst-current-0001'));
    await settle();
    ui.click('#homeActivityRecent');
    await settle();
    await settle();
    // Journey exists and wins over the contact fallback.
    assert.equal(ui.shadow.querySelector('#page-journey').hidden, false, 'the exact Journey detail is opened');
    assert.match(ui.text('#journeyDetail'), /Journey/);
    assert.match(ui.text('#journeyDetail'), /读一读公开内容/);
    ui.click('#journeyBack');
    await settle();

    // The activity detail exposes fact labels, route evidence, message evidence and source.
    ui.click('#homeActivityToggle');
    await settle();
    assert.ok(detailCalls.length > 0);
    const detail = ui.text('#homeActivityDetail');
    assert.match(detail, /本机工具调用记录/);
    assert.match(detail, /路由与证据摘要/);
    assert.match(detail, /Journey 关联/);
    assert.match(detail, /消息证据/);
    assert.match(detail, /不是阅读回执/);
    assert.match(detail, /来源/);
    assert.match(detail, /不是传输证据/);
    const locate = ui.shadow.querySelector('[data-activity-locate-peer]');
    assert.ok(locate);
    locate.click();
    await settle();
    assert.deepEqual(locateCalls, [[PEER_A, 'm-1']]);
  } finally {
    ui.close();
  }
});

test('DOM: Journey summary is labelled separately from the tool-call record', async () => {
  const ui = mountUi({
    onLoadJourney: async () => journey([journeySession({
      state: { ...journeySession().state, status: 'completed' },
      reportRead: 'available', reportMarkdown: '# 报告\n\n一次漫游。',
    })]),
  });
  try {
    await settle();
    ui.app.setActivity(activity([], 'inst-current-0001'));
    await settle();
    // With a completed Journey and no tool activity the card is empty; the
    // Journey report lives in the independent detail and carries its own label.
    assert.match(ui.text('#homeActivityDisclosure'), /两者不互相替代/);
    const journeyCard = ui.shadow.querySelector('#ramingaSessionList .rm-journey-tile');
    assert.ok(journeyCard);
    journeyCard.click();
    await settle();
    assert.match(ui.text('#journeyDetail .rm-journey-summary'), /Agent 生成的报告内容，不是传输证据/);
    const report = ui.shadow.querySelector('#journeyDetail .rm-journey-report');
    assert.ok(report);
    assert.equal(report.open, false);
  } finally {
    ui.close();
  }
});

test('DOM: old instances appear only in the explicit history with a 上次实例 label', async () => {
  const old = operation({
    operationId: 'op-1763450000000-9-ffffffff', pluginInstanceId: 'inst-old-0001',
    state: 'finished', result: 'ok', endedAt: '2026-11-18T09:59:05Z',
  });
  const ui = mountUi({ onLoadJourney: async () => journey([journeySession()]) });
  try {
    await settle();
    ui.app.setActivity(activity([old], 'inst-new-0002'));
    await settle();
    assert.equal(ui.shadow.querySelector('#homeActivityLive').hidden, false);
    assert.match(ui.text('#homeActivityLive'), /Journey 进行中/);
    assert.doesNotMatch(ui.text('#homeActivityLive'), /最近活动/);
    assert.equal(ui.shadow.querySelector('#homeActivityEmpty').hidden, true);
    ui.click('#homeActivityToggle');
    await settle();
    const history = ui.text('#homeActivityDetail');
    assert.match(history, /工具调用历史/);
    assert.match(history, /上次实例/);
  } finally {
    ui.close();
  }
});

test('DOM: peer evidence without a Journey still offers the contact fallback', async () => {
  const profileCalls = [];
  const ui = mountUi({
    onLoadJourney: async () => journey([]),
    onLoadPeerProfile: async (peerId) => {
      profileCalls.push(peerId);
      return { peerId, localName: 'Alice', remoteName: 'Alice', found: true, text: '', files: [], at: Date.now(), error: null, freshness: 'live' };
    },
    onLoadActivityDetail: async (operationId) => ({
      operation: operation({
        operationId, state: 'finished', result: 'ok', endedAt: '2026-11-18T10:00:03Z',
        journeyId: '', journeyMatch: 'none', tool: 'raminga_peer_profile',
        targetType: 'peer_profile', target: { peer_id: PEER_A },
      }),
      evidence: { peer_id: PEER_A },
      journey: null,
      missingReason: '',
    }),
  });
  try {
    await settle();
    ui.app.setActivity(activity([{
      ...operation(), state: 'finished', result: 'ok', journeyId: '', journeyMatch: 'none',
      tool: 'raminga_peer_profile', targetType: 'peer_profile', target: { peer_id: PEER_A },
      endedAt: '2026-11-18T10:00:03Z', evidence: { peer_id: PEER_A },
    }], 'inst-current-0001'));
    await settle();
    ui.click('#homeActivityToggle');
    await settle();
    const peer = ui.shadow.querySelector('[data-activity-peer]');
    assert.ok(peer, 'peer fallback must not depend on a Journey association');
    assert.match(peer.textContent, /查看相关对象/);
    peer.click();
    await settle();
    assert.deepEqual(profileCalls, [PEER_A]);
    assert.ok(ui.shadow.querySelector('#profileView')?.hidden === false, 'contact fallback opens the profile');
  } finally {
    ui.close();
  }
});
