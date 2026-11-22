// First-batch C: one verifiable return target for contact rows, profiles,
// conversations, evidence and the settings gear.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';
import { memoryEvidenceFocusKey } from '../src/memory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWReturnPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWReturnPeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function friend(peerId, overrides = {}) {
  return {
    peerId, name: '', description: '', connection: 'connected', paused: false, unreadCount: 0, ...overrides,
  };
}

function contacts(friends, overrides = {}) {
  return {
    friends, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    connectionFreshness: 'live', total: friends.length, ...overrides,
  };
}

function conversations(rows) {
  return {
    conversations: rows, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    totalUnread: rows.reduce((sum, row) => sum + (Number(row.unreadCount) || 0), 0),
    retention: { retainedMessages: 20, oldestRetainedAt: Date.now() - 1000, maxStoredMessages: 50000 },
  };
}

function messagePage(peerId, messages = []) {
  return {
    peerId, messages, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    hasMore: false, nextBefore: '',
    retention: { retainedMessages: messages.length, oldestRetainedAt: Date.now() - 1000, maxStoredMessages: 50000 },
  };
}

function message(id, text, overrides = {}) {
  return {
    messageId: id, peerId: PEER_A, direction: 'in', text, acked: true,
    createdAt: Date.now() - 1000, ackedAt: null, deliveryStatus: 'received', deliveryError: '',
    origin: 'unknown', deliveryUpdatedAt: null, clientRequestId: '', ...overrides,
  };
}

function profile(peerId = PEER_A, overrides = {}) {
  return {
    peerId, localName: 'Alice', remoteName: 'Alice', found: true,
    text: `# Alice\n\n${Array.from({ length: 24 }, (_, index) => `第 ${index} 段公开资料。`).join('\n\n')}`,
    files: ['profile/index.md'], at: Date.now(), error: null, freshness: 'live',
    agentCard: { state: 'missing', card: null, error: 'missing' },
    manifest: { peerId, publisherName: 'Alice', source: 'remote', at: Date.now(), entries: [], error: null, errorAt: null, freshness: 'live', truncated: false, total: 0 },
    node: null,
    ...overrides,
  };
}

function modelHiddenScroll(node) {
  let stored = 0;
  Object.defineProperty(node, 'scrollTop', {
    configurable: true,
    get() { return node.hidden ? 0 : stored; },
    set(value) { stored = Number(value) || 0; },
  });
  return {
    get() { return stored; },
    set(value) { node.scrollTop = value; },
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
    pages: {
      contacts: { query: '', scroll: 0 },
      messages: { peerId: '', query: '', scroll: 0, chatScrolls: {} },
      explore: { filter: 'all', query: '', scroll: 0 },
    },
    drafts: {},
  };
  const app = createRamingaApp(shadow, { viewState, ...options });
  app.onLeaseReady();
  return {
    dom, shadow, app, viewState,
    active: () => shadow.activeElement,
    navCurrent: () => [...new Set([...shadow.querySelectorAll('nav.rm-nav button[aria-current="page"]')]
      .map((button) => button.dataset.nav))],
    close() { app.destroy(); dom.window.close(); },
  };
}

