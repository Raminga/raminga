// P3 acceptance: durable unread UI (visible/focused/bottom only), only-public
// post favorites, contact home interactions and controlled private impressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp, memorySourceText, readFailureSummary, uncertaintyText } from '../src/app.js';

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
    viewState: options.viewState ?? {
      page: 'explore',
      pages: { explore: { filter: 'all', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} } },
    },
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function contact(overrides = {}) {
  return { peerId: PEER_A, name: 'Alice', description: '', connection: 'connected', paused: false, addrs: [], unreadCount: 0, ...overrides };
}
function contacts(friends) {
  return { friends, at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: friends.length };
}
function conversation(overrides = {}) {
  return {
    peerId: PEER_A, lastMessageId: 'm2', direction: 'in', preview: '上次聊到地图',
    lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 2, hasMessages: true, unreadCount: 2, ...overrides,
  };
}
function conversations(items) {
  return {
    conversations: items, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    retention: { retainedMessages: 10, oldestRetainedAt: null, maxStoredMessages: 1000 },
    totalUnread: items.reduce((sum, item) => sum + item.unreadCount, 0),
  };
}
function message({ id, text, at, direction = 'in', origin = 'unknown' }) {
  return {
    messageId: id, peerId: PEER_A, direction, text, acked: direction === 'out',
    createdAt: at, ackedAt: direction === 'out' ? at + 1 : 0,
    deliveryStatus: direction === 'out' ? 'acked' : 'received', deliveryError: '', origin,
  };
}
function messagePage(peerId, messages) {
  return { peerId, messages, at: Date.now(), error: null, errorAt: null, freshness: 'live', hasMore: false, nextBefore: '', retention: { retainedMessages: messages.length, oldestRetainedAt: null, maxStoredMessages: 1000 } };
}
function baseItem(overrides = {}) {
  return {
    id: 'post-1', peerId: PEER_A, publisherName: '发布节点', path: 'posts/a.json', name: 'a.json',
    sha256: 'a'.repeat(64), sizeBytes: 100, modifiedAt: 0, fetchedAt: Date.now(),
    source: 'raminga_ui_manual', sources: ['raminga_ui_manual'], kind: 'markdown', mime: 'text/markdown',
    previewable: true, title: '地图', summary: '一条公开动态', tags: [], publishedAt: '', authorKind: 'user',
    authorName: 'Alice', contentState: 'available', contentError: '', ...overrides,
  };
}
function discoveries(items) {
  return { items, at: Date.now(), error: null, errorAt: null, freshness: 'live', familiar: false, scanned: items.length, truncated: false, relationComplete: true, ignored: 0 };
}
function profile(overrides = {}) {
  return {
    peerId: PEER_A, localName: 'Alice', remoteName: 'Alice', found: true,
    text: '# Alice\n\n公开资料。', files: ['profile/index.md'], at: Date.now(), error: null, freshness: 'live',
    agentCard: {
      state: 'available',
      card: { schemaVersion: 1, displayName: 'Nova', description: '像素旅人', interests: ['地图'], conversationStyle: '慢', updatedAt: '2026-11-14T10:00:00Z', path: 'profile/agent-card.json', sha256: 'e'.repeat(64) },
      error: '',
    },
    manifest: { source: 'remote', entries: [], error: '', truncated: false }, node: null, ...overrides,
  };
}

async function goToContacts(ui) {
  ui.click('button[data-nav="contacts"]');
  await settle();
}
async function openChatFromIndex(ui) {
  await goToContacts(ui);
  ui.click('#contactsMessages');
  await settle();
  ui.click('#conversationList button[data-conversation-peer]');
  await settle();
}

