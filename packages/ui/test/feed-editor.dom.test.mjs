// Second-batch item 5: the Feed's search/refresh/publish toolbar and its
// independent post editor dialog. These assertions cover the real keyboard
// close path, focus and list-scroll return, draft retention, publish
// confirmation and the blank "write another" form. The host bridge is mocked;
// the DSH acceptance script covers the same paths against real nodes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER = '12D3KooWFeedEditorPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function post(overrides = {}) {
  return {
    id: 'post-map', peerId: PEER, publisherName: '澄野', path: 'posts/map/post.json',
    name: 'post.json', sha256: 'a'.repeat(64), sizeBytes: 640, modifiedAt: 0,
    fetchedAt: Date.parse('2026-11-18T09:00:00Z'), source: 'raminga_content_get',
    sources: ['raminga_content_get'], kind: 'markdown', mime: 'text/markdown', previewable: true,
    title: '雨停后的地图', summary: '一张手绘地图和雨后的街道。', tags: ['地图', '散步'],
    publishedAt: '2026-11-17T08:30:00Z', authorKind: 'user', authorName: '澄野',
    contentState: 'available', contentError: '', images: [],
    ...overrides,
  };
}

function discoveries(items, familiar = false) {
  return {
    items, at: Date.now(), error: null, errorAt: null, freshness: 'live', familiar,
    scanned: items.length, truncated: false, relationComplete: true, ignored: 0,
  };
}

function mine(files) {
  return {
    peerId: 'local-peer-id', at: Date.now(), error: null, errorAt: null, freshness: 'live',
    profile: { state: 'available', markdown: '# Alice', displayName: 'Alice', error: '', path: 'profile/index.md', at: 1 },
    posts: { state: 'available', posts: [], error: '', unattributed: 0, agentAuthored: 0, invalid: 0, errors: [], truncated: false },
    agentCard: { state: 'available', card: { displayName: 'Nova' }, error: '' },
    publicProfile: { state: 'missing', profile: null, error: '' },
    files, filesTruncated: false,
  };
}

function ownFile(overrides = {}) {
  return {
    id: 'own-one', peerId: 'local-peer-id', publisherName: 'Alice', path: 'posts/own-one/post.json',
    name: 'post.json', sha256: '1'.repeat(64), sizeBytes: 500, modifiedAt: 0, fetchedAt: 0,
    source: 'local-public', sources: ['local-public'], kind: 'markdown', mime: 'text/markdown',
    previewable: true, title: '自己的动态', summary: '摘要', tags: [], publishedAt: '2026-11-16T10:00:00Z',
    authorKind: 'user', authorName: 'Alice', contentState: 'available', contentError: '', images: [],
    ...overrides,
  };
}

function draft(overrides = {}) {
  return {
    draftId: 'draft-one', kind: 'post', revision: 1, authorKind: 'user',
    agentName: '', agentDescription: '', agentInterests: [], agentConversationStyle: '',
    humanName: '', humanBioMarkdown: '', avatar: null,
    title: '原有草稿', bodyMarkdown: '原有正文', tags: [], images: [],
    publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(),
    ...overrides,
  };
}

function mountUi(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const host = dom.window.document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = template;
  for (const dialog of shadow.querySelectorAll('dialog')) {
    if (typeof dialog.showModal === 'function' && typeof dialog.close === 'function') {
      // jsdom 31 implements open flags but not modal positioning; the real
      // close/cancel events still dispatch, which is what focus assertions use.
      if (!dialog.showModal) dialog.showModal = function showModal() { this.open = true; };
      if (!dialog.close) dialog.close = function close() { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
      continue;
    }
    dialog.showModal = function showModal() { this.open = true; };
    dialog.close = function close() { if (!this.open) return; this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
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
    dom, shadow, app, viewState,
    q: (selector) => shadow.querySelector(selector),
    click(selector) { const node = typeof selector === 'string' ? shadow.querySelector(selector) : selector; assert.ok(node, `missing ${selector}`); node.click(); return node; },
    text(selector) { return shadow.querySelector(selector)?.textContent ?? ''; },
    activeKey() {
      const node = shadow.activeElement;
      return node?.dataset?.focusKey || node?.id || node?.tagName || '';
    },
    close() { app.destroy(); dom.window.close(); },
  };
}

async function waitUntil(predicate, label, timeout = 1500) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch (error) {
      last = error;
    }
    await wait(10);
  }
  assert.fail(`${label}${last ? `: ${last}` : ''}`);
}

function installFileSupport(dom) {
  const original = {
    create: globalThis.URL.createObjectURL,
    revoke: globalThis.URL.revokeObjectURL,
    image: globalThis.Image,
    fileReader: globalThis.FileReader,
  };
  const urls = new Map();
  let seq = 0;
  globalThis.URL.createObjectURL = (file) => {
    const url = `blob:raminga-test-${++seq}`;
    urls.set(url, file);
    return url;
  };
  globalThis.URL.revokeObjectURL = (url) => { urls.delete(url); };
  globalThis.Image = class FakeImage {
    set src(value) {
      const file = urls.get(value);
      setTimeout(() => {
        if (String(file?.name ?? '').includes('broken')) {
          this.onerror?.(new dom.window.Event('error'));
          return;
        }
        this.naturalWidth = 2;
        this.naturalHeight = 2;
        this.onload?.(new dom.window.Event('load'));
      }, 0);
    }
  };
  globalThis.FileReader = dom.window.FileReader;
  return {
    urls,
    validFile(name = 'valid.png') {
      return new dom.window.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, { type: 'image/png' });
    },
    brokenFile(name = 'broken.png') {
      return new dom.window.File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
    },
    setInput(input, file) {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    restore() {
      if (original.create) globalThis.URL.createObjectURL = original.create;
      else delete globalThis.URL.createObjectURL;
      if (original.revoke) globalThis.URL.revokeObjectURL = original.revoke;
      else delete globalThis.URL.revokeObjectURL;
      if (original.image) globalThis.Image = original.image;
      else delete globalThis.Image;
      if (original.fileReader) globalThis.FileReader = original.fileReader;
      else delete globalThis.FileReader;
    },
  };
}

