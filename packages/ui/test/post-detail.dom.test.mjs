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
    publisherName: '我', publisherAgentName: 'Nova', sources: ['local-public'], source: 'local-public', authorKind: 'agent', authorName: 'Nova',
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

test('Explore and Contacts keep their accessible page names without intro blocks', async () => {
  const ui = mountUi({ onLoadDiscoveries: async () => discoveries([], false) });
  try {
    await settle();
    const explore = ui.shadow.querySelector('#page-explore');
    const contacts = ui.shadow.querySelector('#page-contacts');
    assert.equal(explore.getAttribute('aria-label'), '动态');
    assert.equal(contacts.getAttribute('aria-label'), '联系人');
    assert.equal(explore.querySelector('.rm-page-head'), null, 'the redundant Explore title/subtitle block is gone');
    assert.equal(explore.querySelector('h1'), null);
    assert.equal(contacts.querySelector('.rm-page-head'), null, 'the redundant Contacts title/subtitle block is gone');
    assert.equal(contacts.querySelector('h1'), null);
    assert.ok(explore.querySelector('.rm-explore-bar .rm-filters'), 'filters remain the first Feed control');
    assert.ok(explore.querySelector('#exploreQuery'), 'search remains available');
    assert.ok(contacts.querySelector('#contactQuery'), 'contact search remains available');
    assert.ok(ui.shadow.querySelector('#page-settings .rm-settings-header h1'), 'other page headers are unchanged');
    const css = fs.readFileSync(path.resolve(here, '..', 'src', 'styles', 'workspace.css'), 'utf8');
    assert.match(css, /#page-explore \.rm-explore-bar,\n#page-contacts \.rm-contacts-toolbar \{ padding-top: 18px; \}/,
      'compact desktop spacing is scoped to the two feed toolbars');
    assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*?#page-explore \.rm-explore-bar,\n  #page-contacts \.rm-contacts-toolbar \{ padding-top: 12px; \}/,
      'the narrow layout keeps its own compact inset');
  } finally {
    ui.close();
  }
});

test('own standalone Markdown and generic files open the same detail and restore the Mine filter/search/scroll', async () => {
  const ownPeer = '12D3KooWSelfNode111111111111111111111111111111111';
  const markdownFile = post({
    id: 'mine-note', peerId: ownPeer, publisherName: '我',
    path: 'posts/notes.md', name: 'notes.md', sha256: '1'.repeat(64),
    title: '独立笔记', summary: '一篇独立 Markdown。', tags: [], images: [],
    source: 'local-public', sources: ['local-public'], authorKind: 'user', authorName: '本人',
  });
  const imageFile = post({
    id: 'mine-image', peerId: ownPeer, publisherName: '我',
    path: 'posts/photo.png', name: 'photo.png', sha256: '2'.repeat(64),
    kind: 'image', mime: 'image/png', title: '一张公开图片', summary: '', tags: [], images: [],
    source: 'local-public', sources: ['local-public'], authorKind: 'user', authorName: '本人',
  });
  const pdfFile = post({
    id: 'mine-pdf', peerId: ownPeer, publisherName: '我',
    path: 'posts/report.pdf', name: 'report.pdf', sha256: '3'.repeat(64),
    kind: 'unsupported', mime: 'application/pdf', previewable: false, title: '公开报告',
    summary: '', tags: [], images: [], source: 'local-public', sources: ['local-public'],
  });
  const reads = [];
  const ui = mountUi({
    viewState: normalizeViewState({
      page: 'explore',
      pages: { explore: { filter: 'mine', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } },
    }),
    onLoadMine: async () => ({
      peerId: ownPeer, at: Date.now(), error: null, freshness: 'live',
      profile: { state: 'available', markdown: '# 我', displayName: '我', error: '', path: 'profile/index.md', at: null },
      posts: { state: 'available', posts: [], error: '', unattributed: 0, agentAuthored: 0, invalid: 0, errors: [], truncated: false },
      files: [markdownFile, imageFile, pdfFile],
      filesTruncated: false,
    }),
    onLoadMineFileContent: async (filePath, sha256, sizeBytes) => {
      reads.push({ filePath, sha256, sizeBytes });
      if (filePath === markdownFile.path) {
        return { ...markdownFile, ok: true, subject: 'mine', status: 'ok', kind: 'markdown', text: '# 独立笔记\n\n独立文件正文。', dataUrl: '', html: '', warnings: [], missingResources: [], error: '', post: null };
      }
      return { ...imageFile, ok: true, subject: 'mine', status: 'ok', kind: 'image', text: '', dataUrl: 'data:image/png;base64,UE5H', html: '', warnings: [], missingResources: [], error: '', post: null };
    },
  });
  try {
    await settle();
    await settle();
    const cards = [...ui.shadow.querySelectorAll('#mineFeedList .rm-post')];
    assert.equal(cards.length, 3, 'standalone Markdown, image and generic files all remain listed');
    for (const card of cards) {
      assert.equal(card.querySelector('[data-expand-post]'), null);
      assert.equal(card.querySelector('.rm-post-cta').textContent, '查看动态');
    }
    const query = ui.shadow.querySelector('#exploreQuery');
    query.value = '独立笔记';
    query.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    const page = ui.shadow.querySelector('#page-explore');
    page.scrollTop = 210;
    const card = ui.shadow.querySelector('#mineFeedList .rm-post');
    assert.ok(card);
    const open = card.querySelector('.rm-post-open');
    open.focus();
    open.click();
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-post').hidden, false);
    const detail = ui.shadow.querySelector('#postDetail');
    assert.match(detail.textContent, /独立笔记/);
    assert.match(detail.textContent, /独立文件正文/);
    assert.deepEqual(reads, [{ filePath: markdownFile.path, sha256: markdownFile.sha256, sizeBytes: markdownFile.sizeBytes }]);
    ui.click('#postBack');
    await settle();
    await wait();
    assert.equal(ui.shadow.querySelector('#page-explore').hidden, false);
    assert.equal(ui.viewState.pages.explore.filter, 'mine');
    assert.equal(ui.shadow.querySelector('#exploreQuery').value, '独立笔记');
    assert.equal(ui.shadow.querySelector('#page-explore').scrollTop, 210);
    assert.equal(ui.shadow.activeElement?.dataset?.focusKey, `mine-feed:${markdownFile.path}:${markdownFile.sha256}:open`);

    query.value = '';
    query.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    const imageCard = [...ui.shadow.querySelectorAll('#mineFeedList .rm-post')]
      .find((entry) => entry.textContent.includes('photo.png') || entry.textContent.includes('一张公开图片'));
    assert.ok(imageCard);
    imageCard.querySelector('.rm-post-open').click();
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-post').hidden, false);
    const image = ui.shadow.querySelector('#postDetail .rm-file-image');
    assert.ok(image, 'standalone image renders as native media in the detail');
    assert.equal(image.getAttribute('src'), 'data:image/png;base64,UE5H');
  } finally {
    ui.close();
  }
});

