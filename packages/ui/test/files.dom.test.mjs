// DOM acceptance for generic public-file cards, peer homepage manifest/node
// information, the Mine page and the local status/bootstrap surfaces.
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

async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

function baseItem(overrides = {}) {
  return {
    id: 'file-1', peerId: PEER_A, publisherName: '发布节点甲', path: 'notes/hello.md',
    name: 'hello.md', sha256: 'a'.repeat(64), sizeBytes: 120, modifiedAt: 0,
    fetchedAt: Date.now(), source: 'raminga_ui_manual', sources: ['raminga_ui_manual'],
    kind: 'markdown', mime: 'text/markdown', previewable: true,
    title: 'Hello', summary: '正文摘要', tags: [], publishedAt: '',
    authorKind: 'user', authorName: '原作者乙', contentState: 'available', contentError: '',
    ...overrides,
  };
}

function discoveries(items) {
  return { items, at: Date.now(), error: null, errorAt: null, freshness: 'live', familiar: false, scanned: items.length, truncated: false, relationComplete: true, ignored: 0 };
}

function contacts() {
  return { friends: [{ peerId: PEER_A, name: 'alice', description: '', connection: 'connected', paused: false, addrs: [] }], at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1 };
}

function emptyConversations() {
  return { conversations: [], at: Date.now(), error: null, errorAt: null, freshness: 'live', retention: { retainedMessages: 0, oldestRetainedAt: null, maxStoredMessages: 1000 } };
}

function emptyMessages(peerId) {
  return { peerId, messages: [], at: Date.now(), error: null, errorAt: null, freshness: 'live', hasMore: false, nextBefore: '', retention: { retainedMessages: 0, oldestRetainedAt: null, maxStoredMessages: 1000 } };
}

test('discovery cards use the publisher public name, keep author claims in details and label acquisition sources', async () => {
  const item = baseItem({
    path: 'posts/hello/post.json', name: 'post.json',
    sources: ['raminga_content_get', 'raminga_ui_manual'], source: 'raminga_ui_manual',
  });
  const ui = mountUi({
    onLoadDiscoveries: async () => discoveries([item]),
    onLoadDiscoveryContent: async () => ({
      ...baseItem(), ok: true, subject: 'discovery', status: 'ok', text: '# 正文\n\n内容', html: '', dataUrl: '', warnings: [], missingResources: [], error: '', post: null,
      discoveryRecorded: false, discoveryError: '', id: item.id, source: 'raminga_ui_manual', sources: item.sources,
    }),
    onRevealDiscovery: async () => ({ ok: true, status: 'revealed', error: null, at: Date.now() }),
  });
  try {
    await settle();
    const card = ui.shadow.querySelector('#discoveryList .rm-post');
    assert.match(card.querySelector('.rm-post-name').textContent, /发布节点甲/);
    assert.match(card.querySelector('.rm-post-meta').textContent, /Agent 获取 \+ 手动获取/);
    assert.doesNotMatch([...card.querySelectorAll('.rm-post-name, .rm-post-title, .rm-post-summary')].map((node) => node.textContent).join(' '), /原作者乙/);
    card.querySelector('.rm-source-summary').click();
    assert.match(card.querySelector('.rm-source-details').textContent, /原作者乙/);
    assert.match(card.querySelector('.rm-source-details').textContent, /raminga_content_get/);
    assert.match(card.querySelector('.rm-source-details').textContent, /raminga_ui_manual/);
    assert.equal(card.querySelector('.rm-post-toggle'), null, 'the title/detail is the only reading entry');
    assert.equal(card.querySelector('.rm-post-actions .rm-file-reveal'), null, 'locating belongs in source details');
    const reveal = card.querySelector('.rm-source-details .rm-file-reveal');
    assert.ok(reveal, 'source details keep the local-copy locating action');
    reveal.click();
    await settle();
    assert.match(ui.text('.rm-post'), /已请求宿主在文件夹中显示/);
  } finally {
    ui.close();
  }
});