function draftStore() {
  const assets = new Map();
  const drafts = new Map();
  const saves = [];
  const publishes = [];
  let seq = 0;
  const makeAsset = () => {
    const assetId = `asset-${++seq}`;
    const image = { assetId, sha256: 'a'.repeat(64), mime: 'image/png', width: 2, height: 2, sizeBytes: 8 };
    assets.set(assetId, image);
    return image;
  };
  return {
    saves,
    publishes,
    get draft() { return drafts.get('draft'); },
    save: async (input) => {
      saves.push({ ...input });
      const base = input.draftId ? drafts.get(input.draftId) ?? null : null;
      const draftId = input.draftId || `draft-new-${++seq}`;
      const created = draft({
        ...(base || {}),
        ...input,
        draftId,
        revision: (base?.revision ?? 0) + 1,
        images: (input.imageAssetIds || []).map((id) => assets.get(id)).filter(Boolean),
        publishedPath: base?.publishedPath || '',
      });
      drafts.set(draftId, created);
      drafts.set('draft', created);
      return { draft: created };
    },
    put: async () => ({ image: makeAsset() }),
    publish: async (draftId, revision, sha) => {
      const current = drafts.get(draftId);
      publishes.push({ draftId, revision, sha, title: current?.title, images: current?.images?.length ?? 0 });
      const postPath = `posts/${draftId.replace(/^draft-/, 'post-')}/post.json`;
      if (current) drafts.set(draftId, { ...current, publishedPath: postPath, publishedRevision: revision });
      return publisher({ currentRevision: revision, postPath });
    },
  };
}

function publisher(overrides = {}) {
  return {
    status: 'published', error: '', currentRevision: 2, currentPublishedSha256: 'e'.repeat(64),
    files: [], manifestVersion: 1, manifestGeneratedAtUnixMs: Date.now(),
    postPath: 'posts/own-one/post.json', profilePath: '', warnings: [], manifestSha256: 'f'.repeat(64),
    ...overrides,
  };
}

test('search, refresh and write share one toolbar and the search stays visible with a real clear control', async () => {
  const reads = [];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'familiar', query: '地图', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => { reads.push(familiar); return discoveries([post()], familiar); },
    onLoadDiscoveryContent: async () => ({ ok: true, post: { ...post(), bodyMarkdown: '正文' }, error: null }),
  });
  try {
    await settle();
    const tools = ui.q('.rm-explore-tools');
    assert.equal(tools.contains(ui.q('#exploreSearch')), true, 'search is inside the action group');
    assert.equal(tools.contains(ui.q('#exploreRefresh')), true, 'refresh is inside the action group');
    assert.equal(tools.contains(ui.q('#composePost')), true, 'write is inside the action group');
    assert.equal(ui.q('#exploreSearch').hidden, false, 'search is visible even when old view state said closed');
    assert.equal(ui.q('#exploreQuery').value, '地图');
    assert.equal(ui.q('#exploreClear').hidden, false, 'a query exposes the clear button');
    assert.equal(ui.viewState.pages.explore.filter, 'familiar');
    assert.equal(reads.length, 1);

    ui.click('#exploreClear');
    assert.equal(ui.q('#exploreQuery').value, '');
    assert.equal(ui.q('#exploreClear').hidden, true);
    assert.equal(ui.viewState.pages.explore.filter, 'familiar', 'clearing search keeps the real filter');
    assert.equal(ui.activeKey(), 'exploreQuery', 'clear returns focus to the field');

    ui.q('#exploreQuery').value = '雨';
    ui.q('#exploreQuery').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    await settle();
    assert.equal(ui.q('#exploreClear').hidden, false);
    ui.q('#exploreQuery').dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(ui.q('#exploreQuery').value, '', 'Escape clears without closing the page');
    assert.equal(ui.q('#exploreClear').hidden, true);

    ui.click('#exploreRefresh');
    await settle();
    assert.ok(reads.length >= 2, 'refresh still re-reads the current filter');
    const css = fs.readFileSync(path.resolve(here, '..', 'src', 'styles', 'workspace.css'), 'utf8');
    assert.match(css, /::-webkit-search-cancel-button[\s\S]*?display: none/,
      'the native search clear control is hidden, leaving the accessible custom one');
  } finally {
    ui.close();
  }
});

test('the editor is a modal dialog; Escape restores focus, query, filter and Feed scroll', async () => {
  const reads = [];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'familiar', query: '地图', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => { reads.push(familiar); return discoveries([post()], familiar); },
    onLoadDiscoveryContent: async () => ({ ok: true, post: { ...post(), bodyMarkdown: '正文' }, error: null }),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async () => ({ draft: draft() }),
    onPublishPublicDraft: async () => publisher(),
  });
  try {
    await settle();
    const page = ui.q('#page-explore');
    page.scrollTop = 210;
    ui.q('#composePost').focus();
    ui.click('#composePost');
    await settle();
    assert.equal(ui.q('#postEditorPanel').open, true);
    assert.equal(ui.q('#postEditorPanel').hidden, false);
    assert.equal(ui.activeKey(), 'postTitleInput', 'the editor starts at the title');
    assert.equal(ui.q('#exploreQuery').value, '地图');

    const cancel = new ui.dom.window.Event('cancel', { cancelable: true });
    ui.q('#postEditorPanel').dispatchEvent(cancel);
    await settle();
    assert.equal(cancel.defaultPrevented, true);
    assert.equal(ui.q('#postEditorPanel').open, false);
    assert.equal(ui.q('#postEditorPanel').hidden, true);
    assert.equal(ui.activeKey(), 'composePost', 'closing returns to the trigger');
    assert.equal(ui.q('#exploreQuery').value, '地图');
    assert.equal(ui.viewState.pages.explore.filter, 'familiar');
    assert.equal(page.scrollTop, 210, 'the list anchor is restored');
    assert.equal(reads.length, 1, 'opening and closing the editor does not re-read the Feed');
  } finally {
    ui.close();
  }
});

