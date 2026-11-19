// Second-batch item 3: public contact profile card, honest missing/offline
// states, and the secondary source/identity entry. These tests only use data a
// host already read; they never infer remote fields or start extra reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';
import { profileLabel } from '../src/content.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWContactProfilePeerAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWContactProfilePeerBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PEER_C = '12D3KooWContactProfilePeerCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const AVATAR_SHA = 'a'.repeat(64);
const AVATAR_PATH = 'profile/avatar-aaaaaaaa.png';
const AVATAR_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function contact(peerId, overrides = {}) {
  return {
    peerId, name: '', description: '', connection: 'connected', paused: false, unreadCount: 0, ...overrides,
  };
}

function contacts(friends) {
  return {
    friends, at: Date.now(), error: null, errorAt: null, freshness: 'live',
    connectionFreshness: 'live', total: friends.length,
  };
}

function conversations() {
  return {
    conversations: [], at: Date.now(), error: null, errorAt: null, freshness: 'live',
    totalUnread: 0, retention: { retainedMessages: 0, oldestRetainedAt: 0, maxStoredMessages: 1000 },
  };
}

function messagePage(peerId) {
  return {
    peerId, messages: [], at: Date.now(), error: null, errorAt: null, freshness: 'live',
    hasMore: false, nextBefore: '', retention: { retainedMessages: 0, oldestRetainedAt: 0, maxStoredMessages: 1000 },
  };
}

function card(overrides = {}) {
  return {
    schemaVersion: 1,
    displayName: '潮汐线旁的林岸',
    description: '慢一点回信，先把海边的事看完。喜欢潮汐、旧信和雨声。',
    interests: ['潮汐观测', '旧信与邮戳', '雨声录音', '海边植物'],
    conversationStyle: '不急着追问，喜欢把一句话放一会儿；如果聊到海边，会先听完再回答。',
    updatedAt: '2026-11-18T10:00:00Z',
    path: 'profile/profile.json',
    sha256: 'c'.repeat(64),
    avatarPath: '',
    avatarSha256: '',
    avatarMime: '',
    legacyFallback: false,
    sourceWarning: '',
    ...overrides,
  };
}

function profile(peerId = PEER_A, overrides = {}) {
  return {
    peerId,
    localName: 'lin-an',
    remoteName: '林岸',
    found: true,
    text: '# 林岸\n\n住在潮汐线附近，收集旧信和雨声。',
    files: ['profile/index.md'],
    at: Date.now(),
    error: null,
    freshness: 'live',
    source: 'remote',
    agentCard: { state: 'available', card: card(), error: '' },
    manifest: { source: 'remote', entries: [], error: '', truncated: false },
    node: null,
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
    text: (selector) => shadow.querySelector(selector)?.textContent ?? '',
    click(selector) {
      const node = typeof selector === 'string' ? shadow.querySelector(selector) : selector;
      assert.ok(node, `missing ${selector}`);
      node.click();
      return node;
    },
    close() { app.destroy(); dom.window.close(); },
  };
}

async function openProfile(ui, peerId = PEER_A, friend = null) {
  const row = friend ?? contact(peerId, { name: 'lin-an' });
  ui.app.setContacts(contacts([row]));
  ui.app.setConversations(conversations());
  await settle(10);
  ui.click(`[data-contact-row="${peerId}"] button[data-contact-peer]`);
  await settle(10);
  await settle(10);
}

