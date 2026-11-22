// Real-Chromium regression for a local favorite's "查看来源" action.
//
// A local favorite is authored by this node. Opening the remote contact
// profile would dial ourselves, show "Agent 档案未公开" and offer adding or
// messaging ourselves. The source must instead open the owner's published
// profile in Settings, keep the favorites position/pagination, and leave the
// remote-author profile path unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (fs.existsSync(cache)) {
    const builds = fs.readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      const candidate = path.join(cache, build, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
      if (fs.existsSync(candidate)) return candidate;
      const linux = path.join(cache, build, 'chrome-linux', 'chrome');
      if (fs.existsSync(linux)) return linux;
    }
  }
  return null;
}

const chrome = findChrome();
const REMOTE_PEER = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';

const browserScript = String.raw`
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = { peerProfiles: [], favoriteRequests: [] };
  const SELF = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';
  const REMOTE = '12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6';
  const row = (id, peerId, title) => ({
    id, peerId, path: 'posts/' + id + '/post.json', sha256: 'a'.repeat(64), title,
    createdAt: 2000, available: true,
  });
  const firstPage = Array.from({ length: 50 }, (_, i) => row('extra-' + i, SELF, '分页收藏 ' + i));
  const secondPage = [
    ...Array.from({ length: 4 }, (_, i) => row('more-' + i, SELF, '加载收藏 ' + i)),
    row('local-source', SELF, '本机来源收藏'),
    row('remote-source', REMOTE, '远端来源收藏'),
  ];
  const host = document.getElementById('host');
  const viewState = RamingaUI.createViewState();
  viewState.page = 'settings';
  viewState.settings.index = false;
  viewState.settings.tab = 'favorites';
  viewState.settings.scroll = 0;
  const app = RamingaUI.mountRamingaApp(host, {
    viewState,
    onLoadFavorites: async (before) => {
      results.favoriteRequests.push(before);
      const favorites = before === '' ? firstPage : secondPage;
      return {
        favorites, at: Date.now(), error: null, errorAt: null, freshness: 'live',
        hasMore: before === '', nextBefore: before === '' ? 'next-page' : '', total: favorites.length,
      };
    },
    onLoadMine: async () => ({
      peerId: SELF,
      files: [],
      posts: { state: 'missing', posts: [] },
      profile: { state: 'available', displayName: '本人验收', markdown: '# 本人验收\n\n本机公开介绍。' },
      agentCard: { state: 'available', card: { displayName: '本机 Agent', description: '本机公开 Agent 介绍。' }, error: '' },
      publicProfile: { state: 'missing', profile: null },
    }),
    onLoadPublicDraft: async () => ({ found: false, draft: null }),
    onLoadPeerProfile: async (peerId) => {
      results.peerProfiles.push(peerId);
      return {
        peerId: REMOTE, localName: '远端验收', remoteName: '远端验收', found: true,
        text: '# 远端验收\n\n远端作者公开资料。', files: ['profile/index.md'], at: Date.now(), error: null,
        freshness: 'live', agentCard: { state: 'missing', card: null, error: 'missing' },
      };
    },
  });
  app.onLeaseReady();
  const shadow = host.shadowRoot;
  const settingsPage = shadow.querySelector('#page-settings');
  const source = (id) => shadow.querySelector('[data-favorite-source="' + id + '"]');
  try {
    await sleep(300);
    shadow.querySelector('#settingsFavoritesMore').click();
    await sleep(300);
    results.rowsAfterMore = shadow.querySelectorAll('#settingsFavoritesList .rm-favorite-row').length;

    settingsPage.scrollTop = settingsPage.scrollHeight;
    await sleep(120);
    results.scrollBefore = settingsPage.scrollTop;
    results.localVisible = source('local-source').getBoundingClientRect().top < settingsPage.clientHeight;
    source('local-source').click();
    await sleep(300);

    results.localPeerProfiles = results.peerProfiles.slice();
    results.localOpen = {
      profileHidden: shadow.querySelector('#profileView').hidden,
      publicVisible: !shadow.querySelector('#settings-public').hidden,
      favoritesHidden: shadow.querySelector('#settings-favorites').hidden,
      agentName: shadow.querySelector('#publicAgentName').value,
      humanName: shadow.querySelector('#publicHumanName').value,
      backLabel: shadow.querySelector('#settings-public [data-settings-back]').textContent,
    };

    shadow.querySelector('#settings-public [data-settings-back]').click();
    await sleep(300);
    results.afterLocalBack = {
      scroll: settingsPage.scrollTop,
      rows: shadow.querySelectorAll('#settingsFavoritesList .rm-favorite-row').length,
      favoritesVisible: !shadow.querySelector('#settings-favorites').hidden,
      active: shadow.activeElement?.dataset?.favoriteSource || null,
    };

    source('remote-source').click();
    await sleep(300);
    results.remoteOpen = {
      profileVisible: !shadow.querySelector('#profileView').hidden,
      peerName: shadow.querySelector('#profileName').textContent,
      addContactVisible: !shadow.querySelector('#profileAddContact').hidden,
      messageVisible: !shadow.querySelector('#profileMessage').hidden,
    };
    shadow.querySelector('#profileBack').click();
    await sleep(300);
    results.afterRemoteBack = { scroll: settingsPage.scrollTop, rows: shadow.querySelectorAll('#settingsFavoritesList .rm-favorite-row').length };

    const pre = document.createElement('pre');
    pre.id = 'RESULT';
    pre.textContent = JSON.stringify(results);
    document.body.append(pre);
    app.destroy();
  } catch (error) {
    document.body.textContent = 'ERROR:' + (error && error.stack ? error.stack : String(error));
  }
})();
`;

