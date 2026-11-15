// Real DOM pagination regressions for the >500-row history window.
//
// These tests simulate the DSH host contract (latest refresh plus explicit
// older pages), not the daemon: the page objects are the same normalized shape
// returned by the DSH bridge. They focus on cursor independence, generation
// isolation, retry/busy feedback, per-Peer windows and reading-anchor restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';
import { createViewState } from '../src/view-state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWPaginationPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWPaginationPeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function friend(peerId, overrides = {}) {
  return { peerId, name: '', description: '', connection: 'connected', paused: false, ...overrides };
}

function contacts(friends) {
  return {
    friends,
    at: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    connectionFreshness: 'live',
    total: friends.length,
  };
}

function conversations(rows = []) {
  return {
    conversations: rows,
    at: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    retention: { retainedMessages: 527, oldestRetainedAt: 1, maxStoredMessages: 50000 },
  };
}

function message(id, text, overrides = {}) {
  return {
    messageId: id,
    peerId: PEER_A,
    direction: 'in',
    text,
    acked: true,
    createdAt: 1_000,
    ackedAt: null,
    deliveryStatus: 'received',
    deliveryError: '',
    origin: 'unknown',
    deliveryUpdatedAt: null,
    clientRequestId: '',
    ...overrides,
  };
}

function page(peerId, messages, overrides = {}) {
  return {
    peerId,
    messages,
    at: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    hasMore: false,
    nextBefore: '',
    retention: { retainedMessages: 527, oldestRetainedAt: 1, maxStoredMessages: 50000 },
    ...overrides,
  };
}

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
  const viewState = options.viewState ?? createViewState();
  const app = createRamingaApp(shadow, { viewState, ...options });
  return {
    dom,
    shadow,
    app,
    viewState,
    messageList: shadow.querySelector('#messageList'),
    messageInput: shadow.querySelector('#messageInput'),
    loadOlder: shadow.querySelector('#loadOlder'),
    olderError: shadow.querySelector('#messageOlderError'),
    historyRetry: shadow.querySelector('#messageHistoryRetry'),
    messageState: shadow.querySelector('#messageState'),
    messageStateTitle: shadow.querySelector('#messageStateTitle'),
    messageStateBody: shadow.querySelector('#messageStateBody'),
    messageStateRetry: shadow.querySelector('#messageStateRetry'),
    restoreNote: shadow.querySelector('#messageRestoreNote'),
    contactList: shadow.querySelector('#contactList'),
    back: shadow.querySelector('#conversationBack'),
    close: () => { app.destroy(); dom.window.close(); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function openContact(ui, peerId = PEER_A) {
  ui.app.setContacts(contacts([friend(PEER_A), friend(PEER_B)]));
  ui.app.setConversations(conversations());
  await settle();
  const row = ui.contactList.querySelector(`button[data-contact-peer="${peerId}"]`);
  assert.ok(row, 'contact row exists');
  row.click();
  await settle();
}

function history(count, peerId = PEER_A, start = 1) {
  return Array.from({ length: count }, (_, index) => {
    const number = start + index;
    return message(`m${String(number).padStart(4, '0')}`, `消息 ${number}`, {
      peerId,
      createdAt: 1_700_000_000_000 + number * 1000,
    });
  });
}

/** Fixed-page host: latest 100, then 100-row older pages by message ID. */
function pagedHost(all, { olderDelay = 0 } = {}) {
  const calls = { latest: 0, older: [] };
  const latest = () => all.slice(-100);
  const latestPage = () => {
    const rows = latest();
    return page(PEER_A, rows, { hasMore: all.length > rows.length, nextBefore: rows[0].messageId });
  };
  const olderPage = (before) => {
    const index = all.findIndex((row) => row.messageId === before);
    assert.ok(index > 0, `cursor ${before} exists and has older rows`);
    const start = Math.max(0, index - 100);
    const rows = all.slice(start, index);
    return page(PEER_A, rows, {
      hasMore: start > 0,
      nextBefore: start > 0 ? rows[0].messageId : '',
    });
  };
  return {
    calls,
    latestPage,
    onLoadMessages: async (peerId) => {
      assert.equal(peerId, PEER_A);
      calls.latest += 1;
      return latestPage();
    },
    onLoadOlder: async (peerId, before) => {
      assert.equal(peerId, PEER_A);
      calls.older.push(before);
      if (olderDelay > 0) await new Promise((resolve) => setTimeout(resolve, olderDelay));
      return olderPage(before);
    },
  };
}

test('a latest refresh between every older page never resets the cursor (>500 rows)', async () => {
  const all = history(527);
  const host = pagedHost(all);
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: host.onLoadMessages,
    onLoadOlder: host.onLoadOlder,
  });
  try {
    await openContact(ui);
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100);
    assert.equal(ui.loadOlder.hidden, false);

    // Each older click is preceded by the exact automatic latest refresh that
    // used to overwrite chat.nextBefore with the newest page's cursor.
    for (let click = 0; click < 5; click += 1) {
      ui.app.setMessagePage(host.latestPage());
      await settle();
      assert.equal(ui.loadOlder.hidden, false, `history button is still valid before click ${click + 1}`);
      ui.loadOlder.click();
      await settle();
      await settle();
    }

    const rows = [...ui.messageList.querySelectorAll('.rm-message')];
    const ids = rows.map((row) => row.dataset.messageId);
    assert.equal(rows.length, 527, 'every retained row is rendered exactly once');
    assert.equal(new Set(ids).size, 527, 'stable message IDs are not duplicated');
    assert.equal(ids[0], 'm0001', 'the oldest retained row is present');
    assert.equal(ids.at(-1), 'm0527', 'the newest row remains present');
    assert.deepEqual(host.calls.older, ['m0428', 'm0328', 'm0228', 'm0128', 'm0028']);
    assert.equal(ui.loadOlder.hidden, true, 'the button hides at the real end of retained history');

    // A later auto refresh must not resurrect an invalid button.
    ui.app.setMessagePage(host.latestPage());
    await settle();
    assert.equal(ui.loadOlder.hidden, true, 'latest refresh cannot reopen an exhausted history');
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 527);
  } finally {
    ui.close();
  }
});

