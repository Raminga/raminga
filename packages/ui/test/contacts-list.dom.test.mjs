// Second-batch item 2: contact list structure, verified public-name/avatar
// reuse, full Peer ID access, cached-directory clues and read-free list loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWContactListPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWContactListPeerBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PEER_CLUE = '12D3KooWContactListClueCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const AVATAR_SHA = 'a'.repeat(64);
const AVATAR_PATH = 'profile/avatar-aaaaaaaa.png';
const AVATAR_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
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

function conversation(peerId, overrides = {}) {
  return {
    peerId, lastMessageId: 'm1', direction: 'in', preview: '潮声还在。', lastAt: Date.now() - 60_000,
    deliveryStatus: 'received', origin: 'unknown', messageCount: 1, unreadCount: 0, ...overrides,
  };
}

function conversations(rows) {
  return {
    conversations: rows, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    totalUnread: rows.reduce((sum, row) => sum + (Number(row.unreadCount) || 0), 0),
    retention: { retainedMessages: 20, oldestRetainedAt: Date.now() - 1000, maxStoredMessages: 50000 },
  };
}

function messagePage(peerId) {
  return {
    peerId, messages: [], at: Date.now(), error: null, errorAt: null, freshness: 'live',
    hasMore: false, nextBefore: '',
    retention: { retainedMessages: 0, oldestRetainedAt: 0, maxStoredMessages: 50000 },
  };
}

