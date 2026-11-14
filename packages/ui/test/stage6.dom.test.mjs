// Stage-6 DOM tests for discovery, mine, peer profile and Journey surfaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';

const post = (overrides = {}) => ({
  id: '17',
  peerId: PEER_A,
  path: 'posts/a.json',
  sha256: 'a'.repeat(64),
  sizeBytes: 120,
  fetchedAt: Date.now(),
  source: 'raminga_content_get',
  authorKind: 'user',
  authorName: 'Alice',
  title: '受控公开帖子',
  summary: '这是公开摘要。',
  tags: ['stage6'],
  publishedAt: '2026-11-14T10:00:00Z',
  contentState: 'available',
  contentError: '',
  ...overrides,
});

const discoveries = (items = [post()], overrides = {}) => ({
  items,
  at: Date.now(),
  error: null,
  errorAt: null,
  freshness: 'live',
  familiar: false,
  scanned: items.length,
  truncated: false,
  relationComplete: true,
  ignored: 0,
  ...overrides,
});

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
    page: 'explore',
    pages: { explore: { filter: 'all', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} } },
  };
  const app = createRamingaApp(shadow, { ...options, viewState });
  app.onLeaseReady();
  return {
    dom,
    shadow,
    app,
    viewState,
    click(selector) {
      const node = typeof selector === 'string' ? shadow.querySelector(selector) : selector;
      assert.ok(node, `missing ${selector}`);
      node.click();
      return node;
    },
    text(selector) {
      return shadow.querySelector(selector)?.textContent ?? '';
    },
    close() {
      app.destroy();
      dom.window.close();
    },
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('discovery list expands verified content, opens author profile and restores the source', async () => {
  const calls = [];
  const ui = mountUi({
    onLoadDiscoveries: async (familiar) => {
      calls.push(familiar);
      return discoveries();
    },
    onLoadDiscoveryContent: async (id) => ({
      ok: true,
      id,
      peerId: PEER_A,
      path: 'posts/a.json',
      sha256: 'a'.repeat(64),
      source: 'raminga_content_get',
      fetchedAt: Date.now(),
      post: {
        schemaVersion: 1, title: '受控公开帖子', summary: '这是公开摘要。', bodyMarkdown: '# 正文\n\n<script>alert(1)</script>\n\n[外链](https://example.com/x)\n\n![图](https://example.com/a.png)', tags: [], publishedAt: '2026-11-14T10:00:00Z', authorPeerId: PEER_A, authorKind: 'user', authorName: 'Alice', path: 'posts/a.json', sha256: 'a'.repeat(64), sizeBytes: 120, contentState: 'available',
      },
      error: null,
    }),
    onLoadPeerProfile: async () => ({
      peerId: PEER_A, localName: 'Alice', remoteName: 'Alice', found: true,
      text: '# Alice\n\n远端**声明**。', files: ['profile/index.md'], at: Date.now(), error: null, freshness: 'live',
      agentCard: { state: 'missing', card: null, error: 'missing' },
    }),
  });
  try {
    await settle();
    const card = ui.shadow.querySelector('.rm-post');
    assert.match(card.textContent, /Agent 带回/);
    assert.equal(card.querySelector('.rm-post-source'), null, 'no flat technical source line');
    const visibleCardText = [' .rm-post-meta', ' .rm-post-time', ' .rm-post-title', ' .rm-post-summary']
      .map((selector) => card.querySelector(selector)?.textContent ?? '').join(' ');
    assert.doesNotMatch(visibleCardText, /raminga_content_get|posts\/a\.json|a{32}/, 'technical source fields stay out of the card lead');
    const sourceSummary = card.querySelector('.rm-source-summary');
    assert.ok(sourceSummary, 'source details remain reachable');
    sourceSummary.click();
    await settle();
    let sourceDetails = card.querySelector('.rm-source-details');
    assert.equal(sourceDetails.open, true);
    assert.match(sourceDetails.textContent, /raminga_content_get/);
    assert.match(sourceDetails.textContent, /posts\/a\.json/);
    assert.match(sourceDetails.textContent, new RegExp('a{64}'));
    assert.match(sourceDetails.textContent, /120 字节/);

    const before = ui.click('#discoveryList [data-expand-post]');
    await settle();
    const body = ui.shadow.querySelector('.rm-post-body');
    assert.ok(body);
    assert.match(body.textContent, /正文/);
    assert.doesNotMatch(body.textContent, /内容版本|字节|raminga_content_get|posts\/a\.json/, 'technical metadata stays in the source details');
    assert.equal(body.querySelector('script'), null, 'script tags stay text');
    assert.match(body.textContent, /<script>/); // raw HTML is displayed as text, never parsed
    assert.equal(body.querySelector('img'), null, 'remote images are not auto-loaded');
    assert.match(body.textContent, /未自动加载远端媒体/);
    const link = body.querySelector('a');
    assert.equal(link.getAttribute('href'), 'https://example.com/x');
    assert.equal(link.rel, 'noopener noreferrer nofollow');

    const explorePage = ui.shadow.querySelector('#page-explore');
    explorePage.scrollTop = 120;
    ui.click('#exploreRefresh');
    await settle();
    sourceDetails = ui.shadow.querySelector('.rm-post .rm-source-details');
    assert.equal(sourceDetails.open, true, 'an open source detail survives an explicit refresh');
    assert.equal(explorePage.scrollTop, 120, 'refresh keeps the reading scroll');
    assert.equal(ui.shadow.querySelector('.rm-post-body')?.textContent.includes('正文'), true, 'expanded body survives refresh');

    const avatar = ui.shadow.querySelector('#discoveryList [data-profile-peer]');
    assert.ok(avatar);
    avatar.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.match(ui.text('#profileBody'), /远端声明/);
    ui.click('#profileBack');
    assert.equal(ui.shadow.querySelector('#profileView').hidden, true);
    assert.equal(ui.shadow.querySelector('#page-explore').hidden, false);
    assert.equal(ui.shadow.querySelector('#page-explore').scrollTop, 120);
    assert.equal(ui.shadow.querySelector('.rm-post .rm-source-details').open, true, 'source details survive the profile return');
    assert.equal(ui.shadow.activeElement?.dataset?.profilePeer, PEER_A);
  } finally {
    ui.close();
  }
});

test('opening a peer profile saves the source scroll before hiding the page', async () => {
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async () => discoveries(),
    onLoadPeerProfile: async () => ({
      peerId: PEER_A, localName: 'Alice', remoteName: 'Alice', found: true,
      text: '# Alice\n\n远端声明。', files: ['profile/index.md'], at: Date.now(), error: null, freshness: 'live',
      agentCard: { state: 'missing', card: null, error: 'missing' },
    }),
  });
  try {
    await settle();
    const explore = ui.shadow.querySelector('#page-explore');
    let stored = 0;
    // Real Chromium collapses a hidden page's scrollTop; jsdom keeps it. Model
    // that behavior so saving after `hidden = true` cannot pass this test.
    Object.defineProperty(explore, 'scrollTop', {
      configurable: true,
      get() { return this.hidden ? 0 : stored; },
      set(value) { stored = Number(value); },
    });
    explore.scrollTop = 120;
    ui.shadow.querySelector('#discoveryList [data-profile-peer]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.equal(ui.viewState.pages.explore.scroll, 120, 'source scroll is captured while the page is still laid out');
    ui.click('#profileBack');
    assert.equal(ui.shadow.querySelector('#page-explore').scrollTop, 120);
  } finally {
    ui.close();
  }
});