test('same-timestamp pages merge by stable ID and do not steal the reading position', async () => {
  const base = history(220);
  // Force a wide equal-timestamp group. IDs break the tie deterministically.
  for (const row of base.slice(20, 120)) row.createdAt = 1_700_000_000_000;
  const host = pagedHost(base);
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: host.onLoadMessages,
    onLoadOlder: host.onLoadOlder,
  });
  try {
    await openContact(ui);
    Object.defineProperty(ui.messageList, 'scrollHeight', { configurable: true, get: () => 10_000 });
    Object.defineProperty(ui.messageList, 'clientHeight', { configurable: true, get: () => 200 });
    ui.messageList.scrollTop = 3600;
    ui.messageList.dispatchEvent(new ui.dom.window.Event('scroll'));
    ui.messageInput.value = '分页期间保留的草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));

    // A latest refresh carrying the same timestamp group plus a new row must
    // merge, not replace, and must keep the reader's scrollTop.
    const latest = host.latestPage();
    ui.app.setMessagePage(page(PEER_A, [
      message('m0221', '新消息', { createdAt: 1_700_000_000_500 }),
      ...latest.messages,
    ], { hasMore: true, nextBefore: latest.nextBefore }));
    await settle();
    assert.equal(ui.messageList.scrollTop, 3600, 'a new bottom row does not steal the reading position');
    assert.equal(ui.messageInput.value, '分页期间保留的草稿');

    for (let click = 0; click < 2; click += 1) {
      ui.loadOlder.click();
      await settle();
      await settle();
    }
    const ids = [...ui.messageList.querySelectorAll('.rm-message')].map((row) => row.dataset.messageId);
    assert.equal(new Set(ids).size, ids.length, 'equal timestamps still merge by message ID');
    const equalGroup = ids.filter((id) => {
      const number = Number(id.slice(1));
      return number >= 21 && number <= 120;
    });
    assert.equal(equalGroup.length, 100, 'the whole equal-timestamp group is present once');
  } finally {
    ui.close();
  }
});