test('unsaved new-post input survives close, page switch and reopen until an explicit new-post action', async () => {
  const ui = mountUi({
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => ({ draft: draft({ ...input, draftId: 'draft-new' }) }),
    onPublishPublicDraft: async () => publisher(),
  });
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    ui.q('#postTitleInput').value = '尚未保存的新标题';
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.q('#postBodyInput').value = '尚未保存的新正文';
    ui.q('#postBodyInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.click('#postEditorClose');
    await settle();
    assert.equal(ui.q('#postEditorPanel').open, false);
    assert.equal(ui.activeKey(), 'composePost');

    ui.click('#composePost');
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '尚未保存的新标题');
    assert.equal(ui.q('#postBodyInput').value, '尚未保存的新正文');
    assert.match(ui.text('#postEditorNote'), /尚未保存|已保留/);

    ui.q('#postEditorPanel').dispatchEvent(new ui.dom.window.Event('cancel', { cancelable: true }));
    await settle();
    ui.click('button[data-nav="contacts"]');
    await settle();
    assert.equal(ui.q('#postEditorPanel').open, false);
    ui.click('button[data-nav="explore"]');
    await settle();
    ui.click('#composePost');
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '尚未保存的新标题', 'switching pages retains the draft text');
    assert.equal(ui.q('#postBodyInput').value, '尚未保存的新正文');
  } finally {
    ui.close();
  }
});

test('a second draft switch cannot silently overwrite an earlier incomplete-post stash', async () => {
  const existing = draft({ draftId: 'draft-existing', title: '已有草稿', bodyMarkdown: '已有正文' });
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async () => ({ found: true, draft: existing }),
    onLoadPublicDrafts: async () => ({ drafts: [existing], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => ({ draft: draft({ ...existing, ...input, revision: existing.revision + 1 }) }),
    onPublishPublicDraft: async () => publisher(),
  });
  const setTitle = (value) => {
    ui.q('#postTitleInput').value = value;
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  };
  const chooseDraft = (value) => {
    ui.q('#postDraftSelect').value = value;
    ui.q('#postDraftSelect').dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  };
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    await waitUntil(() => ui.q('#postDraftSelect').options.length >= 2, 'draft menu');

    setTitle('第一份尚未填写正文');
    chooseDraft('draft-existing');
    await waitUntil(() => ui.q('#postTitleInput').value === '已有草稿', 'first draft switch');
    const restore = ui.q('#postRestoreStash');
    assert.equal(restore.hidden, false);
    assert.match(restore.textContent, /第一份尚未填写正文/);

    chooseDraft('');
    await waitUntil(() => ui.q('#postTitleInput').value === '', 'new blank form');
    setTitle('第二份尚未填写正文');
    chooseDraft('draft-existing');
    await settle();

    assert.equal(ui.q('#postDraftSelect').value, '', 'the selector returns to the draft still being edited');
    assert.equal(ui.q('#postTitleInput').value, '第二份尚未填写正文', 'the current input is kept');
    assert.equal(ui.activeKey(), 'postDraftSelect', 'focus returns to the real selector');
    const note = ui.text('#postEditorNote');
    assert.match(note, /没有切换/);
    assert.match(note, /第一份尚未填写正文/);
    assert.equal(restore.hidden, false);
    assert.match(restore.textContent, /替换当前输入/);
    assert.equal(ui.q('#postDiscardStash').hidden, false);

    restore.click();
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '第一份尚未填写正文', 'the old item is explicitly restored');
    assert.match(ui.text('#postEditorNote'), /替换当前输入/);
    assert.equal(restore.hidden, true, 'the single recovery slot is now empty');
    assert.equal(ui.q('#postDiscardStash').hidden, true);
  } finally {
    ui.close();
  }
});

test('discarding the older stash is explicit and keeps the current input recoverable', async () => {
  const existing = draft({ draftId: 'draft-existing', title: '已有草稿', bodyMarkdown: '已有正文' });
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async () => ({ found: true, draft: existing }),
    onLoadPublicDrafts: async () => ({ drafts: [existing], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => ({ draft: draft({ ...existing, ...input, revision: existing.revision + 1 }) }),
    onPublishPublicDraft: async () => publisher(),
  });
  const setTitle = (value) => {
    ui.q('#postTitleInput').value = value;
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  };
  const chooseDraft = (value) => {
    ui.q('#postDraftSelect').value = value;
    ui.q('#postDraftSelect').dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  };
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    await waitUntil(() => ui.q('#postDraftSelect').options.length >= 2, 'draft menu');

    setTitle('第一份尚未填写正文');
    chooseDraft('draft-existing');
    await waitUntil(() => ui.q('#postTitleInput').value === '已有草稿', 'first draft switch');
    chooseDraft('');
    await waitUntil(() => ui.q('#postTitleInput').value === '', 'new blank form');
    setTitle('第二份尚未填写正文');
    chooseDraft('draft-existing');
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '第二份尚未填写正文');
    assert.equal(ui.q('#postDiscardStash').hidden, false);

    ui.q('#postDiscardStash').click();
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '第二份尚未填写正文', 'discarding the old item leaves the current input alone');
    assert.match(ui.text('#postEditorNote'), /已丢弃/);
    assert.equal(ui.q('#postRestoreStash').hidden, true);
    assert.equal(ui.activeKey(), 'postDraftSelect');

    chooseDraft('draft-existing');
    await waitUntil(() => ui.q('#postTitleInput').value === '已有草稿', 'switch after discard');
    assert.match(ui.q('#postRestoreStash').textContent, /第二份尚未填写正文/);
    ui.q('#postRestoreStash').click();
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '第二份尚未填写正文', 'the second input still has its own recovery slot');
  } finally {
    ui.close();
  }
});

