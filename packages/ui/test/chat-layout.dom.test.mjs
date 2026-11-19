// Second-batch item 7: compact chat identity and honest source labels, a clear
// return to the newest message, and read-cursor safety while another surface
// (the peer profile) hides the conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWChatLayoutPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWChatLayoutPeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const AVATAR_URL = 'data:image/png;base64,iVBORw0KGgo=';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function friend(peerId = PEER_A, overrides = {}) {
  return { peerId, name: '', description: '', connection: 'connected', paused: false, unreadCount: 0, ...overrides };
}

function contacts(friends) {
  return {
    friends, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    connectionFreshness: 'live', total: friends.length,
  };
}

function conversations(rows = []) {
  return {
    conversations: rows, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    totalUnread: rows.reduce((sum, row) => sum + (Number(row.unreadCount) || 0), 0),
    retention: { retainedMessages: 20, oldestRetainedAt: Date.now() - 1000, maxStoredMessages: 50000 },
  };
}

function message(id, text, overrides = {}) {
  return {
    messageId: id, peerId: PEER_A, direction: 'in', text, acked: true,
    createdAt: Date.now() - 1000, ackedAt: null, deliveryStatus: 'received', deliveryError: '',
    origin: 'unknown', deliveryUpdatedAt: null, clientRequestId: '', ...overrides,
  };
}

function messagePage(peerId, messages, overrides = {}) {
  return {
    peerId, messages, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    hasMore: false, nextBefore: '',
    retention: { retainedMessages: messages.length, oldestRetainedAt: Date.now() - 1000, maxStoredMessages: 50000 },
    ...overrides,
  };
}

function verifiedProjection(peerId = PEER_A) {
  return {
    state: 'available', at: Date.now(), error: '',
    profiles: [{
      peerId,
      displayName: '潮汐线旁的林岸',
      description: '慢一点回信，先把海边的事看完。',
      interests: ['潮汐', '旧信'],
      conversationStyle: '不急着追问。',
      source: 'remote-profile',
      verifiedAt: Date.now(),
      avatarKey: `${peerId}\u0000profile/avatar-aaaaaaaa.png\u0000${'a'.repeat(64)}\u0000123`,
      avatarUrl: AVATAR_URL,
      avatarMime: 'image/png',
      avatarSha256: 'a'.repeat(64),
      avatarSizeBytes: 123,
      avatarState: 'ready',
      avatarError: '',
    }],
    clues: [],
  };
}

function peerProfile(peerId = PEER_A) {
  return {
    peerId, localName: 'chengye', remoteName: '林岸', found: true,
    text: '# 林岸\n\n住在潮汐线附近。',
    files: ['profile/index.md', 'profile/avatar-aaaaaaaa.png'],
    source: 'remote', at: Date.now(), error: null, freshness: 'live',
    agentCard: {
      state: 'available',
      card: {
        schemaVersion: 1,
        displayName: '潮汐线旁的林岸',
        description: '慢一点回信，先把海边的事看完。',
        interests: ['潮汐', '旧信'],
        conversationStyle: '不急着追问。',
        updatedAt: '',
        path: 'profile/profile.json',
        sha256: '',
        avatarPath: 'profile/avatar-aaaaaaaa.png',
        avatarSha256: 'a'.repeat(64),
        avatarMime: 'image/png',
      },
      error: '',
    },
    manifest: {
      peerId, publisherName: '林岸', source: 'remote', at: Date.now(), error: null, errorAt: null,
      freshness: 'live', truncated: false, total: 2,
      entries: [
        { path: 'profile/profile.json', sha256: 'b'.repeat(64), sizeBytes: 400, kind: 'json', mime: 'application/json' },
        { path: 'profile/avatar-aaaaaaaa.png', sha256: 'a'.repeat(64), sizeBytes: 123, kind: 'image', mime: 'image/png' },
      ],
    },
    node: null,
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
    pages: { contacts: { query: '', scroll: 0 }, messages: { peerId: '', query: '', scroll: 0, chatScrolls: {} } },
    drafts: {},
  };
  const app = createRamingaApp(shadow, { viewState, ...options });
  app.onLeaseReady();
  return {
    dom, shadow, app, viewState,
    page: shadow.querySelector('#page-messages'),
    conversationView: shadow.querySelector('#conversationView'),
    conversationName: shadow.querySelector('#conversationName'),
    conversationAvatar: shadow.querySelector('#conversationAvatar'),
    conversationProfile: shadow.querySelector('#conversationProfile'),
    conversationMeta: shadow.querySelector('#conversationMeta'),
    conversationPeerId: shadow.querySelector('#conversationPeerId'),
    messageList: shadow.querySelector('#messageList'),
    messageInput: shadow.querySelector('#messageInput'),
    jump: shadow.querySelector('#messageJumpLatest'),
    composerJump: shadow.querySelector('#composerJump'),
    active: () => shadow.activeElement,
    close: () => { app.destroy(); dom.window.close(); },
  };
}