test('contacts expose unread filter, recent message source and navigation badge', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact({ unreadCount: 2 }), contact({ peerId: PEER_B, name: 'Bob', connection: 'disconnected', unreadCount: 0 })]),
    onLoadConversations: async () => conversations([conversation({ unreadCount: 2 }), conversation({ peerId: PEER_B, preview: '另一条', direction: 'out', origin: 'agent', unreadCount: 0, lastMessageId: 'b1' })]),
    onLoadMessages: async (peerId) => messagePage(peerId, []),
  });
  try {
    ui.app.setContacts(contacts([contact({ unreadCount: 2 }), contact({ peerId: PEER_B, name: 'Bob', connection: 'disconnected', unreadCount: 0 })]));
    ui.app.setConversations(conversations([conversation({ unreadCount: 2 }), conversation({ peerId: PEER_B, preview: '另一条', direction: 'out', origin: 'agent', unreadCount: 0, lastMessageId: 'b1' })]));
    await settle();
    assert.equal(ui.shadow.querySelector('[data-nav-badge="contacts"]').textContent, '2');
    await goToContacts(ui);
    assert.match(ui.text('#contactList'), /最近：上次聊到地图/);
    assert.equal(ui.shadow.querySelector('[data-contact-row="' + PEER_A + '"] .rm-contact-unread').getAttribute('aria-label'), '2 条未读');
    const bobRecent = ui.shadow.querySelector('[data-contact-row="' + PEER_B + '"] .rm-contact-recent');
    assert.equal(bobRecent.dataset.origin, 'Agent');
    assert.match(bobRecent.textContent, /最近：另一条/);
    ui.click('[data-contact-filter="unread"]');
    await settle();
    assert.equal(ui.shadow.querySelectorAll('#contactList [data-contact-row]').length, 1);
    assert.match(ui.text('#contactList'), /Alice/);
    assert.doesNotMatch(ui.text('#contactList'), /Bob/);
    assert.equal(ui.text('#contactUnreadCount'), '1');
    ui.click('[data-contact-filter="all"]');
    await settle();
    assert.equal(ui.shadow.querySelectorAll('#contactList [data-contact-row]').length, 2);
  } finally {
    ui.close();
  }
});

test('mark read waits for visible focused bottom and cancels on page switch, scroll up or destroy', async () => {
  const calls = [];
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact({ unreadCount: 2 })]),
    onLoadConversations: async () => conversations([conversation({ unreadCount: 2 })]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message({ id: 'm1', text: '一', at: 1000 }), message({ id: 'm2', text: '二', at: 2000 })]),
    onSend: async () => ({}),
    onMarkRead: async (peerId, id) => { calls.push([peerId, id]); return { peerId, lastReadMessageId: id, lastReadAt: 3000, unreadCount: 0 }; },
  });
  try {
    ui.app.setContacts(contacts([contact({ unreadCount: 2 })]));
    ui.app.setConversations(conversations([conversation({ unreadCount: 2 })]));
    await openChatFromIndex(ui);
    ui.shadow.querySelector('#messageInput').focus();
    await wait(650);
    assert.deepEqual(calls, [[PEER_A, 'm2']]);
    // Same row cannot be re-marked by repeated focus.
    ui.shadow.querySelector('#messageInput').focus();
    await wait(650);
    assert.equal(calls.length, 1);
  } finally {
    ui.close();
  }

  const secondCalls = [];
  const ui2 = mountUi({
    onLoadContacts: async () => contacts([contact()]),
    onLoadConversations: async () => conversations([conversation()]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message({ id: 'm1', text: '一', at: 1000 })]),
    onSend: async () => ({}),
    onMarkRead: async (peerId, id) => { secondCalls.push(id); return { peerId, lastReadMessageId: id, lastReadAt: 3000, unreadCount: 0 }; },
  });
  try {
    ui2.app.setContacts(contacts([contact()]));
    ui2.app.setConversations(conversations([conversation()]));
    await openChatFromIndex(ui2);
    const list = ui2.shadow.querySelector('#messageList');
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    list.scrollTop = 0;
    list.dispatchEvent(new ui2.dom.window.Event('scroll'));
    ui2.shadow.querySelector('#messageInput').focus();
    await wait(650);
    assert.equal(secondCalls.length, 0, 'reading older history must not mark newer messages');
    list.scrollTop = 800;
    list.dispatchEvent(new ui2.dom.window.Event('scroll'));
    await wait(650);
    assert.deepEqual(secondCalls, ['m1']);
  } finally {
    ui2.close();
  }

  const thirdCalls = [];
  const ui3 = mountUi({
    onLoadContacts: async () => contacts([contact()]),
    onLoadConversations: async () => conversations([conversation()]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message({ id: 'm1', text: '一', at: 1000 })]),
    onSend: async () => ({}),
    onMarkRead: async () => { thirdCalls.push('called'); return { unreadCount: 0 }; },
  });
  try {
    Object.defineProperty(ui3.dom.window.document, 'visibilityState', { configurable: true, value: 'hidden' });
    ui3.app.setContacts(contacts([contact()]));
    ui3.app.setConversations(conversations([conversation()]));
    await openChatFromIndex(ui3);
    ui3.shadow.querySelector('#messageInput').focus();
    await wait(650);
    assert.equal(thirdCalls.length, 0, 'hidden panel must not mark read');
    Object.defineProperty(ui3.dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
    ui3.dom.window.document.dispatchEvent(new ui3.dom.window.Event('visibilitychange'));
    await wait(650);
    assert.equal(thirdCalls.length, 1);

    ui3.click('button[data-nav="home"]');
    await settle();
    ui3.shadow.querySelector('#messageInput')?.focus();
    await wait(650);
    assert.equal(thirdCalls.length, 1, 'leaving the conversation cancels the timer');
  } finally {
    ui3.close();
  }

  const fourthCalls = [];
  const ui4 = mountUi({
    onLoadContacts: async () => contacts([contact()]),
    onLoadConversations: async () => conversations([conversation()]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message({ id: 'm1', text: '一', at: 1000 })]),
    onSend: async () => ({}),
    onMarkRead: async () => { fourthCalls.push('failed'); throw new Error('offline'); },
  });
  try {
    ui4.app.setContacts(contacts([contact()]));
    ui4.app.setConversations(conversations([conversation()]));
    await openChatFromIndex(ui4);
    ui4.shadow.querySelector('#messageInput').focus();
    await wait(1300);
    assert.equal(fourthCalls.length, 1, 'a failed same-row write must not become a retry loop');
    ui4.app.setMessagePage(messagePage(PEER_A, [message({ id: 'm1', text: '一', at: 1000 }), message({ id: 'm2', text: '新', at: 2000 })]));
    ui4.shadow.querySelector('#messageInput').focus();
    await wait(650);
    assert.equal(fourthCalls.length, 2, 'a newly arrived message can re-arm the debounce');
  } finally {
    ui4.close();
  }
});