function profile(peerId, { displayName = '', description = '', withAvatar = false, found = true } = {}) {
  const entries = withAvatar
    ? [{ path: AVATAR_PATH, sha256: AVATAR_SHA, sizeBytes: 68, mime: 'image/png' }]
    : [];
  return {
    peerId, localName: 'lin-an', remoteName: displayName || 'Lin An', found,
    text: '# Lin An\n\nPublic profile text.\n',
    files: withAvatar ? ['profile/index.md', AVATAR_PATH] : ['profile/index.md'],
    at: Date.now(), error: null, freshness: 'live', source: 'remote',
    agentCard: displayName
      ? {
        state: 'available',
        error: '',
        card: {
          displayName, description, interests: ['潮汐'], conversationStyle: '慢一点回信。',
          avatarPath: withAvatar ? AVATAR_PATH : '',
          avatarSha256: withAvatar ? AVATAR_SHA : '',
          avatarMime: withAvatar ? 'image/png' : '',
          path: 'profile/agent-card.json', sha256: '', updatedAt: '',
        },
      }
      : { state: 'missing', card: null, error: 'missing' },
    manifest: {
      peerId, publisherName: displayName || 'Lin An', source: 'remote', at: Date.now(),
      entries, error: null, errorAt: null, freshness: 'live', truncated: false, total: entries.length,
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
    dom, shadow, app,
    active: () => shadow.activeElement,
    text: (selector) => shadow.querySelector(selector)?.textContent ?? '',
    close() { app.destroy(); dom.window.close(); },
  };
}

test('the list never reads a profile on its own and reuses the verified public name/avatar', async () => {
  let profileReads = 0;
  let friendsReads = 0;
  let failProfile = false;
  const copied = [];
  const ui = mountUi({
    onLoadContacts: async () => contacts([
      friend(PEER_A, { name: 'lin-an', description: '潮汐线附近的联系人。', unreadCount: 2 }),
      friend(PEER_B, { name: 'xiao-zhou', connection: 'disconnected' }),
    ]),
    onLoadConversations: async () => conversations([
      conversation(PEER_A, { unreadCount: 2 }),
    ]),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadPeerProfile: async (peerId) => {
      profileReads += 1;
      if (failProfile) {
        return {
          ...profile(peerId, { displayName: '', found: false }),
          source: 'unavailable', error: '当前读取失败', freshness: 'unavailable',
          agentCard: { state: 'missing', card: null, error: '没有读取到公开 Agent 资料' },
        };
      }
      return profile(peerId, { displayName: '潮汐线旁的林岸', description: '慢一点回信，先把海边的事看完。', withAvatar: true });
    },
    onLoadPeerFriends: async (peerId) => {
      friendsReads += 1;
      return { peerId, source: 'remote', at: Date.now(), error: null, limited: false, friends: [] };
    },
    onLoadPeerFileContent: async (peerId, filePath) => ({
      status: 'ok', kind: 'image', mime: 'image/png', sha256: AVATAR_SHA, sizeBytes: 68,
      dataUrl: AVATAR_URL,
    }),
    onCopyText: async (text) => { copied.push(text); return true; },
  });
  try {
    ui.app.setContacts(contacts([
      friend(PEER_A, { name: 'lin-an', description: '潮汐线附近的联系人。', unreadCount: 2 }),
      friend(PEER_B, { name: 'xiao-zhou', connection: 'disconnected' }),
    ]));
    ui.app.setConversations(conversations([conversation(PEER_A, { unreadCount: 2 })]));
    await settle();
    assert.equal(profileReads, 0, 'rendering the list must not start a profile read');
    const row = ui.shadow.querySelector(`[data-contact-row="${PEER_A}"]`);
    assert.match(row.textContent, /lin-an/);
    assert.equal(row.querySelector('.rm-contact-avatar img'), null, 'no invented avatar before a verified public card');
    assert.equal(row.querySelector('.rm-contact-name b').textContent, 'lin-an');
    assert.equal(row.querySelector('.rm-contact-recent').textContent.includes('潮声还在。'), true);
    assert.equal(row.querySelector('.rm-contact-state').textContent, '已连接');
    assert.equal(row.querySelector('.rm-contact-unread').textContent, '2');

    const query = ui.shadow.querySelector('#contactQuery');
    query.value = PEER_A.slice(-12);
    query.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    assert.ok(ui.shadow.querySelector(`[data-contact-row="${PEER_A}"]`), 'Peer ID search keeps the row');
    assert.equal(profileReads, 0, 'searching by Peer ID is local only');

    const toggle = row.querySelector('[data-toggle-peer]');
    toggle.click();
    const full = row.querySelector('.rm-peer-id-full');
    assert.equal(full.hidden, false, 'the full identifier expands on demand');
    assert.equal(full.textContent, PEER_A);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    toggle.focus();
    ui.app.setContacts(contacts([
      friend(PEER_A, { name: 'lin-an', description: '潮汐线附近的联系人。', unreadCount: 2 }),
      friend(PEER_B, { name: 'xiao-zhou', connection: 'disconnected' }),
    ]));
    await settle();
    assert.equal(ui.active(), row.querySelector('[data-toggle-peer]'), 'a poll keeps focus on the expanded identifier control');
    assert.equal(row.querySelector('.rm-peer-id-full').hidden, false);

    row.querySelector('[data-copy-peer]').click();
    await settle();
    assert.deepEqual(copied, [PEER_A], 'copy uses the complete Peer ID');
    assert.equal(ui.text('#nodeLive'), '完整 Peer ID 已复制。');

    query.value = '';
    query.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    row.querySelector('button[data-contact-peer]').click();
    await settle();
    await settle(20);
    assert.equal(profileReads, 1);
    const profileImage = ui.shadow.querySelector('#profileAvatar img');
    assert.ok(profileImage, 'the profile reads and renders the downloaded avatar');
    ui.shadow.querySelector('#profileBack').click();
    await settle(20);

    const refreshed = ui.shadow.querySelector(`[data-contact-row="${PEER_A}"]`);
    assert.equal(refreshed.querySelector('.rm-contact-name b').textContent, '潮汐线旁的林岸');
    const localNoteText = refreshed.querySelector('.rm-contact-local-note').textContent;
    assert.match(localNoteText, /本机备注/);
    assert.match(localNoteText, /lin-an/);
    assert.match(localNoteText, /潮汐线附近的联系人/);
    assert.match(refreshed.querySelector('.rm-contact-note').textContent, /慢一点回信/);
    const listImage = refreshed.querySelector('.rm-contact-avatar img');
    assert.ok(listImage, 'the verified avatar is reused in the list');
    assert.equal(listImage.getAttribute('src'), profileImage.getAttribute('src'), 'list and profile show the same cached bytes');
    assert.equal(profileReads, 1, 'returning to the list does not re-read the profile');
    assert.equal(friendsReads, 0, 'the list does not read a remote address book');

    query.value = '潮汐线旁的';
    query.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    assert.ok(ui.shadow.querySelector(`[data-contact-row="${PEER_A}"]`), 'the verified public name is searchable');

    // A failed re-read keeps the last verified name/avatar rather than turning
    // a network error into a silent rename.
    query.value = '';
    query.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    failProfile = true;
    ui.shadow.querySelector(`[data-contact-row="${PEER_A}"] button[data-contact-peer]`).click();
    await settle();
    await settle(20);
    ui.shadow.querySelector('#profileBack').click();
    await settle(20);
    const afterFailure = ui.shadow.querySelector(`[data-contact-row="${PEER_A}"]`);
    assert.equal(afterFailure.querySelector('.rm-contact-name b').textContent, '潮汐线旁的林岸');
    assert.equal(afterFailure.querySelector('.rm-contact-avatar img').getAttribute('src'), profileImage.getAttribute('src'));
  } finally {
    ui.close();
  }
});

test('missing profile, long name and offline rows keep a usable fallback', async () => {
  const longName = 'offline-contact-with-long-name-01';
  const ui = mountUi({
    onLoadContacts: async () => contacts([
      friend(PEER_A, { name: longName, description: '一类没有公开 Agent 卡片、也没有消息的联系人。', connection: 'disconnected' }),
    ]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => messagePage(peerId),
  });
  try {
    ui.app.setContacts(contacts([
      friend(PEER_A, { name: longName, description: '一类没有公开 Agent 卡片、也没有消息的联系人。', connection: 'disconnected' }),
    ]));
    ui.app.setConversations(conversations([]));
    await settle();
    const row = ui.shadow.querySelector(`[data-contact-row="${PEER_A}"]`);
    assert.equal(row.querySelector('.rm-contact-name b').textContent, longName);
    assert.equal(row.querySelector('.rm-contact-avatar').textContent, 'O');
    assert.equal(row.querySelector('.rm-contact-avatar img'), null);
    assert.match(row.querySelector('.rm-contact-local-note').textContent, /本机备注/);
    assert.equal(row.querySelector('.rm-contact-state').textContent, '未连接');
    assert.equal(row.querySelector('.rm-contact-state').title.includes('不等于对方永久离线'), true);
    assert.equal(row.querySelector('.rm-contact-recent').textContent, '还没有消息');
    assert.equal(row.querySelector('.rm-peer-id-short').textContent.includes('…'), true);
    assert.equal(row.querySelector('.rm-peer-id-full').hidden, true);
    assert.equal(row.querySelector('.rm-contact-avatar').getAttribute('aria-label'), `查看 ${longName} 的档案`);
  } finally {
    ui.close();
  }
});

test('real cached directory entries become a separate unvisited clue section and viewing one has no side effects', async () => {
  let profileReads = 0;
  let friendsReads = 0;
  let connects = 0;
  const copied = [];
  const ui = mountUi({
    onLoadContacts: async () => contacts([
      friend(PEER_A, { name: 'lin-an' }),
      friend(PEER_B, { name: 'xiao-zhou' }),
    ]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadPeerProfile: async (peerId) => {
      profileReads += 1;
      return profile(peerId, { displayName: '潮汐线旁的林岸', description: '公开简介。', withAvatar: false });
    },
    onLoadPeerFriends: async (peerId) => {
      friendsReads += 1;
      return {
        peerId, source: 'remote', at: Date.now(), error: null, limited: false,
        friends: [
          { peerId: PEER_B, name: '小舟', description: '已在本地联系人中。' },
          { peerId: PEER_CLUE, name: '星云收集者', description: '喜欢收集星云与天文影像。' },
        ],
      };
    },
    onConnect: async () => { connects += 1; return { ok: true }; },
    onCopyText: async (text) => { copied.push(text); return true; },
  });
  try {
    ui.app.setContacts(contacts([
      friend(PEER_A, { name: 'lin-an' }),
      friend(PEER_B, { name: 'xiao-zhou' }),
    ]));
    await settle();
    assert.equal(ui.shadow.querySelector('#contactClues').hidden, true, 'no evidence means no clue section');

    ui.shadow.querySelector(`[data-contact-row="${PEER_A}"] button[data-contact-peer]`).click();
    await settle();
    ui.shadow.querySelector('[data-profile-tab="address"]').click();
    await settle();
    assert.equal(friendsReads, 1, 'only the user-opened address tab reads the public address book');

    const clueSection = ui.shadow.querySelector('#contactClues');
    assert.equal(clueSection.hidden, false);
    assert.equal(clueSection.querySelectorAll('.rm-clue-row').length, 1, 'an existing local contact is not repeated as a clue');
    const clue = clueSection.querySelector('.rm-clue-row');
    assert.equal(clue.dataset.cluePeer, PEER_CLUE);
    assert.match(clue.textContent, /星云收集者/);
    assert.match(clue.textContent, /未访问/);
    assert.match(clue.textContent, /来源：潮汐线旁的林岸/);

    ui.shadow.querySelector('#profileBack').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-contacts').hidden, false);
    const view = clueSection.querySelector('[data-view-clue]');
    view.focus();
    const before = profileReads;
    view.click();
    await settle();
    const notice = ui.shadow.querySelector('#noticeDialog');
    assert.equal(notice.open, true);
    assert.match(notice.textContent, new RegExp(PEER_CLUE));
    assert.match(notice.textContent, /不会建立连接/);
    assert.match(notice.textContent, /不会自动添加联系人/);
    assert.equal(profileReads, before, 'viewing a clue does not read the target profile');
    assert.equal(connects, 0, 'viewing a clue does not dial');
    assert.equal(friendsReads, 1, 'viewing a clue does not read a remote address book');
    assert.equal(ui.shadow.querySelector(`[data-contact-row="${PEER_CLUE}"]`), null, 'viewing a clue does not add a contact row');

    notice.querySelector('[data-close-dialog]').click();
    await settle();
    assert.equal(notice.open, false);
    assert.equal(ui.active(), view, 'closing the clue returns focus to its trigger');

    clue.querySelector('[data-copy-peer]').click();
    await settle();
    assert.deepEqual(copied, [PEER_CLUE]);
  } finally {
    ui.close();
  }
});

test('a host-verified projection survives a remount without a profile or directory read', async () => {
  const avatarKey = `${PEER_A}\u0000${AVATAR_PATH}\u0000${AVATAR_SHA}\u000068`;
  const projection = {
    state: 'available',
    at: Date.now(),
    error: '',
    profiles: [{
      peerId: PEER_A,
      displayName: '潮汐线旁的林岸',
      description: '慢一点回信，先把海边的事看完。',
      interests: ['潮汐'],
      conversationStyle: '慢一点回信。',
      source: 'remote-profile',
      verifiedAt: Date.now() - 1000,
      avatarKey,
      avatarUrl: AVATAR_URL,
      avatarMime: 'image/png',
      avatarSha256: AVATAR_SHA,
      avatarSizeBytes: 68,
      avatarState: 'ready',
      avatarError: '',
    }],
    clues: [{
      peerId: PEER_CLUE,
      name: '星云收集者',
      description: '喜欢收集星云与天文影像。',
      sourcePeerId: PEER_A,
      sourceName: '潮汐线旁的林岸',
      readAt: Date.now() - 2000,
    }],
  };
  let profileReads = 0;
  let friendsReads = 0;
  let connects = 0;
  function mount() {
    return mountUi({
      onLoadContacts: async () => contacts([
        friend(PEER_A, { name: 'lin-an', description: '潮汐线附近的联系人。', unreadCount: 1 }),
      ]),
      onLoadConversations: async () => conversations([
        conversation(PEER_A, { unreadCount: 1 }),
      ]),
      onLoadMessages: async (peerId) => messagePage(peerId),
      onLoadContactProjection: async () => projection,
      onLoadPeerProfile: async (peerId) => {
        profileReads += 1;
        return profile(peerId, { displayName: '不应读取', withAvatar: false });
      },
      onLoadPeerFriends: async (peerId) => {
        friendsReads += 1;
        return { peerId, source: 'remote', at: Date.now(), error: null, limited: false, friends: [] };
      },
      onConnect: async () => { connects += 1; return { ok: true }; },
    });
  }
  const first = mount();
  try {
    first.app.setContacts(contacts([
      friend(PEER_A, { name: 'lin-an', description: '潮汐线附近的联系人。', unreadCount: 1 }),
    ]));
    first.app.setConversations(conversations([conversation(PEER_A, { unreadCount: 1 })]));
    await settle(20);
    const row = first.shadow.querySelector(`[data-contact-row="${PEER_A}"]`);
    assert.equal(row.querySelector('.rm-contact-name b').textContent, '潮汐线旁的林岸');
    const avatar = row.querySelector('.rm-contact-avatar img');
    assert.ok(avatar, 'the verified avatar is available before opening the profile');
    assert.equal(avatar.getAttribute('src'), AVATAR_URL);
    assert.equal(first.shadow.querySelector('#contactClues').hidden, false);
    assert.match(first.shadow.querySelector('#contactClues').textContent, /星云收集者/);
    // The projection is a local read; the list itself must not start any of
    // these remote or relationship-changing actions.
    assert.equal(profileReads, 0);
    assert.equal(friendsReads, 0);
    assert.equal(connects, 0);
  } finally {
    first.close();
  }

  const second = mount();
  try {
    second.app.setContacts(contacts([
      friend(PEER_A, { name: 'lin-an', description: '潮汐线附近的联系人。', unreadCount: 1 }),
    ]));
    second.app.setConversations(conversations([conversation(PEER_A, { unreadCount: 1 })]));
    await settle(20);
    const row = second.shadow.querySelector(`[data-contact-row="${PEER_A}"]`);
    assert.equal(row.querySelector('.rm-contact-name b').textContent, '潮汐线旁的林岸');
    assert.equal(row.querySelector('.rm-contact-avatar img').getAttribute('src'), AVATAR_URL);
    assert.match(second.shadow.querySelector('#contactClues').textContent, /星云收集者/);
    assert.equal(profileReads, 0);
    assert.equal(friendsReads, 0);
    assert.equal(connects, 0);
  } finally {
    second.close();
  }
});

test('a corrupt or missing projection falls back without hiding real contacts', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([
      friend(PEER_A, { name: 'lin-an', description: '本地记录仍然可用。' }),
    ]),
    onLoadConversations: async () => conversations([]),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadContactProjection: async () => ({
      state: 'error', profiles: [], clues: [], at: 0, error: '联系人本地投影不是有效 JSON',
    }),
  });
  try {
    ui.app.setContacts(contacts([
      friend(PEER_A, { name: 'lin-an', description: '本地记录仍然可用。' }),
    ]));
    await settle(20);
    const row = ui.shadow.querySelector(`[data-contact-row="${PEER_A}"]`);
    assert.equal(row.querySelector('.rm-contact-name b').textContent, 'lin-an');
    assert.equal(row.querySelector('.rm-contact-avatar img'), null);
    assert.match(row.querySelector('.rm-contact-local-note').textContent, /本机备注/);
    assert.equal(ui.shadow.querySelector('#contactClues').hidden, true);
  } finally {
    ui.close();
  }
});