test('sandboxed HTML and media previews are created only on demand and cleaned on collapse', async () => {
  const htmlItem = baseItem({
    id: 'html-1', path: 'site/index.html', name: 'index.html', kind: 'html', mime: 'text/html', title: 'Sandbox',
  });
  const mediaItem = baseItem({
    id: 'img-1', path: 'pic.png', name: 'pic.png', kind: 'image', mime: 'image/png', title: 'pic',
  });
  const previews = {
    'html-1': {
      ...htmlItem, ok: true, subject: 'discovery', status: 'ok', text: '', dataUrl: '',
      html: '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></head><body>safe</body></html>',
      warnings: [], missingResources: [], error: '', post: null, discoveryRecorded: false, discoveryError: '', id: 'html-1', source: 'raminga_ui_manual', sources: ['raminga_ui_manual'],
    },
    'img-1': {
      ...mediaItem, ok: true, subject: 'discovery', status: 'ok', text: '', html: '', dataUrl: 'data:image/png;base64,UE5H',
      warnings: [], missingResources: [], error: '', post: null, discoveryRecorded: false, discoveryError: '', id: 'img-1', source: 'raminga_ui_manual', sources: ['raminga_ui_manual'],
    },
  };
  let calls = 0;
  const ui = mountUi({
    onLoadDiscoveries: async () => discoveries([htmlItem, mediaItem]),
    onLoadDiscoveryContent: async (id) => { calls += 1; return previews[id]; },
  });
  try {
    await settle();
    assert.equal(calls, 0, 'previews are not fetched until the reader expands');
    ui.shadow.querySelectorAll('#discoveryList .rm-post')[0].querySelector('[data-expand-post]').click();
    await settle();
    const frame = ui.shadow.querySelector('.rm-html-frame');
    assert.ok(frame);
    assert.equal(frame.getAttribute('sandbox'), '');
    assert.doesNotMatch(frame.getAttribute('sandbox'), /allow-/);
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
    assert.match(frame.getAttribute('srcdoc'), /script-src 'none'/);
    ui.shadow.querySelectorAll('#discoveryList .rm-post')[0].querySelector('[data-expand-post]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('.rm-html-frame'), null, 'collapsing removes the sandboxed document');
    assert.equal(calls, 1);

    ui.shadow.querySelectorAll('#discoveryList .rm-post')[1].querySelector('[data-expand-post]').click();
    await settle();
    const image = ui.shadow.querySelector('.rm-file-image');
    assert.ok(image);
    assert.equal(image.getAttribute('src'), 'data:image/png;base64,UE5H');
    ui.shadow.querySelectorAll('#discoveryList .rm-post')[1].querySelector('[data-expand-post]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('.rm-file-image'), null, 'collapsing releases the media element');
  } finally {
    ui.close();
  }
});

test('peer homepage lists current posts/files and exposes chat, full Peer ID, addresses and copy actions', async () => {
  const copied = [];
  const manifest = {
    peerId: PEER_A, publisherName: '发布节点甲', at: Date.now(), error: null, errorAt: null, freshness: 'live', truncated: false, total: 2,
    entries: [
      baseItem({ id: 'p1', path: 'posts/a.json', name: 'a.json', title: '对方帖子', publisherName: '发布节点甲', kind: 'markdown', sources: ['peer-manifest'] }),
      baseItem({ id: 'f1', path: 'notes/hello.txt', name: 'hello.txt', title: 'hello', kind: 'text', mime: 'text/plain', publisherName: '发布节点甲', sources: ['peer-manifest'] }),
    ],
  };
  const node = {
    peerId: PEER_A, connectionState: 'connected', directConnections: 1, relayConnections: 0,
    currentAddresses: [{ multiaddr: `/ip4/127.0.0.1/tcp/5001/p2p/${PEER_A}`, source: 'connection', reachability: 'verified', observedAt: Date.now() }],
    knownAddresses: [{ multiaddr: `/ip4/10.0.0.2/tcp/5001/p2p/${PEER_A}`, source: 'cache', sourceDetail: 'known', reachability: 'unverified', observedAt: Date.now() }],
    statusAt: Date.now(), freshness: 'live', error: null,
  };
  const ui = mountUi({
    onLoadContacts: async () => contacts(),
    onLoadConversations: async () => emptyConversations(),
    onLoadMessages: async (peerId) => emptyMessages(peerId),
    onLoadPeerProfile: async () => ({
      peerId: PEER_A, localName: 'alice', remoteName: '发布节点甲', found: true,
      text: '# 发布节点甲\n\n资料', files: ['profile/index.md'], at: Date.now(), error: null, freshness: 'live',
      agentCard: { state: 'missing', card: null, error: 'missing' }, manifest, node,
    }),
    onCopyText: async (text) => { copied.push(text); return true; },
  });
  try {
    await settle();
    ui.app.setContacts(contacts());
    ui.click('button[data-nav="contacts"]');
    await settle();
    ui.click('button[data-contact-peer]');
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.match(ui.text('#profileName'), /发布节点甲/);
    assert.match(ui.text('#profilePostList'), /对方帖子/);
    assert.match(ui.text('#profileFileList'), /hello\.txt/);
    assert.equal(ui.shadow.querySelector('#profileNodePeerId').textContent, PEER_A);
    assert.match(ui.text('#profileNodeConnection'), /已连接/);
    assert.match(ui.text('#profileCurrentAddrs'), /127\.0\.0\.1/);
    assert.match(ui.text('#profileCurrentAddrs'), new RegExp(`/p2p/${PEER_A}`));
    assert.match(ui.text('#profileCurrentAddrs'), /当前连接已验证/);
    assert.match(ui.text('#profileAnnouncedAddrs'), /10\.0\.0\.2/);
    assert.match(ui.text('#profileAnnouncedAddrs'), /旧地址，未验证可达/);
    assert.match(ui.text('#profileAnnouncedAddrs'), /本机缓存/);

    ui.click('#profileCopyPeer');
    await settle();
    assert.equal(copied.at(-1), PEER_A);
    ui.click('#profileCopyCurrent');
    await settle();
    assert.match(copied.at(-1), /127\.0\.0\.1/);
    ui.click('#profileCopyAnnounced');
    await settle();
    assert.match(copied.at(-1), /10\.0\.0\.2/);

    ui.click('#profileMessage');
    await settle();
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false);
    assert.equal(ui.shadow.querySelector('#conversationPeerId').textContent, PEER_A);
  } finally {
    ui.close();
  }
});

test('Mine lists every public file, including Agent-authored and non-post formats', async () => {
  const files = [
    baseItem({ id: 'm1', peerId: PEER_B, publisherName: '我的节点', path: 'posts/agent.json', title: 'Agent 内容', authorKind: 'agent', authorName: 'Agent One' }),
    baseItem({ id: 'm2', peerId: PEER_B, publisherName: '我的节点', path: 'notes/hello.txt', kind: 'text', mime: 'text/plain', title: 'hello', authorKind: '', authorName: '' }),
    baseItem({ id: 'm3', peerId: PEER_B, publisherName: '我的节点', path: 'pic.png', kind: 'image', mime: 'image/png', title: 'pic', authorKind: '', authorName: '' }),
  ];
  const ui = mountUi({
    viewState: { page: 'mine', pages: { mine: { scroll: 0 } } },
    onLoadMine: async () => ({
      peerId: PEER_B, at: Date.now(), error: null, errorAt: null, freshness: 'live',
      profile: { state: 'available', markdown: '# 我的节点', displayName: '我的节点', error: '', path: 'profile/index.md', at: Date.now() },
      posts: { state: 'available', posts: [], error: '', unattributed: 0, agentAuthored: 1, invalid: 0, errors: [], truncated: false },
      files, filesTruncated: false,
    }),
    onLoadMineFileContent: async (filePath) => ({ ...files.find((file) => file.path === filePath), ok: true, subject: 'mine', status: 'ok', text: 'body', html: '', dataUrl: '', warnings: [], missingResources: [], error: '', post: null, discoveryRecorded: false, discoveryError: '' }),
  });
  try {
    await settle();
    assert.equal(ui.shadow.querySelectorAll('#minePostList .rm-post').length, 3);
    assert.match(ui.text('#minePostList'), /Agent 内容/);
    assert.match(ui.text('#minePostList'), /hello\.txt/);
    assert.match(ui.text('#minePostList'), /pic\.png/);
    assert.match(ui.text('#mineContentNote'), /Agent 署名文件也按公开内容列出/);
    assert.equal(ui.shadow.querySelector('#shareNode'), null, 'share entry is not on Mine');
    assert.equal(ui.shadow.querySelector('#mineRefresh').textContent, '刷新公开资料');
    ui.click('#mineRefresh');
    await settle();
    assert.equal(ui.shadow.querySelector('#mineRefresh').textContent, '刷新公开资料');
  } finally {
    ui.close();
  }
});

test('status dialog owns local share and bootstrap configuration view', async () => {
  let shares = 0;
  let copied = '';
  const bootstrapPeers = [`/ip4/127.0.0.1/tcp/4001/p2p/${PEER_B}`];
  const ui = mountUi({
    onLoadBootstrap: async () => ({ at: Date.now(), peers: bootstrapPeers, error: null, freshness: 'live', source: 'dht-status' }),
    onShare: async () => {
      shares += 1;
      return { ok: true, peerId: PEER_B, at: Date.now(), stale: false, error: null, addresses: [] };
    },
    onCopyText: async (text) => { copied = text; return true; },
  });
  try {
    await settle();
    ui.click('#nodeTrigger');
    await settle();
    assert.equal(ui.shadow.querySelector('#statusDialog').open, true);
    assert.equal(ui.shadow.querySelector('#shareNode'), null, 'share entry moved out of Mine');
    assert.match(ui.text('#statusBootstrapNote'), /已保存 1 个引导节点|尚未配置/);
    ui.click('#statusBootstrapRefresh');
    await settle();
    assert.match(ui.text('#statusBootstrapList'), /127\.0\.0\.1/);
    ui.click('#statusBootstrapCopy');
    await settle();
    assert.equal(copied, bootstrapPeers[0]);
    ui.click('#statusShareNode');
    await settle();
    assert.equal(ui.shadow.querySelector('#shareDialog').open, true);
    assert.equal(shares, 1);
  } finally {
    ui.close();
  }
});

test('profile failure still exposes the message entry and opens the existing conversation', async () => {
  const ui = mountUi({
    onLoadContacts: async () => contacts(),
    onLoadConversations: async () => emptyConversations(),
    onLoadMessages: async (peerId) => emptyMessages(peerId),
    onLoadPeerProfile: async () => { throw new Error('远端资料暂时不可达'); },
  });
  try {
    await settle();
    ui.app.setContacts(contacts());
    ui.click('button[data-nav="contacts"]');
    await settle();
    ui.click('button[data-contact-peer]');
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.match(ui.text('#profileError'), /远端资料暂时不可达/);
    assert.equal(ui.shadow.querySelector('#profileMessage').hidden, false);
    ui.click('#profileMessage');
    await settle();
    assert.equal(ui.shadow.querySelector('#conversationView').hidden, false);
    assert.equal(ui.shadow.querySelector('#conversationPeerId').textContent, PEER_A);
  } finally {
    ui.close();
  }
});

test('peer downloaded originals expose a verified reveal control only after the local copy exists', async () => {
  const entry = baseItem({
    id: 'pdf-1', path: 'docs/guide.pdf', name: 'guide.pdf', kind: 'unsupported',
    mime: 'application/pdf', previewable: false, title: 'guide',
    sources: ['peer-manifest'], source: 'peer-manifest', contentState: 'not-downloaded',
    contentError: '本机尚未下载这个文件；展开后可手动获取。',
  });
  const calls = [];
  const ui = mountUi({
    onLoadContacts: async () => contacts(),
    onLoadConversations: async () => emptyConversations(),
    onLoadMessages: async (peerId) => emptyMessages(peerId),
    onLoadPeerProfile: async () => ({
      peerId: PEER_A, localName: 'alice', remoteName: '发布节点甲', found: true,
      text: '# 发布节点甲', files: ['docs/guide.pdf'], source: 'remote', at: Date.now(), error: null, freshness: 'live',
      agentCard: { state: 'missing', card: null, error: 'missing' },
      manifest: {
        peerId: PEER_A, publisherName: '发布节点甲', source: 'remote', at: Date.now(), error: null, errorAt: null,
        freshness: 'live', truncated: false, total: 1, entries: [entry],
      },
      node: {
        peerId: PEER_A, connectionState: 'connected', directConnections: 1, relayConnections: 0,
        currentAddresses: [], knownAddresses: [], statusAt: Date.now(), freshness: 'live', error: null,
      },
    }),
    onLoadPeerFileContent: async () => ({
      ...entry, ok: false, subject: 'peer', status: 'unsupported', text: '', html: '', dataUrl: '',
      warnings: [], missingResources: [], error: '本次已手动获取并核对原件，可使用“在文件夹中显示”定位。',
      post: null, discoveryRecorded: true, discoveryError: '', localCopy: 'available',
      acquisition: 'downloaded', source: 'raminga_ui_manual', sources: ['raminga_ui_manual'], fetchedAt: Date.now(),
    }),
    onRevealFile: async (subject, peerId, filePath, sha256, size) => {
      calls.push({ kind: 'reveal', subject, peerId, filePath, sha256, size });
      return { ok: true, status: 'revealed', error: null, at: Date.now() };
    },
  });
  try {
    await settle();
    ui.app.setContacts(contacts());
    ui.click('button[data-nav="contacts"]');
    await settle();
    ui.click('button[data-contact-peer]');
    await settle();
    const before = ui.shadow.querySelector('#profileFileList .rm-post');
    assert.ok(before);
    const disabledReveal = before.querySelector('.rm-file-reveal');
    assert.ok(disabledReveal);
    assert.equal(disabledReveal.disabled, true, 'an undownloaded peer file must not claim a local original');
    assert.match(ui.text('#profileFileList'), /尚未下载/);

    before.querySelector('.rm-post-toggle').click();
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#profileFileList .rm-post .rm-file-preview') !== null, true);
    const after = ui.shadow.querySelector('#profileFileList .rm-post');
    const reveal = after.querySelector('.rm-file-reveal');
    assert.equal(reveal.disabled, false);
    reveal.click();
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].subject, 'peer');
    assert.equal(calls[0].filePath, 'docs/guide.pdf');
    assert.equal(calls[0].sha256, entry.sha256);
    assert.match(ui.text('#profileFileList'), /已请求宿主在文件夹中显示/);
  } finally {
    ui.close();
  }
});

