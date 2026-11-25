// SHARE-01/02: the real share dialog copy path, explicit stale read time,
// in-dialog retry, and the manual-copy fallback when the host refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWSharePeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function contacts() {
  return {
    friends: [{ peerId: PEER_A, name: 'Alice', description: '', connection: 'connected', paused: false }],
    at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
  };
}

function share(overrides = {}) {
  return {
    ok: true,
    peerId: PEER_A,
    at: Date.now() - 1_000,
    stale: false,
    error: null,
    addresses: [{ multiaddr: `/ip4/203.0.113.10/tcp/4001/p2p/${PEER_A}`, kind: 'direct', scope: 'public' }],
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
  const app = createRamingaApp(shadow, {
    viewState: { page: 'contacts', pages: { contacts: { query: '', filter: 'all', scroll: 0 } } },
    onLoadContacts: async () => contacts(),
    ...options,
  });
  app.onLeaseReady();
  return {
    dom, shadow, app,
    active: () => shadow.activeElement,
    click(selector) {
      const node = shadow.querySelector(selector);
      assert.ok(node, `missing ${selector}`);
      node.click();
      return node;
    },
    async open() {
      app.setContacts(contacts());
      await settle();
      this.click('#contactsShare');
      await settle();
      assert.equal(shadow.querySelector('#shareDialog').open, true);
    },
    close() { app.destroy(); dom.window.close(); },
  };
}

test('copy button builds the real share text and reports success', async () => {
  const copied = [];
  const ui = mountUi({
    onShare: async () => share(),
    onCopyText: async (value) => { copied.push(value); return true; },
  });
  try {
    await ui.open();
    ui.click('#shareCopy');
    await settle();
    assert.equal(ui.shadow.querySelector('#shareCopyStatus').textContent, '已复制。粘贴给对方即可。');
    assert.equal(ui.shadow.querySelector('#shareCopyStatus').dataset.tone, '');
    assert.equal(ui.shadow.querySelector('#shareManual').hidden, true);
    assert.equal(copied.length, 1);
    assert.match(copied[0], /^Raminga 节点/m);
    assert.match(copied[0], /Peer ID：12D3KooWSharePeer/);
    assert.match(copied[0], /可尝试连接的地址/);
    assert.match(copied[0], /203\.0\.113\.10/);
    assert.equal(ui.shadow.querySelector('#shareCopy').disabled, false);
  } finally {
    ui.close();
  }
});

test('copy with no advertised address still copies a useful Peer ID', async () => {
  const copied = [];
  const ui = mountUi({
    onShare: async () => share({ addresses: [] }),
    onCopyText: async (value) => { copied.push(value); return true; },
  });
  try {
    await ui.open();
    assert.match(ui.shadow.querySelector('#shareAddressNote').textContent, /没有可直接分享的地址/);
    ui.click('#shareCopy');
    await settle();
    assert.equal(copied.length, 1);
    assert.match(copied[0], /Peer ID：/);
    assert.match(copied[0], /当前没有可直接分享的地址/);
    assert.equal(ui.shadow.querySelector('#shareCopyStatus').textContent, '已复制。粘贴给对方即可。');
  } finally {
    ui.close();
  }
});

test('card options are visible, checked when available, and copy only the selected scope', async () => {
  const copied = [];
  const requested = [];
  const ui = mountUi({
    onContactCard: async (peer, scopes) => {
      requested.push([peer, scopes]);
      const available = peer ? 3 : 7;
      const selected = scopes & available;
      return {
        ok: true, peerId: PEER_A, shareCode: selected ? `card-${selected}` : PEER_A,
        availableAddressScopes: available, includedAddressScopes: selected, hasAddresses: selected !== 0,
      };
    },
    onCopyText: async (value) => { copied.push(value); return true; },
  });
  try {
    await ui.open();
    const dialog = ui.shadow.querySelector('#shareDialog');
    const publicAddress = ui.shadow.querySelector('#sharePublicAddress');
    const relayAddress = ui.shadow.querySelector('#shareRelayAddress');
    const lanAddress = ui.shadow.querySelector('#shareLanAddress');
    assert.equal(ui.shadow.querySelector('#shareAddressChoice').hidden, false);
    assert.ok([publicAddress, relayAddress, lanAddress].every((input) => input.checked && !input.disabled));
    const copyButtons = [...dialog.querySelectorAll('button')].filter((button) => button.textContent.trim().startsWith('复制'));
    assert.deepEqual(copyButtons.map((button) => button.textContent), ['复制名片']);
    assert.equal(ui.shadow.querySelector('#shareAddressHelpCard').hidden, true);
    ui.click('#shareAddressHelp');
    assert.match(ui.shadow.querySelector('#shareAddressHelpCard').textContent, /读取和转发/);
    assert.equal(ui.shadow.querySelector('#shareAddressHelp').getAttribute('aria-expanded'), 'true');
    ui.click('#shareAddressHelp');
    assert.equal(ui.shadow.querySelector('#shareAddressHelpCard').hidden, true);
    ui.click('#shareCopy');
    await settle();
    publicAddress.click();
    relayAddress.click();
    await settle();
    ui.click('#shareCopy');
    await settle();
    lanAddress.click();
    await settle();
    assert.match(ui.shadow.querySelector('#shareAddressSummary').textContent, /仅分享 ID/);
    ui.click('#shareCopy');
    await settle();
    dialog.close();
    ui.click('[data-contact-row] button[aria-haspopup="menu"]');
    const shareFriend = [...ui.shadow.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === '分享此联系人');
    assert.ok(shareFriend);
    shareFriend.click();
    await settle();
    assert.ok(publicAddress.checked && relayAddress.checked);
    assert.ok(lanAddress.disabled && !lanAddress.checked);
    ui.click('#shareCopy');
    await settle();
    assert.deepEqual(copied, ['card-7', 'card-4', PEER_A, 'card-3']);
    assert.deepEqual(requested, [['', 7], ['', 6], ['', 4], ['', 0], [PEER_A, 7]]);
  } finally {
    ui.close();
  }
});

test('a refused clipboard shows, selects and focuses the manual copy text', async () => {
  const ui = mountUi({
    onShare: async () => share(),
    onCopyText: async () => false,
  });
  try {
    await ui.open();
    ui.click('#shareCopy');
    await settle();
    const manual = ui.shadow.querySelector('#shareManual');
    assert.equal(ui.shadow.querySelector('#shareCopyStatus').textContent, '复制失败，请手动选择下面的内容。');
    assert.equal(ui.shadow.querySelector('#shareCopyStatus').dataset.tone, 'error');
    assert.equal(manual.hidden, false);
    assert.match(manual.value, /^Raminga 节点/);
    assert.match(manual.value, /Peer ID：/);
    assert.equal(ui.active(), manual, 'focus must move to the selectable fallback');
    assert.equal(manual.selectionStart, 0);
    assert.equal(manual.selectionEnd, manual.value.length);
    assert.equal(ui.shadow.querySelector('#shareCopy').disabled, false);
  } finally {
    ui.close();
  }
});

test('a stale cached read shows its success time and retries inside the dialog', async () => {
  let calls = 0;
  const at = Date.now() - 60_000;
  const ui = mountUi({
    onShare: async () => {
      calls += 1;
      if (calls === 1) return share({ stale: true, at, error: 'daemon unavailable' });
      return share({ stale: false, at: Date.now(), addresses: [] });
    },
    onCopyText: async () => true,
  });
  try {
    await ui.open();
    const stale = ui.shadow.querySelector('#shareStaleNote');
    assert.equal(stale.hidden, false);
    assert.match(stale.textContent, /成功读取的节点信息/);
    assert.match(stale.textContent, /重试/);
    assert.match(stale.textContent, /秒前|分钟前|刚刚/);
    assert.equal(ui.shadow.querySelector('#shareRetry').hidden, false);
    assert.equal(ui.shadow.querySelector('#shareContent').hidden, false);

    ui.click('#shareRetry');
    await settle();
    assert.equal(calls, 2);
    assert.equal(stale.hidden, true, 'a later successful read restores the fresh state');
    assert.equal(ui.shadow.querySelector('#shareRetry').hidden, true);
    assert.match(ui.shadow.querySelector('#shareAddressNote').textContent, /没有可直接分享的地址/);
  } finally {
    ui.close();
  }
});

test('a complete failure still keeps an in-dialog retry', async () => {
  let calls = 0;
  const ui = mountUi({
    onShare: async () => {
      calls += 1;
      if (calls === 1) return share({ stale: true, at: Date.now() - 30_000, error: 'daemon unavailable' });
      throw new Error('daemon still unavailable');
    },
  });
  try {
    await ui.open();
    assert.equal(ui.shadow.querySelector('#shareRetry').hidden, false);
    ui.click('#shareRetry');
    await settle();
    assert.equal(calls, 2);
    assert.equal(ui.shadow.querySelector('#shareFailure').hidden, false);
    assert.match(ui.shadow.querySelector('#shareFailureRaw').textContent, /daemon still unavailable/);
    assert.equal(ui.shadow.querySelector('#shareContent').hidden, true);
    assert.equal(ui.shadow.querySelector('#shareRetry').hidden, false);
    assert.equal(ui.shadow.querySelector('#shareCopy').disabled, true);
  } finally {
    ui.close();
  }
});

test('stream-only staleness does not claim the status refresh failed', async () => {
  const ui = mountUi({
    onShare: async () => share({ stale: true, at: Date.now() - 5_000, error: '实时更新尚未恢复。' }),
  });
  try {
    await ui.open();
    const text = ui.shadow.querySelector('#shareStaleNote').textContent;
    assert.match(text, /实时更新尚未恢复/);
    assert.match(text, /成功读取的节点信息/);
    assert.doesNotMatch(text, /刷新失败/);
    assert.equal(ui.shadow.querySelector('#shareRetry').hidden, false);
  } finally {
    ui.close();
  }
});
