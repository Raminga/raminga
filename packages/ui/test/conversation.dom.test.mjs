// DOM behavior for the real conversation index, message list and composer.
//
// The daemon is not reached: options receive the same normalized page objects
// the DSH bridge returns. These tests focus on reachable actions, drafts,
// late-result isolation and honest send/delivery wording.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWConversationPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWConversationPeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function friend(peerId, overrides = {}) {
  return { peerId, name: '', description: '', connection: 'connected', paused: false, ...overrides };
}

function contacts(friends, overrides = {}) {
  return {
    friends,
    at: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    connectionFreshness: 'live',
    total: friends.length,
    ...overrides,
  };
}

function conversations(rows, overrides = {}) {
  return {
    conversations: rows,
    at: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    retention: { retainedMessages: 4, oldestRetainedAt: Date.now() - 1000, maxStoredMessages: 50000 },
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
    retention: { retainedMessages: messages.length, oldestRetainedAt: Date.now() - 1000, maxStoredMessages: 50000 },
    ...overrides,
  };
}

function message(id, text, overrides = {}) {
  return {
    messageId: id,
    peerId: PEER_A,
    direction: 'in',
    text,
    acked: true,
    createdAt: Date.now() - 1000,
    ackedAt: null,
    deliveryStatus: 'received',
    deliveryError: '',
    origin: 'unknown',
    deliveryUpdatedAt: null,
    clientRequestId: '',
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
  const viewState = options.viewState ?? {
    page: 'contacts',
    pages: { contacts: { query: '', scroll: 0 }, messages: { peerId: '', query: '', scroll: 3, chatScrolls: {} } },
    drafts: {},
  };
  const app = createRamingaApp(shadow, { viewState, ...options });
  return {
    dom,
    shadow,
    app,
    viewState,
    conversationView: shadow.querySelector('#conversationView'),
    conversationList: shadow.querySelector('#conversationList'),
    conversationQuery: shadow.querySelector('#conversationQuery'),
    messagesStateTitle: shadow.querySelector('#messagesStateTitle'),
    messagesStateAction: shadow.querySelector('#messagesStateAction'),
    messageList: shadow.querySelector('#messageList'),
    messageInput: shadow.querySelector('#messageInput'),
    messageSend: shadow.querySelector('#messageSend'),
    composer: shadow.querySelector('#composer'),
    composerStatus: shadow.querySelector('#composerStatus'),
    sendReconcile: shadow.querySelector('#sendReconcile'),
    sendRestore: shadow.querySelector('#sendRestore'),
    loadOlder: shadow.querySelector('#loadOlder'),
    back: shadow.querySelector('#conversationBack'),
    contactList: shadow.querySelector('#contactList'),
    active: () => shadow.activeElement,
    close: () => { app.destroy(); dom.window.close(); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const frame = () => new Promise((resolve) => setTimeout(resolve, 40));

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('a contact without prior messages opens a real conversation and sends', async () => {
  const sends = [];
  const pages = [];
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' })]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => {
      pages.push(peerId);
      return page(peerId, []);
    },
    onSend: async (peerId, text, requestId) => {
      sends.push({ peerId, text, requestId });
      return {
        ok: true, unknown: false, invalid: false, peerId, requestId,
        messageId: 'out-1', replayed: false, acked: true, deliveryStatus: 'acked', outboxStatus: 'acked',
        error: null, detail: null, at: Date.now(),
      };
    },
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    ui.app.setConversations(conversations([]));
    await settle();
    const row = ui.contactList.querySelector('button[data-contact-peer]');
    assert.ok(row, 'contact row is reachable');
    row.click();
    await settle();
    assert.equal(ui.conversationView.hidden, false);
    assert.equal(ui.shadow.querySelector('#conversationName').textContent, 'Alice');
    assert.deepEqual(pages, [PEER_A], 'opening a contact reads persisted messages');
    assert.equal(ui.active(), ui.messageInput, 'composer is the initial focus target');
    assert.equal(ui.messageInput.value, '');

    // Inbound text is inserted as text, never as executable HTML.
    ui.app.setMessagePage(page(PEER_A, [message('in-1', '<img src=x onerror=alert(1)>')]));
    await settle();
    const bubble = ui.messageList.querySelector('.rm-message-bubble');
    assert.equal(bubble.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(bubble.querySelector('img'), null);

    ui.messageInput.value = '第一条真实消息';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].text, '第一条真实消息');
    assert.match(sends[0].requestId, /^[A-Za-z0-9._:-]{1,128}$/);
    assert.equal(ui.messageInput.value, '', 'submitted draft is cleared');
    assert.equal(ui.active(), ui.messageInput, 'sending keeps keyboard focus in the editor');
    assert.match(ui.composerStatus.textContent, /协议已接收/);
    assert.match(ui.composerStatus.textContent, /阅读状态未知/);
    assert.doesNotMatch(ui.composerStatus.textContent, /已读|未读/);

    // Text typed while the first send was in flight remains a new draft.
    ui.messageInput.value = '等待期间的新草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    assert.equal(ui.app.getDraft(`chat:${PEER_A}`), '等待期间的新草稿');

    ui.back.click();
    await settle();
    assert.equal(ui.viewState.page, 'contacts', 'a contact entry returns to contacts');
    assert.equal(ui.shadow.querySelector('#page-contacts').hidden, false);
    assert.equal(ui.active(), ui.contactList.querySelector('button[data-contact-peer]'), 'the trigger contact regains focus');
    assert.equal(ui.app.getDraft(`chat:${PEER_A}`), '等待期间的新草稿', 'leaving keeps the draft in host state');
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    assert.equal(ui.messageInput.value, '等待期间的新草稿', 'the later re-opened conversation restores the draft');
  } finally {
    ui.close();
  }
});

test('a contact entry returns to its search, scroll and trigger; tab switches keep the draft', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' }), friend(PEER_B, { name: 'Bob' })]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, []),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' }), friend(PEER_B, { name: 'Bob' })]));
    ui.app.setConversations(conversations([]));
    await settle();
    const query = ui.shadow.querySelector('#contactQuery');
    const page = ui.shadow.querySelector('#page-contacts');
    query.value = 'Ali';
    query.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    page.scrollTop = 140;
    const row = ui.contactList.querySelector('button[data-contact-peer]');
    assert.ok(row, 'the searched contact is reachable');
    row.click();
    await settle();
    assert.equal(ui.viewState.page, 'messages');
    assert.equal(ui.viewState.pages.messages.returnPage, 'contacts');
    assert.equal(ui.viewState.pages.messages.returnPeer, PEER_A);

    ui.messageInput.value = 'Alice 未发送草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    assert.equal(ui.back.textContent, '← 返回联系人', 'the back label matches the recorded contact source');

    // A direct tab switch must not drop the draft or the entry source.
    ui.shadow.querySelector('button[data-nav="contacts"]').click();
    await frame();
    assert.equal(ui.viewState.page, 'contacts');
    assert.equal(query.value, 'Ali', 'contact search survives the tab switch');
    assert.equal(page.scrollTop, 140, 'contact scroll survives the tab switch');
    assert.equal(ui.app.getDraft(`chat:${PEER_A}`), 'Alice 未发送草稿');

    ui.shadow.querySelector('button[data-nav="messages"]').click();
    await frame();
    assert.equal(ui.conversationView.hidden, false);
    assert.equal(ui.messageInput.value, 'Alice 未发送草稿', 'the chat reopens with the same draft');

    ui.back.click();
    await settle();
    assert.equal(ui.viewState.page, 'contacts', 'the contact entry returns to contacts');
    assert.equal(ui.shadow.querySelector('#page-contacts').hidden, false);
    assert.equal(query.value, 'Ali', 'back restores the contact search');
    assert.equal(page.scrollTop, 140, 'back restores the contact scroll');
    assert.equal(ui.active(), row, 'back focuses the original contact row');
    assert.equal(ui.viewState.pages.messages.returnPage, '');
    assert.equal(ui.viewState.pages.messages.returnPeer, '');
  } finally {
    ui.close();
  }
});