test('a failed older page is honest, keeps the cursor and is retryable', async () => {
  const all = history(150);
  const calls = [];
  let fail = true;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async () => {
      const rows = all.slice(-100);
      return page(PEER_A, rows, { hasMore: true, nextBefore: rows[0].messageId });
    },
    onLoadOlder: async (_peerId, before) => {
      calls.push(before);
      if (fail) {
        fail = false;
        throw new Error('夹具模拟读取更早消息失败');
      }
      const index = all.findIndex((row) => row.messageId === before);
      const rows = all.slice(Math.max(0, index - 100), index);
      return page(PEER_A, rows, { hasMore: false, nextBefore: '' });
    },
  });
  try {
    await openContact(ui);
    ui.loadOlder.click();
    await settle();
    await settle();
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100, 'failed page adds no rows');
    assert.equal(ui.loadOlder.hidden, false, 'the retry control stays reachable');
    assert.match(ui.olderError.textContent, /读取更早消息失败/);
    assert.match(ui.olderError.textContent, /可以重试/);
    assert.equal(ui.loadOlder.textContent, '加载更早消息');
    assert.equal(ui.loadOlder.getAttribute('aria-disabled'), 'false');

    ui.loadOlder.click();
    await settle();
    await settle();
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 150);
    assert.deepEqual(calls, ['m0051', 'm0051'], 'retry uses the same unadvanced cursor');
    assert.equal(ui.olderError.hidden, true);
    assert.equal(ui.loadOlder.hidden, true, 'successful final page hides the button');
  } finally {
    ui.close();
  }
});

test('a busy older request shows progress, blocks duplicates and still resolves', async () => {
  const all = history(150);
  let release;
  let calls = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async () => {
      const rows = all.slice(-100);
      return page(PEER_A, rows, { hasMore: true, nextBefore: rows[0].messageId });
    },
    onLoadOlder: (_peerId, before) => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => {
          const index = all.findIndex((row) => row.messageId === before);
          const rows = all.slice(Math.max(0, index - 100), index);
          resolve(page(PEER_A, rows, { hasMore: false, nextBefore: '' }));
        };
      });
    },
  });
  try {
    await openContact(ui);
    ui.loadOlder.click();
    await settle();
    assert.equal(calls, 1);
    assert.equal(ui.loadOlder.textContent, '正在读取更早消息…');
    assert.equal(ui.loadOlder.getAttribute('aria-disabled'), 'true');
    ui.loadOlder.click();
    await settle();
    assert.equal(calls, 1, 'a second click while busy is ignored');
    release();
    await settle();
    await settle();
    assert.equal(calls, 1);
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 150);
    assert.equal(ui.loadOlder.hidden, true);
    assert.equal(ui.loadOlder.textContent, '加载更早消息');
  } finally {
    ui.close();
  }
});

