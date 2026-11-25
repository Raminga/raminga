// DOM behavior for the node-status bootstrap settings surface. The real daemon
// acceptance covers persistence/DHT; these tests guard empty/error/upgrade
// states, submit idempotence, focus and refresh-preserves-pending-input.
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
const ADDR_A = `/ip4/127.0.0.1/tcp/44001/p2p/${PEER_A}`;
const SHARE_CODE = 'jwECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gC0JNCg-hJAAAAAAAAAAAAAAAAAAAAQ';

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
    viewState: { page: 'explore', pages: { explore: { filter: 'all', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} } } },
    ...options,
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
    activeId() {
      let node = shadow.activeElement;
      while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
      return node?.id ?? '';
    },
    close() { app.destroy(); dom.window.close(); },
  };
}

async function settle(times = 3) {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function openBootstrap(ui) {
  ui.click('#nodeTrigger');
  await settle();
  // Unfold the settings section so form visibility reflects the real state.
  ui.shadow.querySelector('#statusBootstrap').open = true;
  await settle();
}

function info(entries, overrides = {}) {
  return {
    at: Date.now(),
    peers: entries.flatMap((entry) => entry.addrs),
    entries,
    editable: true,
    requiresUpgrade: false,
    error: null,
    freshness: 'live',
    source: 'bootstrap-api',
    ...overrides,
  };
}

test('empty state, editable form and refresh preserves a pending input', async () => {
  let loads = 0;
  const ui = mountUi({
    onLoadBootstrap: async () => { loads += 1; return info([]); },
    onAddBootstrap: async () => ({ ok: true, changed: true, error: null, requiresUpgrade: false }),
    onRemoveBootstrap: async () => ({ ok: true, changed: true, error: null, requiresUpgrade: false }),
  });
  try {
    await settle();
    await openBootstrap(ui);
    assert.match(ui.text('#statusBootstrapNote'), /尚未配置引导节点/);
    assert.equal(ui.shadow.querySelector('#statusBootstrapEdit').hidden, false);
    const input = ui.shadow.querySelector('#statusBootstrapInput');
    input.value = SHARE_CODE;
    ui.click('#statusBootstrapRefresh');
    await settle();
    assert.equal(input.value, SHARE_CODE, 'refresh must not discard a pending edit');
    assert.ok(loads >= 2);
    assert.equal(ui.shadow.querySelector('#statusBootstrapInput').getAttribute('aria-describedby'), 'statusBootstrapInputHelp');
    assert.equal(ui.shadow.querySelector('#statusBootstrapAdd').disabled, false);
  } finally {
    ui.close();
  }
});

test('add saves, displays saved/not-connected separately, clears once and handles duplicate/error', async () => {
  let entries = [];
  let changed = true;
  let fail = false;
  const seen = [];
  const ui = mountUi({
    onLoadBootstrap: async () => info(entries),
    onAddBootstrap: async (value) => {
      seen.push(value);
      if (fail) throw new Error('请使用打开「附带连接地址」后复制的名片短码');
      if (changed) entries = [{ peerId: PEER_A, addrs: [ADDR_A], online: false, paused: false, savedAt: Date.now() }];
      return { ok: true, changed, error: null, requiresUpgrade: false };
    },
    onRemoveBootstrap: async () => ({ ok: true, changed: true, error: null, requiresUpgrade: false }),
  });
  try {
    await settle();
    await openBootstrap(ui);
    const input = ui.shadow.querySelector('#statusBootstrapInput');
    input.value = SHARE_CODE;
    ui.click('#statusBootstrapAdd');
    await settle();
    assert.deepEqual(seen, [SHARE_CODE]);
    assert.equal(input.value, '', 'successful save clears only the editor');
    assert.ok(ui.text('#statusBootstrapList').includes(PEER_A));
    assert.doesNotMatch(ui.shadow.querySelector('#statusBootstrapList').innerHTML, /127\.0\.0\.1/);
    assert.match(ui.text('#statusBootstrapList'), /已保存 · 暂未连通/);
    assert.doesNotMatch(ui.text('#statusBootstrapList'), /已连接\b/);
    const remove = ui.shadow.querySelector('[data-bootstrap-remove]');
    assert.ok(remove);
    assert.match(remove.getAttribute('aria-label'), /移除引导节点/);
    assert.equal(remove.disabled, false);

    changed = false;
    input.value = SHARE_CODE;
    ui.click('#statusBootstrapAdd');
    await settle();
    assert.match(ui.text('#statusBootstrapFeedback'), /未重复添加/);

    fail = true;
    input.value = PEER_A;
    ui.click('#statusBootstrapAdd');
    await settle();
    assert.match(ui.text('#statusBootstrapFeedback'), /附带连接地址/);
    assert.equal(ui.shadow.querySelector('#statusBootstrapFeedback').dataset.tone, 'error');
    assert.equal(ui.activeId(), 'statusBootstrapInput');
    assert.equal(input.value, PEER_A, 'failure keeps the input for correction');
  } finally {
    ui.close();
  }
});

test('remove keeps the peer/history wording and online/paused states stay distinct', async () => {
  let entries = [
    { peerId: PEER_A, addrs: [ADDR_A], online: false, paused: true, savedAt: Date.now() },
  ];
  const removed = [];
  const ui = mountUi({
    onLoadBootstrap: async () => info(entries),
    onAddBootstrap: async () => ({ ok: true, changed: true, error: null, requiresUpgrade: false }),
    onRemoveBootstrap: async (peerId) => {
      removed.push(peerId);
      entries = [];
      return { ok: true, changed: true, error: null, requiresUpgrade: false };
    },
  });
  try {
    await settle();
    await openBootstrap(ui);
    assert.match(ui.text('#statusBootstrapList'), /已暂停（主动断开）/);
    ui.click('.rm-bootstrap-actions summary');
    assert.equal(ui.shadow.querySelector('.rm-bootstrap-actions').open, true);
    ui.click('[data-bootstrap-remove]');
    await settle();
    assert.deepEqual(removed, [PEER_A]);
    assert.match(ui.text('#statusBootstrapFeedback'), /地址、联系人和主动断开记录保留/);
    assert.match(ui.text('#statusBootstrapNote'), /尚未配置引导节点/);
  } finally {
    ui.close();
  }
});

test('the bootstrap menu opens the single-copy share dialog and restores focus', async () => {
  const requests = [];
  const copied = [];
  const ui = mountUi({
    onLoadBootstrap: async () => info([{ peerId: PEER_A, hasAddresses: true, online: true }]),
    onAddBootstrap: async () => ({ ok: true }),
    onRemoveBootstrap: async () => ({ ok: true }),
    onContactCard: async (peerId, scopes) => {
      requests.push([peerId, scopes]);
      const selected = scopes & 1;
      return { ok: true, peerId, shareCode: selected ? SHARE_CODE : peerId, hasAddresses: selected !== 0, availableAddressScopes: 1, includedAddressScopes: selected };
    },
    onCopyText: async (value) => { copied.push(value); return true; },
  });
  try {
    await settle();
    await openBootstrap(ui);
    const menu = ui.shadow.querySelector('.rm-bootstrap-actions');
    const trigger = ui.click('.rm-bootstrap-actions summary');
    assert.equal(menu.open, true);
    assert.deepEqual([...menu.querySelectorAll('button')].map((button) => button.textContent), ['分享此引导节点', '移除']);
    ui.click('[data-bootstrap-share]');
    await settle();
    assert.equal(menu.open, false);
    assert.equal(ui.shadow.querySelector('#shareDialog').open, true);
    assert.equal(ui.text('#shareHeading'), '分享此引导节点');
    assert.ok(ui.shadow.querySelector('#sharePublicAddress').checked);
    assert.ok(ui.shadow.querySelector('#shareRelayAddress').disabled);
    assert.ok(ui.shadow.querySelector('#shareLanAddress').disabled);
    ui.click('#shareCopy');
    await settle();
    assert.deepEqual(requests, [[PEER_A, 7]]);
    assert.deepEqual(copied, [SHARE_CODE]);
    ui.click('#shareDialog [data-close-dialog]');
    assert.equal(ui.shadow.activeElement, trigger);
    assert.equal(ui.shadow.querySelector('#statusDialog').open, true);
  } finally {
    ui.close();
  }
});

test('load failure, old daemon read-only view and missing host capability are distinct', async () => {
  const failed = mountUi({
    onLoadBootstrap: async () => ({ at: null, peers: [], entries: [], editable: false, requiresUpgrade: false, error: 'daemon 暂不可用', freshness: 'unavailable', source: 'unavailable' }),
    onAddBootstrap: async () => ({ ok: true, changed: true }),
    onRemoveBootstrap: async () => ({ ok: true, changed: true }),
  });
  try {
    await settle();
    await openBootstrap(failed);
    assert.match(failed.text('#statusBootstrapNote'), /读取失败：daemon 暂不可用/);
    assert.equal(failed.shadow.querySelector('#statusBootstrapList').children.length, 0);
    assert.equal(failed.shadow.querySelector('#statusBootstrapEdit').hidden, true);
    assert.match(failed.text('#statusBootstrapUpgrade'), /升级/);
    assert.equal(failed.shadow.querySelector('#statusBootstrapUpgrade').hidden, true);
  } finally {
    failed.close();
  }

  const old = mountUi({
    onLoadBootstrap: async () => ({ at: Date.now(), peers: [ADDR_A], entries: [], editable: false, requiresUpgrade: true, error: null, freshness: 'live', source: 'dht-status' }),
    onAddBootstrap: async () => { throw new Error('current daemon does not support bootstrap write'); },
    onRemoveBootstrap: async () => { throw new Error('current daemon does not support bootstrap write'); },
  });
  try {
    await settle();
    await openBootstrap(old);
    assert.ok(old.text('#statusBootstrapList').includes(PEER_A));
    assert.doesNotMatch(old.shadow.querySelector('#statusBootstrapList').innerHTML, /127\.0\.0\.1/);
    assert.equal(old.shadow.querySelector('#statusBootstrapEdit').hidden, true);
    assert.equal(old.shadow.querySelector('#statusBootstrapUpgrade').hidden, false);
    assert.equal(old.shadow.querySelectorAll('[data-bootstrap-remove]').length, 0, 'old daemon never offers a false write');
  } finally {
    old.close();
  }

  const missing = mountUi({});
  try {
    await settle();
    await openBootstrap(missing);
    assert.match(missing.text('#statusBootstrapUnavailable'), /没有提供引导节点管理/);
    assert.equal(missing.shadow.querySelector('#statusBootstrapRefresh').hidden, true);
  } finally {
    missing.close();
  }
});
