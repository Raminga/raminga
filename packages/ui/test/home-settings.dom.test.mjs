// P1 DOM coverage: Agent-led home, three primary pages, settings sub-pages and
// the contact-home structure. These tests assert real/empty semantics, not
// decorative copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';
import { buildHomeAgentModel } from '../src/pages/home-agent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
const PEER_B = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label}${last ? `: ${last}` : ''}`);
}

function setFileInput(dom, input, bytes, name, type = 'image/png') {
  const file = new dom.window.File([new Uint8Array(bytes)], name, { type });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  return file;
}

const journey = (overrides = {}) => ({
  state: 'available',
  at: Date.now(),
  freshness: 'live',
  persona: { state: 'available', markdown: '# 稳定人格\n\n私有人设正文。', error: '', sha256: 'a'.repeat(64) },
  growth: { state: 'available', markdown: '# 成长\n\n私密成长正文。', error: '', sha256: 'b'.repeat(64) },
  sessions: [{
    id: 's1', dirModifiedAt: Date.now(), stateRead: 'available', stateError: '',
    state: {
      status: 'running', mode: 'explore', intent: '拜访像素旅人',
      startedAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:01:00Z', completedAt: '',
      completionReason: '', currentPeerId: PEER_A, visitedPeerIds: [PEER_A], discoverySources: [],
    },
    eventsRead: 'missing', eventsError: '', events: [], eventsTruncated: false, badEventLines: 0,
    reportRead: 'missing', reportError: '', reportMarkdown: '',
  }],
  sessionsState: 'available', sessionsError: '', sessionsTruncated: false,
  ...overrides,
});

const mine = (overrides = {}) => ({
  peerId: 'local-peer-id',
  at: Date.now(),
  error: null,
  errorAt: null,
  freshness: 'live',
  profile: { state: 'available', markdown: '# Alice\n\n喜欢地图与远方。', displayName: 'Alice', error: '', path: 'profile/index.md', at: 1 },
  posts: { state: 'available', posts: [], error: '', unattributed: 0, agentAuthored: 0, invalid: 0, errors: [], truncated: false },
  agentCard: {
    state: 'available',
    card: {
      schemaVersion: 1, displayName: 'Nova', description: '喜欢探索未知地图。',
      interests: ['地图', '天文'], conversationStyle: '简短、好奇', updatedAt: '2026-11-14T10:00:00Z',
      path: 'profile/agent-card.json', sha256: 'c'.repeat(64),
    },
    error: '',
  },
  publicProfile: { state: 'missing', profile: null, error: '本机还没有公开资料 profile.json' },
  files: [], filesTruncated: false,
  ...overrides,
});

const peerProfileData = (overrides = {}) => ({
  peerId: PEER_B, localName: 'Bob', remoteName: 'Bob', found: true,
  text: '# Bob\n\n关联人类介绍。', files: [], at: Date.now(), error: null, freshness: 'live',
  agentCard: { state: 'missing', card: null, error: 'missing' },
  manifest: { peerId: PEER_B, publisherName: 'Bob', source: 'remote', at: Date.now(), entries: [], error: null, errorAt: null, freshness: 'live', truncated: false, total: 0 },
  node: null,
  ...overrides,
});

const contactList = () => ({
  friends: [{ peerId: PEER_B, name: 'Bob', description: '地图朋友', connection: 'connected', paused: false }],
  at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
});

function mountUi(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const host = dom.window.document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = template;
  for (const dialog of shadow.querySelectorAll('dialog')) {
    if (typeof dialog.showModal === 'function') continue;
    dialog.showModal = function showModal() { this.open = true; };
    dialog.close = function close() {
      if (!this.open) return;
      this.open = false;
      this.dispatchEvent(new dom.window.Event('close'));
    };
  }
  globalThis.AbortController = dom.window.AbortController;
  globalThis.document = dom.window.document;
  const viewState = options.viewState ?? {};
  const app = createRamingaApp(shadow, {
    onLoadMine: async () => mine(),
    onLoadJourney: async () => journey(),
    ...options,
    viewState,
  });
  app.onLeaseReady();
  return {
    dom, shadow, app, viewState,
    click(selector) {
      const node = shadow.querySelector(selector);
      assert.ok(node, `missing ${selector}`);
      node.click();
      return node;
    },
    text(selector) { return shadow.querySelector(selector)?.textContent ?? ''; },
    close() { app.destroy(); dom.window.close(); },
  };
}

test('default route is the Agent-led home and primary navigation has exactly three pages', async () => {
  const ui = mountUi();
  try {
    await settle();
    assert.equal(ui.shadow.querySelector('#page-home').hidden, false);
    assert.equal(ui.shadow.querySelector('#page-explore').hidden, true);
    const buttons = [...ui.shadow.querySelectorAll('#desktopNav button[data-nav]')];
    assert.deepEqual(buttons.map((button) => button.dataset.nav), ['explore', 'home', 'contacts']);
    assert.equal(buttons.filter((button) => button.getAttribute('aria-current') === 'page').length, 1);
    assert.equal(buttons.find((button) => button.getAttribute('aria-current') === 'page').dataset.nav, 'home');
    assert.equal(ui.shadow.querySelector('#mobileNav button[aria-current="page"]').dataset.nav, 'home');
    const homeButton = buttons.find((button) => button.dataset.nav === 'home');
    assert.equal(homeButton.getAttribute('aria-label'), '主页');
    assert.match(homeButton.querySelector('img').getAttribute('src'), /raminga-mark-gradient\.svg/);
    assert.equal(homeButton.textContent.trim(), '主页', 'the brand mark keeps a visually hidden accessible label');
    const actions = [...ui.shadow.querySelector('.rm-topbar-actions').children].map((node) => node.id);
    assert.deepEqual(actions, ['nodeTrigger', 'settingsTrigger'], 'node status precedes the settings gear');
    assert.equal(ui.shadow.querySelector('#settingsTrigger').getAttribute('aria-label'), '设置');

    const gear = ui.shadow.querySelector('#settingsTrigger');
    gear.focus();
    gear.click();
    await settle();
    assert.equal(ui.shadow.querySelector('#page-settings').hidden, false);
    assert.equal(gear.getAttribute('aria-current'), 'page');
    ui.click('#settingsClose');
    await settle(30);
    assert.equal(ui.shadow.querySelector('#page-home').hidden, false);
    assert.equal(gear.hasAttribute('aria-current'), false);

    const hero = ui.shadow.querySelector('#home-agent-hero');
    const human = ui.shadow.querySelector('#home-human-strip');
    assert.ok(hero.compareDocumentPosition(human) & ui.dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'Agent hero precedes the human strip');
    assert.equal(ui.text('#homeAgentName'), 'Nova');
    assert.match(ui.text('#homeAgentBio'), /喜欢探索未知地图/);
    assert.match(ui.text('#homeAgentInterests'), /地图/);
    assert.match(ui.text('#homeAgentStyle'), /简短、好奇/);
    assert.match(ui.text('#mineIdentitySummary'), /喜欢地图与远方/);
    assert.doesNotMatch(ui.text('#page-home'), /私有人设正文|私密成长正文/);
    assert.doesNotMatch(ui.text('#page-home'), /公开主页|Agent 资料|收藏.*tab/i);
    assert.equal(hero.querySelectorAll('[role="tablist"]').length, 0);
  } finally {
    ui.close();
  }
});

test('home activity only shows the latest saved Journey record and marks unfinished records pending', async () => {
  const stale = Date.parse('2020-01-01T00:00:00Z');
  for (const updatedAt of [stale, Date.now()]) {
    const ui = mountUi({
      onLoadJourney: async () => journey({
        sessions: [{
          ...journey().sessions[0],
          state: { ...journey().sessions[0].state, updatedAt: new Date(updatedAt).toISOString() },
        }],
      }),
    });
    try {
      await settle();
      assert.equal(ui.shadow.querySelector('#homeActivityLive').hidden, true, 'no live visit card exists without a tool call');
      const recent = ui.shadow.querySelector('#homeActivityRecent');
      assert.equal(recent.hidden, false);
      assert.doesNotMatch(recent.textContent, /正在访问|正在漫游/);
      assert.match(recent.textContent, /最近记录/);
      assert.match(recent.textContent, /待确认/);
      assert.match(recent.textContent, /最后保存/);
      assert.doesNotMatch(ui.text('#homeAgentStatusText'), /正在访问|正在漫游/);
      assert.match(ui.text('#homeAgentStatusText'), /最近记录 · 待确认/);
      assert.equal(ui.shadow.querySelectorAll('#ramingaSessionList .rm-journey-tile').length, 0, 'the featured record is not duplicated in the grid');
      assert.match(ui.text('#home-activity'), /待确认/);
      assert.doesNotMatch(ui.text('#home-activity'), /正在访问|正在漫游/);

      // The card opens the independent Journey detail with the raw recorded
      // status; the P1 confirmation label remains the only live-looking status.
      assert.equal(ui.shadow.querySelector('#homeActivityToggle').hidden, false);
      recent.click();
      await settle();
      assert.equal(ui.shadow.querySelector('#page-journey').hidden, false);
      assert.match(ui.text('#journeyDetail'), /记录状态/);
      assert.match(ui.text('#journeyDetail'), /运行中/);
      assert.ok(ui.shadow.querySelector('#journeyDetail .rm-journey-detail-head'));
      ui.click('#journeyBack');
      await settle();
      assert.equal(ui.shadow.querySelector('#page-home').hidden, false);
    } finally {
      ui.close();
    }
  }

  const empty = mountUi({ onLoadJourney: async () => journey({ sessions: [], sessionsState: 'missing' }) });
  try {
    await settle();
    assert.equal(empty.shadow.querySelector('#homeActivityEmpty').hidden, false);
    assert.equal(empty.shadow.querySelector('#homeActivityRecent').hidden, true);
    assert.equal(empty.shadow.querySelector('#homeActivityLive').hidden, true);
    assert.match(empty.text('#homeActivityEmpty'), /暂无活动记录/);
    assert.match(empty.text('#homeAgentStatusText'), /暂无活动记录/);
    assert.doesNotMatch(empty.text('#homeAgentStatusText'), /休息|暂停|正在/);
  } finally {
    empty.close();
  }

  const missing = mountUi({ onLoadJourney: async () => { throw new Error('读取失败'); } });
  try {
    await settle();
    assert.match(missing.text('#homeActivityRecent'), /没有读到活动记录/);
    assert.doesNotMatch(missing.text('#homeAgentStatusText'), /休息|暂停|正在/);
    assert.match(missing.text('#homeAgentStatusText'), /活动记录读取失败/);
  } finally {
    missing.close();
  }
});

test('settings private editor saves Markdown with SHA-256 and preserves input on conflict', async () => {
  const calls = [];
  let conflict = true;
  const ui = mountUi({
    onSavePrivateAgent: async (field, content, expectedSha256) => {
      calls.push({ field, content, expectedSha256 });
      if (conflict) return { saved: false, conflict: true, sha256: '', error: '文件已在别处修改，未覆盖；请重新读取后再保存' };
      return { saved: true, field, sha256: 'd'.repeat(64), savedAt: Date.now(), backupName: 'persona.md.bak-1' };
    },
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    assert.equal(ui.shadow.querySelector('#page-settings').hidden, false);
    assert.equal(ui.shadow.querySelector('#settingsIndex').hidden, false);
    assert.equal(ui.shadow.querySelector('#settings-public').hidden, true);
    ui.click('[data-settings-tab="private"]');
    await settle();
    assert.equal(ui.shadow.querySelector('#settings-private').hidden, false);
    assert.match(ui.text('#settings-private'), /仅本机可见/);
    assert.equal(ui.shadow.querySelector('#settingsStableInput').value, '# 稳定人格\n\n私有人设正文。');
    assert.doesNotMatch(ui.text('#page-settings'), /Persona/);

    const input = ui.shadow.querySelector('#settingsStableInput');
    input.value = '# 新人格\n\n只在本机。';
    input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.click('#settingsStableSave');
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].field, 'persona');
    assert.equal(calls[0].content, '# 新人格\n\n只在本机。');
    assert.equal(calls[0].expectedSha256, 'a'.repeat(64));
    assert.equal(input.value, '# 新人格\n\n只在本机。', 'conflict keeps the typed text');
    assert.match(ui.text('#settingsPrivateNote'), /已在别处修改/);

    conflict = false;
    ui.click('#settingsStableSave');
    await settle();
    assert.equal(calls.length, 2);
    assert.match(ui.text('#settingsPrivateNote'), /已保存 persona\.md/);
    assert.match(ui.text('#settingsPrivateNote'), /dddddddddddd/);
    assert.equal(input.value, '# 新人格\n\n只在本机。', 'saved input remains visible');
  } finally {
    ui.close();
  }
});

test('public settings exposes real private draft fields and keeps the public-file surface', async () => {
  const draft = {
    draftId: 'profile', kind: 'profile', revision: 3,
    agentName: 'Nova', agentDescription: '草稿里的 Agent 介绍', agentInterests: ['地图'],
    agentConversationStyle: '好奇', humanName: 'Alice', humanBioMarkdown: '草稿里的人类介绍',
    avatar: null, title: '', bodyMarkdown: '', tags: [], images: [],
    publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
  };
  const ui = mountUi({
    onLoadPublicDraft: async () => ({ found: true, draft }),
    onSavePublicDraft: async () => ({ draft }),
    onPublishPublicDraft: async () => ({ status: 'published', error: '', files: [], manifestSha256: 'd'.repeat(64) }),
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#settings-public').hidden, false);
    for (const id of ['publicAgentName', 'publicAgentDescription', 'publicAgentInterests', 'publicAgentStyle', 'publicHumanName', 'publicHumanBio']) {
      assert.ok(ui.shadow.querySelector(`#${id}`), `missing public profile field ${id}`);
    }
    assert.match(ui.text('#settings-public'), /草稿仅本机可见/);
    assert.match(ui.text('#settings-public'), /尚未发布/);
    assert.doesNotMatch(ui.text('#settings-public'), /暂未开放/);
    assert.equal(ui.shadow.querySelector('#publicAgentName').value, 'Nova');
    assert.equal(ui.shadow.querySelector('#publicHumanName').value, 'Alice');
    assert.ok(ui.shadow.querySelector('#minePostList'));
    assert.ok(ui.shadow.querySelector('#mineRefresh'));
    assert.equal(ui.shadow.querySelector('#favoritesEntry').hidden, true, 'P1 does not show an empty favorites shell');
  } finally {
    ui.close();
  }
});

