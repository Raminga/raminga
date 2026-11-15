// Shared UI + DSH panel runtime integration without a daemon.
//
// The fake RPC supplies the same normalized pages as the real bridge, while
// the real runtime owns latest/older request channels and the real app owns
// the per-Peer cursor. This catches cursor resets and dropped older requests
// that unit tests of either side could miss.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';
import { createViewState } from '../src/view-state.js';
import { createPanelRuntime } from '../../../plugins/dsh/ui/panel-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER = '12D3KooWPaginationRuntimePeerAAAAAAAAAAAAAAAAAAAAAAAA';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function history(count) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `m${String(index + 1).padStart(4, '0')}`,
    peerId: PEER,
    direction: 'in',
    text: `消息 ${index + 1}`,
    acked: true,
    createdAt: 1_700_000_000_000 + index * 1000,
    ackedAt: null,
    deliveryStatus: 'received',
    deliveryError: '',
    origin: 'unknown',
    deliveryUpdatedAt: null,
    clientRequestId: '',
  }));
}

function page(rows, overrides = {}) {
  return {
    peerId: PEER,
    messages: rows,
    at: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    hasMore: false,
    nextBefore: '',
    retention: { retainedMessages: rows.length, oldestRetainedAt: rows[0]?.createdAt ?? null, maxStoredMessages: 50000 },
    ...overrides,
  };
}

function snapshot() {
  return {
    sessionId: 'ui-pagination-0001',
    status: {
      peerId: 'local-peer', nodeId: 'local-node', version: 'test', apiVersion: '3',
      connections: [{ peerId: PEER, route: 'direct', transport: 'tcp' }], peers: [],
    },
    statusAt: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    stream: { phase: 'open', since: Date.now(), lastOpenAt: Date.now(), error: null },
    events: [],
    stats: { openSessions: 1, subscriptions: 1, streamActive: true, streamPhase: 'open' },
  };
}

