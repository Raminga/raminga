// Regression tests for the peer-profile back path.
//
// In Chromium the source page is display:none while a profile is open, so its
// real scrollTop reads 0. The profile is its own scroll container; scrolling it
// used to schedule a host-view save that captured that hidden 0 and replaced
// the reader's position. A pointer press can also move focus before the click
// handler runs. These tests model both effects and verify that the captured
// source position survives late scroll/focus events and a host remount.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';

const post = {
  id: '17',
  peerId: PEER,
  path: 'posts/a.json',
  sha256: 'a'.repeat(64),
  sizeBytes: 120,
  fetchedAt: Date.now(),
  source: 'raminga_content_get',
  authorKind: 'user',
  authorName: '阶段7对端用户',
  title: '阶段7长内容公开帖子',
  summary: '这是公开摘要。',
  tags: ['stage7'],
  publishedAt: '2026-11-14T10:00:00Z',
  contentState: 'available',
  contentError: '',
};

const discoveries = () => ({
  items: [post],
  at: Date.now(),
  error: null,
  errorAt: null,
  freshness: 'live',
  familiar: false,
  scanned: 1,
  truncated: false,
  relationComplete: true,
  ignored: 0,
});

function defaultViewState(overrides = {}) {
  return {
    page: 'explore',
    pages: {
      explore: {
        filter: 'all',
        query: '',
        searchOpen: false,
        scroll: 40,
        expanded: { 17: true },
        sourceOpen: {},
      },
    },
    profile: { peerId: '', returnPage: '', returnPeer: '', triggerId: '' },
    ...overrides,
  };
}

async function mountUi(viewState = defaultViewState()) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
  });
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
    viewState,
    onLoadDiscoveries: async () => discoveries(),
    onLoadDiscoveryContent: async (id) => ({
      ok: true,
      id,
      peerId: PEER,
      path: 'posts/a.json',
      sha256: 'a'.repeat(64),
      source: 'raminga_content_get',
      fetchedAt: Date.now(),
      post: { ...post, bodyMarkdown: '# 正文\n\n阶段7长内容。' },
      error: null,
    }),
    onLoadPeerProfile: async () => ({
      peerId: PEER,
      localName: '阶段7对端用户',
      remoteName: '阶段7对端用户',
      found: true,
      // Long enough that a real browser profile is its own scroller.
      text: '# 阶段7对端用户\n\n' + Array.from({ length: 30 }, (_, i) => `远端资料第 ${i} 段。`).join('\n\n'),
      files: ['profile/index.md'],
      at: Date.now(),
      error: null,
      freshness: 'live',
      agentCard: { state: 'missing', card: null, error: 'missing' },
    }),
  });
  app.onLeaseReady();
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { dom, shadow, app, viewState, host };
}

function modelHiddenScroll(page) {
  let stored = 0;
  Object.defineProperty(page, 'scrollTop', {
    configurable: true,
    get() { return this.hidden ? 0 : stored; },
    set(value) { stored = Number(value); },
  });
  return {
    get() { return stored; },
    set(value) { page.scrollTop = value; },
  };
}

function settle(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a profile scroll cannot replace the hidden source page position on back', async () => {
  const ui = await mountUi();
  try {
    const explore = ui.shadow.querySelector('#page-explore');
    const pageScroll = modelHiddenScroll(explore);
    pageScroll.set(40);
    await settle();

    ui.shadow.querySelector('#discoveryList [data-profile-peer]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.equal(ui.viewState.pages.explore.scroll, 40, 'entry snapshot is saved before the page is hidden');

    // Chromium fires a scroll event when the reader moves the profile itself.
    ui.shadow.querySelector('#profileView').dispatchEvent(new ui.dom.window.Event('scroll'));
    await settle(40);
    assert.equal(ui.viewState.pages.explore.scroll, 40, 'profile scrolling must not capture the hidden page 0');

    ui.shadow.querySelector('#profileBack').click();
    await settle();
    assert.equal(explore.scrollTop, 40, 'back restores the exact source position');
    assert.equal(ui.viewState.pages.explore.scroll, 40);
    assert.equal(ui.shadow.activeElement?.dataset?.profilePeer, PEER, 'focus still returns to the author trigger');
  } finally {
    ui.app.destroy();
    ui.dom.window.close();
  }
});

test('late hidden-page scroll events do not queue a zero save', async () => {
  const ui = await mountUi();
  try {
    const explore = ui.shadow.querySelector('#page-explore');
    const pageScroll = modelHiddenScroll(explore);
    pageScroll.set(64);
    await settle();

    ui.shadow.querySelector('#discoveryList [data-profile-peer]').click();
    await settle();
    explore.dispatchEvent(new ui.dom.window.Event('scroll'));
    await settle(40);
    assert.equal(ui.viewState.pages.explore.scroll, 64);

    ui.shadow.querySelector('#profileBack').click();
    await settle();
    assert.equal(explore.scrollTop, 64);
  } finally {
    ui.app.destroy();
    ui.dom.window.close();
  }
});

test('a focus-induced collapse before the click keeps the pre-focus position', async () => {
  const ui = await mountUi();
  try {
    const explore = ui.shadow.querySelector('#page-explore');
    const pageScroll = modelHiddenScroll(explore);
    pageScroll.set(40);
    await settle();
    const author = ui.shadow.querySelector('#discoveryList [data-profile-peer]');

    // Focus is applied as the default action of the pointer press, before the
    // click handler. Model a browser that scrolls the page to 0 in that gap.
    author.dispatchEvent(new ui.dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    pageScroll.set(0);
    author.click();
    await settle();
    assert.equal(ui.viewState.pages.explore.scroll, 40, 'the pointerdown snapshot wins over the collapsed 0');

    ui.shadow.querySelector('#profileBack').click();
    await settle();
    assert.equal(explore.scrollTop, 40);
  } finally {
    ui.app.destroy();
    ui.dom.window.close();
  }
});

test('a host remount with an open profile keeps the saved source position', async () => {
  const viewState = defaultViewState({
    profile: { peerId: PEER, returnPage: 'explore', returnPeer: '', triggerId: 'explore:17' },
  });
  const ui = await mountUi(viewState);
  try {
    const explore = ui.shadow.querySelector('#page-explore');
    assert.equal(explore.hidden, true, 'the persisted profile opens directly');
    const pageScroll = modelHiddenScroll(explore);
    pageScroll.set(40);

    ui.shadow.querySelector('#profileView').dispatchEvent(new ui.dom.window.Event('scroll'));
    await settle(40);
    assert.equal(viewState.pages.explore.scroll, 40);

    ui.shadow.querySelector('#profileBack').click();
    await settle();
    assert.equal(explore.hidden, false);
    assert.equal(explore.scrollTop, 40);
    assert.equal(viewState.pages.explore.scroll, 40);
  } finally {
    ui.app.destroy();
    ui.dom.window.close();
  }
});