test('public profile confirms once, reuses the request on timeout, and creates a new request after a fresh check', async () => {
  const calls = [];
  let draft = {
    draftId: 'profile', kind: 'profile', revision: 0,
    agentName: 'Nova', agentDescription: '公开介绍', agentInterests: ['地图'],
    agentConversationStyle: '好奇', humanName: 'Alice', humanBioMarkdown: '人类介绍',
    avatar: null, title: '', bodyMarkdown: '', tags: [], images: [],
    publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
  };
  const ui = mountUi({
    onLoadPublicDraft: async () => ({ found: true, draft }),
    onSavePublicDraft: async (input) => {
      calls.push({ kind: 'save', input });
      draft = { ...draft, ...input, revision: draft.revision + 1, agentInterests: [...(input.agentInterests || [])], updatedAtUnixMs: Date.now() };
      return { draft };
    },
    onPublishPublicDraft: async (draftId, revision, sha, requestId) => {
      calls.push({ kind: 'publish', draftId, revision, sha, requestId });
      if (calls.filter((call) => call.kind === 'publish').length === 1) {
        draft = { ...draft, publishedSha256: 'f'.repeat(64), publishedRevision: revision };
        throw new Error('RPC deadline exceeded');
      }
      return {
        requestId,
        status: 'published', error: '', currentRevision: revision,
        currentPublishedSha256: 'f'.repeat(64),
        files: [{ path: 'profile/profile.json', sizeBytes: 123, sha256: 'f'.repeat(64) }],
        manifestVersion: 1, manifestGeneratedAtUnixMs: Date.now(),
        postPath: '', profilePath: 'profile/profile.json', warnings: [], manifestSha256: 'e'.repeat(64),
      };
    },
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle();
    const name = ui.shadow.querySelector('#publicAgentName');
    assert.equal(name.value, 'Nova');
    name.value = 'Nova 2';
    name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    const interests = ui.shadow.querySelector('#publicAgentInterests');
    interests.value = '地图，天文';
    interests.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.click('#publicDraftSave');
    await settle();
    await settle();
    const save = calls.find((call) => call.kind === 'save');
    assert.ok(save, 'save callback ran');
    assert.equal(save.input.draftId, 'profile');
    assert.equal(save.input.kind, 'profile');
    assert.equal(save.input.agentName, 'Nova 2');
    assert.deepEqual(save.input.agentInterests, ['地图', '天文']);
    assert.equal(save.input.expectedRevision, 0);
    assert.match(ui.text('#publicDraftMeta'), /revision 1/);

    ui.click('#publicPublishButton');
    await settle();
    await settle();
    assert.equal(calls.filter((call) => call.kind === 'publish').length, 0, 'first click only confirms');
    assert.match(ui.text('#publicPublishReceipt'), /确认后才会公开/);
    assert.match(ui.text('#publicPublishButton'), /确认发布/);
    ui.click('#publicPublishButton');
    await settle();
    await settle();
    const publish = calls.find((call) => call.kind === 'publish');
    assert.ok(publish, 'publish callback ran');
    assert.equal(publish.draftId, 'profile');
    assert.equal(publish.revision, 1);
    assert.equal(publish.sha, '');
    assert.ok(publish.requestId);
    assert.equal(ui.text('#publicPublishButton'), '重试本次发布');
    // A second panel has published a newer version since the response was lost.
    draft = { ...draft, publishedSha256: 'a'.repeat(64) };
    ui.click('#publicPublishButton');
    await settle();
    await settle();
    const retry = calls.filter((call) => call.kind === 'publish')[1];
    assert.deepEqual(retry, publish);
    assert.match(ui.text('#publicPublishReceipt'), /已确认本次发布，当前公开版本已有更新/);
    assert.match(ui.text('#publicPublishReceiptDetails'), /profile\/profile\.json/);
    assert.match(ui.text('#publicPublishReceiptDetails'), /e{12}/);

    ui.click('#publicPublishButton');
    await settle();
    assert.equal(calls.filter((call) => call.kind === 'publish').length, 2, 'rechecking does not publish');
    ui.click('#publicPublishButton');
    await settle();
    const fresh = calls.filter((call) => call.kind === 'publish')[2];
    assert.ok(fresh.requestId);
    assert.notEqual(fresh.requestId, publish.requestId);
    assert.equal(fresh.sha, 'a'.repeat(64));
  } finally {
    ui.close();
  }
});


test('settings index separates public editing, public files, private spaces and node', async () => {
  const ui = mountUi({
    onLoadMine: async () => mine({
      files: [{
        id: 'hello', peerId: 'local-peer-id', publisherName: 'Alice', path: 'hello.md', name: 'hello.md',
        sha256: 'a'.repeat(64), sizeBytes: 20, modifiedAt: 0, fetchedAt: 0,
        source: 'local-public', sources: ['local-public'], kind: 'markdown', mime: 'text/markdown',
        previewable: true, summary: '一封公开纸条', tags: [], contentState: 'available', contentError: '',
      }],
    }),
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    const labels = [...ui.shadow.querySelectorAll('#settingsIndex .rm-settings-copy b')].map((node) => node.textContent);
    assert.deepEqual(labels, [
      '公开资料编辑', '我的公开文件', 'Agent 私有人设与成长', '私有社交记忆', '收藏的动态', '节点与连接',
    ]);
    assert.doesNotMatch(ui.text('#settingsIndex'), /persona\.md|growth\.md/, 'index uses task copy, not file names');
    assert.ok(ui.shadow.querySelector('#settingsIndex [data-settings-tab="public"]'));
    assert.ok(ui.shadow.querySelector('#settingsIndex [data-settings-tab="files"]'));
    assert.match(ui.text('#settingsIndex'), /草稿和收藏只保存在本机/);

    ui.click('[data-settings-tab="files"]');
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#settings-files').hidden, false);
    assert.equal(ui.shadow.querySelector('#settings-public').hidden, true);
    assert.equal(ui.shadow.querySelector('#settings-files').querySelector('#settingsFilesHeading').textContent, '已发布的文件');
    assert.match(ui.text('#minePostList'), /一封公开纸条/);
    ui.click('#settings-files [data-settings-back]');
    await settle();
    assert.equal(ui.shadow.querySelector('#settingsIndex').hidden, false);

    ui.click('[data-settings-tab="private"]');
    await settle();
    assert.equal(ui.shadow.querySelector('#settings-private').hidden, false);
    assert.match(ui.text('#settings-private'), /仅本机可见/);
    assert.match(ui.text('#settings-private'), /agent\/persona\.md/);
    assert.match(ui.text('#settings-private'), /0700\/0600/);
    ui.click('#settings-private [data-settings-back]');
    await settle();
    assert.equal(ui.shadow.querySelector('#settingsIndex').hidden, false);

    ui.click('[data-settings-tab="node"]');
    await settle();
    assert.equal(ui.shadow.querySelector('#settings-node').hidden, false);
    ui.click('#settings-node [data-settings-back]');
    await settle();
    assert.equal(ui.shadow.querySelector('#settingsIndex').hidden, false);
  } finally {
    ui.close();
  }
});

test('public editor shows old published values, real avatar and a restorable secondary preview', async () => {
  const avatarSha = 'a'.repeat(64);
  const avatarPath = `profile/avatar-${avatarSha.slice(0, 8)}.png`;
  const publicProfile = {
    schemaVersion: 2,
    agentName: '旧 Agent', agentDescription: '旧简介', agentInterests: ['天文', '地图'],
    agentConversationStyle: '旧风格', humanName: '旧人类', humanBioMarkdown: '旧人类介绍',
    avatarPath, avatarSha256: avatarSha, avatarMime: 'image/png',
    updatedAt: '2026-11-01T08:00:00Z', path: 'profile/profile.json', sha256: 'f'.repeat(64),
  };
  const avatarFile = {
    id: 'avatar', peerId: 'local-peer-id', publisherName: 'Alice', path: avatarPath, name: 'avatar.png',
    sha256: avatarSha, sizeBytes: 24, modifiedAt: 0, fetchedAt: 0, source: 'local-public', sources: ['local-public'],
    kind: 'image', mime: 'image/png', previewable: true, summary: '', tags: [], contentState: 'available', contentError: '',
  };
  const data = mine({
    publicProfile: { state: 'available', profile: publicProfile, error: '' },
    agentCard: {
      state: 'available',
      card: { ...mine().agentCard.card, displayName: '旧 Agent', description: '旧简介', avatarPath, avatarSha256: avatarSha, avatarMime: 'image/png' },
      error: '',
    },
    files: [avatarFile],
  });
  const ui = mountUi({
    onLoadMine: async () => data,
    onLoadMineFileContent: async (filePath, sha256) => {
      assert.equal(filePath, avatarPath);
      assert.equal(sha256, avatarSha);
      return { status: 'ok', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,b2xkLWF2YXRhcg==' };
    },
    onLoadPublicDraft: async () => ({ found: false }),
    onSavePublicDraft: async (input) => ({ draft: { ...input, draftId: 'profile', revision: 1, avatar: null, updatedAtUnixMs: Date.now() } }),
  });
  try {
    await settle();
    await settle(10);
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle(10);

    assert.equal(ui.shadow.querySelector('#publicAgentName').value, '旧 Agent');
    assert.equal(ui.shadow.querySelector('#publicAgentDescription').value, '旧简介');
    assert.equal(ui.shadow.querySelector('#publicAgentInterests').value, '天文，地图');
    assert.equal(ui.shadow.querySelector('#publicAgentStyle').value, '旧风格');
    assert.equal(ui.shadow.querySelector('#publicHumanName').value, '旧人类');
    assert.equal(ui.shadow.querySelector('#publicHumanBio').value, '旧人类介绍');
    assert.match(ui.shadow.querySelector('#publicAvatarPreview img').getAttribute('src'), /^data:image\/png/);
    assert.equal(ui.shadow.querySelector('#publicVersionDetails').open, false, 'published preview is secondary');
    assert.equal(ui.text('#publicVersionName'), '旧 Agent');
    assert.match(ui.text('#publicVersionNote'), /profile\/profile\.json/);
    assert.match(ui.text('#publicDraftMeta'), /profile\/profile\.json/);
    assert.match(ui.text('#publicDraftMeta'), /ffffffffffff/);
    assert.equal(ui.shadow.querySelector('#publicRestorePublished').disabled, false);

    const name = ui.shadow.querySelector('#publicAgentName');
    name.value = '恢复前的新名字';
    name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    assert.match(ui.text('#publicDraftStatus'), /有未保存修改/);
    ui.click('#publicRestorePublished');
    await settle();
    await settle(10);
    assert.equal(name.value, '旧 Agent');
    assert.match(ui.text('#publicDraftStatus'), /已恢复公开版本/);
    assert.match(ui.text('#publicDraftStatus'), /有未保存修改/);
  } finally {
    ui.close();
  }
});

test('saving a synthesized profile imports the existing public avatar into the private draft', async () => {
  const avatarSha = 'b'.repeat(64);
  const avatarPath = `profile/avatar-${avatarSha.slice(0, 8)}.png`;
  const data = mine({
    publicProfile: {
      state: 'available',
      profile: {
        schemaVersion: 2, agentName: '旧 Agent', agentDescription: '旧简介', agentInterests: ['天文'],
        agentConversationStyle: '旧风格', humanName: '旧人类', humanBioMarkdown: '旧介绍',
        avatarPath, avatarSha256: avatarSha, avatarMime: 'image/png',
        updatedAt: '2026-11-01T08:00:00Z', path: 'profile/profile.json', sha256: 'f'.repeat(64),
      },
      error: '',
    },
    agentCard: {
      state: 'available',
      card: { ...mine().agentCard.card, displayName: '旧 Agent', avatarPath, avatarSha256: avatarSha, avatarMime: 'image/png' },
      error: '',
    },
    files: [{
      id: 'avatar', peerId: 'local-peer-id', publisherName: 'Alice', path: avatarPath, name: 'avatar.png',
      sha256: avatarSha, sizeBytes: 24, modifiedAt: 0, fetchedAt: 0, source: 'local-public', sources: ['local-public'],
      kind: 'image', mime: 'image/png', previewable: true, summary: '', tags: [], contentState: 'available', contentError: '',
    }],
  });
  const saves = [];
  const uploads = [];
  const ui = mountUi({
    onLoadMine: async () => data,
    onLoadMineFileContent: async () => ({
      status: 'ok', kind: 'image', mime: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==',
    }),
    onLoadPublicDraft: async () => ({ found: false }),
    onSavePublicDraft: async (input) => {
      saves.push(input);
      const revision = saves.length;
      return {
        draft: {
          draftId: 'profile', kind: 'profile', revision,
          avatar: input.avatarAssetId ? { assetId: input.avatarAssetId, sha256: avatarSha, mime: 'image/png', width: 1, height: 1, sizeBytes: 68 } : null,
          ...input, expectedRevision: undefined, updatedAtUnixMs: Date.now(),
        },
      };
    },
    onPutPublicDraftImage: async (draftId, role, filename, base64) => {
      uploads.push({ draftId, role, filename, base64Length: base64.length });
      return { image: { assetId: 'asset-old-avatar', sha256: avatarSha, mime: 'image/png', width: 1, height: 1, sizeBytes: 68 } };
    },
  });
  try {
    await settle();
    await settle(10);
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle(10);
    ui.click('#publicDraftSave');
    await settle();
    await settle();
    await settle();
    await settle(10);
    assert.equal(saves.length, 2, `the draft text save is followed by the imported avatar save (saves=${saves.length}, uploads=${uploads.length}, status=${ui.text('#publicDraftStatus')})`);
    assert.equal(saves[0].avatarAssetId, '');
    assert.equal(saves[0].agentName, '旧 Agent');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].role, 'avatar');
    assert.equal(saves[1].expectedRevision, 1);
    assert.equal(saves[1].avatarAssetId, 'asset-old-avatar');
    assert.match(ui.text('#publicDraftStatus'), /草稿已保存/);
    assert.match(ui.text('#publicDraftMeta'), /revision 2/);
    assert.match(ui.shadow.querySelector('#publicAvatarPreview img').getAttribute('src'), /^data:image\/png/);
  } finally {
    ui.close();
  }
});

test('a late profile save cannot clear newer typing and the next save uses the returned revision', async () => {
  const baseDraft = {
    draftId: 'profile', kind: 'profile', revision: 0,
    agentName: '初始', agentDescription: '', agentInterests: [], agentConversationStyle: '',
    humanName: '人类', humanBioMarkdown: '', avatar: null, title: '', bodyMarkdown: '',
    tags: [], images: [], publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
  };
  const first = deferred();
  const calls = [];
  const ui = mountUi({
    onLoadPublicDraft: async () => ({ found: true, draft: baseDraft }),
    onSavePublicDraft: async (input) => {
      calls.push(input);
      if (calls.length === 1) {
        const release = await first.promise;
        return { draft: { ...baseDraft, ...input, revision: 1, updatedAtUnixMs: Date.now(), avatar: release.avatar || null } };
      }
      return { draft: { ...baseDraft, ...input, revision: 2, updatedAtUnixMs: Date.now() } };
    },
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle();
    const name = ui.shadow.querySelector('#publicAgentName');
    name.value = '保存中的旧输入';
    name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.click('#publicDraftSave');
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].expectedRevision, 0);

    name.value = '保存后继续输入的新内容';
    name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    first.resolve({ avatar: null });
    await settle();
    await settle();
    assert.equal(name.value, '保存后继续输入的新内容', 'late save result must not replace newer input');
    assert.match(ui.text('#publicDraftStatus'), /有未保存修改/);
    assert.match(ui.text('#publicDraftMeta'), /revision 1/);

    ui.click('#publicDraftSave');
    await settle();
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].expectedRevision, 1);
    assert.equal(calls[1].agentName, '保存后继续输入的新内容');
  } finally {
    ui.close();
  }
});