test('saving the complete current input releases the blocked switch without dropping the older stash', async () => {
  const existing = draft({ draftId: 'draft-existing', title: '已有草稿', bodyMarkdown: '已有正文' });
  let saved = null;
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async () => ({ found: true, draft: existing }),
    onLoadPublicDrafts: async () => ({ drafts: [existing, ...(saved ? [saved] : [])], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => {
      saved = draft({ ...input, draftId: 'draft-saved', revision: 1 });
      return { draft: saved };
    },
    onPublishPublicDraft: async () => publisher(),
  });
  const setTitle = (value) => {
    ui.q('#postTitleInput').value = value;
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  };
  const chooseDraft = (value) => {
    ui.q('#postDraftSelect').value = value;
    ui.q('#postDraftSelect').dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  };
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    await waitUntil(() => ui.q('#postDraftSelect').options.length >= 2, 'draft menu');
    setTitle('第一份尚未填写正文');
    chooseDraft('draft-existing');
    await waitUntil(() => ui.q('#postTitleInput').value === '已有草稿', 'first draft switch');
    chooseDraft('');
    await waitUntil(() => ui.q('#postTitleInput').value === '', 'new blank form');
    setTitle('第二份完整动态');
    ui.q('#postBodyInput').value = '第二份完整正文';
    ui.q('#postBodyInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    chooseDraft('draft-existing');
    await settle();
    assert.match(ui.text('#postEditorNote'), /没有切换/);

    ui.click('#postDraftSave');
    await waitUntil(() => ui.q('#postDraftSelect').value === 'draft-saved', 'current input saved');
    assert.match(ui.text('#postEditorNote'), /草稿已保存/);
    assert.match(ui.q('#postRestoreStash').textContent, /恢复未保存的新动态/);
    assert.doesNotMatch(ui.q('#postRestoreStash').textContent, /替换当前输入/);

    chooseDraft('draft-existing');
    await waitUntil(() => ui.q('#postTitleInput').value === '已有草稿', 'switch after saving');
    assert.match(ui.q('#postRestoreStash').textContent, /第一份尚未填写正文/);
    ui.q('#postRestoreStash').click();
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '第一份尚未填写正文');
  } finally {
    ui.close();
  }
});

test('opening another post for edit cannot silently replace an older stash', async () => {
  const existing = draft({ draftId: 'draft-existing', title: '已有草稿', bodyMarkdown: '已有正文' });
  const imported = [];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'mine', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadMine: async () => mine([ownFile()]),
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async () => ({ found: true, draft: existing }),
    onLoadPublicDrafts: async () => ({ drafts: [existing], hasMore: false, nextBefore: '' }),
    onImportPublicPost: async (filePath) => {
      imported.push(filePath);
      return { draft: draft({ ...existing, publishedPath: filePath, publishedSha256: '1'.repeat(64), publishedRevision: 1 }) };
    },
    onSavePublicDraft: async (input) => ({ draft: draft({ ...existing, ...input, revision: existing.revision + 1 }) }),
    onPublishPublicDraft: async () => publisher(),
  });
  const setTitle = (value) => {
    ui.q('#postTitleInput').value = value;
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  };
  const chooseDraft = (value) => {
    ui.q('#postDraftSelect').value = value;
    ui.q('#postDraftSelect').dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  };
  try {
    await waitUntil(() => ui.shadow.querySelector('#mineFeedList .rm-post-edit'), 'mine edit action');
    ui.click('#composePost');
    await settle();
    await waitUntil(() => ui.q('#postDraftSelect').options.length >= 2, 'draft menu');
    setTitle('第一份尚未填写正文');
    chooseDraft('draft-existing');
    await waitUntil(() => ui.q('#postTitleInput').value === '已有草稿', 'draft switch');
    chooseDraft('');
    await waitUntil(() => ui.q('#postTitleInput').value === '', 'new blank form');
    setTitle('第二份尚未填写正文');

    ui.shadow.querySelector('#mineFeedList .rm-post-edit').click();
    await settle();
    assert.deepEqual(imported, [], 'the other post is not opened while an older stash would be overwritten');
    assert.equal(ui.q('#postTitleInput').value, '第二份尚未填写正文');
    assert.match(ui.text('#postEditorNote'), /没有打开其他动态/);
    assert.match(ui.q('#postRestoreStash').textContent, /替换当前输入/);
    assert.equal(ui.activeKey(), 'postDraftSelect');
  } finally {
    ui.close();
  }
});

test('a title-only new post with tags, identity and a pending image survives opening a published card for edit', async () => {
  const imported = [];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'mine', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadMine: async () => mine([ownFile()]),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onImportPublicPost: async (filePath) => {
      imported.push(filePath);
      return { draft: draft({ draftId: 'draft-imported', title: '自己的动态', bodyMarkdown: '原正文', publishedPath: filePath, publishedSha256: '1'.repeat(64), publishedRevision: 1 }) };
    },
    onSavePublicDraft: async (input) => ({ draft: draft({ ...input, draftId: 'draft-new' }) }),
    onPublishPublicDraft: async () => publisher(),
  });
  const fileSupport = installFileSupport(ui.dom);
  try {
    await waitUntil(() => ui.shadow.querySelector('#mineFeedList .rm-post-edit'), 'mine edit action');
    ui.click('#composePost');
    await settle();
    ui.q('#postTitleInput').value = '只有标题的未完成动态';
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.q('#postTagsInput').value = '待保留，标签';
    ui.q('#postTagsInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.q('#postAuthorKind').value = 'agent';
    ui.q('#postAuthorKind').dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    fileSupport.setInput(ui.q('#postImageInput'), fileSupport.validFile('pending-title.png'));
    await waitUntil(() => ui.shadow.querySelectorAll('#postImageList .rm-post-editor-image').length === 1, 'pending image card');
    assert.match(ui.text('#postImageList'), /待上传/);
    ui.click('#postEditorClose');
    await settle();

    const edit = ui.shadow.querySelector('#mineFeedList .rm-post-edit');
    assert.ok(edit);
    edit.click();
    await settle();
    await settle();
    assert.deepEqual(imported, ['posts/own-one/post.json'], 'the old post stays editable');
    assert.equal(ui.q('#postTitleInput').value, '自己的动态');
    ui.click('#postEditorClose');
    await settle();

    ui.click('#composePost');
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '只有标题的未完成动态', 'title-only input is restored');
    assert.equal(ui.q('#postTagsInput').value, '待保留，标签');
    assert.equal(ui.q('#postAuthorKind').value, 'agent');
    assert.equal(ui.shadow.querySelectorAll('#postImageList .rm-post-editor-image').length, 1, 'pending image is restored');
    assert.match(ui.text('#postEditorNote'), /恢复/);
    assert.equal(ui.q('#postImageInput').files[0].name, 'pending-title.png');
  } finally {
    fileSupport.restore();
    ui.close();
  }
});

