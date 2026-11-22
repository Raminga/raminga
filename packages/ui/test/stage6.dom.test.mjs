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
    onRevealDiscovery: async () => ({ ok: true, status: 'revealed', error: null, at: Date.now() }),
    onLoadPeerProfile: async () => ({
      peerId: PEER_A, localName: 'Alice', remoteName: 'Alice', found: true,
      text: '# Alice\n\n远端**声明**。', files: ['profile/index.md'], at: Date.now(), error: null, freshness: 'live',
      agentCard: { state: 'missing', card: null, error: 'missing' },
    }),
  });
  try {
    await settle();
    const card = ui.shadow.querySelector('.rm-post');
    assert.match(card.textContent, /Agent 获取/);
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

    assert.equal(ui.shadow.querySelector('#discoveryList .rm-post-toggle'), null, 'the card has no duplicate reading button');
    const sourceReveal = ui.shadow.querySelector('#discoveryList .rm-source-details .rm-file-reveal');
    assert.ok(sourceReveal, 'local-copy locating stays inside source details');

    const open = ui.shadow.querySelector('#discoveryList .rm-post-open');
    open.focus();
    ui.click(open);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const body = ui.shadow.querySelector('#postDetail .rm-post-detail-body');
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
    const detailSource = ui.shadow.querySelector('#postDetail .rm-source-details');
    assert.ok(detailSource.querySelector('.rm-file-reveal'), 'detail locating lives in source details');
    ui.click('#postBack');
    await settle();

    const explorePage = ui.shadow.querySelector('#page-explore');
    explorePage.scrollTop = 120;
    ui.click('#exploreRefresh');
    await settle();
    // The refresh re-renders the list. Under a parallel test-file load the
    // browser may deliver the scroll restoration on a later task, so wait for
    // the reading position instead of assuming one microtask is enough. The
    // assertion still fails if the refresh really loses the position.
    for (let attempt = 0; attempt < 200 && explorePage.scrollTop !== 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    sourceDetails = ui.shadow.querySelector('.rm-post .rm-source-details');
    assert.equal(sourceDetails.open, true, 'an open source detail survives an explicit refresh');
    assert.equal(explorePage.scrollTop, 120, 'refresh keeps the reading scroll');

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

  let emptyManualReads = 0;
  const empty = mountUi({
    onLoadDiscoveries: async () => discoveries([]),
    onRefreshDiscoveries: async (filter) => {
      emptyManualReads += 1;
      assert.equal(filter, false);
      return discoveries([post({ title: '刷新后带回的新帖', source: 'raminga_ui_refresh', sources: ['raminga_ui_refresh'] })]);
    },
  });
  try {
    await settle();
    assert.match(empty.text('#exploreStateTitle'), /还没有获取到公开帖子/);
    assert.match(empty.text('#exploreStateBody'), /两种来源会分别标注/);
    assert.equal(empty.text('#exploreStateAction'), '刷新动态');
    empty.click('#exploreStateAction');
    for (let attempt = 0; attempt < 50 && !empty.text('#discoveryList').includes('刷新后带回的新帖'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(emptyManualReads, 1, 'the empty-state refresh uses the same manual host entry as the toolbar');
    assert.match(empty.text('#discoveryList'), /刷新后带回的新帖/);
    const cardMeta = empty.shadow.querySelector('#discoveryList .rm-post-meta').textContent;
    assert.match(cardMeta, /手动刷新/, 'the refresh source is shown as clear Chinese');
    assert.doesNotMatch(cardMeta, /raminga_ui_refresh/);
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
    assert.match(ui.text('#exploreStateTitle'), /有过交流的节点还没有公开帖子/);
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

    ui.click('button[data-nav="explore"]');
    await settle();
    assert.equal(ui.viewState.pages.explore.filter, 'familiar');
    assert.equal(ui.shadow.querySelector('#exploreQuery').value, '交流', 'search text survives the return');
    assert.ok(familiarReads >= 2, 'returning to the cached familiar feed revalidates it');
    assert.ok(forceReads >= 1, 'the invalidated read bypasses the host cache');
    assert.match(ui.text('#discoveryList'), /交流对象带回的帖子/);
    assert.doesNotMatch(ui.text('#exploreStateBody'), /还没有有过交流/);
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
    ui.click('button[data-nav="explore"]');
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
    ui.click('button[data-nav="explore"]');
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
    ui.click('button[data-nav="explore"]');
    await settle();
    assert.equal(calls, 1, 'returning within the revalidation window does not poll');
    data = [first, second];
    ui.click('#exploreRefresh');
    await settle();
    assert.equal(calls, 2);
    assert.match(ui.text('#discoveryList'), /外部新增文章/);
    assert.equal(ui.shadow.querySelector('#exploreQuery').value, '文章');
    assert.equal(ui.shadow.querySelector('#discoveryList .rm-post-body'), null, 'the independent detail replaces the inline reading row');
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
    assert.match(ui.text('#mineIdentitySummary'), /公开资料/);
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
    viewState: { page: 'raminga', pages: { raminga: { scroll: 0, expandedSessions: {} } } },
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
    ui.click('#homeActivityRecent');
    await settle();
    assert.equal(ui.shadow.querySelector('#page-journey').hidden, false);
    const detailText = ui.text('#journeyDetail');
    assert.match(detailText, /已完成/);
    assert.match(detailText, /探索/);
    assert.match(detailText, /观察记录/);
    assert.match(detailText, /发出/);
    assert.match(detailText, /记录一次观察/);
    assert.doesNotMatch(ui.text('#journeyDetail .rm-journey-summary'), /observation|completed|\bexplore\b/,
      'raw host values stay out of the summary lead');
    const evidence = ui.shadow.querySelector('#journeyDetail .rm-journey-evidence-row');
    assert.ok(evidence);
    assert.equal(ui.shadow.querySelectorAll('#journeyDetail [data-journey-locate-peer]').length, 1,
      'one message ID in evidence_refs and message_evidence is one reachable action');
    const source = ui.shadow.querySelector('#journeyDetail .rm-journey-source');
    assert.equal(source.open, false);
    const raw = ui.shadow.querySelector('#journeyDetail .rm-journey-event-raw');
    assert.equal(raw.open, false);
    assert.match(raw.textContent, /observation/);
    assert.match(raw.textContent, /\bout\b/);
    assert.match(raw.textContent, /m-same/);
    assert.match(raw.textContent, /尚未确认（仅当时）/);

    ui.shadow.querySelector('#journeyDetail [data-journey-locate-peer]').click();
    await settle();
    assert.equal(locateCalls, 1);
    const result = ui.shadow.querySelector('#journeyDetail [data-journey-locate-peer]')
      .closest('.rm-journey-evidence-row').querySelector('.rm-journey-check');
    assert.match(result.textContent, /已不在当前保留消息中/);
    assert.equal(ui.shadow.querySelector('#page-messages').hidden, true,
      'a clipped reference must not jump into a conversation');

    mismatch = true;
    ui.shadow.querySelector('#journeyDetail [data-journey-locate-peer]').click();
    await settle();
    assert.equal(locateCalls, 2);
    assert.equal(ui.shadow.querySelector('#page-messages').hidden, true,
      'a host result for another message ID must not open a conversation');
    assert.match(ui.text('#journeyDetail'), /消息与这条引用不一致/);
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
    assert.match(ui.shadow.querySelector('#settingsGrowthInput').value, /第 1 次更新/);
    assert.equal(ui.shadow.querySelectorAll('#ramingaSessionList .rm-journey-tile').length, 0, 'the latest record is featured above the grid');
    const page = ui.shadow.querySelector('#page-home');
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
    assert.match(ui.shadow.querySelector('#settingsGrowthInput').value, /第 2 次更新/);
    assert.equal(ui.shadow.querySelectorAll('#ramingaSessionList .rm-journey-tile').length, 1, 'the non-featured Journey appears without remount');
    assert.equal(ui.shadow.querySelector('#ramingaSessionList'), listNode, 'the list stays mounted');
    assert.equal(ui.shadow.querySelector('#page-home'), page, 'the page stays mounted');
    assert.match(ui.text('#ramingaSessionList'), /新报告 2/);
    assert.match(ui.text('#ramingaSessionList'), /第 2 次/);
    assert.equal(page.scrollTop, 180, 'refresh keeps the reading position');
    assert.equal(ui.shadow.activeElement?.dataset?.focusKey, 'journey-refresh', 'refresh keeps focus');

    fail = true;
    revision = 3;
    refresh.click();
    await settle();
    assert.match(ui.shadow.querySelector('#settingsGrowthInput').value, /第 2 次更新/, 'failed refresh keeps the previous readable content');
    assert.match(ui.text('#ramingaRecordsStatus'), /刷新没有完成/);
    assert.match(ui.text('#ramingaRecordsStatus'), /旧记录/);
    assert.equal(ui.text('#ramingaRefresh'), '重试刷新');
    assert.equal(ui.shadow.querySelectorAll('#ramingaSessionList .rm-journey-tile').length, 1);

    fail = false;
    refresh.click();
    await settle();
    assert.match(ui.shadow.querySelector('#settingsGrowthInput').value, /第 3 次更新/);
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
    assert.match(ui.shadow.querySelector('#settingsGrowthInput').value, /第 2 次更新/);
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

const HUMAN_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGsAAAAASUVORK5CYII=';
const HUMAN_AVATAR_V2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAABFaP0WAAAADUlEQVR42mNk+M/wHwAEAQH/2VZqNwAAAABJRU5ErkJggg==';

test('feed cards and their detail use the publisher avatar chosen by the header identity', async () => {
  let listReads = 0;
  let profileReads = 0;
  let contentReads = 0;
  let current = post({
    publisherName: '阿岸',
    publisherAgentName: '小澜',
    publisherAvatarKey: 'human:an',
    publisherAvatarUrl: HUMAN_AVATAR,
    publisherAvatarMime: 'image/png',
    authorKind: 'agent',
    authorName: '小澜',
  });
  const ui = mountUi({
    onLoadDiscoveries: async () => {
      listReads += 1;
      return discoveries([current]);
    },
    onLoadPeerProfile: async () => {
      profileReads += 1;
      throw new Error('the list must not read a remote profile');
    },
    onLoadDiscoveryContent: async () => {
      contentReads += 1;
      throw new Error('the list must not read post content just to paint an avatar');
    },
  });
  try {
    await settle();
    assert.equal(listReads, 1);
    assert.equal(profileReads, 0);
    assert.equal(contentReads, 0, 'painting a card avatar must not add a remote read');
    const avatar = ui.shadow.querySelector('#discoveryList .rm-post-avatar');
    assert.ok(avatar);
    assert.equal(avatar.dataset.kind, 'image');
    assert.equal(avatar.dataset.profilePeer, PEER_A, 'avatar remains the existing profile button');
    assert.match(avatar.getAttribute('aria-label'), /小澜/);
    assert.equal(avatar.querySelector('img')?.getAttribute('src'), HUMAN_AVATAR);
    assert.equal(ui.shadow.querySelector('#discoveryList .rm-post-name').textContent, '小澜', 'the header shows the publishing Agent');
    assert.doesNotMatch(ui.shadow.querySelector('#discoveryList .rm-post-open').textContent, /小澜/);
    assert.match(ui.shadow.querySelector('#discoveryList .rm-source-details').textContent, /Agent署名 · 小澜/, 'the original author declaration stays in source details');
    const contentReadsBeforeDetail = contentReads;

    ui.click('#discoveryList .rm-post-open');
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const detailAvatar = ui.shadow.querySelector('#postDetail .rm-post-avatar');
    assert.ok(detailAvatar);
    assert.equal(detailAvatar.querySelector('img')?.getAttribute('src'), HUMAN_AVATAR, 'detail uses the same publisher avatar');
    assert.equal(detailAvatar.dataset.profilePeer, PEER_A);
    assert.equal(profileReads, 0);
    assert.ok(contentReads >= contentReadsBeforeDetail, 'only the explicit detail open may read post content');
    const contentReadsAfterDetail = contentReads;
    ui.click('#postBack');
    await settle();

    // A changed avatar version must be repainted from the fresh item, not hidden
    // by an old per-card cache.
    current = { ...current, publisherAvatarKey: 'human:an:v2', publisherAvatarUrl: HUMAN_AVATAR_V2 };
    ui.click('#exploreRefresh');
    await settle();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const src = ui.shadow.querySelector('#discoveryList .rm-post-avatar img')?.getAttribute('src');
      if (src === HUMAN_AVATAR_V2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(ui.shadow.querySelector('#discoveryList .rm-post-avatar img')?.getAttribute('src'), HUMAN_AVATAR_V2);
    assert.equal(profileReads, 0);
    assert.equal(contentReads, contentReadsAfterDetail, 'repainting the list avatar must not read post content');

    // A missing or corrupt avatar falls back to the original initial glyph and
    // keeps the profile-button semantics.
    current = { ...current, publisherAvatarKey: 'human:missing', publisherAvatarUrl: '', publisherAvatarMime: '' };
    ui.click('#exploreRefresh');
    await settle();
    const fallback = ui.shadow.querySelector('#discoveryList .rm-post-avatar');
    assert.equal(fallback.dataset.kind, 'initial');
    assert.equal(fallback.querySelector('img'), null);
    assert.equal(fallback.textContent, '小');
    assert.equal(fallback.dataset.profilePeer, PEER_A);
    assert.match(fallback.getAttribute('aria-label'), /小澜/);

    current = { ...current, publisherAvatarKey: 'human:broken', publisherAvatarUrl: HUMAN_AVATAR, publisherAvatarMime: 'image/png' };
    ui.click('#exploreRefresh');
    await settle();
    const broken = ui.shadow.querySelector('#discoveryList .rm-post-avatar');
    assert.equal(broken.dataset.kind, 'image');
    broken.querySelector('img').dispatchEvent(new ui.dom.window.Event('error'));
    assert.equal(broken.dataset.kind, 'initial');
    assert.equal(broken.textContent, '小');

    current = { ...current, publisherAgentName: '', publishedAt: '', modifiedAt: 0 };
    ui.click('#exploreRefresh');
    await settle();
    assert.equal(ui.text('#discoveryList .rm-post-name'), '发布 Agent 未公开');
    assert.equal(ui.shadow.querySelector('#discoveryList .rm-post-avatar img'), null);
    assert.doesNotMatch(ui.text('#discoveryList .rm-post-meta'), /发布于|更新于/);
    assert.equal(profileReads, 0);
    assert.equal(contentReads, contentReadsAfterDetail);
  } finally {
    ui.close();
  }
});

test('discovery list expands one shared avatar table into the existing card fields', async () => {
  const item = post({
    publisherName: '阿岸',
    publisherAgentName: '小澜',
    publisherAvatarKey: 'shared:human:an',
    publisherAvatarUrl: '',
    publisherAvatarMime: 'image/png',
  });
  const data = discoveries([item], {
    avatars: { 'shared:human:an': { url: HUMAN_AVATAR, mime: 'image/png' } },
  });
  const ui = mountUi({ onLoadDiscoveries: async () => data });
  try {
    await settle();
    const avatar = ui.shadow.querySelector('#discoveryList .rm-post-avatar img');
    assert.ok(avatar);
    assert.equal(avatar.getAttribute('src'), HUMAN_AVATAR, 'top-level table bytes reach the existing card renderer');
  } finally {
    ui.close();
  }
});

test('only the explicit Feed refresh starts a bounded host refresh and merges repeated clicks', async () => {
  let localReads = 0;
  let manualReads = 0;
  let resolveManual;
  let current = discoveries([post({ title: '旧动态' })]);
  const ui = mountUi({
    onLoadDiscoveries: async () => {
      localReads += 1;
      return current;
    },
    onRefreshDiscoveries: async (familiar) => {
      manualReads += 1;
      assert.equal(familiar, false);
      return new Promise((resolve) => { resolveManual = resolve; });
    },
  });
  try {
    await settle();
    assert.equal(localReads, 1);
    assert.equal(manualReads, 0, 'page entry does not start a remote check');

    const query = ui.shadow.querySelector('#exploreQuery');
    query.value = '动';
    query.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    assert.equal(manualReads, 0, 'search only re-renders or re-reads the local index');

    ui.click('#exploreRefresh');
    await settle();
    assert.equal(manualReads, 1, 'the visible refresh button starts the host refresh');
    ui.click('#exploreRefresh');
    await settle();
    assert.equal(manualReads, 1, 'a second click while one refresh is in flight is coalesced');
    assert.match(ui.text('#exploreRefresh'), /刷新中/);

    resolveManual({
      ...discoveries([post({ id: '18', title: '新动态' })], {
        refresh: {
          familiar: false, at: Date.now(), checkedPeers: 2, totalPeers: 4,
          imported: 1, skipped: 1, invalid: 0, failed: 1, notCovered: 2,
          truncated: true, coalesced: false, unsupported: false, durationMs: 90,
          error: null, peers: [
            { peerId: '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR', peerName: '小澜', status: 'partial', error: '一条动态获取超时' },
            { peerId: '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6', peerName: '', status: 'not-covered', error: '预算已用完' },
          ],
        },
      }),
    });
    await settle();
    for (let attempt = 0; attempt < 50 && !ui.text('#discoveryList').includes('新动态'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(ui.text('#discoveryList'), /新动态/);
    assert.equal(localReads, 1, 'the host refresh already returned the fresh local index');
    const meta = ui.text('#discoveryMeta');
    assert.match(meta, /本次检查了 2 个节点/);
    assert.match(meta, /收录 1 条新动态/);
    assert.match(meta, /1 个节点失败/);
    assert.match(meta, /1 个节点部分完成（部分内容未收录）/);
    assert.match(meta, /共 4 个候选，2 个本次未检查/);
    const report = ui.shadow.querySelector('#discoveryRefreshReport');
    assert.equal(report.hidden, false, 'per-node refresh results are visible beside the summary');
    assert.equal(report.querySelector('summary').textContent, '本次刷新节点结果（2）');
    const rows = [...report.querySelectorAll('.rm-refresh-peer')];
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /小澜.*部分完成 · 一条动态获取超时/);
    assert.match(rows[1].textContent, /12D3KooW.*未覆盖 · 预算已用完/);
  } finally {
    ui.close();
  }
});

test('a failed manual refresh keeps the previous discovery cards and says why', async () => {
  let manualReads = 0;
  const ui = mountUi({
    onLoadDiscoveries: async () => discoveries([post({ title: '保留下来的旧帖' })]),
    onRefreshDiscoveries: async () => {
      manualReads += 1;
      throw new Error('远端检查超时');
    },
  });
  try {
    await settle();
    assert.match(ui.text('#discoveryList'), /保留下来的旧帖/);
    ui.click('#exploreRefresh');
    await settle();
    for (let attempt = 0; attempt < 50 && !ui.text('#discoveryMeta').includes('超时'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manualReads, 1);
    assert.match(ui.text('#discoveryList'), /保留下来的旧帖/);
    assert.match(ui.text('#discoveryMeta'), /远端检查超时/);
    assert.doesNotMatch(ui.text('#exploreRefresh'), /刷新中/);
  } finally {
    ui.close();
  }
});


test('my Feed reuses the local public profile avatar for list and detail', async () => {
  const data = {
    peerId: PEER_A,
    at: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    profile: { state: 'available', markdown: '# 阿岸\n\n本人公开资料。', displayName: '阿岸', error: '', path: 'profile/index.md', at: Date.now() },
    posts: {
      state: 'available', error: '', unattributed: 0, agentAuthored: 0, invalid: 0, truncated: false,
      errors: [], posts: [{
        schemaVersion: 2, title: '我的本机动态', summary: '本人署名', bodyMarkdown: '# 我的本机动态\n\n正文',
        tags: [], publishedAt: '2026-11-22T08:00:00Z', authorPeerId: PEER_A, authorKind: 'user',
        authorName: '阿岸', path: 'posts/mine-feed/post.json', sha256: 'e'.repeat(64), sizeBytes: 42,
      }],
    },
    files: [],
    filesTruncated: false,
    publisherAgentName: '小澜',
    publisherAvatarKey: 'mine:agent',
    publisherAvatarUrl: HUMAN_AVATAR,
    publisherAvatarMime: 'image/png',
  };
  let mineReads = 0;
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'mine', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadMine: async () => { mineReads += 1; return data; },
  });
  try {
    await settle();
    assert.equal(mineReads, 1);
    const card = ui.shadow.querySelector('#mineFeedList .rm-own-post');
    assert.ok(card, 'the Feed Mine filter is rendered');
    assert.equal(card.querySelector('.rm-post-avatar img')?.getAttribute('src'), HUMAN_AVATAR);
    assert.match(card.querySelector('.rm-source-details').textContent, /用户署名 · 阿岸/);
    assert.match(card.querySelector('.rm-post-author-badge').textContent, /发布 Agent/, 'the header labels the publishing Agent');
    ui.click('#mineFeedList .rm-post-open');
    await settle();
    const detail = ui.shadow.querySelector('#postDetail .rm-post-avatar');
    assert.equal(detail.querySelector('img')?.getAttribute('src'), HUMAN_AVATAR, 'Mine detail reuses the same local public avatar');
    assert.equal(mineReads, 1, 'repainting does not issue another Mine read');
  } finally {
    ui.close();
  }
});