test('profile confirmation is invalidated by text and avatar changes, cancel keeps the draft, and publishing locks the form', async () => {
  const baseDraft = {
    draftId: 'profile', kind: 'profile', revision: 1,
    agentName: 'Nova', agentDescription: '简介', agentInterests: ['天文'], agentConversationStyle: '好奇',
    humanName: 'Alice', humanBioMarkdown: '介绍',
    avatar: { assetId: 'avatar-1', sha256: 'a'.repeat(64), mime: 'image/png', width: 1, height: 1, sizeBytes: 68 },
    title: '', bodyMarkdown: '', tags: [], images: [], publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
  };
  const publish = deferred();
  let saves = 0;
  let publishes = 0;
  const ui = mountUi({
    onLoadPublicDraft: async () => ({ found: true, draft: baseDraft }),
    onSavePublicDraft: async (input) => {
      saves += 1;
      return { draft: {
        ...baseDraft, ...input, revision: 2 + saves, updatedAtUnixMs: Date.now(),
        avatar: input.clearAvatar ? null : baseDraft.avatar,
      } };
    },
    onPublishPublicDraft: async (draftId, revision) => {
      publishes += 1;
      return publish.promise;
    },
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle();
    ui.click('#publicPublishButton');
    await settle();
    await settle();
    assert.equal(publishes, 0);
    assert.match(ui.text('#publicPublishButton'), /确认发布/);
    assert.equal(ui.shadow.querySelector('#publicPublishCancel').hidden, false);

    const name = ui.shadow.querySelector('#publicAgentName');
    name.value = '修改后的 Nova';
    name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    assert.match(ui.text('#publicPublishButton'), /检查发布内容/);
    assert.equal(ui.shadow.querySelector('#publicPublishCancel').hidden, true);

    ui.click('#publicPublishButton');
    await settle();
    await settle();
    ui.click('#publicAvatarClear');
    await settle();
    await settle();
    assert.match(ui.text('#publicPublishButton'), /检查发布内容/);
    assert.match(ui.text('#publicDraftStatus'), /有未保存修改/);

    ui.click('#publicPublishButton');
    await settle();
    await settle();
    assert.match(ui.text('#publicPublishButton'), /确认发布/, ui.text('#publicDraftStatus') + ' / ' + ui.text('#publicPublishReceipt'));
    ui.click('#publicPublishCancel');
    await settle();
    assert.equal(publishes, 0);
    assert.equal(ui.shadow.querySelector('#publicPublishCancel').hidden, true);
    assert.match(ui.text('#publicPublishButton'), /检查发布内容/);

    ui.click('#publicPublishButton');
    await settle();
    await settle();
    ui.click('#publicPublishButton');
    await settle();
    assert.equal(publishes, 1);
    assert.match(ui.text('#publicPublishButton'), /正在发布/);
    assert.equal(name.disabled, true);
    assert.equal(ui.shadow.querySelector('#publicDraftSave').disabled, true);

    publish.resolve({
      status: 'published', error: '', currentRevision: 4, currentPublishedSha256: 'f'.repeat(64),
      files: [{ path: 'profile/profile.json', sizeBytes: 200, sha256: 'f'.repeat(64) }],
      manifestVersion: 1, manifestGeneratedAtUnixMs: Date.now(), postPath: '', profilePath: 'profile/profile.json',
      warnings: [], manifestSha256: 'e'.repeat(64),
    });
    await settle();
    await settle();
    assert.equal(name.disabled, false);
    assert.equal(ui.shadow.querySelector('#publicDraftSave').disabled, false);
    assert.match(ui.text('#publicPublishReceipt'), /发布完成/);
    assert.match(ui.text('#publicPublishReceiptDetails'), /profile\/profile\.json/);
    assert.match(ui.text('#publicPublishStatus'), /已发布/);
  } finally {
    ui.close();
  }
});

test('manual post editor defaults to the human and never silently uses Agent', async () => {
  const calls = [];
  let draft = null;
  const ui = mountUi({
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => {
      calls.push(input);
      draft = {
        ...input,
        draftId: draft?.draftId || 'draft-9-abcdef123456',
        revision: draft ? draft.revision + 1 : 0,
        images: [], avatar: null, publishedSha256: '', publishedRevision: 0,
        publishedPath: '', tags: [...(input.tags || [])],
      };
      return { draft };
    },
    onPublishPublicDraft: async (draftId, revision) => ({
      status: 'published', error: '', currentRevision: revision, currentPublishedSha256: 'd'.repeat(64),
      files: [{ path: `posts/${draftId.replace(/^draft-/, 'post-')}/post.json`, sizeBytes: 10, sha256: 'd'.repeat(64) }],
      manifestVersion: 1, manifestGeneratedAtUnixMs: Date.now(), postPath: '', profilePath: '', warnings: [], manifestSha256: 'c'.repeat(64),
    }),
  });
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    assert.equal(ui.shadow.querySelector('#postAuthorKind').value, 'user');
    assert.match(ui.text('#postAuthorNote'), /来源详情.*本人.*署名/);
    assert.match(ui.text('#postAuthorNote'), /页头显示发布节点公开的 Agent 名称和头像/);
    assert.doesNotMatch(ui.text('#postAuthorNote'), /不会默认|默认标成|Agent 等/);
    ui.shadow.querySelector('#postTitleInput').value = '手写动态';
    ui.shadow.querySelector('#postBodyInput').value = '正文';
    ui.click('#postDraftSave');
    await settle();
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'post');
    assert.equal(calls[0].authorKind, 'user');
    assert.equal(calls[0].expectedRevision, 0);

    ui.shadow.querySelector('#postAuthorKind').value = 'agent';
    ui.shadow.querySelector('#postAuthorKind').dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    ui.click('#postDraftSave');
    await settle();
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].authorKind, 'agent');
    assert.equal(calls[1].expectedRevision, 0, 'the adapter reloads the created draft revision');

    ui.click('#postPublishButton');
    await settle();
    await settle();
    assert.match(ui.text('#postPublishReceipt'), /将.*Agent.*署名发布/);
    ui.click('#postPublishButton');
    await settle();
    await settle();
    assert.match(ui.text('#postPublishReceipt'), /发布完成/);
    assert.match(ui.text('#postPublishReceipt'), /post-9-abcdef123456\/post\.json/);
  } finally {
    ui.close();
  }
});

test('a conflicting profile save keeps local input and offers no silent overwrite', async () => {
  const draft = {
    draftId: 'profile', kind: 'profile', revision: 4,
    agentName: 'Old', agentDescription: '', agentInterests: [], agentConversationStyle: '',
    humanName: 'Human', humanBioMarkdown: '', avatar: null, title: '', bodyMarkdown: '',
    tags: [], images: [], publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
  };
  const ui = mountUi({
    onLoadPublicDraft: async () => ({ found: true, draft }),
    onSavePublicDraft: async () => { throw new Error('failed_precondition: draft revision conflict'); },
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle();
    const name = ui.shadow.querySelector('#publicAgentName');
    name.value = 'Local edit';
    name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.click('#publicDraftSave');
    await settle();
    await settle();
    assert.equal(name.value, 'Local edit', 'typed input survives conflict');
    assert.match(ui.text('#publicDraftStatus'), /草稿已在别处更新/);
  } finally {
    ui.close();
  }
});

test('a failed avatar save advances the draft baseline and a valid retry needs no reload', async () => {
  const oldAvatar = {
    assetId: 'avatar-old', sha256: 'b'.repeat(64), mime: 'image/png',
    width: 2, height: 2, sizeBytes: 8,
  };
  let draft = {
    draftId: 'profile', kind: 'profile', revision: 2,
    agentName: '初始名字', agentDescription: '简介', agentInterests: ['地图'], agentConversationStyle: '好奇',
    humanName: '人类', humanBioMarkdown: '介绍', avatar: oldAvatar,
    title: '', bodyMarkdown: '', tags: [], images: [], publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
  };
  const saves = [];
  const uploads = [];
  let published = 0;
  const ui = mountUi({
    onLoadPublicDraft: async () => ({ found: true, draft }),
    onLoadPublicDraftAsset: async (draftId, assetId) => ({
      image: { ...oldAvatar, assetId },
      dataBase64: 'b2xkLWF2YXRhcg==',
    }),
    onSavePublicDraft: async (input) => {
      saves.push({ ...input });
      const { expectedRevision, ...fields } = input;
      draft = {
        ...draft, ...fields,
        revision: draft.revision + 1,
        updatedAtUnixMs: Date.now(),
        avatar: input.clearAvatar
          ? null
          : input.avatarAssetId
            ? { ...oldAvatar, assetId: input.avatarAssetId, sha256: 'c'.repeat(64) }
            : draft.avatar,
      };
      return { draft: { ...draft } };
    },
    onPutPublicDraftImage: async (draftId, role, filename) => {
      uploads.push(filename);
      if (filename === 'broken.png') {
        throw new Error('Invalid argument: [invalid_argument] image_type: 只支持 PNG 或 JPEG 图片');
      }
      return { image: { ...oldAvatar, assetId: 'avatar-new', sha256: 'c'.repeat(64) } };
    },
    onPublishPublicDraft: async () => {
      published += 1;
      throw new Error('unpublished avatar test must not publish');
    },
  });
  try {
    await settle();
    await settle(10);
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle(10);
    const name = ui.shadow.querySelector('#publicAgentName');
    assert.equal(name.value, '初始名字');
    name.value = '坏图后仍保存的文字';
    name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));

    setFileInput(ui.dom, ui.shadow.querySelector('#publicAvatarInput'), [1, 2, 3], 'broken.png');
    ui.click('#publicDraftSave');
    await waitUntil(() => /头像图片.*(?:无法识别|损坏)/.test(ui.text('#publicDraftStatus')), 'friendly image error');
    await waitUntil(() => /revision 3/.test(ui.text('#publicDraftMeta')), 'first save baseline revision');
    assert.equal(name.value, '坏图后仍保存的文字', 'text save survives the image failure');
    assert.match(ui.text('#publicDraftStatus'), /草稿已保存/);
    assert.doesNotMatch(ui.text('#publicDraftStatus'), /草稿已在别处更新|Invalid argument|image_type/);
    assert.match(ui.text('#publicDraftStatus'), /PNG 或 JPEG/);
    assert.equal(ui.shadow.querySelector('#publicAvatarPreview').dataset.empty, 'false', 'old avatar stays visible');
    assert.equal(published, 0);

    setFileInput(ui.dom, ui.shadow.querySelector('#publicAvatarInput'), [0x89, 0x50, 0x4e, 0x47], 'valid.png');
    ui.click('#publicDraftSave');
    await waitUntil(() => /revision 5/.test(ui.text('#publicDraftMeta')), 'valid avatar retry saved');
    assert.equal(saves[0].expectedRevision, 2);
    assert.equal(saves[1].expectedRevision, 3, 'retry uses the advanced baseline');
    assert.equal(saves[2].expectedRevision, 4);
    assert.deepEqual(uploads, ['broken.png', 'valid.png']);
    assert.match(ui.text('#publicDraftStatus'), /草稿已保存/);
    assert.doesNotMatch(ui.text('#publicDraftStatus'), /草稿已在别处更新/);
    assert.equal(published, 0);
  } finally {
    ui.close();
  }
});

test('a late public-avatar import does not replace a newly picked image', async () => {
  const avatarSha = 'e'.repeat(64);
  const avatarPath = `profile/avatar-${avatarSha.slice(0, 8)}.png`;
  const oldAvatar = { assetId: '', sha256: avatarSha, mime: 'image/png', path: avatarPath };
  const data = mine({
    publicProfile: {
      state: 'available',
      profile: {
        schemaVersion: 2, agentName: '旧 Agent', agentDescription: '旧简介', agentInterests: ['天文'],
        agentConversationStyle: '旧风格', humanName: '旧人类', humanBioMarkdown: '旧介绍',
        avatarPath, avatarSha256: avatarSha, avatarMime: 'image/png',
        updatedAt: '2026-11-01T08:00:00Z', path: 'profile/profile.json', sha256: 'f'.repeat(64),
      },
      error: '',
    },
    files: [{
      id: 'avatar', peerId: 'local-peer-id', publisherName: 'Alice', path: avatarPath, name: 'avatar.png',
      sha256: avatarSha, sizeBytes: 24, modifiedAt: 0, fetchedAt: 0, source: 'local-public', sources: ['local-public'],
      kind: 'image', mime: 'image/png', previewable: true, summary: '', tags: [], contentState: 'available', contentError: '',
    }],
  });
  const imported = deferred();
  const saves = [];
  const uploads = [];
  let created = false;
  let draft = null;
  const ui = mountUi({
    onLoadMine: async () => data,
    onLoadMineFileContent: async (filePath) => {
      assert.equal(filePath, avatarPath);
      return imported.promise;
    },
    onLoadPublicDraft: async () => ({ found: false }),
    onSavePublicDraft: async (input) => {
      saves.push({ ...input });
      const { expectedRevision, ...fields } = input;
      draft = {
        ...(draft || {}), ...fields, draftId: 'profile', kind: 'profile',
        revision: created ? (draft?.revision || 0) + 1 : 0,
        updatedAtUnixMs: Date.now(),
        avatar: input.avatarAssetId
          ? { assetId: input.avatarAssetId, sha256: 'd'.repeat(64), mime: 'image/png', width: 2, height: 2, sizeBytes: 8 }
          : (draft?.avatar || null),
      };
      created = true;
      return { draft: { ...draft } };
    },
    onPutPublicDraftImage: async (draftId, role, filename) => {
      uploads.push(filename);
      return { image: { assetId: 'asset-new', sha256: 'd'.repeat(64), mime: 'image/png', width: 2, height: 2, sizeBytes: 8 } };
    },
  });
  try {
    await settle();
    await settle(10);
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle(10);
    assert.equal(ui.shadow.querySelector('#publicAgentName').value, '旧 Agent');
    ui.click('#publicDraftSave');
    await settle();
    await settle();
    assert.ok(imported.promise, 'public avatar import started');
    setFileInput(ui.dom, ui.shadow.querySelector('#publicAvatarInput'), [0x89, 0x50, 0x4e, 0x47], 'new.png');
    imported.resolve({
      status: 'ok', kind: 'image', mime: 'image/png',
      dataUrl: 'data:image/png;base64,b2xkLWF2YXRhcg==',
    });
    await waitUntil(() => uploads.length === 1 && !ui.shadow.querySelector('#publicDraftSave').disabled, 'new avatar save');
    assert.deepEqual(uploads, ['new.png'], 'late old avatar must not win');
    assert.equal(saves[1].avatarAssetId, 'asset-new');
    assert.match(ui.text('#publicDraftStatus'), /草稿已保存/);
  } finally {
    ui.close();
  }
});