test('opening another post is blocked while a selected image is still validating', async () => {
  const imported = [];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'mine', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadMine: async () => mine([ownFile()]),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onImportPublicPost: async (filePath) => {
      imported.push(filePath);
      return { draft: draft({ draftId: 'draft-imported', title: '自己的动态', bodyMarkdown: '原正文', publishedPath: filePath, publishedSha256: '1'.repeat(64), publishedRevision: 1 }) };
    },
    onSavePublicDraft: async (input) => ({ draft: draft({ ...input, draftId: 'draft-new' }) }),
    onPublishPublicDraft: async () => publisher(),
  });
  const files = installFileSupport(ui.dom);
  try {
    await waitUntil(() => ui.shadow.querySelector('#mineFeedList .rm-post-edit'), 'mine edit action');
    ui.click('#composePost');
    await settle();
    ui.q('#postTitleInput').value = '校验中的图片';
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    files.setInput(ui.q('#postImageInput'), files.validFile('validating.png'));
    ui.shadow.querySelector('#mineFeedList .rm-post-edit').click();
    assert.match(ui.text('#postEditorNote'), /图片仍在校验/);
    await settle();
    assert.deepEqual(imported, [], 'the old post is not opened during validation');
    assert.equal(ui.q('#postTitleInput').value, '校验中的图片');
    await waitUntil(() => ui.shadow.querySelectorAll('#postImageList .rm-post-editor-image').length === 1, 'validated image');
    assert.deepEqual(imported, []);
    assert.equal(ui.q('#postTitleInput').value, '校验中的图片');

    ui.shadow.querySelector('#mineFeedList .rm-post-edit').click();
    await waitUntil(() => imported.length === 1, 'old post opened after validation');
    await waitUntil(() => ui.q('#postTitleInput').value === '自己的动态', 'imported title');
    ui.click('#postEditorClose');
    await settle();
    ui.click('#composePost');
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '校验中的图片');
    assert.equal(ui.shadow.querySelectorAll('#postImageList .rm-post-editor-image').length, 1);
  } finally {
    files.restore();
    ui.close();
  }
});

test('a failed import keeps the incomplete new post editable instead of clearing it', async () => {
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'mine', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadMine: async () => mine([ownFile()]),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onImportPublicPost: async () => { throw new Error('import failed for test'); },
    onSavePublicDraft: async (input) => ({ draft: draft({ ...input, draftId: 'draft-new' }) }),
    onPublishPublicDraft: async () => publisher(),
  });
  try {
    await waitUntil(() => ui.shadow.querySelector('#mineFeedList .rm-post-edit'), 'mine edit action');
    ui.click('#composePost');
    await settle();
    ui.q('#postTitleInput').value = '导入失败也保留';
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.q('#postTagsInput').value = '失败恢复';
    ui.q('#postTagsInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.shadow.querySelector('#mineFeedList .rm-post-edit').click();
    await waitUntil(() => /import failed for test/.test(ui.text('#postEditorNote')), 'import failure note');
    assert.equal(ui.q('#postTitleInput').value, '导入失败也保留');
    assert.equal(ui.q('#postTagsInput').value, '失败恢复');
    assert.equal(ui.q('#postEditorPanel').open, true);
    assert.equal(ui.text('#postEditorStatus'), '新草稿');
  } finally {
    ui.close();
  }
});

test('publish requires confirmation, cancel keeps the draft and success offers a truly blank new post', async () => {
  let draftState = null;
  const saves = [];
  const publishes = [];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: draftState ? [draftState] : [], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => {
      saves.push(input);
      draftState = draft({ ...(draftState || {}), ...input, draftId: draftState?.draftId || 'draft-new', revision: (draftState?.revision ?? 0) + 1 });
      return { draft: draftState };
    },
    onPublishPublicDraft: async (draftId, revision, sha) => {
      publishes.push({ draftId, revision, sha });
      draftState = { ...draftState, publishedPath: 'posts/post-new/post.json', publishedRevision: revision };
      return publisher({ currentRevision: revision, postPath: 'posts/post-new/post.json' });
    },
  });
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    ui.q('#postTitleInput').value = '发布前标题';
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.q('#postBodyInput').value = '发布前正文';
    ui.q('#postBodyInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));

    // A double click before confirmation must not publish twice. The first
    // save is in flight, so the second save/publish is ignored.
    ui.click('#postPublishButton');
    ui.click('#postPublishButton');
    await settle();
    await settle();
    assert.equal(publishes.length, 0, 'the first action only checks the content');
    assert.match(ui.text('#postPublishReceipt'), /确认后才会公开/);
    assert.equal(ui.q('#postPublishButton').textContent, '确认发布这条动态');
    assert.equal(ui.activeKey(), 'postPublishButton');
    assert.equal(ui.q('#postTitleInput').value, '发布前标题');

    ui.click('#postPublishCancel');
    await settle();
    assert.equal(ui.q('#postPublishReceipt').hidden, true);
    assert.equal(ui.q('#postPublishButton').textContent, '检查发布内容');
    assert.equal(ui.activeKey(), 'postPublishButton', 'cancel keeps keyboard focus on the publish action');
    assert.equal(ui.q('#postTitleInput').value, '发布前标题');

    ui.click('#postPublishButton');
    await settle();
    ui.click('#postPublishButton');
    ui.click('#postPublishButton');
    await settle();
    await settle();
    assert.equal(publishes.length, 1, 'a confirmed double click still sends one publish request');
    assert.match(ui.text('#postPublishReceipt'), /发布完成/);
    assert.equal(ui.q('#postWriteAnother').hidden, false);

    ui.click('#postWriteAnother');
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '');
    assert.equal(ui.q('#postBodyInput').value, '');
    assert.equal(ui.q('#postTagsInput').value, '');
    assert.equal(ui.q('#postDraftSelect').value, '');
    assert.equal(ui.text('#postEditorStatus'), '新草稿');
    assert.equal(ui.text('#postEditorHeading'), '写一条公开动态');
    assert.equal(ui.q('#postPublishReceipt').hidden, true);
    assert.equal(ui.q('#postWriteAnother').hidden, true);
    assert.equal(ui.activeKey(), 'postTitleInput');

    ui.click('#postEditorClose');
    await settle();
    ui.click('#composePost');
    await settle();
    assert.equal(ui.q('#postTitleInput').value, '', 'closing after publish and writing again is still blank');
    assert.equal(ui.q('#postBodyInput').value, '');
    assert.equal(ui.q('#postDraftSelect').value, '');
    assert.equal(publishes.length, 1);
  } finally {
    ui.close();
  }
});