test('a conversation-index entry returns to the index position and row focus', async () => {
  const row = {
    peerId: PEER_A, lastMessageId: 'm1', direction: 'in', preview: 'hello',
    lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1,
  };
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' })]),
    onLoadConversations: async () => conversations([row]),
    onLoadMessages: async (peerId) => page(peerId, []),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    ui.app.setConversations(conversations([row]));
    ui.shadow.querySelector('button[data-nav="messages"]').click();
    await settle();
    const page = ui.shadow.querySelector('#page-messages');
    page.scrollTop = 3;
    const trigger = ui.conversationList.querySelector('button[data-conversation-peer]');
    assert.ok(trigger, 'the conversation row is reachable');
    trigger.click();
    await settle();
    assert.equal(ui.viewState.pages.messages.returnPage, 'messages');
    assert.equal(ui.back.textContent, '← 返回对话', 'the back label matches the conversation-index source');
    ui.back.click();
    await settle();
    assert.equal(ui.viewState.page, 'messages');
    assert.equal(ui.shadow.querySelector('#messagesIndex').hidden, false);
    assert.equal(ui.conversationView.hidden, true);
    assert.equal(page.scrollTop, 3, 'the index scroll position is restored');
    assert.equal(ui.active(), trigger, 'the original conversation row regains focus');
    assert.equal(ui.viewState.pages.messages.peerId, '');
  } finally {
    ui.close();
  }
});

test('a chat restored without a valid entry source falls back to the conversation index', async () => {
  const viewState = {
    page: 'messages',
    pages: {
      contacts: { query: '', scroll: 0 },
      messages: { peerId: PEER_A, query: '', scroll: 5, chatScrolls: {}, returnPage: '', returnPeer: '' },
    },
    drafts: {},
  };
  const row = {
    peerId: PEER_A, lastMessageId: 'm1', direction: 'in', preview: 'hello',
    lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1,
  };
  const ui = mountUi({
    viewState,
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([row]),
    onLoadMessages: async (peerId) => page(peerId, []),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([row]));
    await settle();
    assert.equal(ui.conversationView.hidden, false, 'the restored peer chat is open');
    assert.equal(ui.back.textContent, '← 返回对话', 'no recorded source defaults to the conversation index');
    ui.back.click();
    await settle();
    assert.equal(ui.viewState.page, 'messages');
    assert.equal(ui.shadow.querySelector('#messagesIndex').hidden, false);
    assert.equal(ui.shadow.querySelector('#page-messages').scrollTop, 5);
    assert.equal(ui.active(), ui.conversationQuery, 'without a trigger, focus stays on the index search');
  } finally {
    ui.close();
  }
});