test('an inline row chat returns to the same contact row action, search, filter and scroll', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice', unreadCount: 2 })]),
    onLoadConversations: async () => conversations([{ peerId: PEER_A, lastMessageId: 'm1', direction: 'in', preview: '你好', lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1, unreadCount: 2 }]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message('m1', '你好')]),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice', unreadCount: 2 })]));
    ui.app.setConversations(conversations([{ peerId: PEER_A, lastMessageId: 'm1', direction: 'in', preview: '你好', lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1, unreadCount: 2 }]));
    await settle();
    const page = ui.shadow.querySelector('#page-contacts');
    const query = ui.shadow.querySelector('#contactQuery');
    query.value = 'Ali';
    query.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.shadow.querySelector('[data-contact-filter="unread"]').click();
    await settle();
    page.scrollTop = 120;
    const row = ui.shadow.querySelector('[data-contact-row]');
    const chat = row.querySelector('button[data-chat-peer]');
    const main = row.querySelector('button[data-contact-peer]');
    assert.ok(chat && main, 'the row keeps a separate profile body and chat action');
    assert.ok(chat.getBoundingClientRect, 'chat action is a real button');
    assert.equal(chat.querySelector('.rm-contact-unread').textContent, '2');
    assert.match(chat.getAttribute('aria-label'), /2 条未读/);

    chat.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false);
    assert.equal(ui.viewState.pages.messages.returnPage, 'contacts');
    assert.equal(ui.viewState.pages.messages.returnFocus, `contact-chat:${PEER_A}`);
    assert.deepEqual(ui.navCurrent(), ['contacts'], 'only the contacts section is selected in a chat');

    const draft = ui.shadow.querySelector('#messageInput');
    draft.value = '未发送的草稿';
    draft.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.shadow.querySelector('#conversationBack').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-contacts').hidden, false);
    assert.equal(query.value, 'Ali', 'search survives the chat round trip');
    assert.equal(ui.shadow.querySelector('[data-contact-filter="unread"]').getAttribute('aria-pressed'), 'true');
    assert.equal(page.scrollTop, 120, 'contact scroll survives the chat round trip');
    assert.equal(ui.active(), chat, 'the exact inline chat trigger regains focus');
    assert.equal(ui.app.getDraft(`chat:${PEER_A}`), '未发送的草稿');
  } finally {
    ui.close();
  }
});

test('profile message action returns to the same tab, scroll and trigger for posts and address', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' })]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => messagePage(peerId, []),
    onLoadPeerProfile: async () => profile(),
    onLoadPeerDiscoveries: async () => ({ peerId: PEER_A, items: [], at: Date.now(), error: null, freshness: 'live', truncated: false }),
    onLoadPeerFriends: async () => ({ peerId: PEER_A, source: 'remote', at: Date.now(), error: null, limited: false, friends: [] }),
    onLoadContactMemory: async () => ({ peerId: PEER_A, state: 'missing', sha256: '', schemaVersion: 2, contact: null, timeline: [], timelineTruncated: false, error: '', at: Date.now() }),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    await settle();
    ui.shadow.querySelector('#contactList button[data-contact-peer]').click();
    await settle();
    const profileView = ui.shadow.querySelector('#profileView');
    const profileScroll = modelHiddenScroll(profileView);
    const messageButton = ui.shadow.querySelector('#profileMessage');

    for (const tab of ['posts', 'address']) {
      ui.shadow.querySelector(`[data-profile-tab="${tab}"]`).click();
      await settle();
      profileScroll.set(tab === 'posts' ? 210 : 260);
      messageButton.click();
      await settle();
      assert.equal(ui.shadow.querySelector('#conversationView').hidden, false);
      assert.equal(ui.viewState.pages.messages.returnPage, 'profile');
      assert.equal(ui.viewState.pages.messages.returnProfileTab, tab);
      assert.match(ui.shadow.querySelector('#conversationBack').textContent, /返回联系人档案/);
      assert.deepEqual(ui.navCurrent(), ['contacts']);
      ui.shadow.querySelector('#conversationBack').click();
      await settle();
      assert.equal(profileView.hidden, false, 'the profile is reopened, not replaced by the contact list');
      assert.equal(ui.shadow.querySelector(`[data-profile-tab="${tab}"]`).getAttribute('aria-current'), 'page');
      assert.equal(ui.shadow.querySelector('#contactProfilePosts').hidden, tab !== 'posts');
      assert.equal(ui.shadow.querySelector('#contactProfileAddress').hidden, tab !== 'address');
      assert.equal(profileScroll.get(), tab === 'posts' ? 210 : 260, 'profile scroll is restored');
      assert.equal(ui.active(), messageButton, 'the message action regains focus');
      assert.equal(ui.viewState.pages.messages.returnPage, '', 'the chat source is cleared after returning');
    }
  } finally {
    ui.close();
  }
});