test('Mine published originals include a reveal control without any network acquisition', async () => {
  const file = baseItem({
    id: 'mine-pdf', peerId: PEER_B, publisherName: '我的节点', path: 'docs/local.pdf',
    name: 'local.pdf', kind: 'unsupported', mime: 'application/pdf', previewable: false,
    title: 'local', source: 'local-public', sources: ['local-public'], contentState: 'available',
  });
  const calls = [];
  const ui = mountUi({
    viewState: { page: 'mine', pages: { mine: { scroll: 0 } } },
    onLoadMine: async () => ({
      peerId: PEER_B, at: Date.now(), error: null, errorAt: null, freshness: 'live',
      profile: { state: 'available', markdown: '# 我的节点', displayName: '我的节点', error: '', path: 'profile/index.md', at: Date.now() },
      posts: { state: 'available', posts: [], error: '', unattributed: 0, agentAuthored: 0, invalid: 0, errors: [], truncated: false },
      files: [file], filesTruncated: false,
    }),
    onRevealFile: async (subject, peerId, filePath, sha256, size) => {
      calls.push({ subject, peerId, filePath, sha256, size });
      return { ok: true, status: 'revealed', error: null, at: Date.now() };
    },
  });
  try {
    await settle();
    const reveal = ui.shadow.querySelector('#minePostList .rm-post .rm-file-reveal');
    assert.ok(reveal);
    assert.equal(reveal.disabled, false);
    reveal.click();
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].subject, 'mine');
    assert.equal(calls[0].filePath, 'docs/local.pdf');
    assert.equal(calls[0].peerId, PEER_B);
    assert.match(ui.text('#minePostList'), /已请求宿主在文件夹中显示/);
  } finally {
    ui.close();
  }
});

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function imagePost(peerId, overrides = {}) {
  const image = {
    path: 'images/' + 'a'.repeat(64) + '.png',
    publicPath: 'posts/post-images/images/' + 'a'.repeat(64) + '.png',
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    width: 1,
    height: 1,
    sizeBytes: 70,
    manifestState: 'available',
  };
  return baseItem({
    id: 'post-images', peerId, publisherName: '带图作者',
    path: 'posts/post-images/post.json', name: 'post.json',
    title: '真实图文动态', summary: '正文与配图。', tags: ['图'],
    images: [image],
    ...overrides,
  });
}