test('full public card leads with verified avatar, name, bio, interests and conversation style', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact(PEER_A, { name: 'lin-an' })]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadContactMemory: async () => ({ peerId: PEER_A, state: 'missing', sha256: '', schemaVersion: 2, contact: null, timeline: [], timelineTruncated: false, error: '', at: Date.now() }),
    onLoadPeerProfile: async () => profile(PEER_A, {
      agentCard: {
        state: 'available',
        error: '',
        card: card({
          avatarPath: AVATAR_PATH,
          avatarSha256: AVATAR_SHA,
          avatarMime: 'image/png',
        }),
      },
      manifest: {
        source: 'remote', error: '', truncated: false,
        entries: [{ path: AVATAR_PATH, sha256: AVATAR_SHA, sizeBytes: 68, mime: 'image/png' }],
      },
    }),
    onLoadPeerFileContent: async () => ({
      status: 'ok', kind: 'image', mime: 'image/png', sha256: AVATAR_SHA, sizeBytes: 68, dataUrl: AVATAR_URL,
    }),
  });
  try {
    await openProfile(ui);
    assert.equal(ui.text('#profileName'), '潮汐线旁的林岸');
    assert.match(ui.text('#profileAgentDescriptionShort'), /慢一点回信/);
    assert.equal(ui.shadow.querySelectorAll('#profileInterests .rm-profile-tag').length, 4);
    assert.match(ui.text('#profileInterests'), /潮汐观测/);
    assert.match(ui.text('#profileInterests'), /旧信与邮戳/);
    assert.match(ui.text('#profileConversationStyle'), /公开交流风格 · 不急着追问/);
    const avatar = ui.shadow.querySelector('#profileAvatar img');
    assert.ok(avatar, 'the downloaded avatar fills the public card');
    assert.equal(avatar.getAttribute('src'), AVATAR_URL);
    assert.equal(ui.shadow.querySelector('#profileAvatar').getAttribute('data-kind'), 'image');
    assert.equal(ui.shadow.querySelector('#profileMessage').textContent, '发消息');
    assert.equal(ui.shadow.querySelector('#profileMessage').className, 'rm-primary');
    assert.deepEqual(
      [...ui.shadow.querySelectorAll('[data-profile-tab]')].map((tab) => tab.dataset.profileTab),
      ['interactions', 'posts', 'address'],
    );
    // Source, read time and the complete identifier are available but not on
    // the first-screen card by default.
    assert.equal(ui.shadow.querySelector('#profileOriginDetails').open, false);
    assert.equal(ui.shadow.querySelector('#profilePeerId').textContent, PEER_A);
    assert.match(ui.text('#profileSource'), /远端声明/);
    assert.match(ui.text('#profileOriginReadAt'), /\d/);
    assert.equal(ui.shadow.querySelector('#profileReadDetails').hidden, true);
    assert.equal(ui.shadow.querySelector('#profileAgentOpen').hidden, false);
    // The public introduction is not rendered a second time in the interaction
    // timeline; the timeline owns messages, Journey events and impressions.
    assert.doesNotMatch(ui.text('#contactProfileInteractions'), /慢一点回信/);
    assert.doesNotMatch(ui.text('#contactProfileInteractions'), /潮汐观测/);
  } finally {
    ui.close();
  }
});

test('long public text and missing fields keep full readable chips without invented values', async () => {
  const longName = '潮声与旧信记录者·在岸边整理每一次潮汐退去后的细节';
  const longBio = '把潮水退去以后留下的石阶、盐味和没有寄出的信记下来。每天清晨先看潮位，再决定今天是否出门；如果风太大，就留在屋里整理旧邮票。';
  const interests = [
    '潮汐退去后的石阶与盐味', '没有寄出的信和旧邮戳', '雨声与磁带录音', '海岸植物图鉴', '清晨潮位表', '旧灯塔的灯语',
  ];
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact(PEER_B, { name: 'chao-sheng' })]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadContactMemory: async () => ({ peerId: PEER_B, state: 'missing', sha256: '', schemaVersion: 2, contact: null, timeline: [], timelineTruncated: false, error: '', at: Date.now() }),
    onLoadPeerProfile: async () => profile(PEER_B, {
      remoteName: '林岸',
      agentCard: {
        state: 'available',
        error: '',
        card: card({ displayName: longName, description: longBio, interests, conversationStyle: '' }),
      },
    }),
  });
  try {
    await openProfile(ui, PEER_B, contact(PEER_B, { name: 'chao-sheng' }));
    assert.equal(ui.text('#profileName'), longName);
    assert.equal(ui.text('#profileAgentDescriptionShort'), longBio);
    assert.equal(ui.shadow.querySelector('#profileAvatar img'), null);
    assert.equal(ui.shadow.querySelector('#profileAvatar').textContent, [...longName][0]);
    assert.equal(ui.shadow.querySelectorAll('#profileInterests .rm-profile-tag').length, interests.length);
    for (const label of interests) assert.match(ui.text('#profileInterests'), new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(ui.shadow.querySelector('#profileConversationStyle').hidden, true);
    assert.match(ui.text('#profileMissingNote'), /公开交流风格/);
    assert.doesNotMatch(ui.text('#profileConversationStyle'), /公开交流风格/);
    assert.equal(ui.shadow.querySelector('#profileMissingNote').textContent.includes(longBio), false, 'the missing note must not invent missing fields');
  } finally {
    ui.close();
  }
});