test('late content for an older version cannot replace the current detail body', async () => {
  const first = post({ id: 'post-versioned', path: 'posts/versioned/post.json', sha256: 'a'.repeat(64), title: '版本一' });
  const second = post({ id: 'post-versioned', path: 'posts/versioned/post.json', sha256: 'd'.repeat(64), title: '版本二' });
  let list = [first];
  let reads = 0;
  let resolveFirst = null;
  const ui = mountUi({
    viewState: normalizeViewState({ page: 'explore', pages: { explore: { filter: 'all', query: '', scroll: 0 } } }),
    onLoadDiscoveries: async () => discoveries(list, false),
    onLoadDiscoveryContent: async () => {
      reads += 1;
      if (reads === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return contentFor(second, '# 版本二\n\n新版本正文。');
    },
  });
  try {
    await settle();
    ui.shadow.querySelector('#discoveryList .rm-post-open').click();
    await settle();
    assert.equal(reads, 1);
    ui.click('#postBack');
    await settle();
    list = [second];
    ui.click('#exploreRefresh');
    await settle();
    await settle();
    const current = ui.shadow.querySelectorAll('#discoveryList .rm-post')[0];
    assert.ok(current);
    current.querySelector('.rm-post-open').click();
    await settle();
    await settle();
    assert.match(ui.shadow.querySelector('#postDetail').textContent, /版本二/);
    resolveFirst(contentFor(first, '# 版本一\n\n旧版本正文。'));
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-post').hidden, false, 'a late old result must not navigate');
    const detail = ui.shadow.querySelector('#postDetail');
    assert.match(detail.textContent, /新版本正文/);
    assert.doesNotMatch(detail.textContent, /旧版本正文/);
  } finally {
    ui.close();
  }
});

test('a late detail read does not pull the reader back from another page', async () => {
  const item = post({ id: 'post-late', path: 'posts/late/post.json', title: '迟到的详情' });
  let resolveRead = null;
  const ui = mountUi({
    viewState: normalizeViewState({ page: 'explore', pages: { explore: { filter: 'all', query: '', scroll: 0 } } }),
    onLoadDiscoveries: async () => discoveries([item], false),
    onLoadDiscoveryContent: async () => new Promise((resolve) => { resolveRead = resolve; }),
  });
  try {
    await settle();
    ui.shadow.querySelector('#discoveryList .rm-post-open').click();
    await settle();
    ui.click('button[data-nav="home"]');
    await settle();
    assert.equal(ui.shadow.querySelector('#page-home').hidden, false);
    assert.equal(ui.shadow.querySelector('#page-post').hidden, true);
    resolveRead(contentFor(item, '# 迟到正文'));
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-home').hidden, false, 'the reader stays on the page they chose');
    assert.equal(ui.shadow.querySelector('#page-post').hidden, true);
  } finally {
    ui.close();
  }
});

test('a profile posts detail survives remount and returns to the same tab, scroll and card', async () => {
  const entry = {
    id: 'profile-standalone', peerId: PEER_A, publisherName: '澄野', publisherAgentName: 'Nova',
    path: 'posts/tide.md', name: 'tide.md', sha256: 'e'.repeat(64), sizeBytes: 44,
    modifiedAt: Date.parse('2026-11-22T07:25:00Z'), fetchedAt: 0, source: 'peer-manifest', sources: ['peer-manifest'],
    kind: 'markdown', mime: 'text/markdown', previewable: true, title: '潮汐笔记', summary: '远端独立文件',
    tags: [], publishedAt: '', authorKind: 'unknown', authorName: '',
    contentState: 'not-downloaded', contentError: '本机尚未下载这个文件；打开动态后可手动获取。',
  };
  const options = {
    onLoadContacts: async () => ({
      friends: [{ peerId: PEER_A, name: '澄野', description: '', connection: 'connected', paused: false }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
    }),
    onLoadPeerProfile: async () => ({
      peerId: PEER_A, localName: '澄野', remoteName: '澄野', found: true,
      text: '# 澄野', files: ['posts/tide.md'], at: Date.now(), error: null, freshness: 'live',
      agentCard: { state: 'missing', card: null, error: '' },
      manifest: { peerId: PEER_A, publisherName: '澄野', source: 'remote', at: Date.now(), error: null, entries: [entry], truncated: false },
      node: null,
    }),
    onLoadPeerDiscoveries: async () => ({ peerId: PEER_A, items: [], at: Date.now(), error: null, freshness: 'live', truncated: false }),
    onLoadPeerFileContent: async () => { throw new Error('an explicit fetch must not start on restore'); },
  };
  let ui = mountUi(options);
  let viewState;
  try {
    await settle();
    ui.app.setContacts(await options.onLoadContacts());
    ui.click('button[data-nav="contacts"]');
    await settle();
    ui.click('#contactList button[data-contact-peer]');
    await settle();
    ui.click('[data-profile-tab="posts"]');
    await settle();
    const profileView = ui.shadow.querySelector('#profileView');
    profileView.scrollTop = 77;
    const card = ui.shadow.querySelector('#profilePostList .rm-post');
    assert.ok(card);
    card.querySelector('.rm-post-open').click();
    await settle();
    await settle();
    await wait();
    assert.equal(ui.shadow.querySelector('#page-post').hidden, false);
    viewState = ui.viewState;
    assert.match(ui.shadow.querySelector('#postDetail .rm-post-meta').textContent, /^更新于 /);
    assert.match(ui.shadow.querySelector('#postDetail .rm-source-details').textContent, /作者未注明/);
    assert.equal(viewState.post.source, 'peer');
    assert.equal(viewState.post.profileScroll, 77);
    ui.app.destroy();
    ui.dom.window.close();

    ui = mountUi({ ...options, viewState });
    try {
      await settle();
      ui.app.setContacts(await options.onLoadContacts());
      await settle();
      await wait();
      assert.equal(ui.shadow.querySelector('#page-post').hidden, false, 'the peer detail route is restored');
      assert.equal(ui.shadow.querySelector('#profileView').hidden, true, 'restoring the detail never shows the profile overlay');
      assert.deepEqual([...new Set([...ui.shadow.querySelectorAll('nav.rm-nav button[aria-current="page"]')].map((node) => node.dataset.nav))], ['contacts']);
      assert.match(ui.shadow.querySelector('#postDetail').textContent, /posts\/tide\.md/);
      ui.click('#postBack');
      await settle();
      await wait();
      assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
      assert.equal(ui.shadow.querySelector('#contactProfilePosts').hidden, false);
      assert.equal(ui.shadow.querySelector('[data-profile-tab="posts"]').getAttribute('aria-current'), 'page');
      assert.equal(ui.shadow.querySelector('#profileView').scrollTop, 77);
      assert.equal(ui.shadow.activeElement?.dataset?.focusKey, `profile-post:${entry.path}:${entry.sha256}:open`);
    } finally {
      ui.close();
    }
  } catch (error) {
    if (ui && !ui.dom.window.closed) ui.close();
    throw error;
  }
});