function imagePreview(item, image, overrides = {}) {
  return {
    ...item, ok: true, subject: 'peer', status: 'ok', kind: 'image', mime: image.mime,
    text: '', html: '', dataUrl: `data:${image.mime};base64,${TINY_PNG}`,
    warnings: [], missingResources: [], error: '', post: null,
    sha256: image.sha256, sizeBytes: image.sizeBytes,
    localCopy: 'available', acquisition: 'local-copy', discoveryRecorded: false, discoveryError: '',
    ...overrides,
  };
}

test('mine v2 post cards render real images with bounded reads and a closeable preview that restores position', async () => {
  let active = 0;
  let maxActive = 0;
  let reads = 0;
  const files = [
    imagePost(PEER_B, {
      id: 'mine-post-1', publisherName: '我的节点', authorKind: 'agent', authorName: 'Nebula',
      images: [0, 1, 2, 3].map((index) => ({
        path: `images/${String(index).repeat(64).slice(0, 64)}.png`,
        publicPath: `posts/mine-post-1/images/${String(index).repeat(64).slice(0, 64)}.png`,
        sha256: String(index).repeat(64).slice(0, 64),
        mime: 'image/png', width: 1, height: 1, sizeBytes: 70, manifestState: 'available',
      })),
    }),
    imagePost(PEER_B, {
      id: 'mine-post-2', path: 'posts/mine-post-2/post.json',
      title: '第二条带图动态', publisherName: '我的节点', authorKind: 'user', authorName: '本人',
      images: [0, 1, 2, 3].map((index) => ({
        path: `images/${String(index + 4).repeat(64).slice(0, 64)}.png`,
        publicPath: `posts/mine-post-2/images/${String(index + 4).repeat(64).slice(0, 64)}.png`,
        sha256: String(index + 4).repeat(64).slice(0, 64),
        mime: 'image/png', width: 1, height: 1, sizeBytes: 70, manifestState: 'available',
      })),
    }),
  ];
  const ui = mountUi({
    viewState: { page: 'mine', pages: { mine: { scroll: 0 } } },
    onLoadMine: async () => ({
      peerId: PEER_B, at: Date.now(), error: null, errorAt: null, freshness: 'live',
      profile: { state: 'available', markdown: '# 我的节点', displayName: '我的节点', error: '', path: 'profile/index.md', at: Date.now() },
      posts: { state: 'available', posts: [], error: '', unattributed: 0, agentAuthored: 1, invalid: 0, errors: [], truncated: false },
      agentCard: {
        state: 'available',
        card: {
          schemaVersion: 1, displayName: 'Nebula', description: '', interests: [], conversationStyle: '',
          updatedAt: new Date().toISOString(), path: 'profile/profile.json', sha256: 'f'.repeat(64),
        },
        error: '',
      },
      publicProfile: { state: 'missing', profile: null, error: '' },
      files, filesTruncated: false,
    }),
    onLoadMineFileContent: async (filePath, sha256, sizeBytes) => {
      if (filePath.endsWith('/post.json')) {
        const post = files.find((item) => item.path === filePath);
        return {
          ...post, ok: true, subject: 'mine', status: 'ok', kind: 'markdown', mime: 'text/markdown',
          text: '# 真实图文动态\n\n正文与配图。', html: '', dataUrl: '', warnings: [], missingResources: [],
          error: '', localCopy: 'available', acquisition: 'local-copy', discoveryRecorded: false, discoveryError: '',
          post: {
            schemaVersion: 2, title: post.title, summary: post.summary, bodyMarkdown: '# 真实图文动态\n\n正文与配图。',
            tags: post.tags, publishedAt: post.publishedAt, authorPeerId: post.peerId, authorKind: post.authorKind,
            authorName: post.authorName, path: post.path, sha256: sha256 ?? post.sha256, sizeBytes: sizeBytes ?? post.sizeBytes,
            revision: 1, images: post.images,
          },
        };
      }
      reads += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 12));
      active -= 1;
      const image = files.flatMap((item) => item.images).find((entry) => entry.publicPath === filePath);
      assert.ok(image, `missing image ${filePath}`);
      return imagePreview(files[0], image, { subject: 'mine', sha256, sizeBytes });
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(reads, 8);
    assert.ok(maxActive <= 4, `bounded reads, saw ${maxActive}`);
    const images = ui.shadow.querySelectorAll('.rm-post-media-img');
    assert.equal(images.length, 8);
    assert.match(images[0].getAttribute('src'), /^data:image\/png;base64,/);

    // Expanding the card must render the larger detail gallery as well.
    ui.shadow.querySelector('#minePostList .rm-post-toggle').click();
    await settle();
    const detail = ui.shadow.querySelector('#minePostList .rm-post-body .rm-post-media[data-variant="detail"]');
    assert.ok(detail, 'detail gallery is rendered');
    assert.equal(detail.querySelectorAll('.rm-post-media-img:not([hidden])').length, 4);
    assert.match(detail.querySelector('.rm-post-media-img').getAttribute('src'), /^data:image\/png;base64,/);

    const page = ui.shadow.querySelector('#page-settings');
    page.scrollTop = 120;
    const tile = ui.shadow.querySelector('.rm-post-media-item[data-state="ready"]');
    assert.ok(tile);
    tile.focus();
    tile.click();
    const dialog = ui.shadow.querySelector('#imagePreviewDialog');
    assert.equal(dialog.open, true);
    assert.equal(ui.shadow.querySelector('#imagePreviewImg').getAttribute('src'), tile.querySelector('img').getAttribute('src'));
    assert.match(ui.text('#imagePreviewMeta'), /SHA-256/);
    ui.shadow.querySelector('#imagePreviewDialog [data-close-dialog]').click();
    await settle();
    assert.equal(dialog.open, false);
    assert.equal(page.scrollTop, 120);
  } finally {
    ui.close();
  }
});