test('a local-copy introduction repeated from the public card is not shown again in the human strip', async () => {
  const intro = '慢一点回信，先把海边的事看完。喜欢潮汐、旧信和雨声。';
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact(PEER_A, { name: 'lin-an' })]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadPeerProfile: async () => profile(PEER_A, {
      text: `# 林岸\n\n${intro}`,
      source: 'local-copy', error: '对方当前不可达',
      agentCard: { state: 'available', error: '', card: card({ description: intro }) },
    }),
  });
  try {
    await openProfile(ui);
    assert.equal(ui.shadow.querySelector('#profileHumanSummary').hidden, true);
    assert.equal(ui.shadow.querySelector('#profileHumanSummary').textContent, '');
    assert.equal(ui.shadow.querySelector('#profileHumanStrip').hidden, false, 'the closed public text remains reachable');
    assert.match(ui.text('#profileHumanStrip'), /公开资料正文/);
  } finally {
    ui.close();
  }
});

test('offline profile keeps the last verified projection, marks it non-live and retries the same contact', async () => {
  const verifiedAt = Date.now() - 6 * 60 * 1000;
  const avatarKey = `${PEER_A}\u0000${AVATAR_PATH}\u0000${AVATAR_SHA}\u000068`;
  const projection = {
    state: 'available', at: verifiedAt, error: '',
    profiles: [{
      peerId: PEER_A,
      displayName: '潮汐线旁的林岸',
      description: '慢一点回信，先把海边的事看完。',
      interests: ['潮汐观测', '旧信与邮戳'],
      conversationStyle: '不急着追问，喜欢把一句话放一会儿。',
      source: 'remote-profile',
      verifiedAt,
      avatarKey,
      avatarUrl: AVATAR_URL,
      avatarMime: 'image/png',
      avatarSha256: AVATAR_SHA,
      avatarSizeBytes: 68,
      avatarState: 'ready',
      avatarError: '',
    }],
    clues: [],
  };
  const reads = [];
  let fail = true;
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact(PEER_A, { name: 'lin-an' })]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadContactMemory: async () => ({ peerId: PEER_A, state: 'missing', sha256: '', schemaVersion: 2, contact: null, timeline: [], timelineTruncated: false, error: '', at: Date.now() }),
    onLoadContactProjection: async () => projection,
    onLoadPeerProfile: async (peerId) => {
      reads.push(peerId);
      if (fail) {
        return profile(peerId, {
          remoteName: '', found: false, text: '', source: 'unavailable', at: null, freshness: 'unavailable',
          error: '读取对方公开资料没有完成：dial tcp4 127.0.0.1:1: connect: connection refused',
          agentCard: { state: 'missing', card: null, error: '没有读取到公开 Agent 资料' },
          manifest: { source: 'unavailable', entries: [], error: '对方当前不可达', truncated: false },
        });
      }
      return profile(peerId);
    },
  });
  try {
    await settle(20);
    await openProfile(ui);
    assert.equal(ui.text('#profileName'), '潮汐线旁的林岸');
    assert.match(ui.text('#profileAgentDescriptionShort'), /慢一点回信/);
    assert.equal(ui.shadow.querySelectorAll('#profileInterests .rm-profile-tag').length, 2);
    assert.match(ui.text('#profileConversationStyle'), /公开交流风格/);
    assert.equal(ui.shadow.querySelector('#profileAvatar img').getAttribute('src'), AVATAR_URL);
    assert.match(ui.text('#profileFreshness'), /上次成功读取|上次读取/);
    assert.match(ui.text('#profileSource'), /不能当作实时资料|本机已核对/);
    assert.match(ui.text('#profileStale'), /这次读取没有完成/);
    assert.equal(ui.shadow.querySelector('#profileRetry').hidden, false);
    assert.deepEqual([...new Set(reads)], [PEER_A]);
    const before = reads.length;
    fail = false;
    ui.click('#profileRetry');
    await settle(20);
    assert.ok(reads.length > before, 'retry must call the selected profile read');
    assert.equal(ui.text('#profileName'), '潮汐线旁的林岸');
    assert.match(ui.text('#profileAgentDescriptionShort'), /慢一点回信/);
  } finally {
    ui.close();
  }
});

