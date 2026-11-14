// Real-DOM host remount regressions for the persisted reading anchor.
//
// The DSH panel is a React-owned subtree: the host may detach the DOM before
// the effect cleanup calls app.destroy(). These tests reproduce that ordering
// with jsdom and mock layout (jsdom has no layout engine), then verify that a
// valid message-ID anchor survives hide/detach, that a latest-only remount
// exposes an explicit recovery entry, and that restoring uses the saved row
// and offset instead of a stale pixel scrollTop.
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
const PEER_A = '12D3KooWReopenPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWReopenPeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function friend(peerId, name = '') {
  return { peerId, name, description: '', connection: 'connected', paused: false };
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

function history(count = 527, peerId = PEER_A) {
  return Array.from({ length: count }, (_, index) => message(
    `m${String(index + 1).padStart(4, '0')}`,
    `消息 ${index + 1}`,
    { peerId, createdAt: 1_000 + index },
  ));
}

function page(peerId, rows, overrides = {}) {
  return {
    peerId,
    messages: rows,
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

function pagedHost(all, peerId = PEER_A) {
  const latest = () => {
    const rows = all.slice(-100);
    return page(peerId, rows, {
      hasMore: all.length > 100,
      nextBefore: rows[0]?.messageId ?? '',
    });
  };
  return {
    latestPage: latest,
    onLoadMessages: async () => latest(),
    onLoadOlder: async (_peerId, before) => {
      const index = all.findIndex((row) => row.messageId === before);
      if (index < 0) throw new Error('no such cursor');
      const start = Math.max(0, index - 100);
      const rows = all.slice(start, index);
      return page(peerId, rows, {
        hasMore: start > 0,
        nextBefore: start > 0 ? rows[0].messageId : '',
      });
    },
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
  globalThis.document = dom.window.document;
  globalThis.AbortController = dom.window.AbortController;
  const viewState = options.viewState ?? createViewState();
  const app = createRamingaApp(shadow, { viewState, ...options });
  const messageList = shadow.querySelector('#messageList');
  return {
    dom,
    host,
    shadow,
    app,
    viewState,
    messageList,
    messageInput: shadow.querySelector('#messageInput'),
    loadOlder: shadow.querySelector('#loadOlder'),
    restoreNote: shadow.querySelector('#messageRestoreNote'),
    restoreAction: shadow.querySelector('#messageRestoreAction'),
    restoreLatest: shadow.querySelector('#messageRestoreLatest'),
    contactList: shadow.querySelector('#contactList'),
    back: shadow.querySelector('#conversationBack'),
    rows: () => [...messageList.querySelectorAll('.rm-message[data-message-id]')],
    close() {
      app.destroy();
      dom.window.close();
    },
  };
}

/**
 * Mock only the layout facts jsdom lacks. The list is 240px tall and every
 * row is 28px tall; row positions follow the real scrollTop. Detached/hidden
 * nodes report zero geometry, which is the signal the production code must not
 * treat as "delete the anchor".
 */
function installGeometry(ui) {
  const list = ui.messageList;
  const paint = () => {
    for (const [index, row] of ui.rows().entries()) {
      row.getBoundingClientRect = () => (list.isConnected && !list.hidden
        ? {
          top: index * 28 - list.scrollTop, left: 0, right: 600,
          bottom: index * 28 - list.scrollTop + 28, width: 600, height: 28,
          x: 0, y: 0, toJSON() {},
        }
        : { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
    }
  };
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => ui.rows().length * 28 });
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 240 });
  list.getBoundingClientRect = () => (list.isConnected && !list.hidden
    ? { top: 0, left: 0, right: 600, bottom: 240, width: 600, height: 240, x: 0, y: 0, toJSON() {} }
    : { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  const originalReplace = list.replaceChildren.bind(list);
  list.replaceChildren = (...args) => {
    const result = originalReplace(...args);
    paint();
    return result;
  };
  const originalAppend = list.append.bind(list);
  list.append = (...nodes) => {
    const result = originalAppend(...nodes);
    paint();
    return result;
  };
  const observer = new ui.dom.window.MutationObserver(paint);
  observer.observe(list, { childList: true });
  paint();
  return paint;
}

function scrollRowIntoView(ui, messageId, offset = 40) {
  const index = ui.rows().findIndex((row) => row.dataset.messageId === messageId);
  assert.notEqual(index, -1, `${messageId} is rendered before scrolling to it`);
  ui.messageList.scrollTop = Math.max(0, index * 28 - offset);
  ui.messageList.dispatchEvent(new ui.dom.window.Event('scroll'));
}

async function openContact(ui, peerId = PEER_A) {
  ui.app.setContacts(contacts([friend(PEER_A), friend(PEER_B)]));
  ui.app.setConversations(conversations());
  await settle();
  const row = ui.contactList.querySelector(`button[data-contact-peer="${peerId}"]`);
  assert.ok(row, `${peerId} contact row exists`);
  row.click();
  await settle();
  await settle();
}

function baseViewState(peerId = PEER_A) {
  const viewState = createViewState();
  viewState.page = 'messages';
  viewState.pages.messages.peerId = peerId;
  viewState.pages.messages.returnPage = 'contacts';
  viewState.pages.messages.returnPeer = peerId;
  return viewState;
}

test('detach then destroy keeps the last valid anchor; remount exposes an explicit restore that returns to the row and offset', async () => {
  const all = history(527);
  const host = pagedHost(all);
  const viewState = baseViewState();
  let savedAnchor = null;

  const first = mountUi({
    viewState,
    onLoadContacts: async () => contacts([friend(PEER_A), friend(PEER_B)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: host.onLoadMessages,
    onLoadOlder: host.onLoadOlder,
  });
  try {
    installGeometry(first);
    await openContact(first);
    first.loadOlder.click();
    await settle();
    await settle();
    first.loadOlder.click();
    await settle();
    await settle();
    assert.ok(first.rows().some((row) => row.dataset.messageId === 'm0302'));

    first.messageInput.value = '真实重挂前的草稿';
    first.messageInput.dispatchEvent(new first.dom.window.Event('input', { bubbles: true }));
    scrollRowIntoView(first, 'm0302', 40);
    await wait(30);
    savedAnchor = { ...viewState.pages.messages.chatAnchors[PEER_A] };
    assert.ok(savedAnchor.messageId, 'a visible older row was captured');
    assert.ok(['m0300', 'm0301', 'm0302'].includes(savedAnchor.messageId), savedAnchor.messageId);
    assert.equal(savedAnchor.atBottom, undefined);
    assert.equal(viewState.drafts[`chat:${PEER_A}`], '真实重挂前的草稿');

    // A user-triggered older load scrolls programmatically to preserve the
    // reading row. It must keep that exact anchor rather than replacing it
    // with the new page or deleting it.
    first.loadOlder.click();
    await settle();
    await settle();
    assert.deepEqual(viewState.pages.messages.chatAnchors[PEER_A], savedAnchor,
      'a programmatic older-page scroll preserves the existing anchor');

    // The host (React) can remove its subtree before the effect cleanup calls
    // destroy. The detached root reports zero geometry; that must not delete
    // the anchor or overwrite the saved pixel position.
    first.host.remove();
    first.app.destroy();
    first.dom.window.close();
    assert.deepEqual(viewState.pages.messages.chatAnchors[PEER_A], savedAnchor);
    assert.equal(viewState.drafts[`chat:${PEER_A}`], '真实重挂前的草稿');
  } catch (error) {
    first.close();
    throw error;
  }

  const second = mountUi({
    viewState,
    onLoadContacts: async () => contacts([friend(PEER_A), friend(PEER_B)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: host.onLoadMessages,
    onLoadOlder: host.onLoadOlder,
  });
  try {
    installGeometry(second);
    await settle();
    second.app.setMessagePage(host.latestPage());
    await settle();
    assert.equal(second.rows().length, 100, 'the remount starts from the latest bounded page');
    assert.equal(second.messageInput.value, '真实重挂前的草稿', 'draft survives the real remount sequence');
    assert.notEqual(second.messageList.scrollTop, 0, 'the latest page is usable, not an empty window');
    assert.equal(second.restoreNote.hidden, false);
    assert.match(second.restoreNote.textContent, /更早的消息/);
    assert.equal(second.restoreAction.hidden, false, 'the recovery action is reachable');
    assert.equal(second.restoreLatest.hidden, false, 'the reader can explicitly stay at the latest rows');

    // A programmatic/late scroll at the provisional latest window must not
    // overwrite the saved older anchor.
    second.messageList.dispatchEvent(new second.dom.window.Event('scroll'));
    await settle();
    assert.deepEqual(viewState.pages.messages.chatAnchors[PEER_A], savedAnchor);

    second.restoreAction.click();
    await wait(80);
    assert.ok(second.rows().some((row) => row.dataset.messageId === savedAnchor.messageId), 'restore loaded the saved row');
    assert.equal(second.restoreNote.hidden, true, 'successful recovery clears the prompt');
    assert.equal(second.restoreAction.hidden, true);
    const index = second.rows().findIndex((row) => row.dataset.messageId === savedAnchor.messageId);
    assert.equal(index * 28 - second.messageList.scrollTop, savedAnchor.offset, 'the saved in-list offset is restored');
  } finally {
    second.close();
  }
});

test('hiding the messages page and a detached second destroy preserve the anchor until explicit recovery', async () => {
  const all = history(527);
  const host = pagedHost(all);
  const viewState = baseViewState();
  viewState.pages.messages.chatAnchors[PEER_A] = { messageId: 'm0302', offset: 40 };

  const first = mountUi({
    viewState,
    onLoadContacts: async () => contacts([friend(PEER_A), friend(PEER_B)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: host.onLoadMessages,
    onLoadOlder: host.onLoadOlder,
  });
  try {
    installGeometry(first);
    await settle();
    first.app.setMessagePage(host.latestPage());
    await settle();
    assert.equal(first.restoreAction.hidden, false);

    // Switch to another page. The message scroller is now hidden; neither the
    // hide nor the zero geometry may erase the pending anchor.
    first.shadow.querySelector('button[data-nav="contacts"]').click();
    await settle();
    first.messageList.dispatchEvent(new first.dom.window.Event('scroll'));
    await settle();
    assert.deepEqual(viewState.pages.messages.chatAnchors[PEER_A], { messageId: 'm0302', offset: 40 });

    first.host.remove();
    first.app.destroy();
    first.dom.window.close();
    assert.deepEqual(viewState.pages.messages.chatAnchors[PEER_A], { messageId: 'm0302', offset: 40 });
  } catch (error) {
    first.close();
    throw error;
  }

  const second = mountUi({
    viewState,
    onLoadContacts: async () => contacts([friend(PEER_A), friend(PEER_B)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: host.onLoadMessages,
    onLoadOlder: host.onLoadOlder,
  });
  try {
    installGeometry(second);
    await settle();
    second.app.setMessagePage(host.latestPage());
    await settle();
    assert.equal(second.restoreNote.hidden, false);
    second.restoreLatest.click();
    await wait(20);
    assert.equal(viewState.pages.messages.chatAnchors[PEER_A], undefined, 'explicit latest choice clears the old anchor');
    assert.equal(second.restoreNote.hidden, true);
    assert.equal(second.restoreAction.hidden, true);
    assert.ok(second.messageList.scrollTop >= second.rows().length * 28 - 240, 'explicit latest lands at the bottom');
  } finally {
    second.close();
  }
});

test('bottom intent survives a remount, and a failed empty read does not invent a restore prompt', async () => {
  const all = history(120);
  const host = pagedHost(all);
  const viewState = baseViewState();

  const first = mountUi({
    viewState,
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: host.onLoadMessages,
    onLoadOlder: host.onLoadOlder,
  });
  try {
    installGeometry(first);
    await openContact(first);
    await settle();
    first.messageList.scrollTop = first.rows().length * 28 - 240;
    first.messageList.dispatchEvent(new first.dom.window.Event('scroll'));
    await wait(30);
    assert.equal(viewState.pages.messages.chatAnchors[PEER_A]?.atBottom, true);
    first.host.remove();
    first.app.destroy();
    first.dom.window.close();
  } catch (error) {
    first.close();
    throw error;
  }

  const second = mountUi({
    viewState,
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async () => page(PEER_A, [...all.slice(-100), message('m0121', '新消息', { createdAt: 2_000 })], {
      hasMore: true,
      nextBefore: 'm0022',
    }),
    onLoadOlder: host.onLoadOlder,
  });
  try {
    installGeometry(second);
    await settle();
    second.app.setMessagePage(page(PEER_A, [...all.slice(-100), message('m0121', '新消息', { createdAt: 2_000 })], {
      hasMore: true,
      nextBefore: 'm0022',
    }));
    await settle();
    assert.equal(second.restoreNote.hidden, true, 'bottom intent does not show a recovery prompt');
    assert.ok(second.messageList.scrollTop >= second.rows().length * 28 - 240, 'the remount lands at the bottom');
    second.close();
  } catch (error) {
    second.close();
    throw error;
  }

  // A successful empty latest page proves there is no retained older row, so a
  // stale anchor must not keep prompting recovery forever.
  const emptyState = baseViewState();
  emptyState.pages.messages.chatAnchors[PEER_A] = { messageId: 'm0302', offset: 40 };
  const empty = mountUi({
    viewState: emptyState,
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async () => page(PEER_A, [], { hasMore: false, nextBefore: '' }),
  });
  try {
    installGeometry(empty);
    await settle();
    empty.app.setMessagePage(page(PEER_A, [], { hasMore: false, nextBefore: '' }));
    await settle();
    assert.equal(empty.restoreNote.hidden, true, 'an empty conversation is not shown as a broken restore');
    empty.app.destroy();
    assert.equal(emptyState.pages.messages.chatAnchors[PEER_A], undefined);
    empty.dom.window.close();
  } catch (error) {
    empty.close();
    throw error;
  }
});

test('per-Peer anchors do not cross over when the selected conversation changes', async () => {
  const allA = history(220, PEER_A);
  const allB = history(150, PEER_B).map((row) => ({ ...row, messageId: `b${row.messageId.slice(1)}` }));
  const viewState = baseViewState();
  const onLoadMessages = async (peerId) => {
    const all = peerId === PEER_A ? allA : allB;
    const rows = all.slice(-100);
    return page(peerId, rows, { hasMore: all.length > 100, nextBefore: rows[0].messageId });
  };
  const onLoadOlder = async (peerId, before) => {
    const all = peerId === PEER_A ? allA : allB;
    const index = all.findIndex((row) => row.messageId === before);
    const rows = all.slice(Math.max(0, index - 100), index);
    return page(peerId, rows, { hasMore: index - rows.length > 0, nextBefore: rows[0]?.messageId ?? '' });
  };
  const ui = mountUi({
    viewState,
    onLoadContacts: async () => contacts([friend(PEER_A), friend(PEER_B)]),
    onLoadConversations: async () => conversations(),
    onLoadMessages,
    onLoadOlder,
  });
  try {
    installGeometry(ui);
    await openContact(ui, PEER_A);
    ui.loadOlder.click();
    await settle();
    await settle();
    scrollRowIntoView(ui, 'm0102', 36);
    await wait(30);
    const anchorA = { ...viewState.pages.messages.chatAnchors[PEER_A] };
    assert.ok(anchorA.messageId, 'Peer A saved a visible anchor');

    ui.back.click();
    await settle();
    await openContact(ui, PEER_B);
    scrollRowIntoView(ui, 'b0052', 20);
    await wait(30);
    const anchorB = viewState.pages.messages.chatAnchors[PEER_B];
    assert.ok(anchorB?.messageId.startsWith('b'), anchorB?.messageId);
    assert.notEqual(anchorB.messageId, anchorA.messageId);
    assert.deepEqual(viewState.pages.messages.chatAnchors[PEER_A], anchorA, 'Peer B activity does not rewrite Peer A');

    ui.back.click();
    await settle();
    await openContact(ui, PEER_A);
    assert.deepEqual(viewState.pages.messages.chatAnchors[PEER_A], anchorA);
  } finally {
    ui.close();
  }
});