test('closing and reopening the same Peer ignores a late older page', async () => {
  const all = history(200);
  let olderRelease;
  let latestCalls = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async () => {
      latestCalls += 1;
      const rows = all.slice(-100);
      return page(PEER_A, rows, { hasMore: true, nextBefore: rows[0].messageId });
    },
    onLoadOlder: () => new Promise((resolve) => {
      olderRelease = () => {
        const rows = all.slice(0, 100);
        resolve(page(PEER_A, rows, { hasMore: false, nextBefore: '' }));
      };
    }),
  });
  try {
    await openContact(ui);
    ui.loadOlder.click();
    await settle();
    assert.equal(ui.loadOlder.textContent, '正在读取更早消息…');

    ui.back.click();
    await settle();
    assert.equal(ui.viewState.page, 'contacts');
    ui.contactList.querySelector(`button[data-contact-peer="${PEER_A}"]`).click();
    await settle();
    assert.equal(latestCalls, 2, 'reopening performs a fresh latest read');
    const before = ui.messageList.querySelectorAll('.rm-message').length;
    assert.equal(before, 100);

    olderRelease();
    await settle();
    await settle();
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100, 'late older page from the previous generation is ignored');
    assert.equal(ui.loadOlder.getAttribute('aria-disabled'), 'false');
    assert.equal(ui.loadOlder.textContent, '加载更早消息');
  } finally {
    ui.close();
  }
});

test('each Peer keeps its own loaded window and forward cursor', async () => {
  const allA = history(230, PEER_A);
  const allB = history(130, PEER_B, 1000);
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A), friend(PEER_B)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => {
      const all = peerId === PEER_A ? allA : allB;
      const rows = all.slice(-100);
      return page(peerId, rows, { hasMore: all.length > 100, nextBefore: rows[0].messageId });
    },
    onLoadOlder: async (peerId, before) => {
      const all = peerId === PEER_A ? allA : allB;
      const index = all.findIndex((row) => row.messageId === before);
      const rows = all.slice(Math.max(0, index - 100), index);
      return page(peerId, rows, { hasMore: index - rows.length > 0, nextBefore: rows.length > 0 ? rows[0].messageId : '' });
    },
  });
  try {
    await openContact(ui, PEER_A);
    ui.loadOlder.click();
    await settle();
    await settle();
    ui.loadOlder.click();
    await settle();
    await settle();
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 230);
    assert.equal(ui.loadOlder.hidden, true);
    assert.equal(ui.messageInput.value, '');

    ui.back.click();
    await settle();
    ui.contactList.querySelector(`button[data-contact-peer="${PEER_B}"]`).click();
    await settle();
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100);
    assert.equal(ui.loadOlder.hidden, false);
    ui.loadOlder.click();
    await settle();
    await settle();
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 130);
    assert.equal(ui.loadOlder.hidden, true);
    ui.messageList.scrollTop = 500;
    ui.messageList.dispatchEvent(new ui.dom.window.Event('scroll'));
    await settle();

    ui.back.click();
    await settle();
    ui.contactList.querySelector(`button[data-contact-peer="${PEER_A}"]`).click();
    await settle();
    assert.equal(ui.messageList.scrollTop, 0, 'Peer A keeps its own top position, not Peer B scrollTop');
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 230, 'Peer A window survives a switch');
    assert.equal(ui.loadOlder.hidden, true, 'Peer A stays at its own history end');
    assert.equal(ui.messageList.querySelectorAll('[data-message-id^="m1"]').length, 0, 'Peer B rows never leak into A');
  } finally {
    ui.close();
  }
});

test('a remount does not apply a stale pixel offset to a latest-only window', async () => {
  const all = history(527);
  const host = pagedHost(all);
  const viewState = createViewState();
  viewState.page = 'messages';
  viewState.pages.messages.peerId = PEER_A;
  viewState.pages.messages.returnPage = 'contacts';
  viewState.pages.messages.returnPeer = PEER_A;
  viewState.pages.messages.chatScrolls[PEER_A] = 5000;
  viewState.pages.messages.chatAnchors[PEER_A] = { messageId: 'm0300', offset: 0 };

  const ui = mountUi({
    viewState,
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: host.onLoadMessages,
    onLoadOlder: host.onLoadOlder,
  });
  try {
    await settle();
    ui.app.setMessagePage(host.latestPage());
    await settle();
    assert.notEqual(ui.messageList.scrollTop, 5000, 'raw scrollTop is not applied to the latest 100 rows');
    assert.equal(ui.restoreNote.hidden, false, 'the missing anchor has a clear path');
    assert.match(ui.restoreNote.textContent, /更早的消息/);

    for (let click = 0; click < 5; click += 1) {
      ui.loadOlder.click();
      await settle();
      await settle();
    }
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 527);
    assert.equal(ui.messageList.querySelector('[data-message-id="m0300"]') !== null, true);
    assert.equal(ui.restoreNote.hidden, true, 'loading to the anchor clears the recovery note');
  } finally {
    ui.close();
  }
});