test('only public post cards get a favorite star and failures roll back visibly', async () => {
  let reject = true;
  const rows = [baseItem(), baseItem({ id: 'note-1', path: 'notes/hello.md', name: 'hello.md', title: '笔记', kind: 'text', mime: 'text/plain' })];
  const ui = mountUi({
    onLoadDiscoveries: async () => discoveries(rows),
    onLoadFavorites: async () => ({ favorites: [], at: Date.now(), error: null, errorAt: null, freshness: 'live', hasMore: false, nextBefore: '', total: 0 }),
    onSetFavorite: async (input) => {
      if (reject) throw new Error('daemon rejected');
      return { favorite: true, item: { ...input, id: 'fav_1', createdAt: Date.now(), available: true } };
    },
  });
  try {
    await settle();
    const cards = [...ui.shadow.querySelectorAll('#discoveryList .rm-post')];
    assert.equal(cards.length, 2);
    assert.ok(cards[0].querySelector('.rm-post-favorite'), 'public post has a star');
    assert.equal(cards[1].querySelector('.rm-post-favorite'), null, 'non-post file has no star');
    assert.equal(ui.shadow.querySelector('#messagesIndex .rm-post-favorite'), null);
    assert.equal(ui.shadow.querySelector('#contactList .rm-post-favorite'), null);
    cards[0].querySelector('.rm-post-favorite').click();
    await settle();
    assert.match(ui.text('#discoveryMeta'), /收藏没有保存/);
    assert.equal(ui.shadow.querySelector('#discoveryList .rm-post-favorite').getAttribute('aria-pressed'), 'false');
    reject = false;
    ui.shadow.querySelector('#discoveryList .rm-post-favorite').click();
    await settle();
    assert.equal(ui.text('#discoveryList .rm-post-favorite'), '★ 已收藏');
  } finally {
    ui.close();
  }
});

test('settings favorites paginate and keep source position when returning from the author page', async () => {
  const first = { id: 'fav_1', peerId: PEER_A, path: 'posts/a.json', sha256: 'a'.repeat(64), title: '第一条', createdAt: 2000, available: true };
  const second = { id: 'fav_2', peerId: PEER_B, path: 'posts/b.json', sha256: 'b'.repeat(64), title: '第二条', createdAt: 1000, available: false };
  const befores = [];
  const ui = mountUi({
    onLoadFavorites: async (before) => {
      befores.push(before);
      return before === ''
        ? { favorites: [first], at: Date.now(), error: null, errorAt: null, freshness: 'live', hasMore: true, nextBefore: 'c1', total: 1 }
        : { favorites: [second], at: Date.now(), error: null, errorAt: null, freshness: 'live', hasMore: false, nextBefore: '', total: 1 };
    },
    onLoadContacts: async () => contacts([contact()]),
    onLoadConversations: async () => conversations([]),
    onLoadPeerProfile: async () => profile(),
  });
  try {
    await settle();
    assert.equal(ui.shadow.querySelector('#favoritesEntry').hidden, false);
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="favorites"]');
    await settle();
    assert.match(ui.text('#settingsFavoritesList'), /第一条/);
    ui.click('#settingsFavoritesMore');
    await settle();
    assert.deepEqual(befores, ['', 'c1']);
    assert.match(ui.text('#settingsFavoritesList'), /第二条/);
    assert.match(ui.text('#settingsFavoritesList'), /原内容已不在保留范围/);

    // Reproduce the 4321 crash: settings is a tracked scroll page outside
    // view.pages. Opening the author must persist and restore its position.
    const settingsPage = ui.shadow.querySelector('#page-settings');
    settingsPage.scrollTop = 420;
    ui.click('[data-favorite-source]');
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.equal(settingsPage.hidden, true);
    ui.click('#profileBack');
    await settle();
    assert.equal(settingsPage.hidden, false);
    assert.equal(settingsPage.scrollTop, 420);
    assert.match(ui.text('#settingsFavoritesList'), /第一条/);
    assert.match(ui.text('#settingsFavoritesList'), /第二条/);
  } finally {
    ui.close();
  }
});

