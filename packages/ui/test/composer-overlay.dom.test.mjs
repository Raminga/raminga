// Composer status/retry is an overlay above the stable form, not a reserved
// blank row inside it. A persisted failure keeps its draft and reuses the
// original idempotency key when retried.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER = '12D3KooWComposerOverlayPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function contacts() {
  return {
    friends: [{ peerId: PEER, name: 'Alice', description: '', connection: 'connected', paused: false }],
    at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
  };
}
function conversations() {
  return {
    conversations: [], at: Date.now(), error: null, errorAt: null, freshness: 'live',
    retention: { retainedMessages: 0, oldestRetainedAt: null, maxStoredMessages: 1000 },
  };
}
function page(peerId, messages = []) {
  return {
    peerId, messages, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    hasMore: false, nextBefore: '', retention: { retainedMessages: messages.length, oldestRetainedAt: null, maxStoredMessages: 1000 },
  };
}

function mountUi(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const host = dom.window.document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = template;
  for (const dialog of shadow.querySelectorAll('dialog')) {
    if (typeof dialog.showModal === 'function') continue;
    dialog.showModal = function showModal() { this.open = true; };
    dialog.close = function close() { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  }
  globalThis.AbortController = dom.window.AbortController;
  globalThis.document = dom.window.document;
  const app = createRamingaApp(shadow, {
    viewState: { page: 'messages', pages: { messages: { query: '', scroll: 0, peerId: PEER } } },
    ...options,
  });
  return {
    dom, shadow, app,
    composer: shadow.querySelector('#composer'),
    overlay: shadow.querySelector('#composerOverlay'),
    status: shadow.querySelector('#composerStatus'),
    tech: shadow.querySelector('#composerTech'),
    actions: shadow.querySelector('#composerActions'),
    reconcile: shadow.querySelector('#sendReconcile'),
    retry: shadow.querySelector('#sendRestore'),
    input: shadow.querySelector('#messageInput'),
    contactList: shadow.querySelector('#contactList'),
    close: () => { app.destroy(); dom.window.close(); },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('status, technical detail and retry live outside the overflow-clipped form', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts(),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => page(peerId, []),
  });
  try {
    ui.app.onLeaseReady();
    ui.app.setContacts(contacts());
    ui.app.setConversations(conversations());
    await settle();
    assert.equal(ui.composer.contains(ui.status), false);
    assert.equal(ui.composer.contains(ui.actions), false);
    assert.equal(ui.overlay.nextElementSibling, ui.composer, 'the overlay sits immediately above the form');
    assert.equal(ui.overlay.hidden, true, 'an empty status reserves no blank row');
    assert.equal(ui.status.hidden, true);
    assert.equal(ui.actions.hidden, true);
  } finally {
    ui.close();
  }
});

test('a failed send keeps the draft and retry reuses the same requestId', async () => {
  const sends = [];
  let result;
  const ui = mountUi({
    onLoadContacts: async () => contacts(),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => page(peerId, []),
    onSend: async (peerId, text, requestId) => {
      sends.push({ peerId, text, requestId });
      return result;
    },
  });
  try {
    ui.app.onLeaseReady();
    ui.app.setContacts(contacts());
    ui.app.setConversations(conversations());
    await settle();
    ui.shadow.querySelector('button[data-contact-peer]').click();
    await settle();

    result = {
      ok: true, unknown: false, invalid: false, peerId: PEER, requestId: '',
      messageId: 'out-failed', replayed: false, acked: false, deliveryStatus: 'failed',
      outboxStatus: 'failed', error: 'remote refused', detail: null, at: Date.now(),
    };
    ui.input.value = 'keep this failed draft';
    ui.input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    assert.equal(sends.length, 1);
    const requestId = sends[0].requestId;
    assert.equal(ui.input.value, 'keep this failed draft');
    assert.equal(ui.overlay.hidden, false);
    assert.equal(ui.retry.hidden, false);
    assert.equal(ui.actions.hidden, false);
    assert.match(ui.status.textContent, /发送失败/);

    result = {
      ok: true, unknown: false, invalid: false, peerId: PEER, requestId: '',
      messageId: 'out-failed', replayed: true, acked: true, deliveryStatus: 'acked',
      outboxStatus: 'acked', error: null, detail: null, at: Date.now(),
    };
    ui.retry.click();
    await settle();
    assert.equal(sends.length, 2);
    assert.equal(sends[1].requestId, requestId, 'retry keeps the original idempotency key');
    assert.equal(sends[1].text, 'keep this failed draft');
    assert.equal(ui.input.value, '', 'a successful retry consumes only the draft it sent');
    assert.equal(ui.retry.hidden, true);
  } finally {
    ui.close();
  }
});