test('a host that applies the page and also returns it does not render it twice', async () => {
  const all = history(150);
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async () => {
      const rows = all.slice(-100);
      const value = page(PEER_A, rows, { hasMore: true, nextBefore: rows[0].messageId });
      ui.app.setMessagePage(value);
      return value;
    },
    onLoadOlder: async (_peerId, before) => {
      const index = all.findIndex((row) => row.messageId === before);
      const rows = all.slice(Math.max(0, index - 100), index);
      const value = page(PEER_A, rows, { hasMore: false, nextBefore: '' });
      ui.app.appendMessagePage(value);
      return value;
    },
  });
  try {
    await openContact(ui);
    const originalReplace = ui.messageList.replaceChildren.bind(ui.messageList);
    let renders = 0;
    ui.messageList.replaceChildren = (...args) => {
      renders += 1;
      return originalReplace(...args);
    };
    ui.loadOlder.click();
    await settle();
    await settle();
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 150);
    assert.equal(renders, 1, 'one apply means one render, not a second merge/scroll');
  } finally {
    ui.close();
  }
});

test('a stalled older cursor preserves the boundary and a real retry reaches the oldest row', async () => {
  const all = history(150);
  const calls = [];
  let stalled = true;
  const latest = () => {
    const rows = all.slice(-100);
    return page(PEER_A, rows, { hasMore: true, nextBefore: rows[0].messageId });
  };
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async () => latest(),
    onLoadOlder: async (_peerId, before) => {
      calls.push(before);
      if (stalled) {
        stalled = false;
        // hasMore=true but the same cursor and no rows: not a real end.
        return page(PEER_A, [], { hasMore: true, nextBefore: before });
      }
      return page(PEER_A, all.slice(0, 50), { hasMore: false, nextBefore: '' });
    },
  });
  try {
    await openContact(ui);
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100);
    ui.loadOlder.click();
    await settle();
    await settle();
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100, 'the stalled page adds no rows');
    assert.equal(ui.loadOlder.hidden, false, 'the valid previous boundary keeps its retry entry');
    assert.equal(ui.loadOlder.textContent, '重试加载更早消息');
    assert.equal(ui.olderError.hidden, false);
    assert.match(ui.olderError.textContent, /游标没有前进/);
    assert.match(ui.olderError.textContent, /可以重试/);
    assert.doesNotMatch(ui.olderError.textContent, /最早/);
    assert.deepEqual(calls, ['m0051'], 'no automatic retry is issued');

    // A routine latest refresh must not clear the consistency error, hide the
    // retry entry, or reopen/close the boundary by itself.
    ui.app.setMessagePage(latest());
    await settle();
    assert.equal(ui.olderError.hidden, false, 'latest refresh keeps the history error');
    assert.equal(ui.loadOlder.hidden, false);
    assert.deepEqual(calls, ['m0051']);

    ui.loadOlder.click();
    await settle();
    await settle();
    assert.deepEqual(calls, ['m0051', 'm0051'], 'the manual retry uses the preserved cursor');
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 150);
    assert.equal(ui.messageList.querySelector('[data-message-id="m0001"]') !== null, true, 'the oldest row is reachable');
    assert.equal(ui.loadOlder.hidden, true, 'an explicit hasMore=false ends the history');
    assert.equal(ui.olderError.hidden, true);
  } finally {
    ui.close();
  }
});