test('local favorite source opens own public profile without dialing self, while remote source stays a peer profile', async () => {
  const local = { id: 'fav_local_source', peerId: PEER_A, path: 'posts/local/post.json', sha256: 'a'.repeat(64), title: '本机来源', createdAt: 2000, available: true };
  const remote = { id: 'fav_remote_source', peerId: PEER_B, path: 'posts/remote/post.json', sha256: 'b'.repeat(64), title: '远端来源', createdAt: 1000, available: true };
  const befores = [];
  const peerProfiles = [];
  const ui = mountUi({
    onLoadFavorites: async (before) => {
      befores.push(before);
      return before === ''
        ? { favorites: [local], at: Date.now(), error: null, errorAt: null, freshness: 'live', hasMore: true, nextBefore: 'c1', total: 1 }
        : { favorites: [remote], at: Date.now(), error: null, errorAt: null, freshness: 'live', hasMore: false, nextBefore: '', total: 1 };
    },
    onLoadMine: async () => ({
      peerId: PEER_A,
      files: [],
      posts: { state: 'missing', posts: [] },
      profile: { state: 'available', displayName: '本人验收', markdown: '# 本人验收\n\n本机公开介绍。' },
      agentCard: { state: 'available', card: { displayName: '本机 Agent', description: '本机公开 Agent 介绍。' }, error: '' },
      publicProfile: { state: 'missing', profile: null },
    }),
    onLoadPublicDraft: async () => ({ found: false, draft: null }),
    onLoadPeerProfile: async (peerId) => {
      peerProfiles.push(peerId);
      return profile({ peerId: PEER_B, localName: 'Bob', remoteName: 'Bob', text: '# Bob\n\n远端公开资料。' });
    },
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="favorites"]');
    await settle();
    ui.click('#settingsFavoritesMore');
    await settle();
    assert.deepEqual(befores, ['', 'c1']);

    const settingsPage = ui.shadow.querySelector('#page-settings');
    settingsPage.scrollTop = 420;
    ui.click('[data-favorite-source="fav_local_source"]');
    await settle();
    await settle();

    assert.equal(ui.shadow.querySelector('#page-settings').hidden, false);
    assert.equal(ui.shadow.querySelector('#settings-public').hidden, false);
    assert.equal(ui.shadow.querySelector('#settings-favorites').hidden, true);
    assert.equal(ui.shadow.querySelector('#profileView').hidden, true, 'self source must not open the remote contact profile');
    assert.equal(peerProfiles.length, 0, 'self source must not dial the local peer');
    assert.equal(ui.shadow.querySelector('#publicAgentName').value, '本机 Agent');
    assert.equal(ui.shadow.querySelector('#publicHumanName').value, '本人验收');
    assert.equal(ui.shadow.querySelector('#settings-public [data-settings-back]').textContent, '← 返回收藏的动态');

    ui.click('#settings-public [data-settings-back]');
    await settle();
    assert.equal(ui.shadow.querySelector('#settings-favorites').hidden, false);
    assert.equal(ui.shadow.querySelector('#settings-public').hidden, true);
    assert.equal(settingsPage.scrollTop, 420, 'favorites scroll returns with the source');
    assert.match(ui.text('#settingsFavoritesList'), /本机来源/);
    assert.match(ui.text('#settingsFavoritesList'), /远端来源/);
    assert.equal(befores.length, 2, 'return must not refetch or reset pagination');
    assert.equal(ui.shadow.activeElement?.dataset?.favoriteSource, 'fav_local_source', 'focus returns to the source button');

    ui.click('[data-favorite-source="fav_remote_source"]');
    await settle();
    assert.deepEqual(peerProfiles, [PEER_B], 'remote source still reads the peer profile');
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    ui.click('#profileBack');
    await settle();
    assert.equal(settingsPage.scrollTop, 420);
    assert.equal(ui.shadow.querySelector('#settingsFavoritesList').querySelectorAll('.rm-favorite-row').length, 2);
  } finally {
    ui.close();
  }
});