test('peer and contact v2 post cards load image metadata lazily, show missing-image state and use the public avatar chain', async () => {
  const image = {
    path: 'images/' + 'b'.repeat(64) + '.png',
    publicPath: 'posts/peer-post/images/' + 'b'.repeat(64) + '.png',
    sha256: 'b'.repeat(64), mime: 'image/png', width: 1, height: 1, sizeBytes: 70, manifestState: 'available',
  };
  const missing = {
    path: 'images/' + 'c'.repeat(64) + '.png',
    publicPath: 'posts/peer-post/images/' + 'c'.repeat(64) + '.png',
    sha256: 'c'.repeat(64), mime: 'image/png', width: 1, height: 1, sizeBytes: 70, manifestState: 'missing',
  };
  const postItem = baseItem({
    id: 'peer-post', peerId: PEER_A, publisherName: '带图作者',
    path: 'posts/peer-post/post.json', name: 'post.json', title: '远端带图动态',
    kind: 'markdown', mime: 'text/markdown', sources: ['peer-manifest'], source: 'peer-manifest',
    contentState: 'not-downloaded', contentError: '',
  });
  const avatarPath = 'profile/avatar-aaaaaaaa.png';
  const manifest = {
    peerId: PEER_A, publisherName: '带图作者', at: Date.now(), error: null, errorAt: null, freshness: 'live', truncated: false, total: 3,
    entries: [
      postItem,
      baseItem({ id: 'avatar', peerId: PEER_A, publisherName: '带图作者', path: avatarPath, name: 'avatar-aaaaaaaa.png', kind: 'image', mime: 'image/png', title: 'avatar', sources: ['peer-manifest'], sizeBytes: 70, sha256: 'd'.repeat(64) }),
      baseItem({ id: 'post-image', peerId: PEER_A, publisherName: '带图作者', path: image.publicPath, name: 'image.png', kind: 'image', mime: 'image/png', title: 'image', sources: ['peer-manifest'], sizeBytes: 70, sha256: image.sha256 }),
    ],
  };
  let metaCalls = 0;
  const ui = mountUi({
    onLoadContacts: async () => contacts(),
    onLoadConversations: async () => emptyConversations(),
    onLoadMessages: async (peerId) => emptyMessages(peerId),
    onLoadPeerProfile: async () => ({
      peerId: PEER_A, localName: 'alice', remoteName: '带图作者', found: true,
      text: '# 带图作者\n\n资料', files: ['profile/index.md', avatarPath], at: Date.now(), error: null, freshness: 'live',
      agentCard: {
        state: 'available',
        card: {
          schemaVersion: 1, displayName: 'Nebula', description: '', interests: [], conversationStyle: '',
          updatedAt: new Date().toISOString(), path: 'profile/profile.json', sha256: 'e'.repeat(64),
          avatarPath, avatarSha256: 'd'.repeat(64), avatarMime: 'image/png',
        },
        error: '',
      },
      manifest, node: { peerId: PEER_A, connectionState: 'unknown', directConnections: 0, relayConnections: 0, currentAddresses: [], knownAddresses: [], statusAt: null, freshness: 'unavailable', error: null },
    }),
    onLoadPeerPostMeta: async () => {
      metaCalls += 1;
      return {
        found: true, path: postItem.path, sha256: postItem.sha256, title: '远端带图动态', summary: '远端正文。',
        tags: ['远端'], publishedAt: '2026-11-18T10:00:00Z', authorKind: 'agent', authorName: 'Nebula',
        images: [image, missing], error: '',
      };
    },
    onLoadPeerFileContent: async (peerId, filePath, sha256, sizeBytes) => {
      if (filePath === avatarPath) {
        return imagePreview({ ...manifest.entries[1], path: avatarPath }, { mime: 'image/png', sha256: 'd'.repeat(64), sizeBytes: 70 }, { kind: 'image', dataUrl: `data:image/png;base64,${TINY_PNG}` });
      }
      if (filePath === image.publicPath) return imagePreview({ ...manifest.entries[2] }, image);
      throw new Error('unexpected image read');
    },
  });
  try {
    await settle();
    ui.app.setContacts(contacts());
    ui.click('button[data-nav="contacts"]');
    await settle();
    ui.click('button[data-contact-peer]');
    await settle();
    assert.equal(metaCalls, 1);
    ui.click('[data-profile-tab="posts"]');
    await settle();
    const card = ui.shadow.querySelector('#profilePostList .rm-post');
    assert.ok(card);
    assert.match(card.textContent, /远端带图动态/);
    const media = card.querySelector('.rm-post-media');
    assert.ok(media, 'card image strip is rendered');
    assert.equal(media.querySelectorAll('.rm-post-media-item').length, 2);
    assert.match(card.textContent, /公开清单中没有这张图片/);
    assert.match(card.querySelector('.rm-post-media-img').getAttribute('src'), /^data:image\/png;base64,/);
    const avatar = ui.shadow.querySelector('#profileAvatar .rm-profile-avatar-img');
    assert.ok(avatar, 'peer public avatar is rendered through the same controlled read');
    assert.match(avatar.getAttribute('src'), /^data:image\/png;base64,/);
    card.querySelector('.rm-post-media-item[data-state="ready"]').click();
    assert.equal(ui.shadow.querySelector('#imagePreviewDialog').open, true);
    ui.shadow.querySelector('#imagePreviewDialog [data-close-dialog]').click();
    await settle();
    assert.equal(ui.shadow.querySelector('#imagePreviewDialog').open, false);
    assert.ok(ui.shadow.activeElement?.classList?.contains('rm-post-media-item'), 'focus returns to the image tile');
  } finally {
    ui.close();
  }
});