test('an external conflict on the avatar save keeps local text and publishes nothing', async () => {
  const oldAvatar = {
    assetId: 'avatar-old', sha256: 'b'.repeat(64), mime: 'image/png',
    width: 2, height: 2, sizeBytes: 8,
  };
  const draft = {
    draftId: 'profile', kind: 'profile', revision: 2,
    agentName: '初始名字', agentDescription: '', agentInterests: [], agentConversationStyle: '',
    humanName: '人类', humanBioMarkdown: '', avatar: oldAvatar, title: '', bodyMarkdown: '',
    tags: [], images: [], publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
  };
  const saves = [];
  let published = 0;
  const ui = mountUi({
    onLoadPublicDraft: async () => ({ found: true, draft }),
    onLoadPublicDraftAsset: async () => ({ image: oldAvatar, dataBase64: 'b2xkLWF2YXRhcg==' }),
    onSavePublicDraft: async (input) => {
      saves.push({ ...input });
      if (saves.length > 1) throw new Error('failed_precondition: draft revision conflict');
      return { draft: { ...draft, ...input, expectedRevision: undefined, revision: 3, updatedAtUnixMs: Date.now() } };
    },
    onPutPublicDraftImage: async () => ({
      image: { assetId: 'avatar-new', sha256: 'c'.repeat(64), mime: 'image/png', width: 2, height: 2, sizeBytes: 8 },
    }),
    onPublishPublicDraft: async () => {
      published += 1;
      throw new Error('conflicted avatar save must not publish');
    },
  });
  try {
    await settle();
    await settle(10);
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle(10);
    const name = ui.shadow.querySelector('#publicAgentName');
    name.value = '本地保留的新文字';
    name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    setFileInput(ui.dom, ui.shadow.querySelector('#publicAvatarInput'), [0x89, 0x50, 0x4e, 0x47], 'valid.png');
    ui.click('#publicDraftSave');
    await waitUntil(() => /草稿已在别处更新/.test(ui.text('#publicDraftStatus')), 'external conflict');
    assert.equal(name.value, '本地保留的新文字');
    assert.match(ui.text('#publicDraftMeta'), /revision 3/);
    assert.equal(ui.shadow.querySelector('#publicAvatarPreview').dataset.empty, 'false', 'old avatar stays visible');
    assert.equal(saves.length, 2);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(saves.length, 2, 'a conflict must not auto-retry and overwrite');
    assert.equal(published, 0);
  } finally {
    ui.close();
  }
});

test('contact home is Agent-led and has interactions, posts and address regions', async () => {
  const ui = mountUi({
    onLoadContacts: async () => ({
      friends: [{ peerId: PEER_B, name: 'Bob', description: '地图朋友', connection: 'connected', paused: false }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
    }),
    onLoadConversations: async () => ({
      conversations: [{
        peerId: PEER_B, lastMessageId: 'm1', direction: 'in', preview: '上次聊到地图',
        lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1, hasMessages: true,
      }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', retention: null,
    }),
    onLoadPeerProfile: async () => ({
      peerId: PEER_B, localName: 'Bob', remoteName: 'Bob', found: true,
      text: '# Bob\n\n关联人类介绍。', files: ['profile/index.md'], at: Date.now(), error: null, freshness: 'live',
      agentCard: {
        state: 'available',
        card: { schemaVersion: 1, displayName: 'Pixel', description: '像素旅人', interests: ['像素'], conversationStyle: '慢', updatedAt: '2026-11-14T10:00:00Z', path: 'profile/agent-card.json', sha256: 'e'.repeat(64) },
        error: '',
      },
      manifest: { state: 'available', source: 'remote', entries: [], error: '', truncated: false },
      node: null,
    }),
    onLoadPeerFriends: async () => ({
      peerId: PEER_B, source: 'remote', at: Date.now(), error: null, limited: false,
      friends: [
        { name: 'Bob', peerId: PEER_B, addrs: [], description: '地图朋友' },
        { name: 'Carol', peerId: PEER_A, addrs: [], description: '公开通讯录里的新线索' },
      ],
    }),
  });
  try {
    ui.app.setContacts({
      friends: [{ peerId: PEER_B, name: 'Bob', description: '地图朋友', connection: 'connected', paused: false }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 1,
    });
    await settle();
    ui.app.setConversations({
      conversations: [{
        peerId: PEER_B, lastMessageId: 'm1', direction: 'in', preview: '上次聊到地图',
        lastAt: Date.now(), deliveryStatus: 'received', origin: 'unknown', messageCount: 1, hasMessages: true,
      }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', retention: null,
    });
    ui.click('button[data-nav="contacts"]');
    await settle();
    assert.match(ui.text('#contactList'), /最近：上次聊到地图/);
    assert.match(ui.text('#contactList'), /刚刚|\d{1,2}:\d{2}/);
    ui.click('#contactList button[data-contact-peer]');
    await settle();
    assert.equal(ui.shadow.querySelector('#profileView').hidden, false);
    assert.equal(ui.text('#profileName'), 'Pixel');
    assert.match(ui.text('#profileAgentDescriptionShort'), /像素旅人/);
    assert.match(ui.text('#profileHumanName'), /Bob/);
    const tabs = [...ui.shadow.querySelectorAll('[data-profile-tab]')];
    assert.deepEqual(tabs.map((tab) => tab.dataset.profileTab), ['interactions', 'posts', 'address']);
    assert.equal(ui.shadow.querySelector('#contactProfileInteractions').hidden, false);
    assert.equal(ui.shadow.querySelector('#contactProfilePosts').hidden, true);
    assert.match(ui.text('#profileInteractionNote'), /暂未开放/);
    ui.click('[data-profile-tab="posts"]');
    assert.equal(ui.shadow.querySelector('#contactProfilePosts').hidden, false);
    ui.click('[data-profile-tab="address"]');
    await settle();
    assert.equal(ui.shadow.querySelector('#contactProfileAddress').hidden, false);
    assert.equal(ui.shadow.querySelector('#contactProfileFiles'), null);
    assert.match(ui.text('#profileFriendList'), /Bob/);
    assert.match(ui.text('#profileFriendList'), /已有联系/);
    assert.match(ui.text('#profileFriendList'), /Carol/);
    assert.match(ui.text('#profileFriendList'), /公开线索/);
    assert.doesNotMatch(ui.text('#profileAddressNote'), /公开文件|P[1-4]/);

    assert.equal(ui.shadow.querySelector('#profileFilesOpen'), null);
    assert.equal(ui.shadow.querySelector('#profileTabsNav').hidden, false);
    assert.equal(ui.shadow.querySelector('#profileNodeInfo'), null);
    assert.ok(ui.shadow.querySelector('#profileOriginDetails #profileCopyPeerInline'));
  } finally {
    ui.close();
  }
});

test('contact address book shows loading, failure and empty states from GetPeerFriends data', async () => {
  const pending = deferred();
  const ui = mountUi({
    onLoadContacts: async () => contactList(),
    onLoadPeerProfile: async () => peerProfileData(),
    onLoadPeerFriends: async () => pending.promise,
  });
  try {
    await settle();
    ui.app.setContacts(contactList());
    ui.click('button[data-nav="contacts"]');
    await settle();
    ui.click('button[data-contact-peer]');
    await settle();
    ui.click('[data-profile-tab="address"]');
    await settle();
    assert.match(ui.text('#profileAddressStatus'), /读取中/);
    pending.reject(new Error('节点暂不可达'));
    await settle();
    await settle();
    assert.match(ui.text('#profileAddressStatus'), /读取失败/);
    assert.match(ui.text('#profileAddressNote'), /节点暂不可达/);
    assert.equal(ui.shadow.querySelector('#profileAddressRetry').hidden, false);
  } finally {
    ui.close();
  }

  const empty = mountUi({
    onLoadContacts: async () => contactList(),
    onLoadPeerProfile: async () => peerProfileData(),
    onLoadPeerFriends: async () => ({
      peerId: PEER_B, source: 'remote', at: Date.now(), error: null, limited: false, friends: [],
    }),
  });
  try {
    await settle();
    empty.app.setContacts(contactList());
    empty.click('button[data-nav="contacts"]');
    await settle();
    empty.click('button[data-contact-peer]');
    await settle();
    empty.click('[data-profile-tab="address"]');
    await settle();
    await settle();
    assert.equal(empty.shadow.querySelector('#profileAddressEmpty').hidden, false);
    assert.equal(empty.shadow.querySelector('#profileFriendList').hidden, true);
    assert.equal(empty.shadow.querySelector('#profileAddressRetry').hidden, true);
    assert.match(empty.text('#profileAddressStatus'), /无记录/);
    assert.doesNotMatch(empty.text('#contactProfileAddress'), /公开文件/);
  } finally {
    empty.close();
  }

  const unsupported = mountUi({
    onLoadContacts: async () => contactList(),
    onLoadPeerProfile: async () => peerProfileData(),
  });
  try {
    await settle();
    unsupported.app.setContacts(contactList());
    unsupported.click('button[data-nav="contacts"]');
    await settle();
    unsupported.click('button[data-contact-peer]');
    await settle();
    unsupported.click('[data-profile-tab="address"]');
    await settle();
    assert.match(unsupported.text('#profileAddressStatus'), /不可用/);
    assert.match(unsupported.text('#profileAddressNote'), /没有提供公开通讯录读取/);
    assert.equal(unsupported.shadow.querySelector('#profileAddressRetry').hidden, true);
  } finally {
    unsupported.close();
  }
});

test('legacy mine and raminga view states restore home without losing drafts', async () => {
  for (const legacy of ['mine', 'raminga']) {
    const viewState = {
      version: 1,
      page: legacy,
      pages: {
        [legacy]: { scroll: 0, expandedSessions: { s1: true } },
        messages: { peerId: PEER_A, returnPage: legacy, returnPeer: PEER_A },
      },
      drafts: { [`chat:${PEER_A}`]: '旧草稿' },
    };
    const ui = mountUi({ viewState, onLoadContacts: async () => ({ friends: [], at: Date.now(), error: null, errorAt: null, freshness: 'live', connectionFreshness: 'live', total: 0 }) });
    try {
      await settle();
      assert.equal(ui.shadow.querySelector('#page-home').hidden, false);
      assert.equal(ui.viewState.page, 'home');
      assert.equal(ui.app.getDraft(`chat:${PEER_A}`), '旧草稿');
      assert.equal(ui.viewState.version, 2);
    } finally {
      ui.close();
    }
  }
});

test('my dynamics show publishing Agent for both authors and keep the original declaration', async () => {
  const baseFile = {
    peerId: 'local-peer-id', publisherName: 'Alice', publisherAgentName: 'Nova', name: 'post.json', sha256: 'f'.repeat(64),
    sizeBytes: 100, modifiedAt: 0, fetchedAt: 0, source: 'local-public', sources: ['local-public'],
    kind: 'markdown', mime: 'text/markdown', previewable: true, summary: '摘要', tags: [],
    publishedAt: '2026-11-14T10:00:00Z', contentState: 'available', contentError: '',
  };
  const data = mine({
    files: [
      { ...baseFile, id: 'u1', path: 'posts/user.json', title: '本人发布', authorKind: 'user', authorName: 'Alice' },
      { ...baseFile, id: 'a1', path: 'posts/agent.json', title: 'Agent 发布', authorKind: 'agent', authorName: 'Nova' },
      { ...baseFile, id: 'x1', path: 'posts/unknown.json', title: '来源未知', authorKind: '', authorName: '' },
    ],
  });
  const ui = mountUi({ onLoadMine: async () => data, viewState: { page: 'explore', pages: { explore: { filter: 'mine' } } } });
  try {
    await settle();
    await settle();
    assert.equal(ui.shadow.querySelector('#discoveryList').hidden, true);
    assert.equal(ui.shadow.querySelector('#mineFeedList').hidden, false);
    const cards = [...ui.shadow.querySelectorAll('#mineFeedList .rm-post')];
    assert.equal(cards.length, 3);
    const badges = [...ui.shadow.querySelectorAll('#mineFeedList .rm-post-author-badge')].map((node) => node.textContent);
    assert.deepEqual(badges, ['发布 Agent', '发布 Agent', '发布 Agent']);
    assert.deepEqual(cards.map((card) => card.querySelector('.rm-post-name').textContent), ['Nova', 'Nova', 'Nova']);
    assert.match(cards[0].querySelector('.rm-source-details').textContent, /用户署名 · Alice/);
    assert.match(cards[1].querySelector('.rm-source-details').textContent, /Agent署名 · Nova/);
    assert.match(cards[2].querySelector('.rm-source-details').textContent, /作者未注明/);
    assert.match(ui.text('#mineFeedList'), /本人发布/);
    assert.match(ui.text('#mineFeedList'), /Agent 发布/);
  } finally {
    ui.close();
  }
});

test('home hero keeps public profile fields and an inline edit entry when the profile is missing', async () => {
  const data = mine({ agentCard: { state: 'missing', card: null, error: 'missing' } });
  const ui = mountUi({ onLoadMine: async () => data });
  try {
    await settle();
    assert.equal(ui.text('#homeAgentName'), '我的 Agent');
    assert.equal(ui.shadow.querySelector('#homeAgentBio').hidden, true);
    assert.equal(ui.shadow.querySelector('#homeAgentStyle').hidden, true);
    assert.equal(ui.shadow.querySelector('#homeAgentInterests').hidden, true);
    assert.match(ui.text('#homeAgentProfileNote'), /还没有公开档案/);
    assert.match(ui.text('#homeAgentProfileNote'), /补充名称、简介、兴趣和交流风格/);
    assert.doesNotMatch(ui.text('#page-home'), /agent-card\.json|profile\/|public\//);
    assert.equal(ui.shadow.querySelector('#homeAgentAvatar').dataset.empty, 'true');
    assert.equal(ui.text('#homeAgentInitial'), '我');
    assert.match(ui.text('#mineIdentitySummary') ?? '', /喜欢地图与远方/);

    const edit = ui.shadow.querySelector('#homeAgentProfileEdit');
    assert.ok(edit, 'missing profile must expose a reachable edit entry');
    edit.click();
    assert.equal(ui.shadow.querySelector('#settings-public').hidden, false);
    assert.equal(ui.shadow.querySelector('#page-settings').hidden, false);
  } finally {
    ui.close();
  }
});

test('home hero renders a real public avatar edge-to-edge without a nested frame', async () => {
  const avatarSha = '6dbceae94894459da2587b917ddb9a3474005c9b526668765e1ee9e0da9ce5bf';
  const avatarPath = `profile/avatar-${avatarSha.slice(0, 8)}.png`;
  const data = mine({
    agentCard: {
      state: 'available',
      card: {
        ...mine().agentCard.card,
        avatarPath,
        avatarSha256: avatarSha,
        avatarMime: 'image/png',
      },
      error: '',
    },
    files: [{
      path: avatarPath,
      sha256: avatarSha,
      sizeBytes: 24000,
      name: `avatar-${avatarSha.slice(0, 8)}.png`,
      modifiedAt: 1,
    }],
  });
  const ui = mountUi({
    onLoadMine: async () => data,
    onLoadMineFileContent: async (filePath) => {
      assert.equal(filePath, avatarPath);
      return {
        ok: true,
        status: 'ok',
        kind: 'image',
        mime: 'image/png',
        sha256: avatarSha,
        sizeBytes: 24000,
        dataUrl: 'data:image/png;base64,avatar',
      };
    },
  });
  try {
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const avatar = ui.shadow.querySelector('#homeAgentAvatar');
    const image = avatar.querySelector('img');
    assert.equal(avatar.dataset.empty, 'false');
    assert.equal(image.hidden, false);
    assert.match(image.getAttribute('src'), /^data:image\/png/);
    assert.equal(ui.shadow.querySelector('#homeAgentInitial').hidden, true);
    assert.equal(avatar.getAttribute('aria-label'), 'Nova 的 Agent 形象');

    const tags = [...ui.shadow.querySelectorAll('#homeAgentInterests .rm-home-tag')];
    assert.equal(tags.length, 2);
    assert.deepEqual(tags.map((tag) => tag.textContent), ['地图', '天文']);
    for (const tag of tags) {
      assert.equal(tag.querySelectorAll('svg.rm-home-tag-icon').length, 1);
    }
    assert.match(ui.text('#homeAgentStyle'), /公开交流风格 · 简短、好奇/);
    assert.equal(ui.shadow.querySelector('#homeAgentProfileNote').hidden, true);
  } finally {
    ui.close();
  }
});

test('home hero adapts to short and long public descriptions without dropping copy', async () => {
  const descriptions = [
    '喜欢探索未知地图。',
    '这是一段很长的公开简介，用来验证主页主视觉在长简介时会自然增高并保留完整内容，而不是截断或溢出。'.repeat(12),
  ];
  for (const description of descriptions) {
    const data = mine({
      agentCard: {
        state: 'available',
        card: { ...mine().agentCard.card, description },
        error: '',
      },
    });
    const ui = mountUi({ onLoadMine: async () => data });
    try {
      await settle();
      assert.equal(ui.text('#homeAgentBio'), description);
      assert.equal(ui.shadow.querySelector('#homeAgentBio').hidden, false);
      assert.equal(ui.shadow.querySelector('#homeAgentProfileNote').hidden, true);
    } finally {
      ui.close();
    }
  }
});

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGsAAAAASUVORK5CYII=';

function draftAsset(overrides = {}) {
  return {
    assetId: 'asset-1', sha256: 'a'.repeat(64), mime: 'image/png',
    width: 1, height: 1, sizeBytes: Buffer.from(pngBase64, 'base64').length,
    ...overrides,
  };
}

function postDraft(overrides = {}) {
  return {
    draftId: 'draft-1-abcdef123456', kind: 'post', revision: 2, authorKind: 'user',
    agentName: '', agentDescription: '', agentInterests: [], agentConversationStyle: '',
    humanName: '', humanBioMarkdown: '', avatar: null,
    title: '草稿标题', bodyMarkdown: '草稿正文', tags: ['标签'], images: [],
    publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(),
    ...overrides,
  };
}

// A host adapter that keeps one post draft alive across the draft-save and
// publish round trips. The mock mirrors the real host state after publishing:
// the same draft keeps publishedPath instead of being replaced by a blank one.
function mountPublishablePostEditor() {
  let draft = null;
  const publishes = [];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'mine' } } },
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: draft ? [draft] : [], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => {
      draft = postDraft({
        ...(draft || {}),
        ...input,
        draftId: input.draftId || draft?.draftId || 'draft-first-post',
        revision: draft ? draft.revision + 1 : 0,
      });
      return { draft };
    },
    onPublishPublicDraft: async (draftId, revision) => {
      const postPath = `posts/post-first-${publishes.length + 1}/post.json`;
      publishes.push({ draftId, revision, postPath });
      if (draft) {
        draft = {
          ...draft,
          publishedPath: postPath,
          publishedSha256: 'a'.repeat(64),
          publishedRevision: revision,
        };
      }
      return {
        status: 'published', error: '', currentRevision: revision,
        currentPublishedSha256: 'a'.repeat(64),
        files: [{ path: postPath, sizeBytes: 10, sha256: 'a'.repeat(64) }],
        manifestVersion: 1, manifestGeneratedAtUnixMs: Date.now(),
        postPath, profilePath: '', warnings: [], manifestSha256: 'c'.repeat(64),
      };
    },
  });
  return { ui, publishes };
}