async function openFromContact(ui) {
  const chatButton = ui.shadow.querySelector('#contactList button[data-chat-peer]');
  assert.ok(chatButton, 'a chat entry exists on the contact row');
  chatButton.click();
  await settle();
}

test('the chat header prioritises the verified name/avatar and exposes a profile return', async () => {
  const ui = mountUi({
    onLoadContactProjection: async () => verifiedProjection(),
    onLoadPeerProfile: async (peerId) => peerProfile(peerId),
    onLoadMessages: async (peerId) => messagePage(peerId, [
      message('in-1', '对方消息', { createdAt: 1000 }),
      message('out-human', '本人消息', { createdAt: 2000, direction: 'out', origin: 'human', deliveryStatus: 'acked' }),
      message('out-agent', 'Agent 消息', { createdAt: 3000, direction: 'out', origin: 'agent', deliveryStatus: 'pending' }),
      message('out-old', '旧版消息', { createdAt: 4000, direction: 'out', origin: 'unknown', deliveryStatus: 'unknown' }),
    ]),
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'chengye', description: '本机备注：旧名字' })]));
    ui.app.setConversations(conversations([]));
    await settle();
    await openFromContact(ui);
    await settle();

    assert.equal(ui.conversationName.textContent, '潮汐线旁的林岸', 'the verified public name wins over the local alias');
    assert.equal(ui.conversationAvatar.getAttribute('data-kind'), 'image');
    assert.equal(ui.conversationAvatar.querySelector('img')?.getAttribute('src'), AVATAR_URL);
    assert.equal(ui.conversationProfile.hidden, false);
    assert.equal(ui.conversationProfile.textContent, '查看档案');
    assert.match(ui.conversationProfile.getAttribute('aria-label'), /潮汐线旁的林岸/);
    assert.equal(ui.conversationMeta.open, false, 'the full identifier stays in a closed secondary disclosure');
    assert.equal(ui.conversationPeerId.textContent, PEER_A);
    assert.equal(ui.conversationMeta.textContent.includes(PEER_A), true);
    assert.match(ui.shadow.querySelector('#conversationOrigin').textContent, /入口来源：联系人列表/);
    assert.equal(ui.shadow.querySelector('.rm-conversation-head').textContent.includes(PEER_A), false, 'the identifier is not in the primary header');
    assert.equal(ui.shadow.querySelector('#conversationLocalNote').textContent.includes('chengye'), true, 'the local alias remains available as a secondary note');

    const origins = [...ui.shadow.querySelectorAll('.rm-message-origin')].map((node) => node.textContent);
    assert.deepEqual(origins, ['对方', '本人', 'Agent', '来源未知']);
    assert.equal(ui.shadow.querySelectorAll('.rm-message-status').length, 3, 'delivery state stays on outgoing messages only');
    assert.match(ui.messageList.textContent, /协议已接收/);
    assert.match(ui.messageList.textContent, /待发送 · 等待确认/);
    assert.match(ui.messageList.textContent, /投递状态未知/);

    ui.messageInput.value = '档案往返时保留的草稿';
    ui.messageInput.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    Object.defineProperty(ui.messageList, 'scrollTop', { configurable: true, writable: true, value: 36 });
    ui.messageList.dispatchEvent(new ui.dom.window.Event('scroll'));

    ui.conversationProfile.focus();
    ui.conversationProfile.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.equal(ui.page.hidden, true);
    ui.shadow.querySelector('#profileBack').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, true);
    assert.equal(ui.conversationView.hidden, false);
    assert.equal(ui.messageInput.value, '档案往返时保留的草稿');
    assert.equal(ui.messageList.scrollTop, 36, 'the visible history position survives the profile detour');
    assert.equal(ui.active(), ui.conversationProfile, 'the exact profile entry regains focus');
    assert.equal(ui.conversationProfile.hidden, false);
    assert.equal(ui.conversationMeta.open, false);
  } finally {
    ui.close();
  }
});