test('a failed read without a snapshot says unavailable instead of claiming there is no public profile', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact(PEER_A, { name: 'lin-an' })]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadPeerProfile: async (peerId) => profile(peerId, {
      remoteName: '', localName: 'lin-an', found: false, text: '', source: 'unavailable',
      at: null, freshness: 'unavailable',
      error: '读取对方公开资料没有完成：dial tcp4 127.0.0.1:1: connect: connection refused',
      agentCard: { state: 'missing', card: null, error: '没有读取到公开 Agent 资料' },
      manifest: { source: 'unavailable', entries: [], error: '对方当前不可达', truncated: false },
    }),
  });
  try {
    await openProfile(ui);
    assert.equal(ui.shadow.querySelector('#profileAgentBadge').textContent, '公开档案暂不可用');
    assert.equal(ui.text('#profileMissingNote'), '公开档案暂时不可用。');
    assert.doesNotMatch(ui.text('#profileMissingNote'), /没有公开用户档案/);
    assert.equal(ui.shadow.querySelector('#profileRetry').hidden, false);
  } finally {
    ui.close();
  }
});

test('a current card without a verified avatar never borrows an older projection image', async () => {
  const avatarKey = `${PEER_A}\u0000${AVATAR_PATH}\u0000${AVATAR_SHA}\u000068`;
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact(PEER_A, { name: 'lin-an' })]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadContactMemory: async () => ({ peerId: PEER_A, state: 'missing', sha256: '', schemaVersion: 2, contact: null, timeline: [], timelineTruncated: false, error: '', at: Date.now() }),
    onLoadContactProjection: async () => ({
      state: 'available', at: Date.now() - 1000, error: '',
      profiles: [{
        peerId: PEER_A, displayName: '潮汐线旁的林岸', description: '旧简介', interests: ['旧兴趣'],
        conversationStyle: '旧风格', source: 'remote-profile', verifiedAt: Date.now() - 1000,
        avatarKey, avatarUrl: AVATAR_URL, avatarMime: 'image/png', avatarSha256: AVATAR_SHA,
        avatarSizeBytes: 68, avatarState: 'ready', avatarError: '',
      }],
      clues: [],
    }),
    onLoadPeerProfile: async () => profile(PEER_A, {
      agentCard: { state: 'available', error: '', card: card({ avatarPath: '', avatarSha256: '', avatarMime: '' }) },
      manifest: { source: 'remote', entries: [], error: '', truncated: false },
    }),
  });
  try {
    await settle(20);
    await openProfile(ui);
    assert.equal(ui.shadow.querySelector('#profileAvatar img'), null, 'a newer card without an avatar must not reuse old bytes');
    assert.equal(ui.shadow.querySelector('#profileAvatar').textContent, '潮');
    assert.equal(ui.shadow.querySelector('#profileAvatar').getAttribute('data-kind'), 'initial');
  } finally {
    ui.close();
  }
});

test('public files open as a secondary surface and close back to the same tab, scroll and trigger', async () => {
  const manifest = {
    source: 'remote', error: '', truncated: false,
    entries: [
      { path: 'notes/tide.txt', sha256: 'b'.repeat(64), sizeBytes: 12, mime: 'text/plain' },
      { path: 'posts/tide/post.json', sha256: 'd'.repeat(64), sizeBytes: 20, mime: 'application/json' },
    ],
  };
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact(PEER_A, { name: 'lin-an' })]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadContactMemory: async () => ({ peerId: PEER_A, state: 'missing', sha256: '', schemaVersion: 2, contact: null, timeline: [], timelineTruncated: false, error: '', at: Date.now() }),
    onLoadPeerProfile: async () => profile(PEER_A, { manifest }),
    onLoadPeerDiscoveries: async () => ({ peerId: PEER_A, items: [], at: Date.now(), error: null, freshness: 'live', truncated: false }),
  });
  try {
    await openProfile(ui);
    ui.click('[data-profile-tab="posts"]');
    await settle();
    const view = ui.shadow.querySelector('#profileView');
    view.scrollTop = 180;
    ui.click('#profileFilesOpen');
    await settle();
    assert.equal(ui.shadow.querySelector('#contactProfileFiles').hidden, false);
    assert.equal(ui.shadow.querySelector('#profileTabsNav').hidden, true);
    assert.equal(ui.shadow.querySelector('#profileFilesClose').textContent, '收起');
    assert.equal(view.scrollTop, 0, 'opening the file surface starts at its own top');
    ui.click('#profileFilesClose');
    await settle();
    assert.equal(ui.shadow.querySelector('#contactProfileFiles').hidden, true);
    assert.equal(ui.shadow.querySelector('#profileTabsNav').hidden, false);
    assert.equal(ui.shadow.querySelector('[data-profile-tab="posts"]').getAttribute('aria-current'), 'page');
    assert.equal(view.scrollTop, 180, 'closing files restores the source section scroll');
    assert.equal(ui.active(), ui.shadow.querySelector('#profileFilesOpen'), 'closing files restores its trigger');
  } finally {
    ui.close();
  }
});