test('the contact entry source survives a host remount', async () => {
  const viewState = {
    page: 'contacts',
    pages: { contacts: { query: 'Ali', scroll: 0 }, messages: { peerId: '', query: '', scroll: 0, chatScrolls: {} } },
    drafts: {},
  };
  let ui = mountUi({
    viewState,
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' })]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, []),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    ui.messageInput.value = '重挂前草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.app.destroy();
    ui.dom.window.close();

    ui = mountUi({
      viewState,
      onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' })]),
      onLoadConversations: async () => conversations([]),
      onLoadMessages: async (peerId) => page(peerId, []),
    });
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    ui.app.setConversations(conversations([]));
    await settle();
    assert.equal(ui.conversationView.hidden, false, 'the chat is restored after remount');
    assert.equal(ui.messageInput.value, '重挂前草稿');
    assert.equal(ui.back.textContent, '← 返回联系人', 'the back label is restored with the host view state');
    ui.back.click();
    await settle();
    assert.equal(ui.viewState.page, 'contacts', 'the persisted contact source is used after remount');
    assert.equal(ui.active(), ui.contactList.querySelector('button[data-contact-peer]'));
  } finally {
    ui.close();
  }
});

test('send failure restores an editable draft while unknown keeps a reconcile action', async () => {
  let sends = 0;
  let lastRequest = '';
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, []),
    onSend: async (peerId, text, requestId) => {
      sends += 1;
      lastRequest = requestId;
      if (sends === 1) {
        return {
          ok: true, unknown: false, invalid: false, peerId, requestId,
          messageId: 'out-fail', replayed: false, acked: false, deliveryStatus: 'failed', outboxStatus: 'failed',
          error: '远端拒绝', detail: null, at: Date.now(),
        };
      }
      return {
        ok: false, unknown: true, invalid: false, peerId, requestId,
        messageId: '', replayed: false, acked: false, deliveryStatus: 'unknown', outboxStatus: 'unknown',
        error: '发送结果未知', detail: 'timeout', at: Date.now(),
      };
    },
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();

    ui.messageInput.value = '会失败的消息';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(sends, 1);
    assert.equal(ui.messageInput.value, '会失败的消息', 'failed text is retained for editing');
    assert.match(ui.composerStatus.textContent, /发送失败/);
    assert.match(ui.composerStatus.textContent, /重试会复用同一次请求/);
    assert.equal(ui.sendReconcile.hidden, true);

    // A second send returns an ambiguous transport outcome. The UI must not
    // silently create another message; it exposes reconciliation.
    ui.messageInput.value = '';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.messageInput.value = '结果未知的消息';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(sends, 2);
    assert.equal(ui.messageInput.value, '', 'the ambiguous body is not blindly restored as a fresh send');
    assert.match(ui.composerStatus.textContent, /发送结果未知/);
    assert.equal(ui.sendReconcile.hidden, false);
    const ambiguousRequest = lastRequest;

    ui.sendReconcile.click();
    await settle();
    assert.equal(sends, 3);
    assert.equal(lastRequest, ambiguousRequest, 'reconcile reuses the same idempotency key');

    // The persisted page resolves the ambiguity: the same request_id appears
    // as an acknowledged row, so the composer stops asking for reconciliation.
    ui.app.setMessagePage(page(PEER_A, [
      message('out-unknown', '结果未知的消息', {
        direction: 'out', deliveryStatus: 'acked', acked: true, clientRequestId: ambiguousRequest,
      }),
    ]));
    await settle();
    assert.match(ui.composerStatus.textContent, /协议已接收/);
    assert.equal(ui.sendReconcile.hidden, true);
  } finally {
    ui.close();
  }
});

test('IME Enter never sends and Shift+Enter keeps a newline path', async () => {
  let sends = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, []),
    onSend: async (peerId, text, requestId) => {
      sends += 1;
      return { ok: true, unknown: false, invalid: false, peerId, requestId, messageId: 'x', replayed: false, acked: true, deliveryStatus: 'acked', outboxStatus: 'acked', error: null, detail: null, at: Date.now() };
    },
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    ui.messageInput.value = '中文输入';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('compositionstart', { bubbles: true }));
    const composing = new ui.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    ui.messageInput.dispatchEvent(composing);
    await settle();
    assert.equal(sends, 0, 'IME composition Enter must not submit');
    const shift = new ui.dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    ui.messageInput.dispatchEvent(shift);
    await settle();
    assert.equal(sends, 0, 'Shift+Enter is left for a newline');
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('compositionend', { bubbles: true }));
    ui.messageInput.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    assert.equal(sends, 1, 'plain Enter after composition sends once');
  } finally {
    ui.close();
  }
});

test('switching conversations keeps drafts and ignores late pages/results from the old Peer', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' }), friend(PEER_B, { name: 'Bob' })]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, []),
    onSend: async (peerId, text, requestId) => ({
      ok: true, unknown: false, invalid: false, peerId, requestId, messageId: 'late', replayed: false,
      acked: true, deliveryStatus: 'acked', outboxStatus: 'acked', error: null, detail: null, at: Date.now(),
    }),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' }), friend(PEER_B, { name: 'Bob' })]));
    ui.app.setConversations(conversations([]));
    await settle();
    const rows = ui.contactList.querySelectorAll('button[data-contact-peer]');
    rows[0].click();
    await settle();
    ui.messageInput.value = 'Alice 草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.back.click();
    await settle();
    ui.contactList.querySelectorAll('button[data-contact-peer]')[1].click();
    await settle();
    assert.equal(ui.shadow.querySelector('#conversationName').textContent, 'Bob');
    assert.equal(ui.messageInput.value, '');
    ui.messageInput.value = 'Bob 草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));

    // A page for the old Peer arriving after the switch must not cross into
    // Bob's conversation.
    ui.app.setMessagePage(page(PEER_A, [message('late-a', 'Alice 专用正文')]));
    await settle();
    assert.doesNotMatch(ui.messageList.textContent, /Alice 专用正文/);

    ui.back.click();
    await settle();
    ui.contactList.querySelectorAll('button[data-contact-peer]')[0].click();
    await settle();
    assert.equal(ui.messageInput.value, 'Alice 草稿', 'Alice draft restored');
    assert.equal(ui.shadow.querySelector('#conversationName').textContent, 'Alice');
    ui.back.click();
    await settle();
    ui.contactList.querySelectorAll('button[data-contact-peer]')[1].click();
    await settle();
    assert.equal(ui.messageInput.value, 'Bob 草稿', 'Bob draft restored');
  } finally {
    ui.close();
  }
});