test('an initial page without a usable older cursor is a recoverable error, not empty history', async () => {
  const all = history(150);
  const forceCalls = [];
  let latestCalls = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (_peerId, force) => {
      latestCalls += 1;
      forceCalls.push(force);
      if (latestCalls === 1) {
        return page(PEER_A, [], { hasMore: true, nextBefore: '' });
      }
      const rows = all.slice(-100);
      return page(PEER_A, rows, { hasMore: true, nextBefore: rows[0].messageId });
    },
    onLoadOlder: async (_peerId, before) => {
      const index = all.findIndex((row) => row.messageId === before);
      return page(PEER_A, all.slice(0, index), { hasMore: false, nextBefore: '' });
    },
  });
  try {
    await openContact(ui);
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 0);
    assert.equal(ui.messageState.hidden, true, 'the constrained large state is not used for this compact error');
    assert.equal(ui.olderError.hidden, false, 'an unusable cursor is shown as a history error');
    assert.match(ui.olderError.textContent, /没有返回可用的继续游标/);
    assert.match(ui.olderError.textContent, /重新读取历史/);
    assert.doesNotMatch(ui.olderError.textContent, /还没有消息/);
    assert.equal(ui.loadOlder.hidden, true, 'no older request is offered without a cursor');
    assert.equal(ui.historyRetry.hidden, false, 'the history has its own re-read control');

    // A routine latest refresh with the same invalid page cannot silently turn
    // this into an ended or empty history.
    ui.app.setMessagePage(page(PEER_A, [], { hasMore: true, nextBefore: '' }));
    await settle();
    assert.equal(ui.messageState.hidden, true);
    assert.equal(ui.olderError.hidden, false);
    assert.equal(ui.historyRetry.hidden, false);

    ui.historyRetry.click();
    await settle();
    await settle();
    assert.equal(latestCalls, 2, 'the retry re-read the latest page');
    assert.deepEqual(forceCalls, [true, true]);
    assert.equal(ui.messageState.hidden, true);
    assert.equal(ui.historyRetry.hidden, true);
    assert.equal(ui.olderError.hidden, true);
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100);
    assert.equal(ui.loadOlder.hidden, false);

    ui.loadOlder.click();
    await settle();
    await settle();
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 150);
    assert.equal(ui.messageList.querySelector('[data-message-id="m0001"]') !== null, true);
    assert.equal(ui.loadOlder.hidden, true);
  } finally {
    ui.close();
  }
});

test('only an explicit hasMore=false ends history and a later latest refresh cannot reopen it', async () => {
  const all = history(100);
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async () => page(PEER_A, all, { hasMore: false, nextBefore: '' }),
    onLoadOlder: async () => {
      throw new Error('no older request should be made after an explicit end');
    },
  });
  try {
    await openContact(ui);
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100);
    assert.equal(ui.loadOlder.hidden, true, 'hasMore=false ends the history');
    assert.equal(ui.olderError.hidden, true, 'an explicit end is not an error');
    assert.equal(ui.historyRetry.hidden, true);

    // Even a latest page that claims more history must not reopen the ended
    // boundary; the loaded rows stay intact.
    ui.app.setMessagePage(page(PEER_A, all, { hasMore: true, nextBefore: 'm0001' }));
    await settle();
    assert.equal(ui.loadOlder.hidden, true, 'latest refresh cannot reopen an explicit end');
    assert.equal(ui.olderError.hidden, true);
    assert.equal(ui.historyRetry.hidden, true);
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100);
  } finally {
    ui.close();
  }
});