test('a valid image added after checking revokes the old confirmation and the recheck publishes exactly one image', async () => {
  const store = draftStore();
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: store.save,
    onPutPublicDraftImage: store.put,
    onPublishPublicDraft: store.publish,
  });
  const files = installFileSupport(ui.dom);
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    ui.q('#postTitleInput').value = '检查后加图';
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.q('#postBodyInput').value = '确认只应对应检查时的完整草稿版本。';
    ui.q('#postBodyInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));

    ui.click('#postPublishButton');
    await waitUntil(() => /确认后才会公开/.test(ui.text('#postPublishReceipt')), 'first confirmation');
    assert.equal(ui.q('#postPublishReceipt').hidden, false, 'confirmation content is visible');
    assert.equal(ui.q('#postPublishButton').textContent, '确认发布这条动态');
    assert.equal(store.publishes.length, 0);

    files.setInput(ui.q('#postImageInput'), files.validFile('checked-later.png'));
    await waitUntil(() => ui.shadow.querySelectorAll('#postImageList .rm-post-editor-image').length === 1, 'visible pending image');
    await waitUntil(() => ui.q('#postPublishButton').textContent === '检查发布内容', 'confirmation revoked');
    assert.doesNotMatch(ui.text('#postPublishReceipt'), /确认后才会公开/);
    assert.equal(ui.q('#postPublishReceipt').hidden, false, 'the revocation notice stays visible');
    assert.equal(store.publishes.length, 0, 'adding an image must not publish');

    ui.click('#postPublishButton');
    await waitUntil(() => /确认后才会公开/.test(ui.text('#postPublishReceipt')), 'rechecked confirmation');
    assert.equal(ui.q('#postPublishReceipt').hidden, false, 'rechecked confirmation is visible');
    assert.match(ui.text('#postPublishReceipt'), /1 张图片/);

    // A corrupt image after checking is readable and leaves the checked text
    // alone, but it still cannot leave the old confirmation armed.
    files.setInput(ui.q('#postImageInput'), files.brokenFile());
    await waitUntil(() => /无法解码/.test(ui.text('#postEditorNote')), 'corrupt image error');
    assert.equal(ui.q('#postTitleInput').value, '检查后加图');
    assert.equal(ui.q('#postBodyInput').value, '确认只应对应检查时的完整草稿版本。');
    assert.equal(ui.q('#postPublishButton').textContent, '检查发布内容');
    assert.doesNotMatch(ui.text('#postPublishReceipt'), /确认后才会公开/);

    ui.click('#postPublishButton');
    await waitUntil(() => /确认后才会公开/.test(ui.text('#postPublishReceipt')), 'final confirmation');
    assert.match(ui.text('#postPublishReceipt'), /1 张图片/);
    ui.q('#postPublishButton').click();
    ui.q('#postPublishButton').click();
    await waitUntil(() => store.publishes.length === 1, 'exactly one publish');
    assert.equal(store.publishes[0].title, '检查后加图');
    assert.equal(store.publishes[0].images, 1, 'the published draft has the checked image');
  } finally {
    files.restore();
    ui.close();
  }
});

test('a real publish failure keeps the editable draft and the retry publishes once', async () => {
  let attempts = 0;
  let draftState = null;
  const ui = mountUi({
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: draftState ? [draftState] : [], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => {
      draftState = draft({ ...(draftState || {}), ...input, draftId: 'draft-retry', revision: (draftState?.revision ?? 0) + 1 });
      return { draft: draftState };
    },
    onPublishPublicDraft: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('daemon: publication lock unavailable');
      return publisher({ postPath: 'posts/post-retry/post.json' });
    },
  });
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    ui.q('#postTitleInput').value = '失败也保留';
    ui.q('#postBodyInput').value = '这次真实写入失败，内容仍可修改。';
    ui.click('#postPublishButton');
    await settle();
    await settle();
    ui.click('#postPublishButton');
    await settle();
    await settle();
    assert.equal(attempts, 1);
    assert.match(ui.text('#postEditorNote'), /publication lock unavailable/);
    assert.equal(ui.q('#postTitleInput').value, '失败也保留');
    assert.equal(ui.q('#postBodyInput').value, '这次真实写入失败，内容仍可修改。');
    assert.equal(ui.q('#postPublishButton').textContent, '检查发布内容');

    ui.q('#postBodyInput').value = '失败后修改并重试。';
    ui.click('#postPublishButton');
    await settle();
    await settle();
    ui.click('#postPublishButton');
    await settle();
    await settle();
    assert.equal(attempts, 2);
    assert.match(ui.text('#postPublishReceipt'), /发布完成/);
    assert.equal(ui.q('#postBodyInput').value, '失败后修改并重试。');
  } finally {
    ui.close();
  }
});