test('conversation index distinguishes loading, empty, error and search-empty with reachable actions', async () => {
  let loads = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([]),
    onLoadConversations: async () => {
      loads += 1;
      if (loads === 1) throw new Error('daemon read failed');
      return conversations([]);
    },
  });
  try {
    // No successful read yet: loading is not an empty list.
    ui.app.setConversations(conversations([], { at: null, freshness: 'loading' }));
    await settle();
    assert.equal(ui.messagesStateTitle.textContent, '正在读取对话…');

    ui.app.setContacts(contacts([]));
    ui.app.setConversationsError('daemon read failed');
    await settle();
    assert.equal(ui.messagesStateTitle.textContent, '这次没有读到对话');
    assert.match(ui.shadow.querySelector('#messagesStateBody').textContent, /不代表没有对话/);
    assert.equal(ui.messagesStateAction.hidden, false, 'retry action is reachable');

    ui.app.setConversations(conversations([
      { peerId: PEER_A, lastMessageId: 'm1', direction: 'out', preview: 'hello', lastAt: Date.now(), deliveryStatus: 'acked', origin: 'human', messageCount: 1 },
    ]));
    await settle();
    assert.equal(ui.conversationList.hidden, false);
    assert.equal(ui.conversationList.querySelectorAll('button[data-conversation-peer]').length, 1);
    ui.conversationQuery.value = '不存在';
    ui.conversationQuery.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    assert.equal(ui.messagesStateTitle.textContent, '没有找到匹配的会话');
    ui.messagesStateAction.click();
    await settle();
    assert.equal(ui.conversationQuery.value, '');
    assert.equal(ui.conversationList.querySelectorAll('button[data-conversation-peer]').length, 1);
  } finally {
    ui.close();
  }
});

test('node live region announces the same connection count as the visible pill', () => {
  const ui = mountUi();
  try {
    const live = ui.shadow.querySelector('#nodeLive');
    const label = ui.shadow.querySelector('#nodeLabel');
    assert.ok(live);
    ui.app.setNodeStatus({
      phase: 'ready',
      status: { peerId: PEER_A, nodeId: 'n', version: 't', apiVersion: '3', connections: [], peers: [] },
      statusAt: Date.now(),
      freshness: 'live',
      stream: { phase: 'open' },
      stats: { subscriptions: 1, openSessions: 1, streamActive: true, streamPhase: 'open' },
    });
    assert.match(label.textContent, /0 条连接/);
    assert.match(live.textContent, /0 条连接/);

    ui.app.setNodeStatus({
      phase: 'ready',
      status: {
        peerId: PEER_A, nodeId: 'n', version: 't', apiVersion: '3',
        connections: [{ peerId: PEER_A, route: 'direct', transport: 'tcp' }],
        peers: [],
      },
      statusAt: Date.now(),
      freshness: 'live',
      stream: { phase: 'open' },
      stats: { subscriptions: 1, openSessions: 1, streamActive: true, streamPhase: 'open' },
    });
    assert.match(label.textContent, /1 条连接/);
    assert.match(live.textContent, /1 条连接/, 'live region follows the visible count, not only phase changes');
  } finally {
    ui.close();
  }
});

test('auto-scroll only at the bottom and loading older keeps the reading position', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, []),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();

    let height = 1200;
    Object.defineProperty(ui.messageList, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(ui.messageList, 'clientHeight', { configurable: true, get: () => 200 });
    const initial = Array.from({ length: 30 }, (_, index) => message(`m-${index}`, `消息 ${index}`, { createdAt: Date.now() - index * 1000 }));
    ui.app.setMessagePage(page(PEER_A, initial));
    await settle();
    assert.equal(ui.messageList.scrollTop, 1200, 'first page opens at the newest message');

    // Reading older history: a new message must not steal the reading position.
    ui.messageList.scrollTop = 300;
    height = 1300;
    ui.app.setMessagePage(page(PEER_A, [message('new-bottom', '新消息', { createdAt: Date.now() + 1000 }), ...initial]));
    await settle();
    assert.equal(ui.messageList.scrollTop, 300, 'new rows do not jump a reader away from old history');

    // At the bottom: new messages keep the view pinned to the bottom.
    ui.messageList.scrollTop = 1200;
    height = 1400;
    ui.app.setMessagePage(page(PEER_A, [message('newer-bottom', '再一条新消息', { createdAt: Date.now() + 2000 }), ...initial]));
    await settle();
    assert.equal(ui.messageList.scrollTop, 1400);

    // Loading an older page preserves the distance from the bottom.
    ui.messageList.scrollTop = 200;
    let reads = 0;
    Object.defineProperty(ui.messageList, 'scrollHeight', {
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 1400 : 1500;
      },
    });
    const older = Array.from({ length: 10 }, (_, index) => message(`old-${index}`, `更早消息 ${index}`, { createdAt: Date.now() - 100_000 - index * 1000 }));
    ui.app.appendMessagePage(page(PEER_A, older, { hasMore: false }));
    await settle();
    assert.equal(ui.messageList.scrollTop, 300, 'older page keeps scrollHeight - scrollTop constant');
  } finally {
    ui.close();
  }
});