test('a reader away from the newest message is not pulled by a later page and can return explicitly', async () => {
  const ui = mountUi({
    onLoadMessages: async (peerId) => messagePage(peerId, Array.from({ length: 18 }, (_, index) => message(`m-${index + 1}`, `第 ${index + 1} 条真实历史`))),
    onSend: async () => ({}),
  });
  try {
    Object.defineProperty(ui.messageList, 'scrollHeight', { configurable: true, get: () => 1600 });
    Object.defineProperty(ui.messageList, 'clientHeight', { configurable: true, value: 240 });
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    ui.app.setConversations(conversations([]));
    await settle();
    await openFromContact(ui);
    await settle();
    assert.equal(ui.messageList.scrollTop, 1600, 'a new conversation starts at the newest message');
    assert.equal(ui.composerJump.hidden, true);

    ui.messageList.scrollTop = 320;
    ui.messageList.dispatchEvent(new ui.dom.window.Event('scroll'));
    assert.equal(ui.composerJump.hidden, false, 'reading older history offers a clear return to latest');

    ui.app.setMessagePage(messagePage(PEER_A, [
      ...Array.from({ length: 18 }, (_, index) => message(`m-${index + 1}`, `第 ${index + 1} 条真实历史`)),
      message('m-19', '轮询到达的新消息'),
    ]));
    await settle();
    assert.equal(ui.messageList.scrollTop, 320, 'a late page keeps the reading position');
    assert.equal(ui.composerJump.hidden, false, 'the reader is still visibly away from the newest message');

    ui.dom.window.dispatchEvent(new ui.dom.window.Event('resize'));
    await settle();
    assert.equal(ui.messageList.scrollTop, 320, 'a width change does not pull the reader to the bottom');

    ui.jump.click();
    await settle();
    assert.equal(ui.messageList.scrollTop, 1600, 'the explicit action reaches the newest message');
    assert.equal(ui.composerJump.hidden, true);
    assert.equal(ui.active(), ui.messageInput, 'returning to latest leaves a visible keyboard target');
    assert.match(ui.messageList.textContent, /轮询到达的新消息/);
  } finally {
    ui.close();
  }
});

test('a visible bottom chat marks read, but a profile layered over it does not', async () => {
  Object.defineProperty(globalThis.document, 'visibilityState', { configurable: true, value: 'visible' });
  const reads = [];
  const ui = mountUi({
    onLoadMessages: async (peerId) => messagePage(peerId, [message('m-1', '一'), message('m-2', '二')]),
    onLoadPeerProfile: async (peerId) => peerProfile(peerId),
    onSend: async () => ({}),
    onMarkRead: async (peerId, messageId) => {
      reads.push([peerId, messageId]);
      return { peerId, lastReadMessageId: messageId, lastReadAt: Date.now(), unreadCount: 0 };
    },
  });
  try {
    ui.dom.window.document.hasFocus = () => true;
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'chengye', unreadCount: 2 })]));
    ui.app.setConversations(conversations([{
      peerId: PEER_A, lastMessageId: 'm-2', direction: 'in', preview: '二',
      lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 2, unreadCount: 2,
    }]));
    await settle();
    await openFromContact(ui);
    await settle();
    ui.messageInput.focus();
    ui.conversationProfile.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    await wait(700);
    assert.deepEqual(reads, [], 'a hidden conversation must not advance the human read cursor');

    ui.shadow.querySelector('#profileBack').click();
    await settle();
    await wait(700);
    assert.deepEqual(reads, [[PEER_A, 'm-2']], 'returning to the visible bottom chat resumes normal mark-read');
  } finally {
    ui.close();
  }
});