test('favorites read the exact version: local never dials itself, remote mismatch is not shown, invalid is cancellable', async () => {
  const local = { id: 'fav_local', peerId: PEER_A, path: 'posts/local/post.json', sha256: 'a'.repeat(64), title: '本机图文', createdAt: 3000, available: true };
  const remote = { id: 'fav_remote', peerId: PEER_B, path: 'posts/remote/post.json', sha256: 'b'.repeat(64), title: '远端图文', createdAt: 2000, available: true };
  const stale = { id: 'fav_stale', peerId: PEER_B, path: 'posts/gone/post.json', sha256: 'c'.repeat(64), title: '已失效', createdAt: 1000, available: false };
  const mineReads = [];
  const peerReads = [];
  const removals = [];
  let favorites = [local, remote, stale];
  const ui = mountUi({
    onLoadFavorites: async () => ({ favorites, at: Date.now(), error: null, errorAt: null, freshness: 'live', hasMore: false, nextBefore: '', total: favorites.length }),
    onLoadMine: async () => ({ peerId: PEER_A, files: [], posts: { posts: [] } }),
    onLoadMineFileContent: async (path, sha, size) => {
      mineReads.push([path, sha, size]);
      return {
        status: 'ok', kind: 'markdown', mime: 'text/markdown', title: '本机图文',
        text: '# 本机图文\n\n只能从本机公开目录读取的正文。', html: '', dataUrl: '', warnings: [], missingResources: [], error: '',
        post: { title: '本机图文', bodyMarkdown: '# 本机图文\n\n只能从本机公开目录读取的正文。', tags: [], images: [], authorKind: 'user', authorName: 'Alice', publishedAt: '' },
        path, sha256: sha, sizeBytes: 42, peerId: PEER_A,
      };
    },
    onLoadPeerFileContent: async (peerId, path, sha, size) => {
      peerReads.push([peerId, path, sha, size]);
      return {
        status: 'ok', kind: 'markdown', mime: 'text/markdown', title: '远端图文',
        text: '# 远端图文\n\n另一个版本，不应显示。', html: '', dataUrl: '', warnings: [], missingResources: [], error: '',
        post: { title: '远端图文', bodyMarkdown: '# 远端图文\n\n另一个版本，不应显示。', tags: [], images: [], authorKind: 'user', authorName: 'Bob', publishedAt: '' },
        path: 'posts/other/post.json', sha256: 'd'.repeat(64), sizeBytes: 50, peerId: PEER_B,
      };
    },
    onSetFavorite: async (input) => {
      removals.push(input);
      favorites = favorites.filter((item) => !(item.path === input.path && item.sha256 === input.sha256));
      return { favorite: false, item: null };
    },
    onLoadContacts: async () => contacts([contact()]),
    onLoadConversations: async () => conversations([]),
    onLoadPeerProfile: async () => profile(),
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="favorites"]');
    await settle();
    await settle();

    // Local favorite uses the controlled local public path, not peerFilePreview.
    ui.click('[data-favorite-read="fav_local"]');
    await settle();
    assert.deepEqual(mineReads, [['posts/local/post.json', 'a'.repeat(64), 0]]);
    assert.equal(peerReads.length, 0, 'a local post must not dial its own peer');
    assert.equal(ui.shadow.querySelector('#favoriteDialog').open, true);
    assert.match(ui.text('#favoriteDialogBody'), /只能从本机公开目录读取的正文/);
    ui.click('#favoriteDialog [data-close-dialog]');
    await settle();

    // A remote response for another SHA/path must never masquerade as the
    // favorited version.
    ui.click('[data-favorite-read="fav_remote"]');
    await settle();
    assert.deepEqual(peerReads, [[PEER_B, 'posts/remote/post.json', 'b'.repeat(64), 0]]);
    assert.match(ui.text('#favoriteDialogNote'), /版本不一致/);
    assert.doesNotMatch(ui.text('#favoriteDialogBody'), /另一个版本/);
    ui.click('#favoriteDialog [data-close-dialog]');
    await settle();

    // An unavailable favorite cannot be read but can be removed.
    assert.equal(ui.shadow.querySelector('[data-favorite-read="fav_stale"]').disabled, true);
    ui.click('[data-favorite-cancel="fav_stale"]');
    await settle();
    assert.equal(removals.length, 1);
    assert.equal(removals[0].favorite, false);
    assert.equal(removals[0].path, 'posts/gone/post.json');
    assert.equal(ui.shadow.querySelector('[data-favorite-cancel="fav_stale"]'), null);
    assert.equal(favorites.length, 2);
  } finally {
    ui.close();
  }
});