async function publishFirstPost(ui) {
  ui.click('#composePost');
  await settle();
  const title = ui.shadow.querySelector('#postTitleInput');
  const body = ui.shadow.querySelector('#postBodyInput');
  title.value = '第一条公开动态';
  title.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  body.value = '第一条正文';
  body.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  ui.click('#postPublishButton');
  await settle();
  await settle();
  assert.match(ui.text('#postPublishReceipt'), /确认后才会公开/);
  ui.click('#postPublishButton');
  await settle();
  await settle();
  await settle();
  assert.match(ui.text('#postPublishReceipt'), /发布完成/);
  assert.equal(ui.shadow.querySelector('#postEditorPanel').hidden, false, 'the real host leaves the editor expanded');
  assert.equal(title.value, '第一条公开动态');
}

function withObjectUrls(run) {
  const originalCreate = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;
  const created = [];
  const revoked = [];
  let seq = 0;
  globalThis.URL.createObjectURL = () => {
    const url = `blob:raminga-test-${++seq}`;
    created.push(url);
    return url;
  };
  globalThis.URL.revokeObjectURL = (url) => { revoked.push(url); };
  return Promise.resolve()
    .then(() => run({ created, revoked }))
    .finally(() => {
      globalThis.URL.createObjectURL = originalCreate;
      globalThis.URL.revokeObjectURL = originalRevoke;
    });
}

test('saved draft images and avatar use controlled asset reads, survive remount and revoke object URLs', async () => {
  await withObjectUrls(async ({ revoked }) => {
    const post = postDraft({
      images: [draftAsset()],
      publishedPath: 'posts/post-agent/post.json',
      publishedSha256: 'b'.repeat(64),
      authorKind: 'agent',
    });
    const profileDraft = {
      draftId: 'profile', kind: 'profile', revision: 3, authorKind: 'user',
      agentName: 'Nova', agentDescription: '简介', agentInterests: ['天文'], agentConversationStyle: '好奇',
      humanName: 'Alice', humanBioMarkdown: '介绍', avatar: draftAsset({ assetId: 'avatar-1' }),
      title: '', bodyMarkdown: '', tags: [], images: [],
      publishedPath: '', publishedSha256: '', publishedRevision: 0,
      createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(),
    };
    const reads = [];
    const options = {
      onLoadPublicDraft: async (id) => ({ found: true, draft: id === 'profile' ? profileDraft : post }),
      onLoadPublicDrafts: async () => ({ drafts: [post], hasMore: false, nextBefore: '' }),
      onLoadPublicDraftAsset: async (draftId, assetId) => {
        reads.push(`${draftId}:${assetId}`);
        return { image: draftAsset({ assetId }), dataBase64: pngBase64 };
      },
      onSavePublicDraft: async (input) => ({ draft: postDraft({ ...input, draftId: input.draftId || post.draftId }) }),
    };
    for (let mount = 0; mount < 2; mount += 1) {
      const ui = mountUi(options);
      try {
        await settle();
        ui.click('#composePost');
        await settle();
        const select = ui.shadow.querySelector('#postDraftSelect');
        select.value = post.draftId;
        select.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
        await settle();
        await settle();
        const card = ui.shadow.querySelector('#postImageList .rm-post-editor-image');
        assert.ok(card, 'saved draft image card is rendered');
        assert.match(card.textContent, /PNG · 1×1/);
        const thumb = card.querySelector('img');
        assert.ok(thumb?.getAttribute('src')?.startsWith('blob:raminga-test-'), `thumbnail src = ${thumb?.getAttribute('src')}`);
        assert.equal(thumb.isConnected, true);

        ui.click('#settingsTrigger');
        await settle();
        ui.click('[data-settings-tab="public"]');
        await settle();
        await settle();
        const avatar = ui.shadow.querySelector('#publicAvatarPreview img');
        assert.ok(avatar?.getAttribute('src')?.startsWith('blob:raminga-test-'), `avatar src = ${avatar?.getAttribute('src')}`);
      } finally {
        ui.close();
      }
    }
    assert.deepEqual([...new Set(reads)].sort(), ['draft-1-abcdef123456:asset-1', 'profile:avatar-1']);
    assert.equal(revoked.some((url) => url.startsWith('blob:raminga-test-')), true, 'draft object URLs are revoked');
  });
});

test('my post cards import existing local v1/v2 posts for controlled editing and remote cards have no edit entry', async () => {
  const baseFile = {
    peerId: 'local-peer-id', publisherName: 'Alice', publisherAgentName: 'Nova', name: 'post.json', sha256: 'f'.repeat(64),
    sizeBytes: 100, modifiedAt: 0, fetchedAt: 0, source: 'local-public', sources: ['local-public'],
    kind: 'markdown', mime: 'text/markdown', previewable: true, summary: '摘要', tags: [],
    publishedAt: '2026-11-14T10:00:00Z', contentState: 'available', contentError: '',
  };
  const v2Path = 'posts/post-agent/post.json';
  const v1Path = 'posts/legacy.json';
  const imported = [];
  const ui = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'mine' } } },
    onLoadPublicDraft: async () => ({ found: false }),
    onLoadPublicDrafts: async () => ({ drafts: [], hasMore: false, nextBefore: '' }),
    onSavePublicDraft: async (input) => ({ draft: postDraft({ ...input, draftId: input.draftId || 'draft-import' }) }),
    onImportPublicPost: async (path) => {
      imported.push(path);
      return {
        draft: postDraft({
          draftId: `draft-import-${imported.length}`, title: path === v1Path ? '旧 v1 标题' : 'Agent 标题',
          authorKind: path === v1Path ? 'user' : 'agent', publishedPath: path, publishedSha256: 'b'.repeat(64),
        }),
      };
    },
    onLoadMine: async () => mine({
      files: [
        { ...baseFile, id: 'v2', path: v2Path, title: 'Agent 发布', authorKind: 'agent', authorName: 'Nova' },
        { ...baseFile, id: 'v1', path: v1Path, title: '旧 v1', authorKind: 'user', authorName: 'Alice' },
      ],
    }),
  });
  try {
    await settle();
    await settle();
    const cards = [...ui.shadow.querySelectorAll('#mineFeedList .rm-post')];
    assert.equal(cards.length, 2);
    assert.equal(cards[0].querySelector('.rm-post-edit').textContent, '编辑');
    cards[0].querySelector('.rm-post-edit').click();
    await settle();
    await settle();
    assert.deepEqual(imported, [v2Path]);
    assert.equal(ui.shadow.querySelector('#postTitleInput').value, 'Agent 标题');
    assert.equal(ui.shadow.querySelector('#postAuthorKind').disabled, true);
    assert.match(ui.text('#postAuthorNote'), /来源详情.*保留Agent.*署名/);
    assert.equal(ui.shadow.querySelector('#postPanel, #postEditorPanel')?.hidden, false);

    cards[1].querySelector('.rm-post-edit').click();
    await settle();
    await settle();
    assert.deepEqual(imported, [v2Path, v1Path]);
    assert.equal(ui.shadow.querySelector('#postTitleInput').value, '旧 v1 标题');
    assert.equal(ui.shadow.querySelector('#postImageInput').disabled, true);
    assert.match(ui.text('#postAuthorNote'), /旧版动态保持原格式/);
  } finally {
    ui.close();
  }

  const remote = mountUi({
    viewState: { page: 'explore', pages: { explore: { filter: 'all' } } },
    onLoadDiscoveries: async () => ({
      items: [{
        ...baseFile, id: 'remote', peerId: PEER_B, publisherName: 'Bob', path: 'posts/post-remote/post.json',
        source: 'peer-manifest', sources: ['peer-manifest'], authorKind: 'user', authorName: 'Bob',
      }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live', familiar: false,
      scanned: 1, truncated: false, relationComplete: true, ignored: 0,
    }),
    onImportPublicPost: async () => { throw new Error('remote content must not be imported'); },
  });
  try {
    await settle();
    await settle();
    assert.equal(remote.shadow.querySelectorAll('#discoveryList .rm-post').length, 1);
    assert.equal(remote.shadow.querySelectorAll('#discoveryList .rm-post-edit').length, 0);
  } finally {
    remote.close();
  }
});

test('conflict save-as-new keeps the original draft images without reselecting', async () => {
  const oldImage = draftAsset({ assetId: 'old-image' });
  const source = postDraft({ images: [oldImage], title: '冲突标题' });
  const savedInputs = [];
  const uploaded = [];
  const ui = mountUi({
    onLoadPublicDraft: async () => ({ found: true, draft: source }),
    onLoadPublicDrafts: async () => ({ drafts: [source], hasMore: false, nextBefore: '' }),
    onLoadPublicDraftAsset: async (draftId, assetId) => {
      assert.equal(draftId, source.draftId);
      assert.equal(assetId, 'old-image');
      return { image: oldImage, dataBase64: pngBase64 };
    },
    onPutPublicDraftImage: async (draftId, role, filename, dataBase64) => {
      assert.equal(role, 'image');
      assert.equal(dataBase64, pngBase64);
      const asset = draftAsset({ assetId: `copied-${uploaded.length + 1}` });
      uploaded.push({ draftId, asset, filename });
      return { image: asset };
    },
    onSavePublicDraft: async (input) => {
      savedInputs.push(input);
      const revision = input.draftId ? 1 : 0;
      return {
        draft: postDraft({
          ...input, draftId: input.draftId || 'draft-new-abcdef', revision,
          images: input.imageAssetIds.map((assetId) => draftAsset({ assetId })),
        }),
      };
    },
  });
  try {
    await settle();
    ui.click('#composePost');
    await settle();
    const select = ui.shadow.querySelector('#postDraftSelect');
    select.value = source.draftId;
    select.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    await settle();
    await settle();
    ui.shadow.querySelector('#postSaveAsNew').hidden = false;
    ui.click('#postSaveAsNew');
    await settle();
    await settle();
    assert.equal(savedInputs.length, 2);
    assert.equal(savedInputs[0].draftId, '');
    assert.equal(savedInputs[1].draftId, 'draft-new-abcdef');
    assert.deepEqual(savedInputs[1].imageAssetIds, ['copied-1']);
    assert.equal(uploaded.length, 1, 'original image bytes were copied to the new draft');
    assert.match(ui.text('#postEditorNote'), /原有图片.*保留/);
  } finally {
    ui.close();
  }
});

