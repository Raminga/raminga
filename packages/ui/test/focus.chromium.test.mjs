// Real-Chromium focus regression for the add-contact request lifecycle.
//
// jsdom does not blur a focused control when it becomes disabled, so the DOM
// tests cannot reproduce the original P2 (`document.activeElement` falls to
// BODY). This test builds a temporary copy of the browser bundle, mounts it in
// headless Chromium and drives the same focus/click/submit sequence a keyboard
// user performs. It needs no project dependency: Chrome/Chromium is discovered
// locally and the test is skipped when none is available.
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
  // Playwright's browser cache, when present, avoids any extra dependency.
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
  const address = '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';
  const success = {
    ok: true,
    peerId: '12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe',
    route: 'direct',
    transport: 'tcp',
    reused: false,
    contact: { ok: true, found: true },
    status: { ok: true },
  };
  const host = document.getElementById('host');
  const app = RamingaUI.mountRamingaApp(host, {
    viewState: RamingaUI.createViewState(),
    onLoadContacts: async () => ({ friends: [], at: Date.now(), error: null, freshness: 'live', connectionFreshness: 'live', total: 0 }),
    onConnect: () => {
      window.__calls += 1;
      return new Promise((resolve) => { window.__resolve = resolve; });
    },
  });
  const shadow = host.shadowRoot;
  const q = (selector) => shadow.querySelector(selector);
  const activeId = () => shadow.activeElement?.id ?? null;
  const input = () => q('#addContactInput');
  const submit = () => q('#addContactSubmit');
  const view = () => q('#addContactView');
  const close = () => q('#addContactDialog [data-close-dialog]');
  try {
    q('#addContact').click();
    input().value = address;
    submit().focus();
    submit().click();
    results.busy = {
      active: activeId(),
      submitDisabled: submit().disabled,
      ariaDisabled: submit().getAttribute('aria-disabled'),
      inputDisabled: input().disabled,
      inputReadOnly: input().readOnly,
    };
    submit().click();
    results.callsAfterDuplicate = window.__calls;
    window.__resolve({ ok: false, error: 'dial tcp 127.0.0.1:1: connect: connection refused' });
    await sleep(50);
    results.failure = {
      active: activeId(),
      activeTag: shadow.activeElement?.tagName ?? null,
      documentActive: document.activeElement?.tagName ?? null,
      submitDisabled: submit().disabled,
      retryText: submit().textContent,
      inputReadOnly: input().readOnly,
      tone: q('#addContactFeedback').dataset.tone,
    };
    submit().click();
    results.callsBeforeRetry = window.__calls;
    window.__resolve(success);
    await sleep(50);
    results.success = {
      active: activeId(),
      viewHidden: view().hidden,
      submitHidden: submit().hidden,
      inputDisabled: input().disabled,
      inputReadOnly: input().readOnly,
    };

    // Close, reopen, then move to the close button while a new request is in
    // flight. The late success must not steal focus back to 查看联系人.
    close().click();
    q('#addContact').click();
    input().value = address;
    submit().focus();
    submit().click();
    const closeButton = close();
    closeButton.focus();
    window.__resolve(success);
    await sleep(50);
    results.moved = {
      activeIsClose: shadow.activeElement === closeButton,
      viewHidden: view().hidden,
    };

    // Close again, reopen an empty form, then let the previous request settle.
    closeButton.click();
    q('#addContact').click();
    input().value = address;
    submit().focus();
    submit().click();
    close().click();
    q('#addContact').click();
    window.__resolve(success);
    await sleep(50);
    results.late = {
      active: activeId(),
      feedbackHidden: q('#addContactFeedback').hidden,
      submitHidden: submit().hidden,
      viewHidden: view().hidden,
      inputValue: input().value,
    };
    app.destroy();
    document.body.textContent = 'RESULT:' + JSON.stringify(results);
  } catch (error) {
    document.body.textContent = 'ERROR:' + (error && error.stack ? error.stack : String(error));
  }
})();
`;

test('real Chromium keeps add-contact focus through failure, retry, success and late results', {
  skip: chrome === null ? 'Chrome/Chromium is not installed' : false,
}, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-focus-'));
  try {
    const bundle = path.join(tmp, 'bundle.js');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), bundle], { stdio: 'pipe' });
    fs.writeFileSync(path.join(tmp, 'page.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host" style="width:900px;height:800px"></div>
<script src="bundle.js"></script>
<script>window.__calls = 0;</script>
<script src="focus.js"></script>
</body></html>`);
    fs.writeFileSync(path.join(tmp, 'focus.js'), browserScript);
    const stdout = execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      '--virtual-time-budget=5000',
      '--dump-dom',
      `file://${path.join(tmp, 'page.html')}`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    const match = /RESULT:(\{.*?\})<\/body>/s.exec(stdout);
    assert.ok(match, `browser did not return a result:\n${stdout.slice(-2000)}`);
    const result = JSON.parse(match[1]);

    assert.equal(result.busy.active, 'addContactSubmit');
    assert.equal(result.busy.submitDisabled, false);
    assert.equal(result.busy.ariaDisabled, 'true');
    assert.equal(result.busy.inputDisabled, false);
    assert.equal(result.busy.inputReadOnly, true);
    assert.equal(result.callsAfterDuplicate, 1, 'busy click must not start a second dial');

    assert.equal(result.failure.active, 'addContactSubmit');
    assert.equal(result.failure.submitDisabled, false);
    assert.equal(result.failure.retryText, '重试连接');
    assert.equal(result.failure.inputReadOnly, false);
    assert.equal(result.failure.tone, 'error');
    assert.notEqual(result.failure.documentActive, 'BODY');
    assert.equal(result.callsBeforeRetry, 2);

    assert.equal(result.success.active, 'addContactView');
    assert.equal(result.success.viewHidden, false);
    assert.equal(result.success.submitHidden, true);
    assert.equal(result.success.inputDisabled, false);
    assert.equal(result.success.inputReadOnly, true);

    assert.equal(result.moved.activeIsClose, true, 'a user-moved focus target must win');
    assert.equal(result.moved.viewHidden, false);

    assert.equal(result.late.active, 'addContactInput');
    assert.equal(result.late.feedbackHidden, true);
    assert.equal(result.late.submitHidden, false);
    assert.equal(result.late.viewHidden, true);
    assert.equal(result.late.inputValue, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
