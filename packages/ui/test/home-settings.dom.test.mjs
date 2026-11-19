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

test('public profile drafts save privately and publish only after a second confirmation', async () => {
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
    onPublishPublicDraft: async (draftId, revision, sha) => {
      calls.push({ kind: 'publish', draftId, revision, sha });
      return {
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
    assert.match(ui.text('#publicPublishReceipt'), /发布完成/);
    assert.match(ui.text('#publicPublishReceiptDetails'), /profile\/profile\.json/);
    assert.match(ui.text('#publicPublishReceiptDetails'), /e{12}/);
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
    assert.match(ui.text('#postAuthorNote'), /将以本人/);
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
    assert.equal(ui.shadow.querySelector('#contactProfileFiles').hidden, true);
    assert.match(ui.text('#profileFriendList'), /Bob/);
    assert.match(ui.text('#profileFriendList'), /已有联系/);
    assert.match(ui.text('#profileFriendList'), /Carol/);
    assert.match(ui.text('#profileFriendList'), /公开线索/);
    assert.doesNotMatch(ui.text('#profileAddressNote'), /公开文件|P[1-4]/);

    ui.click('#profileFilesOpen');
    assert.equal(ui.shadow.querySelector('#contactProfileFiles').hidden, false);
    assert.equal(ui.shadow.querySelector('#contactProfileAddress').hidden, true);
    assert.equal(ui.shadow.querySelector('#profileTabsNav').hidden, true);
    assert.match(ui.text('#profileFilesNote'), /没有动态以外的文件/);
    ui.click('#profileFilesClose');
    assert.equal(ui.shadow.querySelector('#contactProfileFiles').hidden, true);
    assert.equal(ui.shadow.querySelector('#profileTabsNav').hidden, false);
    assert.ok(ui.shadow.querySelector('#profileCopyPeer'));
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

test('my dynamics show both authors from the real declaration and never guess unknown', async () => {
  const baseFile = {
    peerId: 'local-peer-id', publisherName: 'Alice', name: 'post.json', sha256: 'f'.repeat(64),
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
    assert.deepEqual(badges, ['本人', 'Agent', '来源未注明']);
    assert.equal(ui.shadow.querySelector('#mineFeedList .rm-post-author-badge[data-kind="user"]').textContent, '本人');
    assert.equal(ui.shadow.querySelector('#mineFeedList .rm-post-author-badge[data-kind="agent"]').textContent, 'Agent');
    assert.equal(ui.shadow.querySelector('#mineFeedList .rm-post-author-badge[data-kind="unknown"]').textContent, '来源未注明');
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
    peerId: 'local-peer-id', publisherName: 'Alice', name: 'post.json', sha256: 'f'.repeat(64),
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
    assert.match(ui.text('#postAuthorNote'), /署名来源保留为Agent/);
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
    assert.match(ui.text('#postAuthorNote'), /将以 Agent.*署名发布/);
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