test('familiar filter and empty/error states are distinct', async () => {
  let familiar = false;
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: false, scroll: 0, expanded: {} } } },
    onLoadDiscoveries: async (filter) => {
      familiar = filter;
      return discoveries(filter ? [post({ id: '18', peerId: PEER_B, title: '交流对象帖子' })] : [post()], { familiar: filter });
    },
  });
  try {
    await settle();
    assert.equal(ui.shadow.querySelectorAll('.rm-post').length, 1);
    ui.click('[data-filter="familiar"]');
    await settle();
    assert.equal(familiar, true);
    assert.match(ui.text('#discoveryList'), /交流对象帖子/);
  } finally {
    ui.close();
  }

  const empty = mountUi({ onLoadDiscoveries: async () => discoveries([]) });
  try {
    await settle();
    assert.match(empty.text('#exploreStateTitle'), /还没有 Agent 带回的公开内容/);
    assert.match(empty.text('#exploreStateBody'), /不会自动变成动态/);
  } finally {
    empty.close();
  }

  const failed = mountUi({ onLoadDiscoveries: async () => { throw new Error('索引读取失败'); } });
  try {
    await settle();
    assert.match(failed.text('#exploreStateTitle'), /这次没有读到公开动态/);
    assert.match(failed.text('#exploreStateBody'), /不代表没有任何公开内容/);
    assert.match(failed.text('#discoveryMeta'), /索引读取失败/);
  } finally {
    failed.close();
  }
});

test('a late response from the previous filter cannot replace the current discovery set', async () => {
  let resolveAll;
  const all = new Promise((resolve) => { resolveAll = resolve; });
  const ui = mountUi({
    onLoadDiscoveries: (familiar) => familiar
      ? Promise.resolve(discoveries([post({ id: '18', title: '当前筛选结果' })], { familiar: true }))
      : all,
  });
  try {
    await settle();
    ui.click('[data-filter="familiar"]');
    await settle();
    assert.match(ui.text('#discoveryList'), /当前筛选结果/);
    resolveAll(discoveries([post({ id: '17', title: '迟到的旧结果' })]));
    await settle();
    assert.doesNotMatch(ui.text('#discoveryList'), /迟到的旧结果/);
    assert.match(ui.text('#discoveryList'), /当前筛选结果/);
  } finally {
    ui.close();
  }
});

