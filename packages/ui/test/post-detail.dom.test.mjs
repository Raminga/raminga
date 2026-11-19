// First-batch A acceptance: Feed cards open one independent post detail; the
// title/excerpt, image, favorite and own-post edit entries keep their real
// actions, and returning restores the Feed filter, search, scroll and focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';
import { normalizeViewState } from '../src/view-state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const IMAGE_SHA = 'b'.repeat(64);

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
  const viewState = options.viewState ?? normalizeViewState({
    page: 'explore',
    pages: { explore: { filter: 'familiar', query: '地图', searchOpen: true, scroll: 240, expanded: {}, sourceOpen: {} } },
  });
  const app = createRamingaApp(shadow, { ...options, viewState });
  app.onLeaseReady();
  return {
    dom, shadow, app, viewState,
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
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function post(overrides = {}) {
  return {
    id: 'post-map', peerId: PEER_A, publisherName: '澄野', path: 'posts/map/post.json',
    name: 'post.json', sha256: 'a'.repeat(64), sizeBytes: 640, modifiedAt: 0,
    fetchedAt: Date.parse('2026-11-18T09:00:00Z'), source: 'raminga_content_get',
    sources: ['raminga_content_get'], kind: 'markdown', mime: 'text/markdown', previewable: true,
    title: '雨停后的地图', summary: '一张手绘地图和雨后的街道。', tags: ['地图', '散步'],
    publishedAt: '2026-11-17T08:30:00Z', authorKind: 'user', authorName: '澄野',
    contentState: 'available', contentError: '',
    images: [{ path: 'images/map.png', publicPath: 'posts/map/images/map.png', sha256: IMAGE_SHA, mime: 'image/png', width: 800, height: 600, sizeBytes: 1200, manifestState: 'unknown' }],
    ...overrides,
  };
}

function textPost(overrides = {}) {
  return post({
    id: 'post-plain', path: 'posts/plain.json', name: 'plain.json', sha256: 'c'.repeat(64),
    title: '没有配图的记录', summary: '纯文字帖不该留下图片占位。', tags: [], images: [],
    publishedAt: '2026-11-16T10:00:00Z', ...overrides,
  });
}

function discoveries(items, familiar = true) {
  return {
    items, at: Date.now(), error: null, errorAt: null, freshness: 'live', familiar,
    scanned: items.length, truncated: false, relationComplete: true, ignored: 0,
  };
}

function contentFor(item, body) {
  return {
    ok: true, subject: 'discovery', status: 'ok', kind: 'markdown', mime: 'text/markdown',
    title: item.title, text: body, html: '', dataUrl: '', warnings: [], missingResources: [], error: '',
    post: null, id: item.id, peerId: item.peerId, path: item.path, sha256: item.sha256,
    sizeBytes: item.sizeBytes, source: item.source, sources: item.sources,
    fetchedAt: item.fetchedAt, localCopy: 'available', acquisition: 'local-copy',
    discoveryRecorded: false, discoveryError: '',
  };
}

test('post detail keeps publish time, tags, body and image preview and restores the Feed', async () => {
  const map = post();
  const plain = textPost();
  const favorites = [];
  const imageReads = [];
  let loadCalls = 0;
  const ui = mountUi({
    onLoadDiscoveries: async (familiar) => { loadCalls += 1; return discoveries([map, plain], familiar); },
    onLoadDiscoveryContent: async (id) => contentFor(id === map.id ? map : plain, id === map.id ? '# 地图\n\n雨停以后，街角的苔藓比昨天更绿。' : '今天只有文字。'),
    onLoadPeerFileContent: async (peerId, publicPath, sha256, sizeBytes) => {
      imageReads.push([peerId, publicPath, sha256, sizeBytes]);
      return { ok: true, status: 'ok', kind: 'image', mime: 'image/png', sha256: IMAGE_SHA, sizeBytes: 1200, dataUrl: 'data:image/png;base64,UE5H', title: 'map', text: '', html: '', warnings: [], missingResources: [], error: '', post: null };
    },
    onRevealDiscovery: async () => ({ ok: true, status: 'revealed', error: null, at: Date.now() }),
    onLoadFavorites: async () => ({ favorites: [], hasMore: false, nextBefore: '', total: 0, error: null }),
    onSetFavorite: async ({ favorite }) => {
      favorites.push(favorite);
      return { favorite, item: { id: 'fav-1', peerId: map.peerId, path: map.path, sha256: map.sha256, title: map.title, available: true } };
    },
  });
  try {
    await settle();
    const page = ui.shadow.querySelector('#page-explore');
    page.scrollTop = 240;
    const card = ui.shadow.querySelector('#discoveryList .rm-post');
    assert.ok(card);
    assert.match(card.querySelector('.rm-post-meta').textContent, /发布于/);
    assert.doesNotMatch(card.querySelector('.rm-post-meta').textContent, /2026-11-18/);
    assert.match(card.querySelector('.rm-source-details').textContent, /获取时间/);
    assert.equal(card.querySelector('.rm-post-toggle'), null, 'no duplicate reading button in the main card');
    assert.equal(card.querySelector('.rm-post-actions .rm-file-reveal'), null, 'no locating button in the main card');
    assert.ok(card.querySelector('.rm-source-details .rm-file-reveal'), 'locating lives in source details');
    assert.doesNotMatch(ui.shadow.querySelector('#discoveryMeta').textContent, /获取记录|106/);
    assert.equal(ui.shadow.querySelector('#discoveryScope').hidden, false);
    assert.match(ui.shadow.querySelector('#discoveryScopeBody').textContent, /普通文件不会占用/);
    const open = card.querySelector('.rm-post-open');
    assert.ok(open);
    open.focus();
    open.click();
    await settle();
    await wait();

    assert.equal(ui.shadow.querySelector('#page-post').hidden, false);
    assert.equal(ui.shadow.querySelector('#page-explore').hidden, true);
    const detail = ui.shadow.querySelector('#postDetail');
    assert.equal(detail.hidden, false);
    assert.match(detail.textContent, /雨停后的地图/);
    assert.match(detail.textContent, /地图/);
    assert.match(detail.textContent, /散步/);
    assert.match(detail.textContent, /雨停以后/);
    assert.match(detail.querySelector('.rm-post-meta').textContent, /2026\/11\/17|2026-11-17/);
    assert.doesNotMatch(detail.querySelector('.rm-post-meta').textContent, /获取时间/);
    assert.match(detail.querySelector('.rm-source-details').textContent, /获取时间/);
    assert.match(detail.querySelector('.rm-source-details').textContent, /内容版本/);
    assert.match(detail.querySelector('.rm-source-details').textContent, /文件类型/);
    assert.match(detail.querySelector('.rm-source-details').textContent, /大小/);
    assert.equal(detail.querySelector('.rm-post-actions .rm-file-reveal'), null, 'detail locating moved into source');
    assert.ok(detail.querySelector('.rm-source-details .rm-file-reveal'));

    const imageTile = detail.querySelector('.rm-post-media-item');
    assert.ok(imageTile);
    await wait();
    assert.equal(imageReads.length, 1);
    assert.equal(imageReads[0][1], 'posts/map/images/map.png');
    assert.equal(imageTile.querySelector('.rm-post-media-img').hidden, false);
    imageTile.click();
    await wait();
    assert.equal(ui.shadow.querySelector('#imagePreviewDialog').open, true);
    ui.click('#imagePreviewDialog [data-close-dialog]');
    await wait();
    assert.equal(ui.shadow.querySelector('#imagePreviewDialog').open, false);

    const star = detail.querySelector('.rm-post-favorite');
    assert.ok(star);
    star.click();
    await settle();
    assert.deepEqual(favorites, [true]);
    assert.match(ui.shadow.querySelector('#postDetail').textContent, /已收藏/);

    ui.click('#postBack');
    await settle();
    await wait();
    assert.equal(ui.shadow.querySelector('#page-explore').hidden, false);
    assert.equal(ui.shadow.querySelector('#page-post').hidden, true);
    assert.equal(ui.viewState.pages.explore.filter, 'familiar');
    assert.equal(ui.viewState.pages.explore.query, '地图');
    assert.equal(ui.shadow.querySelector('#exploreQuery').value, '地图');
    assert.equal(ui.shadow.querySelector('#page-explore').scrollTop, 240);
    assert.equal(ui.shadow.activeElement?.dataset?.focusKey, 'post:post-map:open');
    assert.equal(ui.shadow.querySelector('#desktopNav [data-nav="explore"]').getAttribute('aria-current'), 'page');
    assert.equal(loadCalls, 1, 'returning uses the cached Feed instead of a new read');
  } finally {
    ui.close();
  }
});

test('non-post diagnostics stay out of the first screen and live in the scope disclosure', async () => {
  const map = post();
  const data = discoveries([map]);
  data.ignored = 106;
  data.truncated = true;
  data.scanned = 503;
  const ui = mountUi({
    onLoadDiscoveries: async () => data,
    onLoadDiscoveryContent: async () => contentFor(map, '# 地图\n\n正文'),
  });
  try {
    await settle();
    const meta = ui.shadow.querySelector('#discoveryMeta');
    assert.equal(meta.hidden, true, 'a normal first screen has no yellow non-post banner');
    assert.doesNotMatch(meta.textContent, /106/);
    const list = ui.shadow.querySelector('#discoveryList');
    assert.doesNotMatch(list.textContent, /106 条获取记录/);
    const scope = ui.shadow.querySelector('#discoveryScope');
    assert.equal(scope.hidden, false);
    assert.equal(scope.open, false, 'scope details start collapsed after the posts');
    assert.ok(list.compareDocumentPosition(scope) & 4, 'normal posts precede the secondary disclosure');
    const body = scope.querySelector('#discoveryScopeBody');
    assert.match(body.textContent, /其中 106 条不是可识别的公开帖子/);
    assert.match(body.textContent, /最多读取 500 条帖子候选/);
    assert.match(body.textContent, /已排除在动态、搜索和计数之外/);
  } finally {
    ui.close();
  }
});

test('pure text post detail has no media placeholder, and view state restores the detail route', async () => {
  const plain = textPost();
  const state = normalizeViewState({
    page: 'post',
    pages: { explore: { filter: 'all', query: '', searchOpen: false, scroll: 88, expanded: {}, sourceOpen: {} } },
    post: {
      id: plain.id, peerId: plain.peerId, path: plain.path, sha256: plain.sha256,
      sizeBytes: plain.sizeBytes, source: 'explore', filter: 'all', query: '', scroll: 0,
      returnFocus: 'post:post-plain:open',
    },
  });
  assert.equal(state.page, 'post');
  assert.equal(state.post.path, plain.path);
  const ui = mountUi({
    viewState: state,
    onLoadDiscoveries: async () => discoveries([plain], false),
    onLoadDiscoveryContent: async () => contentFor(plain, '只有文字，没有图片。'),
  });
  try {
    await settle();
    await settle();
    const detail = ui.shadow.querySelector('#postDetail');
    // debug removed
    // ui.shadow.querySelector('#postDetailStateTitle').textContent, ui.shadow.querySelector('#postDetailStateBody').textContent, detail.hidden, detail.textContent);
    assert.equal(detail.hidden, false);
    assert.match(detail.textContent, /没有配图的记录/);
    assert.equal(detail.querySelector('.rm-post-media'), null);
    assert.equal(detail.querySelector('.rm-post-detail-main').dataset.hasMedia, 'false');
    ui.click('#postBack');
    await settle();
    assert.equal(ui.viewState.page, 'explore');
    assert.equal(ui.shadow.querySelector('#page-explore').scrollTop, 88);
  } finally {
    ui.close();
  }
});

test('own post detail exposes edit while a remote discovery post does not', async () => {
  const own = post({
    id: 'mine-1', peerId: '12D3KooWSelfNode111111111111111111111111111111111', path: 'posts/own/post.json',
    publisherName: '我', sources: ['local-public'], source: 'local-public', authorKind: 'agent', authorName: 'Nova',
  });
  const ui = mountUi({
    onLoadMine: async () => ({
      peerId: own.peerId, at: Date.now(), error: null, freshness: 'live',
      profile: { state: 'available', markdown: '# 我', displayName: '我', error: '', path: 'profile/index.md', at: null },
      posts: { state: 'available', posts: [], error: '', unattributed: 0, agentAuthored: 1, invalid: 0, errors: [], truncated: false },
      files: [own],
      filesTruncated: false,
    }),
    onLoadMineFileContent: async () => ({ ok: true, subject: 'mine', status: 'ok', kind: 'markdown', text: '自己的正文', post: null, dataUrl: '', html: '', warnings: [], missingResources: [], error: '' }),
    onLoadPublicDraft: async () => ({ draft: null }),
    onSavePublicDraft: async () => ({ draft: null }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onImportPublicPost: async () => ({ draft: null }),
  });
  try {
    await settle();
    const mineButton = ui.shadow.querySelector('[data-filter="mine"]');
    mineButton.click();
    await settle();
    await settle();
    const card = ui.shadow.querySelector('#mineFeedList .rm-post');
    assert.ok(card, 'own Feed card is rendered');
    assert.equal(card.querySelector('.rm-post-author-badge').dataset.kind, 'agent');
    card.querySelector('.rm-post-open').click();
    await settle();
    const detail = ui.shadow.querySelector('#postDetail');
    assert.match(detail.textContent, /Agent/);
    assert.ok(detail.querySelector('.rm-post-edit'), 'own post detail keeps the edit entry');
  } finally {
    ui.close();
  }
});