test('a failed directory read keeps the same source history until a newer success replaces it', async () => {
  const readAt = Date.now() - 3 * 60 * 1000;
  let friendsCalls = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact(PEER_A, { name: 'lin-an' })]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadPeerProfile: async () => profile(PEER_A),
    onLoadContactProjection: async () => ({
      state: 'available', at: readAt, error: '', profiles: [],
      clues: [{
        peerId: PEER_B, sourcePeerId: PEER_A, sourceName: '潮汐线旁的林岸',
        name: '星云收集者', description: '喜欢收集星云与天文影像。', readAt,
      }],
    }),
    onLoadPeerFriends: async (peerId) => {
      friendsCalls += 1;
      if (friendsCalls === 1) {
        return {
          peerId, source: 'remote', at: readAt, error: null, limited: false,
          friends: [{ name: '星云收集者', peerId: PEER_B, addrs: [], description: '喜欢收集星云与天文影像。' }],
        };
      }
      if (friendsCalls === 2) {
        return {
          peerId, source: 'unavailable', at: null, limited: false, friends: [],
          error: 'dial tcp4 127.0.0.1:1: connect: connection refused',
        };
      }
      return {
        peerId, source: 'remote', at: Date.now(), error: null, limited: false,
        friends: [{ name: '新的公开声明', peerId: PEER_C, addrs: [], description: '这是更新后的声明。' }],
      };
    },
  });
  try {
    await settle(20);
    await openProfile(ui);
    ui.click('[data-profile-tab="address"]');
    await settle(20);
    assert.equal(ui.shadow.querySelectorAll('#profileFriendList [data-friend-peer]').length, 1);
    assert.equal(ui.shadow.querySelectorAll('#profileFriendList [data-friend-history]').length, 0);

    // Reopen within the same panel after the source became unreachable. The
    // first response is gone from profileState, but the same-source local
    // history must remain readable.
    ui.click('#profileBack');
    await settle(10);
    await openProfile(ui);
    ui.click('[data-profile-tab="address"]');
    await settle(25);
    const oldClue = ui.shadow.querySelector(`#profileFriendList [data-friend-peer="${PEER_B}"]`);
    assert.ok(oldClue, 'the historical directory row must survive the failed re-read');
    assert.equal(oldClue.dataset.friendHistory, 'local-history');
    assert.match(oldClue.textContent, /星云收集者/);
    assert.match(ui.text('#profileAddressStatus'), /读取失败/);
    const historyNote = ui.text('#profileAddressNote');
    assert.match(historyNote, /本机历史|上次读取/);
    assert.match(historyNote, /部分/);
    assert.match(historyNote, /不是.*完整/);
    assert.equal(ui.shadow.querySelector('#profileAddressEmpty').hidden, true);
    assert.equal(ui.shadow.querySelector('#profileAddressRetry').hidden, false);

    // A real successful response replaces the historical copy, even when it
    // reports a different row set.
    ui.click('#profileAddressRetry');
    await settle(30);
    assert.equal(ui.shadow.querySelector(`#profileFriendList [data-friend-peer="${PEER_B}"]`), null);
    const freshClue = ui.shadow.querySelector(`#profileFriendList [data-friend-peer="${PEER_C}"]`);
    assert.ok(freshClue, 'the newer online response must render');
    assert.equal(freshClue.dataset.friendHistory, undefined);
    assert.equal(ui.shadow.querySelectorAll('#profileFriendList [data-friend-history]').length, 0);
    assert.equal(ui.text('#profileAddressStatus'), '1 位');
    assert.doesNotMatch(ui.text('#profileAddressNote'), /本机历史|上次读取|部分历史/);
    assert.equal(ui.shadow.querySelector('#profileAddressRetry').hidden, true);
  } finally {
    ui.close();
  }
});