test('write post with the published editor still expanded starts a new form without losing unsaved input', async () => {
  const { ui, publishes } = mountPublishablePostEditor();
  try {
    await publishFirstPost(ui);
    assert.equal(publishes.length, 1);

    // The newly published draft is now dirty. An explicit "write post" click
    // must preserve it and explain why it did not start a second form.
    const body = ui.shadow.querySelector('#postBodyInput');
    body.value = '尚未保存的补充';
    body.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.click('#composePost');
    await settle();
    assert.equal(body.value, '尚未保存的补充', 'unsaved edits survive an explicit write click');
    assert.equal(ui.shadow.querySelector('#postTitleInput').value, '第一条公开动态');
    assert.match(ui.text('#postEditorNote'), /未保存/);
    assert.equal(publishes.length, 1, 'preserving the draft must not publish again');

    // Saving clears dirty without dropping publishedPath. The next explicit
    // write click starts a blank form even though the panel never collapsed.
    ui.click('#postDraftSave');
    await settle();
    await settle();
    assert.equal(publishes.length, 1, 'saving the edited draft must not publish it');
    assert.equal(ui.shadow.querySelector('#postAuthorKind').disabled, true, 'the draft is still the published one');

    ui.click('#composePost');
    await settle();
    assert.equal(ui.shadow.querySelector('#postTitleInput').value, '');
    assert.equal(ui.shadow.querySelector('#postBodyInput').value, '');
    assert.equal(ui.shadow.querySelector('#postTagsInput').value, '');
    assert.equal(ui.shadow.querySelector('#postAuthorKind').value, 'user');
    assert.equal(ui.shadow.querySelector('#postAuthorKind').disabled, false);
    assert.equal(ui.shadow.querySelector('#postDraftSelect').value, '');
    assert.equal(ui.text('#postEditorStatus'), '新草稿');
    assert.equal(ui.shadow.querySelector('#postPublishReceipt').hidden, true, 'the previous receipt is cleared');
    assert.match(ui.text('#postEditorNote'), /已开始一条新动态/);

    const author = ui.shadow.querySelector('#postAuthorKind');
    author.value = 'agent';
    author.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    await settle();
    assert.match(ui.text('#postAuthorNote'), /来源详情.*Agent.*署名.*页头显示发布节点公开的 Agent 名称和头像/);
  } finally {
    ui.close();
  }
});

test('write post after collapsing a published editor starts a new form', async () => {
  const { ui, publishes } = mountPublishablePostEditor();
  try {
    await publishFirstPost(ui);
    assert.equal(publishes.length, 1);

    ui.click('#postEditorClose');
    assert.equal(ui.shadow.querySelector('#postEditorPanel').hidden, true);

    ui.click('#composePost');
    await settle();
    assert.equal(ui.shadow.querySelector('#postEditorPanel').hidden, false);
    assert.equal(ui.shadow.querySelector('#postTitleInput').value, '');
    assert.equal(ui.shadow.querySelector('#postBodyInput').value, '');
    assert.equal(ui.shadow.querySelector('#postTagsInput').value, '');
    assert.equal(ui.shadow.querySelector('#postAuthorKind').disabled, false);
    assert.equal(ui.shadow.querySelector('#postDraftSelect').value, '');
    assert.equal(ui.text('#postEditorStatus'), '新草稿');
    assert.match(ui.text('#postEditorNote'), /已开始一条新动态/);
    assert.equal(publishes.length, 1);
  } finally {
    ui.close();
  }
});

test('an avatar-only public Agent card shows the real avatar, default name and incomplete hint', async () => {
  const avatarSha = '9'.repeat(64);
  const avatarPath = `profile/avatar-${avatarSha.slice(0, 8)}.png`;
  const publicProfile = {
    schemaVersion: 2,
    agentName: '', agentDescription: '', agentInterests: [], agentConversationStyle: '',
    humanName: '', humanBioMarkdown: '',
    avatarPath, avatarSha256: avatarSha, avatarMime: 'image/png',
    updatedAt: '2026-11-20T10:00:00Z', path: 'profile/profile.json', sha256: 'f'.repeat(64),
  };
  const data = mine({
    profile: { state: 'missing', markdown: '', displayName: '', error: '', path: 'profile/index.md', at: null },
    publicProfile: { state: 'available', profile: publicProfile, error: '' },
    agentCard: {
      state: 'available',
      error: '',
      card: {
        schemaVersion: 1, displayName: '', description: '', interests: [], conversationStyle: '',
        updatedAt: '2026-11-20T10:00:00Z', path: 'profile/profile.json', sha256: 'f'.repeat(64),
        avatarPath, avatarSha256: avatarSha, avatarMime: 'image/png', legacyFallback: false,
      },
    },
    files: [{
      path: avatarPath, sha256: avatarSha, sizeBytes: 24000,
      name: `avatar-${avatarSha.slice(0, 8)}.png`, modifiedAt: 1,
    }],
  });
  const ui = mountUi({
    onLoadMine: async () => data,
    onLoadMineFileContent: async () => ({
      ok: true, status: 'ok', kind: 'image', mime: 'image/png', sha256: avatarSha, sizeBytes: 24000,
      dataUrl: 'data:image/png;base64,avatar-only',
    }),
  });
  try {
    await settle();
    await settle(10);
    assert.equal(ui.text('#homeAgentName'), '我的 Agent', 'an empty Agent name uses the default, not a placeholder file');
    assert.doesNotMatch(ui.text('#homeAgentProfileNote'), /还没有公开档案/);
    assert.match(ui.text('#homeAgentProfileNote'), /公开档案还缺名称/);
    assert.match(ui.text('#homeAgentProfileNote'), /简介/);
    assert.match(ui.text('#homeAgentProfileNote'), /兴趣/);
    assert.match(ui.text('#homeAgentProfileNote'), /公开交流风格/);
    const avatar = ui.shadow.querySelector('#homeAgentAvatar');
    assert.equal(avatar.dataset.empty, 'false');
    assert.equal(avatar.querySelector('img').hidden, false);
    assert.match(avatar.querySelector('img').getAttribute('src'), /^data:image\/png/);
    assert.equal(ui.shadow.querySelector('#homeAgentInitial').hidden, true);
    assert.match(ui.text('#mineIdentitySummary'), /还没有公开人类介绍/);
    assert.doesNotMatch(ui.text('#mineIdentitySummary'), /关联人类 ·/);
    assert.equal(ui.shadow.querySelector('#homeAgentProfileRetry').hidden, true);
  } finally {
    ui.close();
  }
});

test('a failed first public profile read is not shown as an empty profile and retries', async () => {
  let calls = 0;
  const ui = mountUi({
    onLoadMine: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Published 暂时不可用');
      return mine();
    },
  });
  try {
    await settle();
    assert.equal(ui.text('#homeAgentName'), '我的 Agent');
    assert.match(ui.text('#homeAgentBio'), /公开 Agent 档案这次没有读到/);
    assert.match(ui.text('#homeAgentProfileNote'), /读取公开 Agent 档案失败/);
    assert.doesNotMatch(ui.text('#homeAgentProfileNote'), /还没有公开档案/);
    const retry = ui.shadow.querySelector('#homeAgentProfileRetry');
    assert.equal(retry.hidden, false);
    retry.focus();
    retry.click();
    await settle();
    assert.equal(calls, 2);
    assert.equal(ui.text('#homeAgentName'), 'Nova');
    assert.equal(ui.shadow.querySelector('#homeAgentProfileNote').hidden, true);
    assert.equal(retry.hidden, true);
  } finally {
    ui.close();
  }
});

test('a refresh failure keeps the last published Agent snapshot with time and retry', async () => {
  const at = Date.now() - 60_000;
  const fresh = mine();
  let failing = false;
  const ui = mountUi({
    onLoadMine: async () => {
      if (failing) {
        return {
          ...fresh,
          at,
          error: 'Published 暂时不可用',
          errorAt: Date.now(),
          freshness: 'stale',
        };
      }
      return { ...fresh, at: Date.now(), error: null, errorAt: null, freshness: 'live' };
    },
    onLoadMineFileContent: async () => ({
      ok: true, status: 'ok', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,stale',
    }),
  });
  try {
    await settle();
    assert.equal(ui.text('#homeAgentName'), 'Nova');
    assert.equal(ui.shadow.querySelector('#homeAgentProfileNote').hidden, true);

    failing = true;
    ui.app.reloadMine();
    await settle();
    assert.equal(ui.text('#homeAgentName'), 'Nova', 'the last verified card is retained');
    assert.match(ui.text('#homeAgentProfileNote'), /上次成功读取/);
    assert.match(ui.text('#homeAgentProfileNote'), /最近一次刷新失败/);
    assert.match(ui.text('#homeAgentProfileNote'), /公开资料可能不是最新/);
    const retry = ui.shadow.querySelector('#homeAgentProfileRetry');
    assert.equal(retry.hidden, false);

    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    assert.match(ui.text('#publicVersionNote'), /成功读取的公开版本/);
    assert.equal(ui.shadow.querySelector('#publicVersionRetry').hidden, false);

    failing = false;
    ui.shadow.querySelector('#publicVersionRetry').click();
    await settle();
    assert.equal(ui.text('#homeAgentName'), 'Nova');
    assert.equal(ui.shadow.querySelector('#publicVersionNote').textContent.includes('成功读取的公开版本'), false);
    assert.equal(ui.shadow.querySelector('#publicVersionRetry').hidden, true);
  } finally {
    ui.close();
  }
});