test('interaction message evidence opens the exact chat and returns to its evidence row', async () => {
  const memory = {
    peerId: PEER_A, state: 'missing', sha256: '', schemaVersion: 2, contact: null,
    timeline: [{
      id: 'message:m-evidence', kind: 'message', at: Date.now(), summary: '一条真实历史消息',
      source: '对方消息', private: true, evidence: { messageIds: ['m-evidence'] }, direction: 'in', origin: 'unknown',
    }],
    timelineTruncated: false, error: '', at: Date.now(),
  };
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' })]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message('m-evidence', '一条真实历史消息')]),
    onLoadPeerProfile: async () => profile(),
    onLoadContactMemory: async () => memory,
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    await settle();
    ui.shadow.querySelector('#contactList button[data-contact-peer]').click();
    await settle();
    const profileView = ui.shadow.querySelector('#profileView');
    const profileScroll = modelHiddenScroll(profileView);
    profileScroll.set(90);
    const evidenceKey = memoryEvidenceFocusKey(PEER_A, 'message:m-evidence', 'm-evidence');
    const evidence = ui.shadow.querySelector(`[data-focus-key="${evidenceKey}"]`);
    assert.ok(evidence, 'the timeline message has a stable item-and-message evidence focus key');
    evidence.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false);
    assert.equal(ui.viewState.pages.messages.returnPage, 'profile');
    assert.equal(ui.viewState.pages.messages.returnFocus, evidenceKey);
    assert.equal(ui.shadow.querySelector(`#messageList [data-message-id="m-evidence"]`) !== null, true);
    ui.shadow.querySelector('#conversationBack').click();
    await settle();
    assert.equal(profileView.hidden, false);
    assert.equal(ui.shadow.querySelector('[data-profile-tab="interactions"]').getAttribute('aria-current'), 'page');
    assert.equal(profileScroll.get(), 90);
    assert.equal(ui.active(), ui.shadow.querySelector(`[data-focus-key="${evidenceKey}"]`));
  } finally {
    ui.close();
  }
});

test('the gear returns to the conversation index and to a focused chat with its draft', async () => {
  const row = {
    peerId: PEER_A, lastMessageId: 'm1', direction: 'in', preview: '你好',
    lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1,
  };
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' })]),
    onLoadConversations: async () => conversations([row]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message('m1', '你好')]),
    onSend: async (peerId, text, requestId) => ({
      ok: true, unknown: false, invalid: false, peerId, requestId, messageId: 'out-1',
      replayed: false, acked: true, deliveryStatus: 'acked', outboxStatus: 'acked',
      error: null, detail: null, at: Date.now(),
    }),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    ui.app.setConversations(conversations([row]));
    await settle();
    ui.shadow.querySelector('#contactsMessages').click();
    await settle();
    const page = ui.shadow.querySelector('#page-messages');
    const indexScroll = modelHiddenScroll(page);
    indexScroll.set(140);
    const indexRow = ui.shadow.querySelector('#conversationList button[data-conversation-peer]');
    indexRow.focus();

    ui.shadow.querySelector('#settingsTrigger').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-settings').hidden, false);
    assert.equal(ui.shadow.querySelector('#settingsIndex').hidden, false);
    assert.equal(ui.shadow.querySelector('#settingsClose').hidden, false);
    ui.shadow.querySelector('#settingsClose').click();
    await settle(30);
    assert.equal(ui.shadow.querySelector('#page-messages').hidden, false);
    assert.equal(ui.shadow.querySelector('#messagesIndex').hidden, false);
    assert.equal(indexScroll.get(), 140, 'conversation index scroll is restored after settings');
    assert.ok(ui.shadow.querySelector('#page-messages').contains(ui.active()), 'focus returns to the conversation index');

    indexRow.click();
    await settle();
    const input = ui.shadow.querySelector('#messageInput');
    input.value = '设置往返草稿';
    input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.shadow.querySelector('#settingsTrigger').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-settings').hidden, false);
    ui.shadow.querySelector('#settingsClose').click();
    await settle(30);
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false, 'the same chat is still open');
    assert.equal(input.value, '设置往返草稿', 'the unsent draft survives the settings detour');
    assert.equal(ui.active(), input, 'closing settings returns focus to the composer');
  } finally {
    ui.close();
  }
});