test('a cached empty familiar feed updates after a persisted human send without remounting', async () => {
  const sentAt = Date.now();
  let relationVisible = false;
  let persistedMessage = null;
  let familiarReads = 0;
  let forceReads = 0;
  const content = post({ id: '18', title: '交流对象带回的帖子', peerId: PEER_B });
  const ui = mountUi({
    viewState: {
      page: 'explore',
      pages: {
        explore: {
          filter: 'familiar', query: '交流', searchOpen: true, scroll: 0,
          expanded: {}, sourceOpen: {},
        },
      },
    },
    onLoadDiscoveries: async (familiar, force) => {
      if (!familiar) return discoveries([post()]);
      familiarReads += 1;
      if (force) forceReads += 1;
      return discoveries(relationVisible ? [content] : [], { familiar: true, relationComplete: true });
    },
    onLoadContacts: async () => ({
      friends: [{ peerId: PEER_B, name: 'Bob', description: '', connection: 'connected', paused: false }],
      at: sentAt, error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
    }),
    onLoadConversations: async () => ({
      conversations: [], at: sentAt, error: null, errorAt: null, freshness: 'live',
      retention: { retainedMessages: 0, oldestRetainedAt: null, maxStoredMessages: 1000 },
    }),
    onLoadMessages: async (peerId) => ({
      peerId,
      messages: persistedMessage ? [persistedMessage] : [],
      at: sentAt, error: null, errorAt: null, freshness: 'live', hasMore: false, nextBefore: '',
      retention: { retainedMessages: persistedMessage ? 1 : 0, oldestRetainedAt: sentAt, maxStoredMessages: 1000 },
    }),
    onSend: async (peerId, text, requestId) => {
      persistedMessage = {
        messageId: 'm-human-1', peerId, direction: 'out', text, acked: false,
        createdAt: sentAt, ackedAt: null, deliveryStatus: 'pending', deliveryError: '',
        origin: 'human', deliveryUpdatedAt: null, clientRequestId: requestId,
      };
      relationVisible = true;
      return {
        ok: true, unknown: false, invalid: false, peerId, requestId,
        messageId: 'm-human-1', replayed: false, acked: false, deliveryStatus: 'pending',
        outboxStatus: 'pending', error: null, detail: null, at: sentAt,
      };
    },
  });
  try {
    await settle();
    assert.match(ui.text('#exploreStateTitle'), /还没有你发过消息的节点带回的内容/);
    assert.doesNotMatch(ui.text('#exploreStateBody'), /持久人工出站记录|raminga_content_get/);
    assert.equal(familiarReads, 1);

    ui.app.setContacts({
      friends: [{ peerId: PEER_B, name: 'Bob', description: '', connection: 'connected', paused: false }],
      at: sentAt, error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
    });
    ui.app.setConversations({
      conversations: [], at: sentAt, error: null, errorAt: null, freshness: 'live',
      retention: { retainedMessages: 0, oldestRetainedAt: null, maxStoredMessages: 1000 },
    });
    ui.click('button[data-nav="contacts"]');
    await settle();
    const row = ui.shadow.querySelector('button[data-contact-peer]');
    assert.ok(row, 'contact row is reachable');
    row.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false);

    const input = ui.shadow.querySelector('#messageInput');
    input.value = '真实人工消息';
    input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.shadow.querySelector('#composer').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.match(ui.shadow.querySelector('#composerStatus').textContent, /等待确认|已经保存/);

    ui.click('button[data-nav="home"]');
    await settle();
    assert.equal(ui.viewState.pages.explore.filter, 'familiar');
    assert.equal(ui.shadow.querySelector('#exploreQuery').value, '交流', 'search text survives the return');
    assert.ok(familiarReads >= 2, 'returning to the cached familiar feed revalidates it');
    assert.ok(forceReads >= 1, 'the invalidated read bypasses the host cache');
    assert.match(ui.text('#discoveryList'), /交流对象带回的帖子/);
    assert.doesNotMatch(ui.text('#exploreStateBody'), /还没有你发过消息/);
  } finally {
    ui.close();
  }
});