test('a per-Peer saved chat scroll is restored after leaving the conversation', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, [
      message('m-2', '二', { createdAt: Date.now() - 1000 }),
      message('m-1', '一', { createdAt: Date.now() - 2000 }),
    ]),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    Object.defineProperty(ui.messageList, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(ui.messageList, 'clientHeight', { configurable: true, get: () => 200 });
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    ui.messageList.scrollTop = 150;
    ui.messageList.dispatchEvent(new ui.dom.window.Event('scroll'));
    await settle();
    ui.back.click();
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    assert.equal(ui.messageList.scrollTop, 150, 'the saved per-Peer position is restored');
  } finally {
    ui.close();
  }
});

test('sending blocks duplicate submits without taking focus or clearing a new draft', async () => {
  const gate = deferred();
  let sends = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, []),
    onSend: async (peerId, text, requestId) => {
      sends += 1;
      await gate.promise;
      return {
        ok: true, unknown: false, invalid: false, peerId, requestId, messageId: 'out-slow',
        replayed: false, acked: true, deliveryStatus: 'acked', outboxStatus: 'acked',
        error: null, detail: null, at: Date.now(),
      };
    },
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    ui.messageInput.value = '第一条';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(sends, 1);
    assert.equal(ui.messageInput.value, '', 'submitted body cleared once');
    assert.equal(ui.active(), ui.messageInput, 'focus stays in the editor while sending');
    // Duplicate submit/click while pending must not create another send.
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    ui.messageSend.click();
    await settle();
    assert.equal(sends, 1, 'pending send is guarded');
    ui.messageInput.value = '等待时的新草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.back.focus();
    gate.resolve();
    await settle();
    assert.equal(ui.messageInput.value, '等待时的新草稿', 'completion does not clear the new draft');
    assert.equal(ui.active(), ui.back, 'late result does not steal focus from a control the user chose');
  } finally {
    ui.close();
  }
});

test('a removed cancel action does not drop keyboard focus to the document body', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, [
      message('pending-1', '待发消息', { direction: 'out', deliveryStatus: 'pending', origin: 'human' }),
    ]),
    onCancelOutbox: async (_peerId, messageId) => ({ ok: true, messageId, status: 'cancelled' }),
    onSend: async (peerId, text, requestId) => ({ ok: false, unknown: true, peerId, requestId }),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    const cancel = ui.messageList.querySelector('[data-message-action="cancel"]');
    assert.ok(cancel);
    cancel.focus();
    assert.equal(ui.active(), cancel);
    // ACK refresh removes the pending action. Focus must move to a reachable
    // editor control, not the document body.
    ui.app.setMessagePage(page(PEER_A, [
      message('pending-1', '待发消息', { direction: 'out', deliveryStatus: 'acked', acked: true, origin: 'human' }),
    ]));
    await settle();
    assert.equal(ui.messageList.querySelector('[data-message-action="cancel"]'), null);
    assert.equal(ui.active(), ui.messageInput);
  } finally {
    ui.close();
  }
});

test('a later ACK supersedes an earlier local cancel success notice', async () => {
  let rows = [];
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, [...rows]),
    onSend: async (peerId, text, requestId) => {
      rows = [message('cancel-then-ack', text, {
        direction: 'out',
        acked: false,
        deliveryStatus: 'pending',
        origin: 'human',
        clientRequestId: requestId,
      })];
      return {
        ok: true, unknown: false, invalid: false, peerId, requestId,
        messageId: 'cancel-then-ack', replayed: false, acked: false,
        deliveryStatus: 'pending', outboxStatus: 'pending', error: null, detail: null, at: Date.now(),
      };
    },
    onCancelOutbox: async (_peerId, messageId) => {
      rows = rows.map((row) => (row.messageId === messageId
        ? { ...row, deliveryStatus: 'cancelled', deliveryError: 'cancelled by local user' }
        : row));
      return { ok: true, messageId, status: 'cancelled', error: null, at: Date.now() };
    },
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    ui.messageInput.value = '取消与 ACK 竞态';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    ui.messageList.querySelector('[data-message-action="cancel"]').click();
    await settle();
    assert.match(ui.composerStatus.textContent, /已取消这条待发消息/);

    // The daemon won the race: the same requestId is later observed as ACKed.
    // The explicit cancel notice must not outlive that persisted truth.
    rows = rows.map((row) => ({ ...row, acked: true, deliveryStatus: 'acked', deliveryError: '' }));
    ui.app.setMessagePage(page(PEER_A, rows));
    await settle();
    assert.match(ui.composerStatus.textContent, /协议已接收/);
    assert.doesNotMatch(ui.composerStatus.textContent, /已取消这条待发消息/);
    assert.equal(ui.messageList.querySelector('.rm-message-status').textContent, '协议已接收');
  } finally {
    ui.close();
  }
});