test('an overlapping older page with no new rows but an advancing cursor can continue', async () => {
  const all = history(250);
  const calls = [];
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async () => {
      const rows = all.slice(-100);
      // Opaque cursor: the next page may include the already-loaded boundary
      // row (inclusive overlap) and move past it without adding a new row.
      return page(PEER_A, rows, { hasMore: true, nextBefore: 'cursor-1' });
    },
    onLoadOlder: async (_peerId, before) => {
      calls.push(before);
      if (before === 'cursor-1') {
        return page(PEER_A, [all[150]], { hasMore: true, nextBefore: 'cursor-2' });
      }
      if (before === 'cursor-2') {
        return page(PEER_A, all.slice(50, 150), { hasMore: true, nextBefore: 'cursor-3' });
      }
      if (before === 'cursor-3') {
        return page(PEER_A, all.slice(0, 50), { hasMore: false, nextBefore: '' });
      }
      throw new Error(`unexpected cursor ${before}`);
    },
  });
  try {
    await openContact(ui);
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100);
    ui.loadOlder.click();
    await settle();
    await settle();
    assert.deepEqual(calls, ['cursor-1']);
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 100, 'the overlap page added no new rows');
    assert.equal(ui.olderError.hidden, true, 'a legitimate overlap is not an error');
    assert.equal(ui.loadOlder.hidden, false, 'the advanced cursor keeps the history entry');

    ui.loadOlder.click();
    await settle();
    await settle();
    assert.deepEqual(calls, ['cursor-1', 'cursor-2'], 'the next request uses the advanced cursor');
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 200);
    assert.equal(ui.olderError.hidden, true);

    ui.loadOlder.click();
    await settle();
    await settle();
    assert.deepEqual(calls, ['cursor-1', 'cursor-2', 'cursor-3']);
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 250);
    assert.equal(ui.messageList.querySelector('[data-message-id="m0001"]') !== null, true);
    assert.equal(ui.loadOlder.hidden, true);
  } finally {
    ui.close();
  }
});

test('a stalled cursor error, retry and latest refresh preserve draft and reading position', async () => {
  const all = history(150);
  let stalled = true;
  const latest = () => {
    const rows = all.slice(-100);
    return page(PEER_A, rows, { hasMore: true, nextBefore: rows[0].messageId });
  };
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async () => latest(),
    onLoadOlder: async (_peerId, before) => {
      if (stalled) {
        stalled = false;
        return page(PEER_A, [], { hasMore: true, nextBefore: before });
      }
      return page(PEER_A, all.slice(0, 50), { hasMore: false, nextBefore: '' });
    },
  });
  try {
    await openContact(ui);
    Object.defineProperty(ui.messageList, 'scrollHeight', { configurable: true, get: () => 10_000 });
    Object.defineProperty(ui.messageList, 'clientHeight', { configurable: true, get: () => 200 });
    ui.messageList.scrollTop = 1200;
    ui.messageList.dispatchEvent(new ui.dom.window.Event('scroll'));
    ui.messageInput.value = '一致性错误期间保留的草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));

    ui.loadOlder.click();
    await settle();
    await settle();
    assert.equal(ui.olderError.hidden, false);
    assert.equal(ui.messageInput.value, '一致性错误期间保留的草稿');
    assert.equal(ui.messageList.scrollTop, 1200, 'the stalled page does not move the reading position');

    ui.app.setMessagePage(latest());
    await settle();
    assert.equal(ui.olderError.hidden, false);
    assert.equal(ui.messageInput.value, '一致性错误期间保留的草稿');
    assert.equal(ui.messageList.scrollTop, 1200, 'latest refresh keeps the reading position');

    ui.loadOlder.click();
    await settle();
    await settle();
    assert.equal(ui.messageList.querySelectorAll('.rm-message').length, 150);
    assert.equal(ui.olderError.hidden, true);
    assert.equal(ui.messageInput.value, '一致性错误期间保留的草稿');
    assert.equal(ui.messageList.scrollTop, 1200, 'retry keeps the reading position');
    assert.equal(ui.messageList.querySelector('[data-message-id="m0001"]') !== null, true);
  } finally {
    ui.close();
  }
});