test('an unknown send only updates familiar after the persisted human row is verified', async () => {
  let persisted = false;
  let relationVisible = false;
  let familiarReads = 0;
  let forceReads = 0;
  let requestIdUsed = '';
  const content = post({ id: '19', title: '确认后出现的交流内容', peerId: PEER_B });
  const ui = mountUi({
    viewState: {
      page: 'explore',
      pages: { explore: { filter: 'familiar', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} } },
    },
    onLoadDiscoveries: async (familiar, force) => {
      if (!familiar) return discoveries([post()]);
      familiarReads += 1;
      if (force) forceReads += 1;
      return discoveries(relationVisible ? [content] : [], { familiar: true, relationComplete: true });
    },
    onLoadContacts: async () => ({
      friends: [{ peerId: PEER_B, name: 'Bob', description: '', connection: 'connected', paused: false }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
    }),
    onLoadConversations: async () => ({
      conversations: [], at: Date.now(), error: null, errorAt: null, freshness: 'live',
      retention: { retainedMessages: 0, oldestRetainedAt: null, maxStoredMessages: 1000 },
    }),
    onLoadMessages: async (peerId) => ({
      peerId,
      messages: persisted ? [{
        messageId: 'm-human-unknown', peerId, direction: 'out', text: '超时但已保存', acked: false,
        createdAt: Date.now(), ackedAt: null, deliveryStatus: 'pending', deliveryError: '',
        origin: 'human', deliveryUpdatedAt: null, clientRequestId: requestIdUsed,
      }] : [],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', hasMore: false, nextBefore: '',
      retention: { retainedMessages: persisted ? 1 : 0, oldestRetainedAt: null, maxStoredMessages: 1000 },
    }),
    onSend: async (peerId, text, requestId) => {
      requestIdUsed = requestId;
      persisted = true;
      relationVisible = true;
      return {
        ok: false, unknown: true, invalid: false, peerId, requestId,
        messageId: '', replayed: false, acked: false, deliveryStatus: 'unknown',
        outboxStatus: 'unknown', error: 'timeout', detail: 'deadline exceeded', at: Date.now(),
      };
    },
  });
  try {
    await settle();
    assert.equal(familiarReads, 1);
    ui.app.setContacts({
      friends: [{ peerId: PEER_B, name: 'Bob', description: '', connection: 'connected', paused: false }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
    });
    ui.app.setConversations({
      conversations: [], at: Date.now(), error: null, errorAt: null, freshness: 'live',
      retention: { retainedMessages: 0, oldestRetainedAt: null, maxStoredMessages: 1000 },
    });
    ui.click('button[data-nav="contacts"]');
    await settle();
    ui.shadow.querySelector('button[data-contact-peer]').click();
    await settle();
    const input = ui.shadow.querySelector('#messageInput');
    input.value = '超时但已保存';
    input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.shadow.querySelector('#composer').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    ui.click('button[data-nav="home"]');
    await settle();
    assert.ok(familiarReads >= 2, 'a persisted row resolves the unknown send into a real relation');
    assert.match(ui.text('#discoveryList'), /确认后出现的交流内容/);
  } finally {
    ui.close();
  }
});

test('an unknown send without a persisted row does not invent a familiar relationship', async () => {
  let relationVisible = false;
  let familiarReads = 0;
  const content = post({ id: '20', title: '外部变化后出现的内容', peerId: PEER_B });
  const ui = mountUi({
    viewState: {
      page: 'explore',
      pages: { explore: { filter: 'familiar', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} } },
    },
    onLoadDiscoveries: async (familiar, force) => {
      if (!familiar) return discoveries([post()]);
      familiarReads += 1;
      return discoveries(relationVisible ? [content] : [], { familiar: true, relationComplete: true });
    },
    onLoadContacts: async () => ({
      friends: [{ peerId: PEER_B, name: 'Bob', description: '', connection: 'connected', paused: false }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
    }),
    onLoadConversations: async () => ({
      conversations: [], at: Date.now(), error: null, errorAt: null, freshness: 'live',
      retention: { retainedMessages: 0, oldestRetainedAt: null, maxStoredMessages: 1000 },
    }),
    onLoadMessages: async (peerId) => ({
      peerId, messages: [], at: Date.now(), error: null, errorAt: null, freshness: 'live',
      hasMore: false, nextBefore: '', retention: { retainedMessages: 0, oldestRetainedAt: null, maxStoredMessages: 1000 },
    }),
    onSend: async (peerId, text, requestId) => ({
      ok: false, unknown: true, invalid: false, peerId, requestId, messageId: '',
      replayed: false, acked: false, deliveryStatus: 'unknown', outboxStatus: 'unknown',
      error: 'timeout', detail: 'deadline exceeded', at: Date.now(),
    }),
  });
  try {
    await settle();
    assert.equal(familiarReads, 1);
    ui.app.setContacts({
      friends: [{ peerId: PEER_B, name: 'Bob', description: '', connection: 'connected', paused: false }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
    });
    ui.app.setConversations({
      conversations: [], at: Date.now(), error: null, errorAt: null, freshness: 'live',
      retention: { retainedMessages: 0, oldestRetainedAt: null, maxStoredMessages: 1000 },
    });
    ui.click('button[data-nav="contacts"]');
    await settle();
    ui.shadow.querySelector('button[data-contact-peer]').click();
    await settle();
    const input = ui.shadow.querySelector('#messageInput');
    input.value = '没有保存的超时消息';
    input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.shadow.querySelector('#composer').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    ui.click('button[data-nav="home"]');
    await settle();
    assert.equal(familiarReads, 1, 'an unknown send without a persisted row must not be counted as a relation');

    relationVisible = true;
    ui.click('#exploreRefresh');
    await settle();
    assert.equal(familiarReads, 2, 'the visible refresh entry reaches external changes');
    assert.match(ui.text('#discoveryList'), /外部变化后出现的内容/);
  } finally {
    ui.close();
  }
});

test('cached discovery data is not polled, explicit refresh picks up external content and keeps reading state', async () => {
  const first = post({ id: '30', title: '第一篇文章' });
  const second = post({ id: '31', title: '外部新增文章', path: 'posts/second.json', sha256: 'c'.repeat(64), sizeBytes: 240 });
  let data = [first];
  let calls = 0;
  const ui = mountUi({
    viewState: {
      page: 'explore',
      pages: {
        explore: {
          filter: 'all', query: '文章', searchOpen: true, scroll: 0,
          expanded: { 30: true }, sourceOpen: { 30: true },
        },
      },
    },
    onLoadDiscoveries: async () => {
      calls += 1;
      return discoveries(data);
    },
    onLoadDiscoveryContent: async (id) => ({
      ok: true, id, peerId: PEER_A, path: 'posts/a.json', sha256: 'a'.repeat(64),
      source: 'raminga_content_get', fetchedAt: Date.now(),
      post: { ...post(), bodyMarkdown: '第一篇文章正文' }, error: null,
    }),
  });
  try {
    await settle();
    assert.equal(calls, 1);
    const explorePage = ui.shadow.querySelector('#page-explore');
    explorePage.scrollTop = 64;
    ui.click('button[data-nav="contacts"]');
    await settle();
    ui.click('button[data-nav="home"]');
    await settle();
    assert.equal(calls, 1, 'returning within the revalidation window does not poll');
    data = [first, second];
    ui.click('#exploreRefresh');
    await settle();
    assert.equal(calls, 2);
    assert.match(ui.text('#discoveryList'), /外部新增文章/);
    assert.equal(ui.shadow.querySelector('#exploreQuery').value, '文章');
    assert.equal(ui.shadow.querySelector('.rm-post-body')?.textContent.includes('第一篇文章正文'), true, 'expanded row survives');
    assert.equal(ui.shadow.querySelector('.rm-source-details')?.open, true, 'open source details survive');
    assert.equal(explorePage.scrollTop, 64);
    ui.click('[data-filter="familiar"]');
    ui.click('[data-filter="all"]');
    ui.click('[data-filter="familiar"]');
    ui.click('[data-filter="all"]');
    await settle();
    assert.equal(calls, 3, 'filter switching reads familiar once and does not duplicate the cached all read');
  } finally {
    ui.close();
  }
});

test('destroy while discovery reads are pending leaves no rendered result', async () => {
  let resolveAll;
  let resolveFamiliar;
  const all = new Promise((resolve) => { resolveAll = resolve; });
  const familiar = new Promise((resolve) => { resolveFamiliar = resolve; });
  const ui = mountUi({
    onLoadDiscoveries: (filter) => (filter ? familiar : all),
  });
  await settle();
  ui.click('[data-filter="familiar"]');
  await settle();
  ui.close();
  resolveAll(discoveries([post({ title: '迟到的旧结果' })]));
  resolveFamiliar(discoveries([post({ id: '18', title: '迟到的筛选结果' })], { familiar: true }));
  await settle();
  assert.equal(ui.shadow.childNodes.length, 0);
});

test('an Agent public card keeps its exact file provenance inside closeable source details', async () => {
  const ui = mountUi({
    onLoadDiscoveries: async () => discoveries(),
    onLoadPeerProfile: async () => ({
      peerId: PEER_A, localName: 'Alice', remoteName: 'Alice', found: true,
      text: '# Alice\n\n远端**声明**。', files: ['profile/index.md', 'profile/agent-card.json'],
      at: Date.now(), error: null, freshness: 'live',
      agentCard: {
        state: 'available',
        card: {
          displayName: 'Nova', description: '公开 Agent 介绍', interests: ['测试'],
          conversationStyle: '简洁', updatedAt: '2026-11-14T11:00:00Z',
          path: 'profile/agent-card.json', sha256: 'd'.repeat(64),
        },
        error: '',
      },
    }),
  });
  try {
    await settle();
    ui.click('#discoveryList [data-profile-peer]');
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    ui.click('#profileAgentOpen');
    await settle();
    const dialog = ui.shadow.querySelector('#agentCardDialog');
    assert.equal(dialog.open, true);
    const source = ui.shadow.querySelector('#agentCardSource').textContent;
    assert.match(source, /远端声明/);
    assert.doesNotMatch(source, /profile\/agent-card\.json|d{32}|SHA-256/);
    const summary = dialog.querySelector('.rm-source-summary');
    assert.ok(summary);
    summary.click();
    const details = dialog.querySelector('.rm-source-details');
    assert.equal(details.open, true);
    assert.match(details.textContent, /profile\/agent-card\.json/);
    assert.match(details.textContent, new RegExp('d{64}'));
  } finally {
    ui.close();
  }
});

test('mine shows the public user profile and only explicit user-authored posts', async () => {
  const ui = mountUi({
    viewState: { page: 'mine', pages: { mine: { scroll: 0 } } },
    onLoadMine: async () => ({
      peerId: PEER_A,
      at: Date.now(),
      error: null,
      errorAt: null,
      freshness: 'live',
      profile: { state: 'available', markdown: '# Alice\n\n公开资料。', displayName: 'Alice', error: '', path: 'profile/index.md', at: Date.now() },
      posts: {
        state: 'available', error: '', unattributed: 1, agentAuthored: 1, invalid: 0, truncated: false,
        errors: [], posts: [{
          schemaVersion: 1, title: '我的公开帖子', summary: '本人署名', bodyMarkdown: '正文', tags: [], publishedAt: '2026-11-14T10:00:00Z',
          authorPeerId: PEER_A, authorKind: 'user', authorName: 'Alice', path: 'posts/mine.json', sha256: 'b'.repeat(64), sizeBytes: 10,
        }],
      },
    }),
  });
  try {
    await settle();
    assert.match(ui.text('#mineProfileContent'), /公开资料/);
    assert.match(ui.text('#minePostList'), /我的公开帖子/);
    assert.match(ui.text('#mineContentNote'), /缺少明确的本人作者声明/);
    assert.match(ui.text('#mineContentNote'), /Agent 署名/);
    assert.doesNotMatch(ui.text('#page-mine'), /Persona|稳定人格/);
    const mineCard = ui.shadow.querySelector('#minePostList .rm-own-post');
    assert.ok(mineCard);
    const visibleMineText = [' .rm-post-meta', ' .rm-post-title', ' .rm-post-summary']
      .map((selector) => mineCard.querySelector(selector)?.textContent ?? '').join(' ');
    assert.doesNotMatch(visibleMineText, /posts\/mine\.json|b{32}/, 'mine path and hash stay out of the card lead');
    const mineSource = ui.shadow.querySelector('#minePostList .rm-source-summary');
    assert.ok(mineSource);
    mineSource.click();
    assert.match(ui.text('#minePostList'), /posts\/mine\.json/);
    assert.match(ui.text('#minePostList'), new RegExp('b{64}'));
    assert.match(ui.text('#minePostList'), /10 字节/);
  } finally {
    ui.close();
  }
});

test('Journey labels raw values, dedupes one message pointer and keeps history separate', async () => {
  let locateCalls = 0;
  let mismatch = false;
  const ui = mountUi({
    viewState: { page: 'raminga', pages: { raminga: { scroll: 0, expandedSessions: { s1: true } } } },
    onLoadJourney: async () => ({
      state: 'available',
      at: Date.now(),
      freshness: 'live',
      persona: { state: 'available', markdown: '# 稳定人格\n\n简洁。', error: '' },
      growth: { state: 'missing', markdown: '', error: 'missing' },
      sessionsState: 'available',
      sessionsError: '',
      sessionsTruncated: false,
      sessions: [{
        id: 's1', dirModifiedAt: Date.now(), stateRead: 'available', stateError: '',
        state: { status: 'completed', mode: 'explore', intent: '读内容', startedAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:01:00Z', completedAt: '2026-11-14T10:01:00Z', completionReason: '', currentPeerId: PEER_A, visitedPeerIds: [PEER_A], discoverySources: [] },
        eventsRead: 'available', eventsError: '', eventsTruncated: false, badEventLines: 0, reportRead: 'missing', reportError: '', reportMarkdown: '',
        events: [{
          sequence: 2, type: 'observation', timestamp: '2026-11-14T10:00:02Z', summary: '记录一次观察', peerId: PEER_A, sourcePeerId: '',
          messageIds: ['m-same'], contentPaths: [], messageEvidence: { messageId: 'm-same', peerId: PEER_A, direction: 'out', summary: '当时观察的摘要', observedAt: '2026-11-14T10:00:02Z', createdAtUnixMs: '', acked: false, ackedAtUnixMs: '', contentSha256: '' },
        }],
      }],
    }),
    onLocateMessage: async () => {
      locateCalls += 1;
      if (mismatch) {
        return { found: true, peerId: PEER_A, messageId: 'm-same', message: { messageId: 'm-other', peerId: PEER_A, createdAt: Date.now() }, error: null, scanned: 20, complete: true };
      }
      return { found: false, peerId: PEER_A, messageId: 'm-same', message: null, error: null, scanned: 20, complete: true };
    },
  });
  try {
    await settle();
    const sessionText = ui.text('#ramingaSessionList');
    assert.match(sessionText, /已完成/);
    assert.match(sessionText, /探索/);
    assert.match(sessionText, /观察记录/);
    assert.match(sessionText, /发出/);
    assert.match(sessionText, /历史观察/);
    assert.match(sessionText, /不是 Node 当前投递或 ACK 状态/);
    const event = ui.shadow.querySelector('.rm-journey-events > li');
    assert.ok(event);
    const visible = [
      '.rm-journey-event-head', '.rm-journey-event-text', '.rm-journey-peer-ref',
      '.rm-journey-actions', '.rm-journey-evidence',
    ].map((selector) => event.querySelector(selector)?.textContent ?? '').join(' ');
    assert.doesNotMatch(visible, /observation|completed|\bexplore\b|\bout\b|m-same/,
      'raw host values and message IDs stay out of the reading lead');
    assert.equal(event.querySelectorAll('[data-locate-message]').length, 1,
      'one message ID in evidence_refs and message_evidence is one reachable action');
    const raw = event.querySelector('.rm-journey-record');
    assert.ok(raw, 'raw values remain reachable in record details');
    assert.match(raw.textContent, /observation/);
    assert.match(raw.textContent, /\bout\b/);
    assert.match(raw.textContent, /m-same/);
    assert.match(raw.textContent, /尚未确认（仅当时）/);
    assert.doesNotMatch(visible, /尚未确认|acked/);

    event.querySelector('[data-locate-message]').click();
    await settle();
    assert.equal(locateCalls, 1);
    const results = ui.shadow.querySelectorAll('[data-locate-result]');
    assert.equal(results.length, 1, 'one click produces one result, not a duplicate observation result');
    assert.match(results[0].textContent, /已不在当前保留消息中/);
    assert.doesNotMatch(ui.text('#ramingaJourneyMeta'), /已不在当前保留消息中/);
    assert.equal(ui.shadow.querySelector('#page-messages').hidden, true,
      'a clipped reference must not jump into a conversation');

    mismatch = true;
    ui.shadow.querySelector('[data-locate-message]').click();
    await settle();
    assert.equal(locateCalls, 2);
    assert.equal(ui.shadow.querySelector('#page-messages').hidden, true,
      'a host result for another message ID must not open a conversation');
    assert.match(ui.text('#ramingaSessionList'), /消息与这条引用不一致/);
  } finally {
    ui.close();
  }
});

test('Journey refresh forces a host read and preserves expansion, scroll, focus and old content', async () => {
  let revision = 1;
  let fail = false;
  const calls = [];
  const session = (id, text) => ({
    id, dirModifiedAt: Date.now(), stateRead: 'available', stateError: '',
    state: {
      status: 'completed', mode: 'explore', intent: `第 ${revision} 次`, startedAt: '2026-11-14T10:00:00Z',
      updatedAt: '2026-11-14T10:01:00Z', completedAt: '2026-11-14T10:01:00Z', completionReason: '',
      currentPeerId: PEER_A, visitedPeerIds: [PEER_A], discoverySources: [],
    },
    eventsRead: 'available', eventsError: '', eventsTruncated: false, badEventLines: 0,
    reportRead: 'available', reportError: '', reportMarkdown: `# 报告\n\n${text}`,
    events: [],
  });
  const payload = () => ({
    state: 'available', at: Date.now(), freshness: 'live',
    persona: { state: 'available', markdown: '# 人格\n\n稳定。', error: '' },
    growth: { state: 'available', markdown: `# 成长\n\n第 ${revision} 次更新。`, error: '' },
    sessionsState: 'available', sessionsError: '', sessionsTruncated: false,
    sessions: [session('s1', `报告 ${revision}`), ...(revision >= 2 ? [session('s2', `新报告 ${revision}`)] : [])],
  });
  const ui = mountUi({
    viewState: { page: 'raminga', pages: { raminga: { scroll: 120, expandedSessions: { s1: true } } } },
    onLoadJourney: async (force) => {
      calls.push(force === true);
      if (fail) {
        return {
          state: 'error', at: Date.now(), sessionsError: '夹具读取失败', sessions: [],
          persona: null, growth: null, sessionsState: 'error', sessionsTruncated: false, freshness: 'unavailable',
        };
      }
      return payload();
    },
  });
  try {
    await settle();
    assert.match(ui.text('#ramingaGrowth'), /第 1 次更新/);
    assert.equal(ui.shadow.querySelectorAll('.rm-journey-card').length, 1);
    const page = ui.shadow.querySelector('#page-raminga');
    const listNode = ui.shadow.querySelector('#ramingaSessionList');
    page.scrollTop = 180;
    revision = 2;
    const refresh = ui.shadow.querySelector('#ramingaRefresh');
    assert.ok(refresh);
    assert.equal(refresh.hidden, false);
    refresh.focus();
    refresh.click();
    await settle();
    assert.deepEqual(calls, [false, true], 'manual refresh forces the host bridge read');
    assert.match(ui.text('#ramingaGrowth'), /第 2 次更新/);
    assert.equal(ui.shadow.querySelectorAll('.rm-journey-card').length, 2, 'new Journey directory appears without remount');
    assert.equal(ui.shadow.querySelector('#ramingaSessionList'), listNode, 'the list stays mounted');
    assert.equal(ui.shadow.querySelector('#page-raminga'), page, 'the page stays mounted');
    assert.equal(ui.shadow.querySelector('[data-session-toggle="s1"]').getAttribute('aria-expanded'), 'true');
    assert.match(ui.text('#ramingaSessionList'), /报告 2/);
    assert.equal(page.scrollTop, 180, 'refresh keeps the reading position');
    assert.equal(ui.shadow.activeElement?.dataset?.focusKey, 'journey-refresh', 'refresh keeps focus');

    fail = true;
    revision = 3;
    refresh.click();
    await settle();
    assert.match(ui.text('#ramingaGrowth'), /第 2 次更新/, 'failed refresh keeps the previous readable content');
    assert.match(ui.text('#ramingaRecordsStatus'), /刷新没有完成/);
    assert.match(ui.text('#ramingaRecordsStatus'), /旧记录/);
    assert.equal(ui.text('#ramingaRefresh'), '重试刷新');
    assert.equal(ui.shadow.querySelectorAll('.rm-journey-card').length, 2);

    fail = false;
    refresh.click();
    await settle();
    assert.match(ui.text('#ramingaGrowth'), /第 3 次更新/);
    assert.doesNotMatch(ui.text('#ramingaRecordsStatus'), /刷新没有完成/);
    assert.equal(ui.text('#ramingaRefresh'), '刷新记录');
  } finally {
    ui.close();
  }
});

test('Journey refresh coalesces concurrent clicks and ignores a result after close', async () => {
  let calls = 0;
  const pending = [];
  const payload = (revision) => ({
    state: 'available', at: Date.now(), freshness: 'live',
    persona: { state: 'available', markdown: '# 人格', error: '' },
    growth: { state: 'available', markdown: `# 成长\n\n第 ${revision} 次更新。`, error: '' },
    sessionsState: 'missing', sessionsError: '', sessionsTruncated: false, sessions: [],
  });
  const ui = mountUi({
    viewState: { page: 'raminga', pages: { raminga: { scroll: 0, expandedSessions: {} } } },
    onLoadJourney: (force) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(payload(1));
      return new Promise((resolve) => pending.push({ force, resolve }));
    },
  });
  try {
    await settle();
    const refresh = ui.shadow.querySelector('#ramingaRefresh');
    refresh.click();
    refresh.click();
    refresh.click();
    await settle();
    assert.equal(calls, 2, 'concurrent clicks share the in-flight read');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].force, true);
    pending[0].resolve(payload(2));
    await settle();
    await settle();
    assert.equal(calls, 3, 'a force click during the read becomes one trailing force read');
    assert.equal(pending.length, 2);
    assert.equal(pending[1].force, true);
    assert.match(ui.text('#ramingaGrowth'), /第 2 次更新/);
    ui.close();
    pending[1].resolve(payload(3));
    await settle();
  } finally {
    if (ui.viewState) ui.close();
  }
});