test('a true empty response clears persisted directory history, while failure without history is an honest empty state', async () => {
  const readAt = Date.now() - 5 * 60 * 1000;
  let friendsCalls = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts([contact(PEER_A, { name: 'lin-an' })]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadPeerProfile: async () => profile(PEER_A),
    onLoadContactProjection: async () => ({
      state: 'available', at: readAt, error: '', profiles: [],
      clues: [{
        peerId: PEER_B, sourcePeerId: PEER_A, sourceName: '潮汐线旁的林岸',
        name: '星云收集者', description: '喜欢收集星云与天文影像。', readAt,
      }],
    }),
    onLoadPeerFriends: async (peerId) => {
      friendsCalls += 1;
      if (friendsCalls === 1) {
        return { peerId, source: 'unavailable', at: null, limited: false, friends: [], error: '对方当前不可达' };
      }
      return { peerId, source: 'remote', at: Date.now(), error: null, limited: false, friends: [] };
    },
  });
  try {
    await settle(20);
    await openProfile(ui);
    ui.click('[data-profile-tab="address"]');
    await settle(25);
    assert.ok(ui.shadow.querySelector(`#profileFriendList [data-friend-peer="${PEER_B}"]`),
      'the persisted same-source clue is the only history before the retry');
    assert.equal(ui.shadow.querySelector(`#profileFriendList [data-friend-peer="${PEER_B}"]`).dataset.friendHistory, 'local-history');
    ui.click('#profileAddressRetry');
    await settle(30);
    assert.equal(ui.shadow.querySelector(`#profileFriendList [data-friend-peer="${PEER_B}"]`), null);
    assert.equal(ui.shadow.querySelector('#profileFriendList').hidden, true);
    assert.equal(ui.shadow.querySelector('#profileAddressEmpty').hidden, false);
    assert.match(ui.text('#profileAddressEmptyTitle'), /没有读取到公开通讯录/);
    assert.doesNotMatch(ui.text('#profileAddressNote'), /本机历史|部分历史/);
    assert.equal(ui.text('#profileAddressStatus'), '无记录');
  } finally {
    ui.close();
  }

  const empty = mountUi({
    onLoadContacts: async () => contacts([contact(PEER_A, { name: 'lin-an' })]),
    onLoadConversations: async () => conversations(),
    onLoadMessages: async (peerId) => messagePage(peerId),
    onLoadPeerProfile: async () => profile(PEER_A),
    onLoadContactProjection: async () => ({ state: 'missing', at: 0, error: '', profiles: [], clues: [] }),
    onLoadPeerFriends: async (peerId) => {
      throw new Error('dial tcp4 127.0.0.1:1: connect: connection refused');
    },
  });
  try {
    await settle(20);
    await openProfile(empty);
    empty.click('[data-profile-tab="address"]');
    await settle(25);
    assert.equal(empty.shadow.querySelector('#profileFriendList').hidden, true);
    assert.equal(empty.shadow.querySelector('#profileAddressEmpty').hidden, false);
    assert.equal(empty.shadow.querySelector('#profileAddressEmpty').dataset.tone, 'error');
    assert.match(empty.text('#profileAddressEmptyTitle'), /没有可用的历史通讯录/);
    assert.match(empty.text('#profileAddressEmptyText'), /读取失败/);
    assert.equal(empty.shadow.querySelector('#profileAddressRetry').hidden, false);
    assert.match(empty.text('#profileAddressStatus'), /读取失败/);
    assert.match(empty.text('#profileAddressNote'), /不可达|读取失败/);
  } finally {
    empty.close();
  }
});


test('profileLabel never presents a Peer ID as a public display name', () => {
  assert.equal(profileLabel({ remoteName: PEER_A, localName: 'lin-an' }, PEER_A), 'lin-an');
  assert.equal(profileLabel({ remoteName: '潮汐线旁的林岸', localName: 'lin-an' }, PEER_A), '潮汐线旁的林岸');
  assert.equal(profileLabel({ remoteName: '', localName: '' }, PEER_A).includes('…'), true);
});