test('switching drafts clears an armed confirmation and the next publish uses the selected draft', async () => {
  const draftsByName = {
    'draft-a': draft({ draftId: 'draft-a', revision: 1, title: '草稿 A', bodyMarkdown: 'A 正文' }),
    'draft-b': draft({ draftId: 'draft-b', revision: 1, title: '草稿 B', bodyMarkdown: 'B 正文' }),
  };
  const publishes = [];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async (id) => ({ found: true, draft: draftsByName[id] }),
    onLoadPublicDrafts: async () => ({ drafts: Object.values(draftsByName), hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => ({ draft: draft({ ...input, draftId: input.draftId, revision: (draftsByName[input.draftId]?.revision ?? 0) + 1 }) }),
    onPublishPublicDraft: async (draftId, revision) => {
      publishes.push({ draftId, revision });
      return publisher({ currentRevision: revision, postPath: `posts/${draftId.replace(/^draft-/, 'post-')}/post.json` });
    },
  });
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    await waitUntil(() => ui.q('#postDraftSelect').options.length >= 3, 'draft list loaded');
    ui.q('#postDraftSelect').value = 'draft-a';
    ui.q('#postDraftSelect').dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    await waitUntil(() => ui.q('#postTitleInput').value === '草稿 A', 'draft A loaded');
    ui.click('#postPublishButton');
    await waitUntil(() => /确认后才会公开/.test(ui.text('#postPublishReceipt')), 'draft A confirmation');
    assert.match(ui.text('#postPublishReceipt'), /posts\/post-a\/post\.json/);

    ui.q('#postDraftSelect').value = 'draft-b';
    ui.q('#postDraftSelect').dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    await waitUntil(() => ui.q('#postTitleInput').value === '草稿 B', 'draft B loaded');
    assert.equal(ui.q('#postPublishButton').textContent, '检查发布内容', 'switching drafts revokes confirmation');
    assert.doesNotMatch(ui.text('#postPublishReceipt'), /确认后才会公开/);

    ui.click('#postPublishButton');
    await waitUntil(() => /确认后才会公开/.test(ui.text('#postPublishReceipt')), 'draft B confirmation');
    assert.match(ui.text('#postPublishReceipt'), /posts\/post-b\/post\.json/);
    ui.click('#postPublishButton');
    await waitUntil(() => publishes.length === 1, 'draft B published');
    assert.deepEqual(publishes[0], { draftId: 'draft-b', revision: 1 });
  } finally {
    ui.close();
  }
});

test('a late save receipt cannot overwrite newer input or arm confirmation, and controls block a draft switch', async () => {
  let resolveFirst = null;
  let firstStarted = false;
  let draftState = null;
  const saves = [];
  const publishes = [];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: draftState ? [draftState] : [], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => {
      saves.push({ ...input });
      if (!firstStarted) {
        firstStarted = true;
        return new Promise((resolve) => {
          resolveFirst = () => {
            draftState = draft({ ...(draftState || {}), ...input, draftId: 'draft-delayed', revision: 1 });
            resolve({ draft: draftState });
          };
        });
      }
      draftState = draft({ ...(draftState || {}), ...input, draftId: 'draft-delayed', revision: (draftState?.revision ?? 0) + 1 });
      return { draft: draftState };
    },
    onPublishPublicDraft: async (draftId, revision) => {
      publishes.push({ draftId, revision, title: draftState?.title });
      return publisher({ currentRevision: revision, postPath: 'posts/post-delayed/post.json' });
    },
  });
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    ui.q('#postTitleInput').value = '保存中的旧标题';
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.q('#postBodyInput').value = '保存中的旧正文';
    ui.q('#postBodyInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.click('#postPublishButton');
    await waitUntil(() => firstStarted, 'first save started');
    assert.equal(ui.q('#postDraftSelect').disabled, true, 'draft switch is controlled during save');
    assert.equal(ui.q('#postPublishButton').disabled, true);
    assert.equal(ui.q('#postImageInput').disabled, true);

    ui.q('#postTitleInput').value = '保存期间的新标题';
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.q('#postBodyInput').value = '保存期间的新正文';
    ui.q('#postBodyInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    resolveFirst();
    await waitUntil(() => !ui.q('#postDraftSelect').disabled, 'first save finished');
    assert.equal(ui.q('#postTitleInput').value, '保存期间的新标题', 'late response did not restore old text');
    assert.equal(ui.q('#postBodyInput').value, '保存期间的新正文');
    assert.equal(ui.q('#postPublishButton').textContent, '检查发布内容');
    assert.doesNotMatch(ui.text('#postPublishReceipt'), /确认后才会公开/);
    assert.match(ui.text('#postEditorNote'), /保存期间|尚未保存/);

    ui.click('#postPublishButton');
    await waitUntil(() => /确认后才会公开/.test(ui.text('#postPublishReceipt')), 'rechecked confirmation');
    assert.equal(saves.length, 2);
    assert.equal(saves[1].title, '保存期间的新标题');
    ui.click('#postPublishButton');
    await waitUntil(() => publishes.length === 1, 'newer version published');
    assert.equal(publishes[0].title, '保存期间的新标题');
  } finally {
    ui.close();
  }
});

test('removing an image is controlled while its upload/save is in flight and works after the response', async () => {
  const store = draftStore();
  let releaseUpload = null;
  let uploadStarted = false;
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => discoveries([post()], familiar),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: store.save,
    onPutPublicDraftImage: (draftId, role, filename, base64) => {
      uploadStarted = true;
      return new Promise((resolve) => {
        releaseUpload = () => resolve(store.put(draftId, role, filename, base64));
      });
    },
    onPublishPublicDraft: store.publish,
  });
  const files = installFileSupport(ui.dom);
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    ui.q('#postTitleInput').value = '上传中移除图片';
    ui.q('#postTitleInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.q('#postBodyInput').value = '上传期间移除操作应受控。';
    ui.q('#postBodyInput').dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    files.setInput(ui.q('#postImageInput'), files.validFile('uploading.png'));
    await waitUntil(() => ui.shadow.querySelectorAll('#postImageList .rm-post-editor-image').length === 1, 'image card');
    ui.click('#postDraftSave');
    await waitUntil(() => uploadStarted, 'upload started');
    const remove = ui.q('#postImageList .rm-post-editor-image .rm-quiet');
    assert.ok(remove);
    remove.click();
    assert.equal(ui.shadow.querySelectorAll('#postImageList .rm-post-editor-image').length, 1, 'removal is blocked during upload');
    assert.match(ui.text('#postEditorNote'), /完成后再移除图片/);
    releaseUpload();
    await waitUntil(() => !ui.q('#postDraftSave').disabled, 'save finished');
    assert.equal(ui.shadow.querySelectorAll('#postImageList .rm-post-editor-image').length, 1);
    ui.q('#postImageList .rm-post-editor-image .rm-quiet').click();
    assert.equal(ui.shadow.querySelectorAll('#postImageList .rm-post-editor-image').length, 0);
    assert.match(ui.text('#postEditorNote'), /移除图片/);
  } finally {
    files.restore();
    ui.close();
  }
});