test('long dial errors are folded, keep the composer short and leave cancel reachable', async () => {
  const longError = 'dial peer 12D3KooWConversationPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA failed after 4 candidate(s): '
    + '/ip4/127.0.0.1/tcp/4101 source=cache family=ipv4: failed to dial: all dials failed; '
    + '/ip4/127.0.0.1/tcp/4103 source=cache family=ipv4: failed to dial: context deadline exceeded; '
    + '/ip4/127.0.0.1/udp/4101/quic-v1 source=cache family=ipv4: failed to dial: context deadline exceeded; '
    + '/ip4/127.0.0.1/udp/4104/quic-v1 source=cache family=ipv4: failed to dial: context deadline exceeded; '
    + 'peer may be offline or its address is stale '
    + 'candidate-detail '.repeat(60).trimEnd();
  const longBody = '这是一条很长的消息正文，用来确认最后一条消息和操作仍然可以滚动露出。'.repeat(40);
  let rows = [];
  let sends = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, [...rows]),
    onSend: async (peerId, text, requestId) => {
      sends += 1;
      rows = [message('out-long', text, {
        direction: 'out',
        deliveryStatus: 'pending',
        acked: false,
        origin: 'human',
        clientRequestId: requestId,
        deliveryError: longError,
      })];
      return {
        ok: true, unknown: false, invalid: false, peerId, requestId,
        messageId: 'out-long', replayed: false, acked: false,
        deliveryStatus: 'pending', outboxStatus: 'pending',
        error: longError, detail: null, at: Date.now(),
      };
    },
    onCancelOutbox: async (_peerId, messageId) => {
      rows = rows.map((row) => (row.messageId === messageId
        ? { ...row, deliveryStatus: 'cancelled', deliveryError: 'cancelled by local user' }
        : row));
      return { ok: true, messageId, status: 'cancelled', error: null, at: Date.now() };
    },
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();

    ui.messageInput.value = longBody;
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(sends, 1);

    // The default composer text is short and actionable; the raw dial text is
    // not in the status line.
    assert.match(ui.composerStatus.textContent, /已交给节点，等待确认/);
    assert.doesNotMatch(ui.composerStatus.textContent, /dial peer|connection refused|source=cache/);
    const composerTech = ui.shadow.querySelector('#composerTech');
    assert.equal(composerTech.hidden, true, 'the persisted row owns the same raw error, so the composer does not duplicate it');

    const messageRow = ui.messageList.querySelector('[data-message-id="out-long"]');
    assert.ok(messageRow);
    assert.equal(messageRow.querySelector('.rm-message-bubble').textContent, longBody);
    assert.equal(messageRow.querySelector('.rm-message-status').textContent, '待发送 · 等待确认');
    const messageTech = messageRow.querySelector('.rm-message-tech');
    assert.ok(messageTech);
    assert.equal(messageTech.tagName, 'BUTTON', 'the message detail is an explicit action, not an inline expansion');
    assert.equal(ui.shadow.querySelector('#technicalDialog').open, false);

    // A real activation opens the shared detail dialog instead of changing the
    // conversation layout; the raw text is fully readable and the source
    // regains focus on close.
    messageTech.focus();
    messageTech.click();
    const technicalDialog = ui.shadow.querySelector('#technicalDialog');
    assert.equal(technicalDialog.open, true);
    assert.equal(ui.shadow.querySelector('#technicalHeading').textContent, '投递技术详情');
    assert.equal(ui.shadow.querySelector('#technicalRaw').textContent, longError);
    assert.match(ui.shadow.querySelector('#technicalIntro').textContent, /待发送 · 等待确认/);
    assert.equal(ui.active(), technicalDialog.querySelector('[data-close-dialog]'));
    technicalDialog.querySelector('[data-close-dialog]').click();
    assert.equal(technicalDialog.open, false);
    assert.equal(ui.active(), messageTech, 'closing returns focus to the message detail action');

    const cancel = messageRow.querySelector('[data-message-action="cancel"]');
    assert.ok(cancel, 'the pending message keeps a reachable cancel action');
    cancel.focus();
    cancel.click();
    await settle();
    await settle();
    assert.match(ui.composerStatus.textContent, /已取消这条待发消息/);
    assert.match(ui.composerStatus.textContent, /不会再自动重试/);
    assert.doesNotMatch(ui.composerStatus.textContent, /没有被对端接收|对端没有收到|未接收/);
    assert.equal(ui.messageList.querySelector('.rm-message-status').textContent, '已取消');
    assert.equal(ui.active()?.dataset.messageId, 'out-long', 'focus stays with the cancelled row');
    assert.equal(ui.app.getDraft(`chat:${PEER_A}`), '', 'cancelling does not invent or clear a draft');
  } finally {
    ui.close();
  }
});

test('a persisted ACK advances the same send task and never overwrites a new draft', async () => {
  const pendingError = 'dial peer failed: 127.0.0.1:4101 connect: connection refused';
  let rows = [];
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, [...rows]),
    onSend: async (peerId, text, requestId) => {
      rows = [message('out-ack', text, {
        direction: 'out',
        acked: false,
        deliveryStatus: 'pending',
        origin: 'human',
        clientRequestId: requestId,
        deliveryError: pendingError,
      })];
      return {
        ok: true, unknown: false, invalid: false, peerId, requestId,
        messageId: 'out-ack', replayed: false, acked: false,
        deliveryStatus: 'pending', outboxStatus: 'pending',
        error: pendingError, detail: null, at: Date.now(),
      };
    },
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();

    ui.messageInput.value = '重连后应当变为已接收';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.match(ui.composerStatus.textContent, /已交给节点，等待确认/);
    assert.equal(ui.shadow.querySelector('#composerTech').hidden, true, 'the persisted error is shown on its message once');

    // The user starts a new draft while the queued message is still pending.
    ui.messageInput.value = '重连后的新草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    assert.equal(ui.app.getDraft(`chat:${PEER_A}`), '重连后的新草稿');

    // The daemon reconnects and the same requestId is persisted as ACKed. The
    // composer must adopt the terminal state, not keep the stale pending RPC
    // result, and must not touch the new draft.
    rows = [{ ...rows[0], acked: true, deliveryStatus: 'acked', deliveryError: '', ackedAt: Date.now() }];
    ui.app.setMessagePage(page(PEER_A, rows));
    await settle();
    assert.match(ui.composerStatus.textContent, /协议已接收/);
    assert.match(ui.composerStatus.textContent, /阅读状态未知/);
    assert.doesNotMatch(ui.composerStatus.textContent, /等待确认|没有确认前|connection refused/);
    assert.equal(ui.shadow.querySelector('#composerTech').hidden, true, 'the ACK clears the old technical error');
    assert.equal(ui.shadow.querySelector('.rm-message-status').textContent, '协议已接收');
    assert.equal(ui.messageInput.value, '重连后的新草稿', 'a terminal refresh never overwrites the new draft');
    assert.equal(ui.app.getDraft(`chat:${PEER_A}`), '重连后的新草稿');

    // Leaving and re-entering restores the same task projection and draft.
    ui.back.click();
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    assert.match(ui.composerStatus.textContent, /协议已接收/);
    assert.doesNotMatch(ui.composerStatus.textContent, /等待确认/);
    assert.equal(ui.messageInput.value, '重连后的新草稿');
  } finally {
    ui.close();
  }
});