test('offline profile shows a short readable reason with raw details collapsed and translated memory values', async () => {
  const raw = '读取对方公开资料没有完成：Raminga 节点返回暂不可用（[unavailable] fetch manifest: dial peer 12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6 failed after 1 candidate(s): /ip4/127.0.0.1/tcp/58496: dial tcp4 127.0.0.1:58496: connect: connection refused; peer may be offline）。本机路径 /Users/fanyuhang/Documents/raminga/.local/p3/node-b/raminga.db 和 agent/contact-notes.json';
  const memory = {
    peerId: PEER_B, state: 'available', sha256: 'f'.repeat(64), schemaVersion: 2,
    contact: { peerId: PEER_B, impressions: [{ id: 'imp-1', summary: '表达克制。', uncertainty: 'medium', createdAt: '2026-11-18T09:55:00Z', updatedAt: '2026-11-18T09:55:00Z', evidenceRefs: { sessionIds: [], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] } }], observations: [], curiosities: [] },
    timeline: [
      { id: 'impression:imp-1', kind: 'impression', at: 4000, summary: '表达克制。', source: '私有印象 · 确定性 medium', private: true, evidence: { sessionIds: [], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] }, direction: '', origin: '' },
    ],
    timelineTruncated: false, error: '', at: Date.now(),
  };
  const ui = mountUi({
    viewState: { page: 'contacts', pages: { contacts: { filter: 'all', query: '', scroll: 0 } } },
    onLoadContacts: async () => contacts([contact({ peerId: PEER_B, name: 'Bob' })]),
    onLoadConversations: async () => conversations([]),
    onLoadPeerProfile: async () => profile({
      peerId: PEER_B, localName: 'Bob', remoteName: 'Bob', found: false, text: '', error: raw, source: 'local-copy',
      manifest: { source: 'local-history', entries: [], error: raw, truncated: false },
    }),
    onLoadContactMemory: async () => memory,
  });
  try {
    ui.app.setContacts(contacts([contact({ peerId: PEER_B, name: 'Bob' })]));
    await settle();
    ui.click('#contactList button[data-contact-peer]');
    await settle();
    assert.match(ui.text('#profileStale'), /对方当前不可达/);
    assert.doesNotMatch(ui.text('#profileStale'), /dial|ip4|connection refused|\/Users\/|\.db/);
    assert.equal(ui.shadow.querySelector('#profileReadDetails').hidden, false);
    assert.match(ui.text('#profileReadRaw'), /dial peer/);
    assert.match(ui.text('#profileReadRaw'), /\/Users\/fanyuhang/);
    assert.match(ui.text('#profileStale'), /技术详情|这次读取没有完成/);
    assert.match(ui.text('#profileTimeline'), /确定性 中/);
    assert.doesNotMatch(ui.text('#profileTimeline'), /确定性 medium/);
  } finally {
    ui.close();
  }
});

test('user-facing error helpers keep paths and implementation values out of the main label', () => {
  assert.equal(uncertaintyText('medium'), '中');
  assert.equal(memorySourceText('私有印象 · 确定性 medium'), '私有印象 · 确定性 中');
  const summary = readFailureSummary('fetch manifest: dial peer /ip4/127.0.0.1/tcp/1: connect: connection refused at /Users/me/data/raminga.db');
  assert.match(summary, /对方当前不可达/);
  assert.doesNotMatch(summary, /ip4|\/Users|\.db/);
  const pathOnly = readFailureSummary('读取 /Users/me/data/raminga.db 与 agent/contact-notes.json 失败');
  assert.doesNotMatch(pathOnly, /\/Users|\.db|contact-notes/);
  assert.equal(memorySourceText('私有观察 · contact-notes'), '私有观察 · 私有记忆记录');
});

