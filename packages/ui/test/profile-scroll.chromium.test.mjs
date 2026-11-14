// Real-Chromium regression for profile back restoring the feed position.
//
// jsdom cannot model a display:none scroller: Chromium reports scrollTop 0 for
// the hidden source page while the profile (its own overflow scroller) is open.
// This test reproduces the real sequence, a profile scroll save and a
// focus-induced 0 before the author click, then verifies the captured position
// on back. Chrome/Chromium is discovered locally and the test is skipped when
// unavailable. It needs no project dependency.
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

const browserScript = String.raw`
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = {};
  const peer = '12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';
  const longText = Array.from({ length: 24 }, (_, i) => '这是第 ' + i + ' 段远端公开资料，用来形成可滚动的档案内容。').join('\n\n');
  const posts = Array.from({ length: 10 }, (_, i) => ({
    id: String(100 + i), peerId: peer, path: 'posts/' + i + '.json', sha256: 'a'.repeat(64),
    sizeBytes: 400, fetchedAt: Date.now(), source: 'raminga_content_get', authorKind: 'user',
    authorName: '阶段7对端用户', title: '阶段7长内容公开帖子 ' + i, summary: '摘要 ' + i,
    tags: ['stage7'], publishedAt: '2026-11-14T10:00:00Z', contentState: 'available', contentError: '',
  }));
  const host = document.getElementById('host');
  const viewState = RamingaUI.createViewState();
  viewState.pages.explore.expanded['100'] = true;
  const app = RamingaUI.mountRamingaApp(host, {
    viewState,
    onLoadDiscoveries: async () => ({ items: posts, at: Date.now(), error: null, errorAt: null, freshness: 'live', familiar: false, scanned: posts.length, truncated: false, relationComplete: true, ignored: 0 }),
    onLoadDiscoveryContent: async (id) => ({ ok: true, id, peerId: peer, path: 'posts/x.json', sha256: 'b'.repeat(64), source: 'raminga_content_get', fetchedAt: Date.now(), post: { title: 'post', bodyMarkdown: Array.from({ length: 14 }, (_, i) => '这是第 ' + i + ' 段正文，用来形成足够长的可滚动内容。').join('\n\n'), tags: [], publishedAt: '2026-11-14T10:00:00Z', authorPeerId: peer, authorKind: 'user', authorName: '阶段7对端用户', path: 'posts/x.json', sha256: 'b'.repeat(64), sizeBytes: 400, contentState: 'available' }, error: null }),
    onLoadPeerProfile: async () => ({ peerId: peer, localName: '阶段7对端用户', remoteName: '阶段7对端用户', found: true, text: '# 阶段7对端用户\n\n' + longText, files: ['profile/index.md'], at: Date.now(), error: null, freshness: 'live', agentCard: { state: 'missing', card: null, error: 'missing' } }),
  });
  app.onLeaseReady();
  const shadow = host.shadowRoot;
  const page = shadow.querySelector('#page-explore');
  const profile = shadow.querySelector('#profileView');
  const author = () => shadow.querySelector('#discoveryList [data-profile-peer]');
  try {
    await sleep(200);
    page.scrollTop = 40;
    await sleep(80);
    results.before = { scroll: page.scrollTop, authorTop: author().getBoundingClientRect().top };

    author().click();
    await sleep(100);
    results.open = { sourceScroll: viewState.pages.explore.scroll, pageHidden: page.hidden, profileHidden: profile.hidden, profileHeight: profile.scrollHeight };
    profile.scrollTop = 200;
    await sleep(120);
    results.profileScrolled = { sourceScroll: viewState.pages.explore.scroll, profileTop: profile.scrollTop };

    shadow.querySelector('#profileBack').click();
    await sleep(120);
    results.afterBack = {
      scroll: page.scrollTop,
      sourceScroll: viewState.pages.explore.scroll,
      authorTop: author().getBoundingClientRect().top,
      active: shadow.activeElement?.dataset?.profileRef || shadow.activeElement?.id || null,
    };

    // Focus-induced collapse before the click: record the position at
    // pointerdown, let a synthetic default action collapse the page, then click.
    page.scrollTop = 40;
    await sleep(80);
    author().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    page.scrollTop = 0;
    author().click();
    await sleep(100);
    results.focusOpen = { sourceScroll: viewState.pages.explore.scroll };
    shadow.querySelector('#profileBack').click();
    await sleep(120);
    results.focusBack = { scroll: page.scrollTop, sourceScroll: viewState.pages.explore.scroll };

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

test('real Chromium profile back survives profile scrolling and focus-induced collapse', {
  skip: chrome === null ? 'Chrome/Chromium is not installed' : false,
}, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-profile-scroll-'));
  try {
    const bundle = path.join(tmp, 'bundle.js');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), bundle], { stdio: 'pipe' });
    fs.writeFileSync(path.join(tmp, 'page.html'), `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%}#host{width:1280px;height:800px}</style></head><body>
<div id="host"></div>
<script>
// The app uses rAF for coalesced view saves. Chrome's --virtual-time-budget
// does not reliably tick rAF in headless dump-dom mode, so map it to a timer
// while preserving the coalescing semantics under test.
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

    assert.equal(result.before.scroll, 40);
    assert.ok(result.before.authorTop > 0 && result.before.authorTop < 800, 'author is visible before the click');
    assert.equal(result.open.pageHidden, true);
    assert.equal(result.open.profileHidden, false);
    assert.equal(result.open.sourceScroll, 40, 'entry snapshot is saved before hiding the source page');
    assert.ok(result.open.profileHeight > 800, 'profile is a real scroller');
    assert.ok(result.profileScrolled.profileTop > 0, 'the profile actually scrolled');
    assert.equal(result.profileScrolled.sourceScroll, 40, 'profile scrolling must not capture the hidden source 0');
    assert.equal(result.afterBack.scroll, 40, 'back restores the source page position');
    assert.equal(result.afterBack.sourceScroll, 40);
    assert.equal(result.afterBack.authorTop, result.before.authorTop, 'the same author is back at the same viewport position');
    assert.equal(result.afterBack.active, 'explore:100', 'focus returns to the author trigger');

    assert.equal(result.focusOpen.sourceScroll, 40, 'pointerdown snapshot survives a pre-click collapse');
    assert.equal(result.focusBack.scroll, 40);
    assert.equal(result.focusBack.sourceScroll, 40);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