function fakeTimers() {
  let next = 1;
  const intervals = new Map();
  return {
    setInterval(callback) { const id = next++; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout() { return next++; },
    clearTimeout() {},
  };
}

test('real runtime keeps the older cursor while its latest channel refreshes', async () => {
  const all = history(527);
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const host = dom.window.document.getElementById('host');
  globalThis.AbortController = dom.window.AbortController;
  globalThis.document = dom.window.document;

  const calls = [];
  let app = null;
  const contacts = {
    friends: [{ peerId: PEER, name: '', description: '', connection: 'connected', paused: false }],
    at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
  };
  const conversations = {
    conversations: [{ peerId: PEER, lastMessageId: all.at(-1).messageId, direction: 'in', preview: '消息 527', lastAt: all.at(-1).createdAt, deliveryStatus: 'received', origin: 'unknown', messageCount: all.length }],
    at: Date.now(), error: null, errorAt: null, freshness: 'live', retention: null,
  };
  const rpc = {
    async open() { return { ok: true, value: snapshot() }; },
    async poll() { return { ok: true, value: snapshot() }; },
    async refresh() { return { ok: true, value: snapshot() }; },
    async close() { return { ok: true, value: { openSessions: 0, subscriptions: 0, streamActive: false } }; },
    async contacts() { return { ok: true, value: contacts }; },
    async conversations() { return { ok: true, value: conversations }; },
    async messages(_session, peerId, before) {
      assert.equal(peerId, PEER);
      calls.push(before);
      if (before === '') {
        const rows = all.slice(-100);
        return { ok: true, value: page(rows, { hasMore: true, nextBefore: rows[0].messageId }) };
      }
      const index = all.findIndex((row) => row.messageId === before);
      const rows = all.slice(Math.max(0, index - 100), index);
      return {
        ok: true,
        value: page(rows, { hasMore: index - rows.length > 0, nextBefore: rows[0]?.messageId ?? '' }),
      };
    },
  };

  const runtime = createPanelRuntime({
    rpc,
    mount(target, options) {
      const shadow = target.attachShadow({ mode: 'open' });
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
      app = createRamingaApp(shadow, options);
      return app;
    },
    viewState: createViewState(),
    resolvePhase: () => 'ready',
    sessionId: 'ui-pagination-0001',
    onBootError: (error) => { throw error; },
    logger: { info() {}, warn() {} },
    timers: fakeTimers(),
  });
  try {
    runtime.start(host);
    await flush();
    await settle();
    const shadow = host.shadowRoot;
    const row = shadow.querySelector(`button[data-contact-peer="${PEER}"]`);
    assert.ok(row, 'contact row is rendered');
    row.click();
    await flush();
    await settle();
    assert.equal(shadow.querySelectorAll('#messageList .rm-message').length, 100);

    for (let click = 1; click <= 5; click += 1) {
      // A real runtime refresh goes through the latest channel only. It must
      // not reset the cursor that the user's older pages have advanced.
      await runtime.refresh();
      await flush();
      await settle();
      const button = shadow.querySelector('#loadOlder');
      assert.equal(button.hidden, false, `history button before click ${click}`);
      button.click();
      await flush();
      await settle();
      await settle();
    }

    const ids = [...shadow.querySelectorAll('#messageList .rm-message')].map((rowEl) => rowEl.dataset.messageId);
    assert.equal(ids.length, 527);
    assert.equal(new Set(ids).size, 527);
    assert.equal(ids[0], 'm0001');
    assert.equal(ids.at(-1), 'm0527');
    assert.deepEqual(calls.filter(Boolean), ['m0428', 'm0328', 'm0228', 'm0128', 'm0028']);
    assert.equal(calls.filter((value) => value === '').length, 6, 'each refresh used the independent latest channel');
    assert.equal(shadow.querySelector('#loadOlder').hidden, true);
  } finally {
    runtime.dispose();
    app?.destroy();
    dom.window.close();
  }
});


test('a late older page from before a close/reopen cannot move the new visit', async () => {
  const all = history(150);
  const older = deferred();
  let olderStarted = 0;
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const host = dom.window.document.getElementById('host');
  globalThis.AbortController = dom.window.AbortController;
  globalThis.document = dom.window.document;

  const contacts = {
    friends: [{ peerId: PEER, name: '', description: '', connection: 'connected', paused: false }],
    at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
  };
  const rpc = {
    async open() { return { ok: true, value: snapshot() }; },
    async poll() { return { ok: true, value: snapshot() }; },
    async refresh() { return { ok: true, value: snapshot() }; },
    async close() { return { ok: true, value: { openSessions: 0, subscriptions: 0, streamActive: false } }; },
    async contacts() { return { ok: true, value: contacts }; },
    async conversations() {
      return { ok: true, value: { conversations: [], at: Date.now(), error: null, errorAt: null, freshness: 'live', retention: null } };
    },
    async messages(_session, _peer, before) {
      if (before.length > 0) {
        olderStarted += 1;
        return older.promise;
      }
      const rows = all.slice(-100);
      return { ok: true, value: page(rows, { hasMore: true, nextBefore: rows[0].messageId }) };
    },
  };
  let app = null;
  const runtime = createPanelRuntime({
    rpc,
    mount(target, options) {
      const shadow = target.attachShadow({ mode: 'open' });
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
      app = createRamingaApp(shadow, options);
      return app;
    },
    viewState: createViewState(),
    resolvePhase: () => 'ready',
    sessionId: 'ui-pagination-0002',
    onBootError: (error) => { throw error; },
    logger: { info() {}, warn() {} },
    timers: fakeTimers(),
  });
  try {
    runtime.start(host);
    await flush();
    await settle();
    const shadow = host.shadowRoot;
    shadow.querySelector(`button[data-contact-peer="${PEER}"]`).click();
    await flush();
    await settle();
    assert.equal(shadow.querySelectorAll('#messageList .rm-message').length, 100);
    shadow.querySelector('#loadOlder').click();
    await flush();
    assert.equal(olderStarted, 1);
    assert.equal(shadow.querySelector('#loadOlder').textContent, '正在读取更早消息…');

    shadow.querySelector('#conversationBack').click();
    await settle();
    shadow.querySelector(`button[data-contact-peer="${PEER}"]`).click();
    await flush();
    await settle();
    const beforeLate = shadow.querySelectorAll('#messageList .rm-message').length;
    assert.equal(beforeLate, 100);

    older.resolve({
      ok: true,
      value: page(all.slice(0, 51), { hasMore: false, nextBefore: '' }),
    });
    await flush();
    await settle();
    await settle();
    assert.equal(shadow.querySelectorAll('#messageList .rm-message').length, 100,
      'the late page from the previous generation is dropped');
    assert.equal(shadow.querySelector('#loadOlder').hidden, false,
      'the current visit keeps its own cursor and retry path');
  } finally {
    runtime.dispose();
    app?.destroy();
    dom.window.close();
  }
});