test('an unread filter row that disappears after a human read falls back to the unread filter', async () => {
  Object.defineProperty(uiDocument(), 'visibilityState', { configurable: true, value: 'visible' });
  let markReads = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice', unreadCount: 1 })]),
    onLoadConversations: async () => conversations([{ peerId: PEER_A, lastMessageId: 'm1', direction: 'in', preview: '未读', lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1, unreadCount: 1 }]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message('m1', '未读')]),
    onSend: async (peerId, text, requestId) => ({
      ok: true, unknown: false, invalid: false, peerId, requestId, messageId: 'out-1',
      replayed: false, acked: true, deliveryStatus: 'acked', outboxStatus: 'acked',
      error: null, detail: null, at: Date.now(),
    }),
    onMarkRead: async (peerId, messageId) => {
      markReads += 1;
      return { peerId, messageId, unreadCount: 0, lastReadMessageId: messageId, lastReadAt: Date.now() };
    },
  });
  try {
    Object.defineProperty(ui.dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
    ui.dom.window.document.hasFocus = () => true;
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice', unreadCount: 1 })]));
    ui.app.setConversations(conversations([{ peerId: PEER_A, lastMessageId: 'm1', direction: 'in', preview: '未读', lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1, unreadCount: 1 }]));
    await settle();
    ui.shadow.querySelector('[data-contact-filter="unread"]').click();
    await settle();
    ui.shadow.querySelector('#contactList button[data-chat-peer]').click();
    await settle();
    await settle(650);
    assert.equal(markReads, 1, 'a visible, focused human chat at the bottom advances the read cursor once');
    ui.shadow.querySelector('#conversationBack').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#contactList').hidden, true, 'the now-read row left the unread filter');
    assert.equal(ui.active(), ui.shadow.querySelector('[data-contact-filter="unread"]'), 'focus falls back to the active filter');
  } finally {
    ui.close();
  }
});

function uiDocument() {
  return globalThis.document;
}

test('a settings detour before the mark-read debounce does not clear unread', async () => {
  let markReads = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice', unreadCount: 1 })]),
    onLoadConversations: async () => conversations([{ peerId: PEER_A, lastMessageId: 'm1', direction: 'in', preview: '未读', lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1, unreadCount: 1 }]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message('m1', '未读')]),
    onSend: async (peerId, text, requestId) => ({
      ok: true, unknown: false, invalid: false, peerId, requestId, messageId: 'out-1',
      replayed: false, acked: true, deliveryStatus: 'acked', outboxStatus: 'acked',
      error: null, detail: null, at: Date.now(),
    }),
    onMarkRead: async (peerId, messageId) => {
      markReads += 1;
      return { peerId, messageId, unreadCount: 0, lastReadMessageId: messageId, lastReadAt: Date.now() };
    },
  });
  try {
    Object.defineProperty(ui.dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
    ui.dom.window.document.hasFocus = () => true;
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice', unreadCount: 1 })]));
    ui.app.setConversations(conversations([{ peerId: PEER_A, lastMessageId: 'm1', direction: 'in', preview: '未读', lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1, unreadCount: 1 }]));
    await settle();
    ui.shadow.querySelector('#contactList button[data-chat-peer]').click();
    await settle();
    ui.shadow.querySelector('#settingsTrigger').click();
    await settle(650);
    assert.equal(markReads, 0, 'leaving the conversation cancels the pending mark-read write');
    assert.equal(ui.viewState.pages.messages.returnPage, 'contacts');
  } finally {
    ui.close();
  }
});