test('post image object URLs are revoked when the panel is destroyed', async () => {
  const image = {
    path: 'images/' + 'e'.repeat(64) + '.png',
    publicPath: 'posts/mine-object-url/images/' + 'e'.repeat(64) + '.png',
    sha256: 'e'.repeat(64), mime: 'image/png', width: 1, height: 1, sizeBytes: 70, manifestState: 'available',
  };
  const ui = mountUi({
    viewState: { page: 'mine', pages: { mine: { scroll: 0 } } },
    onLoadMine: async () => ({
      peerId: PEER_B, at: Date.now(), error: null, errorAt: null, freshness: 'live',
      profile: { state: 'available', markdown: '# 我的节点', displayName: '我的节点', error: '', path: 'profile/index.md', at: Date.now() },
      posts: { state: 'available', posts: [], error: '', unattributed: 0, agentAuthored: 0, invalid: 0, errors: [], truncated: false },
      agentCard: { state: 'missing', card: null, error: '' },
      publicProfile: { state: 'missing', profile: null, error: '' },
      files: [imagePost(PEER_B, { id: 'object-url-post', images: [image] })],
      filesTruncated: false,
    }),
    onLoadMineFileContent: async () => imagePreview(image, image, { subject: 'mine' }),
  });
  const revoked = [];
  let created = 0;
  Object.defineProperty(ui.dom.window.URL, 'createObjectURL', {
    configurable: true,
    value: () => { created += 1; return `blob:raminga-test-${created}`; },
  });
  Object.defineProperty(ui.dom.window.URL, 'revokeObjectURL', {
    configurable: true,
    value: (url) => { revoked.push(url); },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const img = ui.shadow.querySelector('.rm-post-media-img');
    assert.match(img.getAttribute('src'), /^blob:raminga-test-/);
    ui.close();
    assert.ok(revoked.some((url) => url.startsWith('blob:raminga-test-')), 'object URL is revoked on destroy');
  } finally {
    // mountUi.close() is idempotent for the app but JSDOM may already be closed.
    try { ui.close(); } catch { /* already destroyed */ }
  }
});