test('contact memory shows private evidence, jumps to the message, and edits one impression with the file hash', async () => {
  const timeline = [
    { id: 'message:m1', kind: 'message', at: 1000, summary: '收到一条真实消息', source: '对方消息', private: true, evidence: { sessionIds: [], eventIds: [], messageIds: ['m1'], contentPaths: [], contentSha256: [] }, direction: 'in', origin: 'unknown' },
    { id: 'journey:s1:1', kind: 'journey', at: 2000, summary: '完成真实访问', source: 'Journey 记录 · visit_completed', private: true, evidence: { sessionIds: ['s1'], eventIds: ['s1:1'], messageIds: [], contentPaths: ['posts/a.json'], contentSha256: [] }, direction: '', origin: '' },
    { id: 'observation:obs-1', kind: 'observation', at: 3000, summary: '读过公开散步记录。', source: '私有观察 · contact-notes', private: true, evidence: { sessionIds: ['s1'], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] }, direction: '', origin: '' },
    { id: 'impression:imp-1', kind: 'impression', at: 4000, summary: '表达克制。', source: '私有印象 · 确定性 medium', private: true, evidence: { sessionIds: ['s1'], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] }, direction: '', origin: '' },
  ];
  const contactNote = {
    peerId: PEER_A, displayNameSnapshot: 'Alice', updatedAt: '2026-11-18T10:00:00Z',
    observations: [], curiosities: [],
    impressions: [{ id: 'imp-1', summary: '表达克制。', uncertainty: 'medium', createdAt: '2026-11-18T09:55:00Z', updatedAt: '2026-11-18T09:55:00Z', evidenceRefs: { sessionIds: ['s1'], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] } }],
  };
  let savedInput = null;
  const memory = {
    peerId: PEER_A, state: 'available', sha256: 'f'.repeat(64), schemaVersion: 2, contact: contactNote,
    timeline, timelineTruncated: false, error: '', at: Date.now(),
  };
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact()]),
    onLoadConversations: async () => conversations([conversation()]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message({ id: 'm1', text: '收到一条真实消息', at: 1000 })]),
    onLoadPeerProfile: async () => profile(),
    onLoadContactMemory: async () => memory,
    onLoadJourney: async () => ({
      state: 'available', at: Date.now(), persona: { state: 'missing', markdown: '', error: '', sha256: '' }, growth: { state: 'missing', markdown: '', error: '', sha256: '' },
      sessions: [{ id: 's1', dirModifiedAt: 1, stateRead: 'available', stateError: '', state: { status: 'completed', mode: 'exploration', intent: 'x', startedAt: '2026-11-18T09:00:00Z', updatedAt: '2026-11-18T10:00:00Z', completedAt: '2026-11-18T10:00:00Z', completionReason: 'goal', currentPeerId: PEER_A, visitedPeerIds: [PEER_A], discoverySources: [] }, eventsRead: 'available', eventsError: '', events: [], eventsTruncated: false, badEventLines: 0, reportRead: 'missing', reportError: '', reportMarkdown: '' }],
      sessionsState: 'available', sessionsError: '', sessionsTruncated: false, freshness: 'live',
    }),
    onSaveContactImpression: async (input) => {
      savedInput = input;
      const updatedContact = { ...contactNote, impressions: [{ ...contactNote.impressions[0], summary: input.summary, uncertainty: input.uncertainty }] };
      return { saved: true, conflict: false, sha256: 'e'.repeat(64), savedAt: Date.now(), contact: updatedContact, memory: { ...memory, sha256: 'e'.repeat(64), contact: updatedContact }, error: '' };
    },
  });
  try {
    ui.app.setContacts(contacts([contact()]));
    ui.app.setConversations(conversations([conversation()]));
    await goToContacts(ui);
    ui.click('#contactList button[data-contact-peer]');
    await settle();
    assert.match(ui.text('#profileTimeline'), /仅本机可见/);
    assert.match(ui.text('#profileTimeline'), /消息/);
    assert.match(ui.text('#profileTimeline'), /Journey/);
    assert.match(ui.text('#profileInteractionNote'), /仅本机保存的私有记忆/);
    assert.ok(ui.shadow.querySelector('[data-memory-message="m1"]'));
    assert.ok(ui.shadow.querySelector('[data-memory-journey="s1"]'));

    ui.click('#profileImpressionEdit');
    const dialog = ui.shadow.querySelector('#impressionDialog');
    assert.equal(dialog.open, true);
    const summary = ui.shadow.querySelector('#impressionSummary');
    assert.equal(summary.value, '表达克制。');
    summary.value = '更愿意交流，但仍需证据。';
    ui.shadow.querySelector('#impressionForm').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(savedInput.peerId, PEER_A);
    assert.equal(savedInput.impressionId, 'imp-1');
    assert.equal(savedInput.expectedSha256, 'f'.repeat(64));
    assert.equal(savedInput.summary, '更愿意交流，但仍需证据。');
    assert.equal(dialog.open, false);
    assert.match(ui.text('#profileImpressionSummary'), /更愿意交流/);

    // Journey evidence jump opens the exact independent Journey detail.
    ui.click('[data-memory-journey="s1"]');
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-journey').hidden, false);
    assert.match(ui.text('#journeyDetail'), /记录标识/);
    assert.match(ui.text('#journeyDetail'), /s1/);
    ui.click('#journeyBack');
    await settle();
    assert.equal(ui.shadow.querySelector('#page-home').hidden, false);

    // Message evidence jump opens the real conversation.
    ui.click('button[data-nav="contacts"]');
    await settle();
    ui.click('#contactList button[data-contact-peer]');
    await settle();
    ui.click('[data-memory-message="m1"]');
    await settle();
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false);
    assert.equal(ui.shadow.querySelector('#conversationPeerId').textContent, PEER_A);
  } finally {
    ui.close();
  }
});