test('a chat and profile source survive a host remount and return to the same tab', async () => {
  let ui = mountUi({
    onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' })]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => messagePage(peerId, []),
    onLoadPeerProfile: async () => profile(),
    onLoadPeerFriends: async () => ({ peerId: PEER_A, source: 'remote', at: Date.now(), error: null, limited: false, friends: [] }),
    onLoadContactMemory: async () => ({ peerId: PEER_A, state: 'missing', sha256: '', schemaVersion: 2, contact: null, timeline: [], timelineTruncated: false, error: '', at: Date.now() }),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    await settle();
    ui.shadow.querySelector('#contactList button[data-contact-peer]').click();
    await settle();
    ui.shadow.querySelector('[data-profile-tab="address"]').click();
    await settle();
    ui.shadow.querySelector('#profileMessage').click();
    await settle();
    const viewState = ui.viewState;
    ui.app.destroy();
    ui.dom.window.close();

    ui = mountUi({
      viewState,
      onLoadContacts: async () => contacts([friend(PEER_A, { name: 'Alice' })]),
      onLoadConversations: async () => conversations([]),
      onLoadMessages: async (peerId) => messagePage(peerId, []),
      onLoadPeerProfile: async () => profile(),
      onLoadPeerFriends: async () => ({ peerId: PEER_A, source: 'remote', at: Date.now(), error: null, limited: false, friends: [] }),
      onLoadContactMemory: async () => ({ peerId: PEER_A, state: 'missing', sha256: '', schemaVersion: 2, contact: null, timeline: [], timelineTruncated: false, error: '', at: Date.now() }),
    });
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    await settle();
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false, 'the chat, not the profile overlay, is restored');
    assert.match(ui.shadow.querySelector('#conversationBack').textContent, /返回联系人档案/);
    assert.equal(ui.shadow.querySelector('#profileView').hidden, true);
    ui.shadow.querySelector('#conversationBack').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.equal(ui.shadow.querySelector('[data-profile-tab="address"]').getAttribute('aria-current'), 'page');
  } finally {
    ui.close();
  }
});

test('home edit returns to the same position while gear sub-pages return to the settings index', async () => {
  const ui = mountUi({
    viewState: { page: 'home' },
    onLoadMine: async () => ({
      peerId: PEER_A, at: Date.now(), error: null, errorAt: null, freshness: 'live',
      profile: { state: 'missing', markdown: '', displayName: '', path: 'profile/index.md', error: '', at: null },
      posts: { state: 'available', posts: [], error: '', unattributed: 0, agentAuthored: 0, invalid: 0, errors: [], truncated: false },
      agentCard: { state: 'missing', card: null, error: '' },
      publicProfile: { state: 'missing', profile: null, error: '' },
      files: [], filesTruncated: false,
    }),
  });
  try {
    await settle();
    const home = ui.shadow.querySelector('#page-home');
    const homeScroll = modelHiddenScroll(home);
    homeScroll.set(333);
    const edit = ui.shadow.querySelector('.rm-home-hero-edit');
    assert.ok(edit);
    edit.focus();
    edit.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#settings-public').hidden, false);
    assert.equal(ui.shadow.querySelector('#settingsIndex').hidden, true);
    assert.match(ui.shadow.querySelector('#settings-public [data-settings-back]').textContent, /返回主页/);
    ui.shadow.querySelector('#settings-public [data-settings-back]').click();
    await settle(30);
    assert.equal(ui.shadow.querySelector('#page-home').hidden, false);
    assert.equal(homeScroll.get(), 333, 'home scroll survives a direct public edit round trip');
    assert.equal(ui.active(), edit, 'the home edit entry regains focus');

    const gear = ui.shadow.querySelector('#settingsTrigger');
    gear.focus();
    gear.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#settingsIndex').hidden, false);

    ui.shadow.querySelector('#settingsIndex [data-settings-tab="files"]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#settings-files').hidden, false);
    assert.match(ui.shadow.querySelector('#settings-files [data-settings-back]').textContent, /返回设置/);
    ui.shadow.querySelector('#settings-files [data-settings-back]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#settingsIndex').hidden, false);

    ui.shadow.querySelector('#settingsIndex [data-settings-tab="private"]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#settings-private').hidden, false);
    ui.shadow.querySelector('#settings-private [data-settings-back]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#settingsIndex').hidden, false);

    ui.shadow.querySelector('#settingsIndex [data-settings-tab="public"]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#settings-public').hidden, false);
    assert.match(ui.shadow.querySelector('#settings-public [data-settings-back]').textContent, /返回设置/);
    ui.shadow.querySelector('#settings-public [data-settings-back]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#settingsIndex').hidden, false, 'gear sub-pages go back to the index, not home');

    ui.shadow.querySelector('#settingsClose').click();
    await settle(30);
    assert.equal(ui.shadow.querySelector('#page-home').hidden, false);
    assert.equal(homeScroll.get(), 333);
  } finally {
    ui.close();
  }
});