test('persisted failure and cancellation replace a pending task without overclaiming', async () => {
  const pendingError = 'dial peer failed after cached candidates';
  let rows = [];
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, [...rows]),
    onSend: async (peerId, text, requestId) => {
      // The daemon returns the stable messageId but the persisted row has no
      // clientRequestId yet: messageId is the only safe fallback.
      rows = [message('out-terminal', text, {
        direction: 'out',
        acked: false,
        deliveryStatus: 'pending',
        origin: 'human',
        clientRequestId: '',
        deliveryError: pendingError,
      })];
      return {
        ok: true, unknown: false, invalid: false, peerId, requestId,
        messageId: 'out-terminal', replayed: false, acked: false,
        deliveryStatus: 'pending', outboxStatus: 'pending',
        error: pendingError, detail: null, at: Date.now(),
      };
    },
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();

    ui.messageInput.value = '终态推进测试';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    ui.messageInput.value = '失败后的新草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));

    rows = [{ ...rows[0], deliveryStatus: 'failed', deliveryError: 'permanent rejection from peer' }];
    ui.app.setMessagePage(page(PEER_A, rows));
    await settle();
    assert.match(ui.composerStatus.textContent, /发送失败/);
    assert.doesNotMatch(ui.composerStatus.textContent, /等待确认/);
    assert.doesNotMatch(ui.composerStatus.textContent, /对端没有收到|未被对端接收|没有送达/);
    assert.equal(ui.messageInput.value, '失败后的新草稿', 'failure refresh does not restore text over a new draft');
    assert.equal(ui.messageList.querySelector('.rm-message-status').textContent, '发送失败');

    rows = [{ ...rows[0], deliveryStatus: 'cancelled', deliveryError: 'cancelled by local user' }];
    ui.app.setMessagePage(page(PEER_A, rows));
    await settle();
    assert.match(ui.composerStatus.textContent, /发送已取消/);
    assert.doesNotMatch(ui.composerStatus.textContent, /等待确认/);
    assert.doesNotMatch(ui.composerStatus.textContent, /没有被对端接收|对端没有收到/);
    assert.equal(ui.messageInput.value, '失败后的新草稿');
    assert.equal(ui.messageList.querySelector('.rm-message-status').textContent, '已取消');
  } finally {
    ui.close();
  }
});

test('another message or another Peer late page never rewrites the current send feedback', async () => {
  const rowsByPeer = new Map([[PEER_A, []], [PEER_B, []]]);
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' }), friend(PEER_B, { name: 'Bob' })]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, [...(rowsByPeer.get(peerId) ?? [])]),
    onSend: async (peerId, text, requestId) => {
      rowsByPeer.set(peerId, [message('out-isolated', text, {
        peerId,
        direction: 'out',
        acked: false,
        deliveryStatus: 'pending',
        origin: 'human',
        clientRequestId: requestId,
      })]);
      return {
        ok: true, unknown: false, invalid: false, peerId, requestId,
        messageId: 'out-isolated', replayed: false, acked: false,
        deliveryStatus: 'pending', outboxStatus: 'pending',
        error: '', detail: null, at: Date.now(),
      };
    },
  });
  try {
    const allContacts = contacts([friend(PEER_A, { name: 'Alice' }), friend(PEER_B, { name: 'Bob' })]);
    ui.app.setContacts(allContacts);
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector(`button[data-contact-peer="${PEER_A}"]`).click();
    await settle();
    ui.messageInput.value = 'Peer 隔离消息';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.match(ui.composerStatus.textContent, /已交给节点，等待确认/);

    // A different persisted message in the same Peer must not change the task.
    ui.app.setMessagePage(page(PEER_A, [
      ...rowsByPeer.get(PEER_A),
      message('out-other', '其他消息', {
        direction: 'out', acked: true, deliveryStatus: 'acked', origin: 'human', clientRequestId: 'other-request',
      }),
    ]));
    await settle();
    assert.match(ui.composerStatus.textContent, /已交给节点，等待确认/, 'only the task requestId may drive its composer');

    // Switch to Peer B, then let a stale ACK page for Peer A arrive. It must be
    // ignored while B is selected and must not alter A's stored task.
    ui.back.click();
    await settle();
    ui.contactList.querySelector(`button[data-contact-peer="${PEER_B}"]`).click();
    await settle();
    const ackedA = [{ ...rowsByPeer.get(PEER_A)[0], acked: true, deliveryStatus: 'acked', deliveryError: '' }];
    ui.app.setMessagePage(page(PEER_A, ackedA));
    await settle();
    assert.equal(ui.composerStatus.textContent, '', 'a late page for another Peer does not leak into this composer');

    // A's own persisted page is still pending; switching back must show the
    // pending task, not the late ACK that belonged to an inactive view.
    ui.back.click();
    await settle();
    ui.contactList.querySelector(`button[data-contact-peer="${PEER_A}"]`).click();
    await settle();
    assert.match(ui.composerStatus.textContent, /已交给节点，等待确认/);

    rowsByPeer.set(PEER_A, ackedA);
    ui.app.setMessagePage(page(PEER_A, ackedA));
    await settle();
    assert.match(ui.composerStatus.textContent, /协议已接收/);
    assert.doesNotMatch(ui.composerStatus.textContent, /等待确认/);
  } finally {
    ui.close();
  }
});