test('confirming discard cancels the queued autosave and keeps the draft revision', async () => {
  const base = {
    draftId: 'profile', kind: 'profile', revision: 3,
    agentName: '公开旧名', agentDescription: '', agentInterests: [], agentConversationStyle: '',
    humanName: '', humanBioMarkdown: '', avatar: null, title: '', bodyMarkdown: '',
    tags: [], images: [], publishedPath: 'profile/profile.json', publishedSha256: 'd'.repeat(64),
    publishedRevision: 3, createdAtUnixMs: Date.now() - 1000, updatedAtUnixMs: Date.now() - 1000,
    authorKind: 'user',
  };
  const late = deferred();
  let loads = 0;
  const saves = [];
  let publishes = 0;
  const ui = mountUi({
    onLoadPublicDraft: async () => {
      loads += 1;
      if (loads === 1) return { found: true, draft: base };
      return late.promise;
    },
    onSavePublicDraft: async (input) => {
      saves.push(input);
      return { draft: { ...base, ...input, revision: base.revision + saves.length, updatedAtUnixMs: Date.now() } };
    },
    onPublishPublicDraft: async () => {
      publishes += 1;
      return { status: 'error' };
    },
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle();
    const name = ui.shadow.querySelector('#publicAgentName');
    assert.equal(name.value, '公开旧名');
    name.value = '确认放弃的临时输入';
    name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    assert.match(ui.text('#publicDraftStatus'), /有未保存修改/);

    ui.click('#publicDraftReload');
    assert.match(ui.text('#publicDraftReload'), /确认放弃修改并重新载入/);
    ui.click('#publicDraftReload');
    assert.equal(loads, 2, 'the second click starts the fresh draft read');
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(saves.length, 0, 'the abandoned autosave timer never writes');
    assert.equal(publishes, 0);
    assert.equal(ui.text('#publicDraftMeta').includes('revision 4'), false);

    late.resolve({ found: true, draft: base });
    await settle();
    await settle();
    assert.equal(name.value, '公开旧名', 'the confirmed reload restores the saved draft');
    assert.match(ui.text('#publicDraftMeta'), /revision 3/);
    assert.doesNotMatch(ui.text('#publicDraftStatus'), /有未保存修改/);
    assert.equal(saves.length, 0);
  } finally {
    ui.close();
  }
});

test('a late draft load never replaces input made while it was in flight, and later input still saves', async () => {
  const base = {
    draftId: 'profile', kind: 'profile', revision: 2,
    agentName: '已保存草稿', agentDescription: '', agentInterests: [], agentConversationStyle: '',
    humanName: '', humanBioMarkdown: '', avatar: null, title: '', bodyMarkdown: '',
    tags: [], images: [], publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now() - 1000, updatedAtUnixMs: Date.now() - 1000, authorKind: 'user',
  };
  const late = deferred();
  let loads = 0;
  const saves = [];
  const ui = mountUi({
    onLoadPublicDraft: async () => {
      loads += 1;
      if (loads === 1) return { found: true, draft: base };
      return late.promise;
    },
    onSavePublicDraft: async (input) => {
      saves.push(input);
      return { draft: { ...base, ...input, revision: base.revision + saves.length, updatedAtUnixMs: Date.now() } };
    },
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle();
    const name = ui.shadow.querySelector('#publicAgentName');
    ui.click('#publicDraftReload');
    ui.click('#publicDraftReload');
    assert.equal(loads, 2);

    // Input made after the reload began (the real form is briefly locked, but
    // the guard must also cover a programmatic/host event that still arrives).
    name.value = '载入期间的新输入';
    name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    late.resolve({ found: true, draft: base });
    await settle();
    assert.equal(name.value, '载入期间的新输入', 'the older load cannot overwrite newer input');
    assert.match(ui.text('#publicDraftStatus'), /有未保存修改/);

    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(saves.length, 1, 'input made after confirmation is still saved normally');
    assert.equal(saves[0].agentName, '载入期间的新输入');
    assert.equal(saves[0].expectedRevision, 2);
    assert.equal(name.value, '载入期间的新输入');
  } finally {
    ui.close();
  }
});

test('a slow home-avatar read cannot overwrite a newer published avatar and the latest key is fetched', async () => {
  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);
  const pathA = `profile/avatar-${shaA.slice(0, 8)}.png`;
  const pathB = `profile/avatar-${shaB.slice(0, 8)}.png`;
  const avatarFile = (path, sha) => ({
    path, sha256: sha, sizeBytes: 10, name: path.split('/').pop(), modifiedAt: 1,
    id: path, peerId: 'local-peer-id', publisherName: 'Alice', fetchedAt: 0,
    source: 'local-public', sources: ['local-public'], kind: 'image', mime: 'image/png',
    previewable: true, summary: '', tags: [], publishedAt: '', authorKind: '', authorName: '',
    contentState: 'available', contentError: '',
  });
  const dataFor = (path, sha) => mine({
    agentCard: {
      state: 'available', error: '',
      card: { ...mine().agentCard.card, displayName: 'Nova', avatarPath: path, avatarSha256: sha, avatarMime: 'image/png' },
    },
    files: [avatarFile(path, sha)],
  });
  const slowA = deferred();
  const calls = [];
  let mode = 'a';
  const ui = mountUi({
    onLoadMine: async () => (mode === 'a' ? dataFor(pathA, shaA) : dataFor(pathB, shaB)),
    onLoadMineFileContent: async (filePath) => {
      calls.push(filePath);
      if (filePath === pathA) return slowA.promise;
      return { status: 'ok', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,avatar-b' };
    },
  });
  try {
    await settle();
    await settle(10);
    assert.deepEqual(calls, [pathA], 'the first published avatar read is in flight');

    mode = 'b';
    ui.app.reloadMine();
    await settle();
    await settle(10);
    assert.deepEqual(calls, [pathA, pathB], 'the newest key is read instead of being skipped while busy');
    const image = ui.shadow.querySelector('#homeAgentAvatar img');
    assert.equal(image.getAttribute('src'), 'data:image/png;base64,avatar-b');

    slowA.resolve({ status: 'ok', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,avatar-a' });
    await settle();
    assert.equal(image.getAttribute('src'), 'data:image/png;base64,avatar-b', 'the old reply cannot replace the newer avatar');
    assert.equal(ui.shadow.querySelector('#homeAgentAvatar').dataset.empty, 'false');
  } finally {
    ui.close();
  }
});

test('restoring the published avatar cannot override a newer local image pick', async () => {
  const shaA = 'c'.repeat(64);
  const pathA = `profile/avatar-${shaA.slice(0, 8)}.png`;
  const publicProfile = {
    schemaVersion: 2,
    agentName: '旧 Agent', agentDescription: '旧简介', agentInterests: [], agentConversationStyle: '',
    humanName: '', humanBioMarkdown: '',
    avatarPath: pathA, avatarSha256: shaA, avatarMime: 'image/png',
    updatedAt: '2026-11-01T08:00:00Z', path: 'profile/profile.json', sha256: 'f'.repeat(64),
  };
  const data = mine({
    publicProfile: { state: 'available', profile: publicProfile, error: '' },
    agentCard: {
      state: 'available', error: '',
      card: {
        ...mine().agentCard.card, displayName: '旧 Agent', description: '旧简介',
        avatarPath: pathA, avatarSha256: shaA, avatarMime: 'image/png',
      },
    },
    files: [{
      path: pathA, sha256: shaA, sizeBytes: 10, name: pathA.split('/').pop(),
      id: pathA, peerId: 'local-peer-id', publisherName: '旧人类', fetchedAt: 0,
      source: 'local-public', sources: ['local-public'], kind: 'image', mime: 'image/png',
      previewable: true, summary: '', tags: [], publishedAt: '', authorKind: '', authorName: '',
      contentState: 'available', contentError: '',
    }],
  });
  const lateRestore = deferred();
  let reads = 0;
  const ui = mountUi({
    onLoadMine: async () => data,
    onLoadMineFileContent: async () => {
      reads += 1;
      if (reads === 1) {
        return { status: 'ok', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,home-avatar' };
      }
      return lateRestore.promise;
    },
    onLoadPublicDraft: async () => ({ found: false }),
    onSavePublicDraft: async (input) => ({ draft: { ...input, draftId: 'profile', revision: 1, avatar: null, updatedAtUnixMs: Date.now() } }),
  });
  try {
    await settle();
    await settle(10);
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle(10);
    assert.equal(reads, 1, 'the home hero already loaded the published avatar');
    ui.click('#publicRestorePublished');
    await settle();
    assert.equal(reads, 2, 'restore starts a controlled published-avatar read');

    const input = ui.shadow.querySelector('#publicAvatarInput');
    setFileInput(ui.dom, input, [...Buffer.from(pngBase64, 'base64')], 'new-avatar.png');
    await settle();
    const picked = ui.shadow.querySelector('#publicAvatarPreview img').getAttribute('src');
    assert.match(picked, /^data:image\/png;base64,/);

    lateRestore.resolve({ status: 'ok', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,old-published-avatar' });
    await settle();
    assert.equal(
      ui.shadow.querySelector('#publicAvatarPreview img').getAttribute('src'),
      picked,
      'the late restore reply must not replace the newer pick',
    );
  } finally {
    ui.close();
  }
});

test('public version title distinguishes loading, read failure and a genuinely empty profile', async () => {
  const loadingRead = deferred();
  const loadingUi = mountUi({ onLoadMine: async () => loadingRead.promise });
  try {
    await settle();
    loadingUi.click('#settingsTrigger');
    await settle();
    loadingUi.click('[data-settings-tab="public"]');
    await settle();
    assert.equal(loadingUi.text('#publicVersionName'), '正在读取公开版本…');
  } finally {
    loadingUi.close();
  }

  const failedUi = mountUi({ onLoadMine: async () => { throw new Error('Published 暂时不可用'); } });
  try {
    await settle();
    failedUi.click('#settingsTrigger');
    await settle();
    failedUi.click('[data-settings-tab="public"]');
    await settle();
    assert.equal(failedUi.text('#publicVersionName'), '读取公开版本失败');
    assert.match(failedUi.text('#publicVersionNote'), /读取公开版本没有完成/);
  } finally {
    failedUi.close();
  }

  const emptyUi = mountUi({
    onLoadMine: async () => mine({
      profile: { state: 'missing', markdown: '', displayName: '', error: '', path: 'profile/index.md', at: null },
      agentCard: { state: 'missing', card: null, error: 'missing' },
      publicProfile: { state: 'missing', profile: null, error: '' },
    }),
  });
  try {
    await settle();
    emptyUi.click('#settingsTrigger');
    await settle();
    emptyUi.click('[data-settings-tab="public"]');
    await settle();
    assert.equal(emptyUi.text('#publicVersionName'), '尚无公开版本');
    assert.match(emptyUi.text('#publicVersionNote'), /还没有公开版本/);
  } finally {
    emptyUi.close();
  }
});

test('a late rejected published-avatar restore cannot overwrite a newer draft or show its old preview', async () => {
  const oldSha = '1'.repeat(64);
  const oldPath = `profile/avatar-${oldSha.slice(0, 8)}.png`;
  const publicProfile = {
    schemaVersion: 2,
    agentName: '旧 Agent', agentDescription: '旧简介', agentInterests: [], agentConversationStyle: '',
    humanName: '', humanBioMarkdown: '',
    avatarPath: oldPath, avatarSha256: oldSha, avatarMime: 'image/png',
    updatedAt: '2026-11-01T08:00:00Z', path: 'profile/profile.json', sha256: 'f'.repeat(64),
  };
  const data = mine({
    publicProfile: { state: 'available', profile: publicProfile, error: '' },
    agentCard: {
      state: 'available', error: '',
      card: { ...mine().agentCard.card, displayName: '旧 Agent', avatarPath: oldPath, avatarSha256: oldSha, avatarMime: 'image/png' },
    },
    files: [{
      path: oldPath, sha256: oldSha, sizeBytes: 24, name: 'avatar-old.png', modifiedAt: 0,
    }],
  });
  const draftB = {
    draftId: 'profile', kind: 'profile', revision: 7,
    agentName: '新草稿 B', agentDescription: 'B 简介', agentInterests: ['B'], agentConversationStyle: 'B 风格',
    humanName: 'B 人类', humanBioMarkdown: 'B 介绍', avatar: null, humanAvatar: null,
    title: '', bodyMarkdown: '', tags: [], images: [],
    publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
  };
  const lateRestore = deferred();
  let reads = 0;
  let draftBReady = false;
  const ui = mountUi({
    onLoadMine: async () => data,
    onLoadMineFileContent: async () => {
      reads += 1;
      if (reads === 1) {
        return { status: 'ok', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,b2xkLWhvbWU=' };
      }
      return lateRestore.promise;
    },
    onLoadPublicDraft: async () => (draftBReady ? { found: true, draft: draftB } : { found: false }),
  });
  try {
    await settle();
    await settle(10);
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle(10);
    assert.equal(reads, 1, 'home loaded the published avatar first');
    ui.click('#publicRestorePublished');
    await settle();
    assert.equal(reads, 2, 'restore starts its own read');

    draftBReady = true;
    ui.click('#publicDraftReload');
    ui.click('#publicDraftReload');
    await settle();
    await settle(10);
    assert.equal(ui.shadow.querySelector('#publicAgentName').value, '新草稿 B');
    assert.match(ui.text('#publicDraftMeta'), /revision 7/);
    const previewAtB = ui.shadow.querySelector('#publicAvatarPreview img').getAttribute('src');
    assert.doesNotMatch(previewAtB, /b2xkLWhvbWU/, 'draft B must not borrow the old published avatar URL');
    assert.doesNotMatch(previewAtB, /^data:image\/png;base64,b2xkLWhvbWU/);

    lateRestore.reject(new Error('旧公开头像读取失败'));
    await settle();
    await settle(10);
    assert.equal(ui.shadow.querySelector('#publicAgentName').value, '新草稿 B', 'late failure must not restore draft A text');
    assert.match(ui.text('#publicDraftMeta'), /revision 7/);
    assert.doesNotMatch(ui.text('#publicDraftStatus'), /旧公开头像读取失败/);
    assert.doesNotMatch(ui.text('#publicDraftStatus'), /当前内容来自已有公开资料/);
    assert.doesNotMatch(
      ui.shadow.querySelector('#publicAvatarPreview img').getAttribute('src'),
      /b2xkLWhvbWU/,
      'late failure must not put avatar A back on draft B',
    );
  } finally {
    ui.close();
  }
});

test('Agent and human draft previews are independent when picking and clearing either image', async () => {
  await withObjectUrls(async () => {
    const baseDraft = {
      draftId: 'profile', kind: 'profile', revision: 2,
      agentName: 'Nova', agentDescription: '', agentInterests: [], agentConversationStyle: '',
      humanName: 'Alice', humanBioMarkdown: '', title: '', bodyMarkdown: '', tags: [], images: [],
      avatar: draftAsset({ assetId: 'agent-saved' }),
      humanAvatar: draftAsset({ assetId: 'human-saved', sha256: 'd'.repeat(64) }),
      publishedPath: '', publishedSha256: '', publishedRevision: 0,
      createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
    };
    const reads = [];
    const ui = mountUi({
      onLoadPublicDraft: async () => ({ found: true, draft: baseDraft }),
      onLoadPublicDraftAsset: async (draftId, assetId) => {
        reads.push(`${draftId}:${assetId}`);
        return {
          image: draftAsset({ assetId, sha256: assetId === 'agent-saved' ? 'a'.repeat(64) : 'd'.repeat(64) }),
          dataBase64: pngBase64,
        };
      },
      onSavePublicDraft: async (input) => ({ draft: { ...baseDraft, ...input, revision: 3 } }),
    });
    try {
      await settle();
      ui.click('#settingsTrigger');
      await settle();
      ui.click('[data-settings-tab="public"]');
      await settle();
      await settle(10);
      const agentPreview = () => ui.shadow.querySelector('#publicAvatarPreview img').getAttribute('src');
      const humanPreview = () => ui.shadow.querySelector('#publicHumanAvatarPreview img').getAttribute('src');
      await waitUntil(() => agentPreview().startsWith('blob:raminga-test-') && humanPreview().startsWith('blob:raminga-test-'), 'both saved draft previews');
      const initialHuman = humanPreview();

      setFileInput(ui.dom, ui.shadow.querySelector('#publicAvatarInput'), [...Buffer.from(pngBase64, 'base64')], 'agent-new.png');
      await waitUntil(() => agentPreview().startsWith('data:image/png;base64,'), 'Agent local preview');
      assert.equal(humanPreview(), initialHuman, 'picking an Agent image must not touch the human preview');

      const pickedAgent = agentPreview();
      setFileInput(ui.dom, ui.shadow.querySelector('#publicHumanAvatarInput'), [...Buffer.from(pngBase64, 'base64')], 'human-new.png');
      await waitUntil(() => humanPreview().startsWith('data:image/png;base64,'), 'human local preview');
      assert.equal(agentPreview(), pickedAgent, 'picking a human image must not touch the Agent preview');

      const pickedHuman = humanPreview();
      ui.click('#publicAvatarClear');
      await settle();
      assert.equal(agentPreview(), 'assets/raminga-mark-gradient.svg');
      assert.equal(humanPreview(), pickedHuman, 'clearing the Agent image leaves the human image');

      ui.click('#publicHumanAvatarClear');
      await settle();
      assert.equal(humanPreview(), 'assets/raminga-mark-gradient.svg');
      assert.deepEqual([...new Set(reads)].sort(), ['profile:agent-saved', 'profile:human-saved']);
    } finally {
      ui.close();
    }
  });
});

test('Agent and human uploads save independent asset ids and both previews survive reload', async () => {
  await withObjectUrls(async () => {
    let current = {
      draftId: 'profile', kind: 'profile', revision: 1,
      agentName: 'Nova', agentDescription: '', agentInterests: [], agentConversationStyle: '',
      humanName: 'Alice', humanBioMarkdown: '', title: '', bodyMarkdown: '', tags: [], images: [],
      avatar: draftAsset({ assetId: 'agent-old', sha256: 'a'.repeat(64) }),
      humanAvatar: draftAsset({ assetId: 'human-old', sha256: 'd'.repeat(64) }),
      publishedPath: '', publishedSha256: '', publishedRevision: 0,
      createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
    };
    const saves = [];
    const uploads = [];
    const ui = mountUi({
      onLoadPublicDraft: async () => ({ found: true, draft: current }),
      onLoadPublicDraftAsset: async (draftId, assetId) => ({
        image: draftAsset({ assetId, sha256: String(assetId).startsWith('agent') ? 'a'.repeat(64) : 'd'.repeat(64) }),
        dataBase64: pngBase64,
      }),
      onSavePublicDraft: async (input) => {
        saves.push({ ...input });
        const avatar = input.avatarAssetId
          ? draftAsset({ assetId: input.avatarAssetId, sha256: input.avatarAssetId.startsWith('agent') ? 'a'.repeat(64) : 'd'.repeat(64) })
          : input.clearAvatar ? null : current.avatar;
        const humanAvatar = input.humanAvatarAssetId
          ? draftAsset({ assetId: input.humanAvatarAssetId, sha256: input.humanAvatarAssetId.startsWith('human') ? 'd'.repeat(64) : 'a'.repeat(64) })
          : input.clearHumanAvatar ? null : current.humanAvatar;
        current = {
          ...current,
          ...input,
          revision: current.revision + 1,
          updatedAtUnixMs: Date.now(),
          avatar,
          humanAvatar,
        };
        return { draft: { ...current } };
      },
      onPutPublicDraftImage: async (draftId, role, filename) => {
        uploads.push({ draftId, role, filename });
        const assetId = role === 'human_avatar' ? 'human-new' : 'agent-new';
        return { image: draftAsset({ assetId, sha256: role === 'human_avatar' ? 'd'.repeat(64) : 'a'.repeat(64) }) };
      },
    });
    try {
      await settle();
      ui.click('#settingsTrigger');
      await settle();
      ui.click('[data-settings-tab="public"]');
      await settle();
      await settle(10);
      setFileInput(ui.dom, ui.shadow.querySelector('#publicAvatarInput'), [...Buffer.from(pngBase64, 'base64')], 'agent-new.png');
      setFileInput(ui.dom, ui.shadow.querySelector('#publicHumanAvatarInput'), [...Buffer.from(pngBase64, 'base64')], 'human-new.png');
      ui.click('#publicDraftSave');
      await waitUntil(() => saves.length === 3 && uploads.length === 2 && !ui.shadow.querySelector('#publicDraftSave').disabled, 'dual avatar uploads and saves');
      assert.deepEqual(uploads.map((item) => item.role), ['avatar', 'human_avatar']);
      assert.equal(saves[0].avatarAssetId, '', 'a newly picked Agent file has no asset id before upload');
      assert.equal(saves[0].humanAvatarAssetId, '', 'a newly picked human file has no asset id before upload');
      assert.equal(saves[1].avatarAssetId, 'agent-new');
      assert.equal(saves[1].humanAvatarAssetId, '');
      assert.equal(saves[2].avatarAssetId, 'agent-new');
      assert.equal(saves[2].humanAvatarAssetId, 'human-new');
      assert.equal(saves[2].clearAvatar, false);
      assert.equal(saves[2].clearHumanAvatar, false);
      assert.match(ui.text('#publicDraftMeta'), /revision 4/);

      ui.click('#publicDraftReload');
      await settle();
      await settle(10);
      await waitUntil(() => {
        const agent = ui.shadow.querySelector('#publicAvatarPreview img').getAttribute('src') ?? '';
        const human = ui.shadow.querySelector('#publicHumanAvatarPreview img').getAttribute('src') ?? '';
        return agent.startsWith('blob:raminga-test-') && human.startsWith('blob:raminga-test-');
      }, 'both saved draft avatars survive reload');
      assert.match(ui.text('#publicDraftMeta'), /revision 4/);
    } finally {
      ui.close();
    }
  });
});

test('publish confirmation names both images and is invalidated by either avatar change', async () => {
  const agentImage = draftAsset({ assetId: 'agent-published', sha256: 'a'.repeat(64) });
  const humanImage = draftAsset({ assetId: 'human-published', sha256: 'd'.repeat(64) });
  const baseDraft = {
    draftId: 'profile', kind: 'profile', revision: 2,
    agentName: 'Nova', agentDescription: '', agentInterests: [], agentConversationStyle: '',
    humanName: 'Alice', humanBioMarkdown: '', title: '', bodyMarkdown: '', tags: [], images: [],
    avatar: agentImage, humanAvatar: humanImage,
    publishedPath: '', publishedSha256: '', publishedRevision: 0,
    createdAtUnixMs: Date.now(), updatedAtUnixMs: Date.now(), authorKind: 'user',
  };
  const saves = [];
  const publishes = [];
  const ui = mountUi({
    onLoadPublicDraft: async () => ({ found: true, draft: baseDraft }),
    onLoadPublicDraftAsset: async (draftId, assetId) => ({
      image: assetId === 'agent-published' ? agentImage : humanImage,
      dataBase64: pngBase64,
    }),
    onSavePublicDraft: async (input) => {
      saves.push({ ...input });
      const avatar = input.clearAvatar ? null : input.avatarAssetId ? agentImage : baseDraft.avatar;
      const humanAvatar = input.clearHumanAvatar ? null : input.humanAvatarAssetId ? humanImage : baseDraft.humanAvatar;
      return {
        draft: { ...baseDraft, ...input, avatar, humanAvatar, revision: baseDraft.revision + saves.length }
      };
    },
    onPublishPublicDraft: async () => {
      publishes.push(1);
      return { status: 'invalid', error: 'test stop', files: [] };
    },
    onPutPublicDraftImage: async () => ({ image: draftAsset({ assetId: 'agent-new' }) }),
  });
  try {
    await settle();
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle(10);
    ui.click('#publicPublishButton');
    await settle();
    await settle(10);
    assert.equal(ui.text('#publicPublishButton'), '确认发布公开资料');
    assert.match(ui.text('#publicPublishReceipt'), /Agent 头像：已设置/);
    assert.match(ui.text('#publicPublishReceipt'), /关联人类头像：已设置/);
    assert.equal(publishes.length, 0, 'the confirmation step still needs an explicit second click');

    ui.click('#publicHumanAvatarClear');
    await settle();
    assert.equal(ui.text('#publicPublishButton'), '检查发布内容', 'human avatar clear invalidates the saved confirmation snapshot');

    ui.click('#publicPublishButton');
    await settle();
    await settle(10);
    assert.equal(ui.text('#publicPublishButton'), '确认发布公开资料');
    setFileInput(ui.dom, ui.shadow.querySelector('#publicAvatarInput'), [...Buffer.from(pngBase64, 'base64')], 'agent-change.png');
    await settle();
    assert.equal(ui.text('#publicPublishButton'), '检查发布内容', 'Agent avatar pick invalidates the saved confirmation snapshot');
  } finally {
    ui.close();
  }
});

test('home human strip shows the published v2 human avatar and ignores a late older read', async () => {
  const oldSha = '2'.repeat(64);
  const newSha = '3'.repeat(64);
  const oldPath = `profile/human-avatar-${oldSha.slice(0, 8)}.png`;
  const newPath = `profile/human-avatar-${newSha.slice(0, 8)}.png`;
  const oldScreen = deferred();
  let mineCalls = 0;
  const dataA = mine({
    publicProfile: {
      state: 'available', error: '',
      profile: {
        schemaVersion: 2, agentName: 'Nova', agentDescription: '', agentInterests: [], agentConversationStyle: '',
        humanName: '旧人类', humanBioMarkdown: '', avatarPath: '', avatarSha256: '', avatarMime: '',
        humanAvatarPath: oldPath, humanAvatarSha256: oldSha, humanAvatarMime: 'image/png',
        updatedAt: '2026-11-01T08:00:00Z', path: 'profile/profile.json', sha256: 'f'.repeat(64),
      },
    },
    files: [{ path: oldPath, sha256: oldSha, sizeBytes: 20, name: 'old.png', modifiedAt: 0 }],
  });
  const dataB = mine({
    profile: { state: 'missing', markdown: '', displayName: '', error: '', path: 'profile/index.md', at: null },
    publicProfile: {
      state: 'available', error: '',
      profile: {
        schemaVersion: 2, agentName: '', agentDescription: '', agentInterests: [], agentConversationStyle: '',
        humanName: '', humanBioMarkdown: '', avatarPath: '', avatarSha256: '', avatarMime: '',
        humanAvatarPath: newPath, humanAvatarSha256: newSha, humanAvatarMime: 'image/png',
        updatedAt: '2026-11-02T08:00:00Z', path: 'profile/profile.json', sha256: 'e'.repeat(64),
      },
    },
    files: [{ path: newPath, sha256: newSha, sizeBytes: 21, name: 'new.png', modifiedAt: 1 }],
  });
  const ui = mountUi({
    onLoadMine: async () => (++mineCalls === 1 ? dataA : dataB),
    onLoadMineFileContent: async (filePath) => {
      if (filePath === oldPath) return oldScreen.promise;
      return {
        status: 'ok', kind: 'image', mime: 'image/png', sha256: newSha, sizeBytes: 21,
        dataUrl: 'data:image/png;base64,bmV3LWh1bWFuLWF2YXRhcg==',
      };
    },
  });
  try {
    await settle();
    await settle(10);
    const avatar = ui.shadow.querySelector('#homeHumanAvatar');
    assert.ok(avatar, 'home human strip exposes the human avatar image');
    ui.app.reloadMine();
    await settle();
    await settle(10);
    assert.equal(avatar.hidden, false);
    assert.match(avatar.getAttribute('src'), /bmV3LWh1bWFuLWF2YXRhcg/);
    assert.equal(ui.text('#mineIdentityTitle'), '关联人类', 'an empty v2 human name falls back to the shared heading');

    oldScreen.resolve({
      status: 'ok', kind: 'image', mime: 'image/png', sha256: oldSha, sizeBytes: 20,
      dataUrl: 'data:image/png;base64,b2xkLWh1bWFuLWF2YXRhcg==',
    });
    await settle();
    await settle(10);
    assert.match(
      ui.shadow.querySelector('#homeHumanAvatar').getAttribute('src'),
      /bmV3LWh1bWFuLWF2YXRhcg/,
      'the late older read must not replace the newest human avatar',
    );
  } finally {
    ui.close();
  }
});

test('published v2 human fields are real data even for the literal 关联人类 name or avatar-only profiles', () => {
  const base = mine({
    profile: { state: 'missing', markdown: '', displayName: '', error: '', path: 'profile/index.md', at: null },
    agentCard: { state: 'missing', card: null, error: 'missing' },
  });
  const explicitName = buildHomeAgentModel({
    mine: {
      ...base,
      publicProfile: {
        state: 'available', error: '',
        profile: {
          schemaVersion: 2, agentName: '', agentDescription: '', agentInterests: [], agentConversationStyle: '',
          humanName: '关联人类', humanBioMarkdown: '',
          avatarPath: '', avatarSha256: '', avatarMime: '',
          humanAvatarPath: '', humanAvatarSha256: '', humanAvatarMime: '',
          updatedAt: '', path: 'profile/profile.json', sha256: 'f'.repeat(64),
        },
      },
    },
  });
  assert.equal(explicitName.human.available, true, 'an explicit v2 humanName is not treated as the generated placeholder');
  assert.equal(explicitName.human.name, '关联人类');

  const avatarOnly = buildHomeAgentModel({
    mine: {
      ...base,
      publicProfile: {
        state: 'available', error: '',
        profile: {
          schemaVersion: 2, agentName: '', agentDescription: '', agentInterests: [], agentConversationStyle: '',
          humanName: '', humanBioMarkdown: '',
          avatarPath: '', avatarSha256: '', avatarMime: '',
          humanAvatarPath: 'profile/human-avatar-eeeeeeee.png', humanAvatarSha256: 'e'.repeat(64), humanAvatarMime: 'image/png',
          updatedAt: '', path: 'profile/profile.json', sha256: 'f'.repeat(64),
        },
      },
    },
  });
  assert.equal(avatarOnly.human.available, true, 'a v2 humanAvatarPath alone counts as published human data');
  assert.equal(avatarOnly.human.avatarPath, 'profile/human-avatar-eeeeeeee.png');

  const legacyPlaceholder = buildHomeAgentModel({
    mine: {
      ...base,
      profile: {
        state: 'available', markdown: '# 关联人类\n\n', displayName: '关联人类',
        error: '', path: 'profile/index.md', at: 1,
      },
      publicProfile: { state: 'missing', profile: null, error: '' },
    },
  });
  assert.equal(legacyPlaceholder.human.available, false, 'the legacy default index.md heading without v2 human fields stays a placeholder');

  const legacyReal = buildHomeAgentModel({
    mine: {
      ...base,
      profile: {
        state: 'available', markdown: '# 旧人类\n\n喜欢旧地图。', displayName: '旧人类',
        error: '', path: 'profile/index.md', at: 1,
      },
      publicProfile: { state: 'missing', profile: null, error: '' },
    },
  });
  assert.equal(legacyReal.human.available, true, 'a real old index.md profile remains visible');
  assert.equal(legacyReal.human.name, '旧人类');
});

function publishedPairData() {
  const agentSha = 'a'.repeat(64);
  const humanSha = 'd'.repeat(64);
  const agentPath = `profile/avatar-${agentSha.slice(0, 8)}.png`;
  const humanPath = `profile/human-avatar-${humanSha.slice(0, 8)}.png`;
  return {
    data: mine({
      publicProfile: {
        state: 'available', error: '',
        profile: {
          schemaVersion: 2,
          agentName: '公开 Agent', agentDescription: '公开简介', agentInterests: ['天文'], agentConversationStyle: '温和',
          humanName: '公开人类', humanBioMarkdown: '公开人类介绍',
          avatarPath: agentPath, avatarSha256: agentSha, avatarMime: 'image/png',
          humanAvatarPath: humanPath, humanAvatarSha256: humanSha, humanAvatarMime: 'image/png',
          updatedAt: '2026-11-01T08:00:00Z', path: 'profile/profile.json', sha256: 'f'.repeat(64),
        },
      },
      agentCard: {
        state: 'available', error: '',
        card: {
          ...mine().agentCard.card, displayName: '公开 Agent',
          avatarPath: agentPath, avatarSha256: agentSha, avatarMime: 'image/png',
        },
      },
      files: [
        { path: agentPath, sha256: agentSha, sizeBytes: 40, name: 'agent.png', modifiedAt: 0 },
        { path: humanPath, sha256: humanSha, sizeBytes: 41, name: 'human.png', modifiedAt: 1 },
      ],
    }),
    agentPath,
    humanPath,
    agentDataUrl: 'data:image/png;base64,cHVibGlzaGVkLWFnZW50',
    humanDataUrl: 'data:image/png;base64,cHVibGlzaGVkLWh1bWFu',
  };
}

test('restore-published restores both avatars, and one failed image read does not corrupt the other or the form', async () => {
  const pair = publishedPairData();
  const ui = mountUi({
    onLoadMine: async () => pair.data,
    onLoadMineFileContent: async (filePath) => (filePath === pair.humanPath
      ? { status: 'ok', kind: 'image', mime: 'image/png', dataUrl: pair.humanDataUrl }
      : { status: 'ok', kind: 'image', mime: 'image/png', dataUrl: pair.agentDataUrl }),
    onLoadPublicDraft: async () => ({ found: false }),
  });
  try {
    await settle();
    await settle(10);
    ui.click('#settingsTrigger');
    await settle();
    ui.click('[data-settings-tab="public"]');
    await settle();
    await settle(10);
    assert.equal(
      ui.shadow.querySelector('#publicHumanAvatarPreview img').getAttribute('src'),
      pair.humanDataUrl,
      'the fallback draft previews the published v2 human avatar from home state',
    );
    ui.click('#publicRestorePublished');
    await settle();
    await settle(20);
    assert.equal(ui.shadow.querySelector('#publicAgentName').value, '公开 Agent');
    assert.equal(ui.shadow.querySelector('#publicHumanName').value, '公开人类');
    assert.equal(ui.shadow.querySelector('#publicHumanBio').value, '公开人类介绍');
    assert.equal(ui.shadow.querySelector('#publicAvatarPreview img').getAttribute('src'), pair.agentDataUrl);
    assert.equal(ui.shadow.querySelector('#publicHumanAvatarPreview img').getAttribute('src'), pair.humanDataUrl);
  } finally {
    ui.close();
  }

  const failed = mountUi({
    onLoadMine: async () => pair.data,
    onLoadMineFileContent: async (filePath) => {
      if (filePath === pair.humanPath) throw new Error('人类头像读取失败');
      return { status: 'ok', kind: 'image', mime: 'image/png', dataUrl: pair.agentDataUrl };
    },
    onLoadPublicDraft: async () => ({ found: false }),
  });
  try {
    await settle();
    await settle(10);
    failed.click('#settingsTrigger');
    await settle();
    failed.click('[data-settings-tab="public"]');
    await settle();
    await settle(10);
    failed.click('#publicRestorePublished');
    await settle();
    await settle(20);
    assert.equal(failed.shadow.querySelector('#publicAgentName').value, '公开 Agent', 'text form survives the human image failure');
    assert.equal(failed.shadow.querySelector('#publicHumanName').value, '公开人类');
    assert.equal(failed.shadow.querySelector('#publicAvatarPreview img').getAttribute('src'), pair.agentDataUrl, 'the Agent image still restores');
    assert.equal(failed.shadow.querySelector('#publicHumanAvatarPreview img').getAttribute('src'), 'assets/raminga-mark-gradient.svg');
    assert.match(failed.text('#publicHumanAvatarNote'), /人类头像读取失败/);
  } finally {
    failed.close();
  }
});