test('editing a card imports that post, keeps identity and version, updates the original and avoids a duplicate publish', async () => {
  let published = false;
  const imported = [];
  const publishes = [];
  let files = [ownFile(), ownFile({ id: 'own-two', path: 'posts/own-two/post.json', title: '另一条', sha256: '2'.repeat(64) })];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'mine', query: '的', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadMine: async () => mine(files),
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onImportPublicPost: async (filePath) => {
      imported.push(filePath);
      return { draft: draft({ draftId: 'draft-import', title: '自己的动态', bodyMarkdown: '原正文', publishedPath: filePath, publishedSha256: '1'.repeat(64), publishedRevision: 1 }) };
    },
    onSavePublicDraft: async (input) => ({ draft: draft({ ...input, draftId: input.draftId || 'draft-import', publishedPath: 'posts/own-one/post.json' }) }),
    onPublishPublicDraft: async (draftId, revision) => {
      publishes.push({ draftId, revision });
      published = true;
      files = [ownFile({ title: '改过的标题', sha256: '9'.repeat(64) }), files[1]];
      return publisher({ currentRevision: revision, postPath: 'posts/own-one/post.json' });
    },
  });
  try {
    await settle();
    await settle();
    const before = ui.shadow.querySelectorAll('#mineFeedList .rm-post');
    assert.equal(before.length, 1, 'query narrows the mine Feed before editing');
    const edit = before[0].querySelector('.rm-post-edit');
    assert.ok(edit);
    edit.focus();
    edit.click();
    await settle();
    await settle();
    assert.deepEqual(imported, ['posts/own-one/post.json']);
    assert.equal(ui.q('#postEditorPanel').open, true);
    assert.equal(ui.text('#postEditorHeading'), '编辑公开动态');
    assert.equal(ui.q('#postTitleInput').value, '自己的动态');
    assert.equal(ui.q('#postAuthorKind').disabled, true, 'author identity is retained');
    assert.match(ui.text('#postAuthorNote'), /发布会更新原帖/);
    assert.equal(ui.activeKey(), 'postTitleInput');

    ui.q('#postTitleInput').value = '改过的标题';
    ui.q('#postBodyInput').value = '改过的正文';
    ui.click('#postPublishButton');
    await settle();
    await settle();
    assert.match(ui.text('#postPublishReceipt'), /确认后才会公开/);
    assert.match(ui.text('#postPublishReceipt'), /posts\/own-one\/post\.json/, 'edited posts confirm their real published path');
    assert.doesNotMatch(ui.text('#postPublishReceipt'), /posts\/post-draft-import/);
    ui.click('#postPublishButton');
    await settle();
    await settle();
    assert.equal(publishes.length, 1);
    assert.equal(publishes[0].draftId, 'draft-import');
    assert.equal(published, true);

    ui.click('#postEditorClose');
    await settle();
    await wait(40);
    assert.equal(ui.q('#postEditorPanel').open, false);
    assert.equal(ui.viewState.pages.explore.filter, 'mine');
    assert.equal(ui.q('#exploreQuery').value, '的');
    const after = ui.shadow.querySelectorAll('#mineFeedList .rm-post');
    assert.equal(after.length, 1, 'the edited card replaces the original instead of adding a duplicate');
    assert.match(after[0].textContent, /改过的标题/);
    assert.doesNotMatch(after[0].textContent, /自己的动态/);
    assert.match(ui.activeKey(), /mine-feed:posts\/own-one\/post\.json:9+.*:edit/, 'focus returns to the replaced card edit action');
  } finally {
    ui.close();
  }
});


test('Feed search totals are the real filtered matches and source details lead with identity then technical facts', async () => {
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '地图', searchOpen: true, scroll: 0, expanded: {}, sourceOpen: {} } } },
    onLoadDiscoveries: async (familiar) => discoveries([
      post({ modifiedAt: Date.parse('2026-11-18T09:30:00Z') }),
      post({
        id: 'post-other', path: 'posts/other/post.json', title: '别的动态',
        summary: '和搜索无关。', tags: [], publisherName: '另一位发布者',
      }),
    ], familiar),
    onLoadDiscoveryContent: async () => ({ ok: true, post: { ...post(), bodyMarkdown: '正文' }, error: null }),
  });
  try {
    await settle();
    const scope = ui.q('#discoveryScope');
    assert.equal(scope.hidden, false);
    assert.match(ui.text('#discoverySearchCount'), /匹配搜索的公开内容共 1 条/);
    assert.doesNotMatch(ui.text('#discoveryMeta'), /匹配搜索的公开内容/,
      'search count is secondary disclosure, not a first-screen diagnostic banner');
    assert.equal(ui.shadow.querySelectorAll('#discoveryList .rm-post').length, 1);

    const details = ui.q('#discoveryList .rm-source-details');
    details.querySelector('summary').click();
    await settle();
    const groups = [...details.querySelectorAll('.rm-source-group')];
    assert.deepEqual(groups.map((group) => group.dataset.section), ['lead', 'technical']);
    assert.match(groups[0].textContent, /发布节点公开名/);
    assert.match(groups[0].textContent, /原作者声明/);
    assert.match(groups[0].textContent, /发表时间/);
    assert.match(groups[0].textContent, /文件更新时间/);
    assert.match(groups[1].textContent, /发布节点 Peer ID/);
    assert.match(groups[1].textContent, /内容版本 SHA-256/);
    const labels = [...groups[0].querySelectorAll('dt'), ...groups[1].querySelectorAll('dt')].map((node) => node.textContent);
    assert.deepEqual(labels.slice(0, 4), ['发布节点公开名', '原作者声明', '发表时间', '文件更新时间']);
    assert.equal(groups[0].querySelectorAll('dt').length, 4, 'identity and both distinct times lead the disclosure');
  } finally {
    ui.close();
  }
});