test('real Chromium local favorite source opens own public profile and returns to favorites position', {
  skip: chrome === null ? 'Chrome/Chromium is not installed' : false,
}, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-fav-source-'));
  try {
    const bundle = path.join(tmp, 'bundle.js');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), bundle], { stdio: 'pipe' });
    fs.writeFileSync(path.join(tmp, 'page.html'), `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%}#host{width:1280px;height:800px}</style></head><body>
<div id="host"></div>
<script>
window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
</script>
<script src="bundle.js"></script>
<script src="probe.js"></script>
</body></html>`);
    fs.writeFileSync(path.join(tmp, 'probe.js'), browserScript);
    const stdout = execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      '--window-size=1280,800',
      '--virtual-time-budget=10000',
      '--dump-dom',
      `file://${path.join(tmp, 'page.html')}`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 40_000 });
    const match = /<pre id="RESULT">(.*?)<\/pre>/s.exec(stdout);
    assert.ok(match, `browser did not return a result:\n${stdout.slice(-2000)}`);
    const result = JSON.parse(match[1]);

    assert.equal(result.rowsAfterMore, 56);
    assert.deepEqual(result.favoriteRequests, ['', 'next-page']);
    assert.ok(result.scrollBefore > 0, 'favorites list must be a real scroller');
    assert.equal(result.localVisible, true, 'the clicked local source is physically visible');

    assert.equal(result.localOpen.profileHidden, true, 'self source must not open the remote contact profile');
    assert.equal(result.localOpen.publicVisible, true);
    assert.equal(result.localOpen.favoritesHidden, true);
    assert.equal(result.localOpen.agentName, '本机 Agent');
    assert.equal(result.localOpen.humanName, '本人验收');
    assert.equal(result.localOpen.backLabel, '← 返回收藏的动态');
    assert.deepEqual(result.localPeerProfiles, [], 'self source must not dial the local peer');

    assert.ok(Math.abs(result.afterLocalBack.scroll - result.scrollBefore) <= 1, 'favorites scroll returns');
    assert.equal(result.afterLocalBack.rows, 56);
    assert.equal(result.afterLocalBack.favoritesVisible, true);
    assert.equal(result.afterLocalBack.active, 'local-source');
    assert.deepEqual(result.favoriteRequests, ['', 'next-page'], 'return keeps loaded pages');

    assert.deepEqual(result.peerProfiles, [REMOTE_PEER], 'remote source still reads the peer profile');
    assert.equal(result.remoteOpen.profileVisible, true);
    assert.equal(result.remoteOpen.peerName, '远端验收');
    assert.equal(result.afterRemoteBack.rows, 56);
    assert.ok(Math.abs(result.afterRemoteBack.scroll - result.scrollBefore) <= 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