test('Journey and mine report missing host records without inventing activity', async () => {
  const calls = [];
  let fail = false;
  const ui = mountUi({
    viewState: { page: 'raminga', pages: { raminga: { scroll: 0, expandedSessions: {} } } },
    onLoadJourney: async (force) => {
      calls.push(force === true);
      if (fail) throw new Error('模拟读取失败');
      return {
        state: 'missing', at: Date.now(), freshness: 'unavailable',
        persona: { state: 'missing', markdown: '', error: 'missing' },
        growth: { state: 'missing', markdown: '', error: 'missing' },
        sessions: [], sessionsState: 'missing', sessionsError: 'agent/sessions 不存在', sessionsTruncated: false,
      };
    },
  });
  try {
    await settle();
    assert.match(ui.text('#ramingaStateTitle'), /还没有可读取的 Agent 记录/);
    assert.doesNotMatch(ui.text('#ramingaSessionList'), /消息|连接/);
    const refresh = ui.shadow.querySelector('#ramingaRefresh');
    assert.ok(refresh);
    assert.equal(refresh.hidden, false, 'the empty state keeps a reachable refresh entry');
    refresh.click();
    await settle();
    assert.deepEqual(calls, [false, true], 'empty-state refresh forces the host bridge read');
    fail = true;
    refresh.click();
    await settle();
    assert.match(ui.text('#ramingaStateTitle'), /这次没有刷新到 Agent 记录/);
    assert.match(ui.text('#ramingaStateBody'), /模拟读取失败/);
    assert.equal(ui.text('#ramingaRefresh'), '重试刷新');
  } finally {
    ui.close();
  }
});