test('composer technical details use the independent dialog and restore source focus', async () => {
  const detail = 'RPC deadline exceeded while dialing cached candidates '.repeat(30).trim();
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, []),
    onSend: async (peerId, text, requestId) => ({
      ok: false, unknown: true, invalid: false, peerId, requestId,
      error: '这次发送没有收到节点结果。',
      detail,
    }),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    ui.messageInput.value = '结果未知的消息';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.match(ui.composerStatus.textContent, /发送结果未知/);
    assert.doesNotMatch(ui.composerStatus.textContent, /deadline exceeded/);
    const composerTech = ui.shadow.querySelector('#composerTech');
    assert.equal(composerTech.hidden, false);
    composerTech.focus();
    composerTech.click();
    const dialog = ui.shadow.querySelector('#technicalDialog');
    assert.equal(dialog.open, true);
    assert.equal(ui.shadow.querySelector('#technicalHeading').textContent, '发送技术详情');
    assert.match(ui.shadow.querySelector('#technicalRaw').textContent, /RPC deadline exceeded while dialing cached candidates/);
    assert.doesNotMatch(ui.composerStatus.textContent, /deadline exceeded/, 'the dialog owns the raw text');
    dialog.querySelector('[data-close-dialog]').click();
    assert.equal(dialog.open, false);
    assert.equal(ui.active(), composerTech);
  } finally {
    ui.close();
  }
});

test('a detail dialog survives a row refresh and returns focus to the same message', async () => {
  const longError = 'dial peer failed: connection refused '.repeat(20).trim();
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, [
      message('pending-refresh', '待发消息', {
        direction: 'out', acked: false, deliveryStatus: 'pending', origin: 'human', deliveryError: longError,
      }),
    ]),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    const detail = ui.messageList.querySelector('.rm-message-tech');
    detail.click();
    const dialog = ui.shadow.querySelector('#technicalDialog');
    assert.equal(dialog.open, true);

    // The periodic refresh replaces the row while the dialog is open; the
    // message is now ACKed so its detail action disappears.
    ui.app.setMessagePage(page(PEER_A, [
      message('pending-refresh', '待发消息', { direction: 'out', acked: true, deliveryStatus: 'acked', origin: 'human' }),
    ]));
    await settle();
    assert.equal(dialog.open, true, 'a background refresh does not close the detail view');
    assert.equal(ui.messageList.querySelector('[data-message-action="detail"]'), null);
    dialog.querySelector('[data-close-dialog]').click();
    assert.equal(dialog.open, false);
    assert.equal(ui.active()?.dataset.messageId, 'pending-refresh', 'focus returns to the same message row');
    assert.equal(ui.messageList.querySelector('.rm-message-status').textContent, '协议已接收');
  } finally {
    ui.close();
  }
});

test('a failed send reports no confirmation without claiming the remote did not receive it', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, []),
    onSend: async (peerId, text, requestId) => ({
      ok: true, unknown: false, invalid: false, peerId, requestId,
      messageId: 'out-failed', replayed: false, acked: false,
      deliveryStatus: 'failed', outboxStatus: 'failed',
      error: 'dial peer failed after 4 candidate(s)', detail: null, at: Date.now(),
    }),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    ui.messageInput.value = '失败文案';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.match(ui.composerStatus.textContent, /没有获得送达确认/);
    assert.doesNotMatch(ui.composerStatus.textContent, /没有送达|未被对端接收|对端没有收到/);
  } finally {
    ui.close();
  }
});

test('the composer enforces the daemon UTF-8 byte limit without discarding text', async () => {
  let sends = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A)]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => page(peerId, []),
    onSend: async (peerId, text, requestId) => {
      sends += 1;
      return { ok: true, unknown: false, invalid: false, peerId, requestId, messageId: 'x', replayed: false, acked: true, deliveryStatus: 'acked', outboxStatus: 'acked', error: null, detail: null, at: Date.now() };
    },
  });
  try {
    ui.app.setNodeStatus({
      phase: 'ready',
      status: { peerId: PEER_A, nodeId: 'n', version: 't', apiVersion: '3', connections: [], peers: [], maxChatTextBytes: 10 },
      statusAt: Date.now(),
      freshness: 'live',
      stream: { phase: 'open' },
      stats: { subscriptions: 1, openSessions: 1, streamActive: true, streamPhase: 'open' },
    });
    ui.app.setContacts(contacts([friend(PEER_A)]));
    ui.app.setConversations(conversations([]));
    await settle();
    ui.contactList.querySelector('button[data-contact-peer]').click();
    await settle();
    ui.messageInput.value = '你好你好你好'; // 18 UTF-8 bytes
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.composer.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(sends, 0);
    assert.equal(ui.messageInput.value, '你好你好你好', 'over-limit text stays editable');
    assert.match(ui.composerStatus.textContent, /18 字节/);
    assert.match(ui.composerStatus.textContent, /10 字节/);
    assert.equal(ui.shadow.querySelector('#messageCounter').dataset.over, 'true');
  } finally {
    ui.close();
  }
});