test('mark read re-arms in finally when a newer message arrived while the write was in flight', async () => {
  let release;
  const calls = [];
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact({ unreadCount: 1 })]),
    onLoadConversations: async () => conversations([conversation({ unreadCount: 1 })]),
    onLoadMessages: async (peerId) => messagePage(peerId, [message({ id: 'm1', text: '一', at: 1000 })]),
    onSend: async () => ({}),
    onMarkRead: async (peerId, id) => {
      calls.push(id);
      if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
      return { peerId, lastReadMessageId: id, lastReadAt: 3000, unreadCount: 0 };
    },
  });
  try {
    ui.app.setContacts(contacts([contact({ unreadCount: 1 })]));
    ui.app.setConversations(conversations([conversation({ unreadCount: 1 })]));
    await openChatFromIndex(ui);
    ui.shadow.querySelector('#messageInput').focus();
    await wait(650);
    assert.deepEqual(calls, ['m1']);
    ui.app.setMessagePage(messagePage(PEER_A, [message({ id: 'm2', text: '新消息', at: 2000 })]));
    ui.shadow.querySelector('#messageInput').focus();
    await wait(650);
    assert.deepEqual(calls, ['m1'], 'a write already in flight is not duplicated');
    release();
    await wait(700);
    assert.deepEqual(calls, ['m1', 'm2'], 'finally re-arms for the newer row');
  } finally {
    ui.close();
  }
});

test('a non-contact author profile shows only local posts and an add-contact action', async () => {
  let memoryReads = 0;
  const ui = mountUi({
    onLoadDiscoveries: async () => discoveries([baseItem()]),
    onLoadContacts: async () => contacts([]),
    onLoadConversations: async () => conversations([]),
    onLoadPeerProfile: async () => profile({ remoteName: '远端作者' }),
    onLoadContactMemory: async () => { memoryReads += 1; return { peerId: PEER_A, state: 'missing', sha256: '', schemaVersion: 0, contact: null, timeline: [], timelineTruncated: false, error: '', at: Date.now() }; },
    onConnect: async () => ({ ok: true }),
  });
  try {
    ui.app.setContacts(contacts([]));
    await settle();
    ui.shadow.querySelector('#discoveryList [data-profile-peer]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.equal(ui.shadow.querySelector('[data-profile-tab="interactions"]').hidden, true);
    assert.equal(ui.shadow.querySelector('[data-profile-tab="address"]').hidden, true);
    assert.equal(ui.shadow.querySelector('[data-profile-tab="posts"]').hidden, false);
    assert.equal(ui.shadow.querySelector('[data-profile-tab="posts"]').getAttribute('aria-current'), 'page');
    assert.equal(ui.shadow.querySelector('#contactProfileInteractions').hidden, true);
    assert.equal(ui.shadow.querySelector('#contactProfilePosts').hidden, false);
    assert.equal(memoryReads, 0, 'a non-contact profile must not read private relationship memory');
    const add = ui.shadow.querySelector('#profileAddContact');
    assert.equal(add.hidden, false);
    add.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#addContactDialog').open, true);
    assert.equal(ui.shadow.querySelector('#addContactInput').value, PEER_A);
  } finally {
    ui.close();
  }
});

test('opening a profile before contacts load keeps the interactions tab and then loads memory', async () => {
  let memoryReads = 0;
  const ui = mountUi({
    viewState: {
      page: 'contacts',
      pages: { contacts: { filter: 'all', query: '', scroll: 0 } },
      contactProfile: { peerId: PEER_A, tab: 'interactions', returnPage: 'contacts', returnPeer: '', triggerId: `contacts:${PEER_A}` },
    },
    onLoadContacts: async () => contacts([contact()]),
    onLoadConversations: async () => conversations([conversation()]),
    onLoadPeerProfile: async () => profile(),
    onLoadContactMemory: async () => {
      memoryReads += 1;
      return { peerId: PEER_A, state: 'missing', sha256: '', schemaVersion: 0, contact: null, timeline: [], timelineTruncated: false, error: '', at: Date.now() };
    },
  });
  try {
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    ui.app.setContacts(contacts([contact()]));
    await settle();
    await settle();
    assert.equal(memoryReads, 1, 'the later contacts snapshot must make the peer a real contact');
    const interactions = ui.shadow.querySelector('[data-profile-tab="interactions"]');
    assert.equal(interactions.hidden, false);
    assert.equal(interactions.getAttribute('aria-current'), 'page');
    assert.equal(ui.shadow.querySelector('#profileAddContact').hidden, true);
  } finally {
    ui.close();
  }
});
