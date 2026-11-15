// Real DOM behavior for the daemon-backed contact list.
//
// Pure state helpers are covered in contacts.test.mjs. These tests mount the
// actual template through createRamingaApp in jsdom and drive the same DOM
// operations a host poll uses, so focus identity, row reuse and scroll are
// verified rather than inferred from strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');

const PEER_A = '12D3KooWContactsPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWContactsPeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function friend(peerId, overrides = {}) {
  return {
    peerId,
    name: '',
    description: '',
    connection: 'unknown',
    paused: false,
    ...overrides,
  };
}

function contacts(friends, overrides = {}) {
  return {
    friends,
    at: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    connectionFreshness: 'live',
    total: friends.length,
    ...overrides,
  };
}

function mountUi(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const host = dom.window.document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = template;
  // jsdom 31 still has no HTMLDialogElement.showModal/close. The app only uses
  // those two methods plus the open property, so provide the minimal native
  // contract here instead of mounting without dialogs.
  for (const dialog of shadow.querySelectorAll('dialog')) {
    if (typeof dialog.showModal === 'function') continue;
    dialog.showModal = function showModal() {
      if (this.open) return;
      this.open = true;
    };
    dialog.close = function close() {
      if (!this.open) return;
      this.open = false;
      this.dispatchEvent(new dom.window.Event('close'));
    };
  }
  // app.js creates a global AbortController; jsdom's EventTarget only accepts
  // the AbortSignal class from its own window.
  globalThis.AbortController = dom.window.AbortController;
  globalThis.document = dom.window.document;
  const app = createRamingaApp(shadow, {
    viewState: { page: 'contacts', pages: { contacts: { query: '', scroll: 0 } } },
    ...options,
  });
  return {
    dom,
    shadow,
    app,
    page: shadow.querySelector('#page-contacts'),
    query: shadow.querySelector('#contactQuery'),
    list: shadow.querySelector('#contactList'),
    meta: shadow.querySelector('#contactsMeta'),
    metaRetry: shadow.querySelector('#contactsMetaRetry'),
    stateTitle: shadow.querySelector('#contactsStateTitle'),
    stateBody: shadow.querySelector('#contactsStateBody'),
    stateAction: shadow.querySelector('#contactsStateAction'),
    stateRetry: shadow.querySelector('#contactsStateRetry'),
    addTrigger: shadow.querySelector('#addContact'),
    addDialog: shadow.querySelector('#addContactDialog'),
    addForm: shadow.querySelector('#addContactForm'),
    addInput: shadow.querySelector('#addContactInput'),
    addSubmit: shadow.querySelector('#addContactSubmit'),
    addCheck: shadow.querySelector('#addContactCheck'),
    addView: shadow.querySelector('#addContactView'),
    addClose: shadow.querySelector('#addContactDialog [data-close-dialog]'),
    addFeedback: shadow.querySelector('#addContactFeedback'),
    addFeedbackTitle: shadow.querySelector('#addContactFeedbackTitle'),
    active: () => shadow.activeElement,
    close: () => {
      app.destroy();
      dom.window.close();
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('a 4s contact refresh reuses the focused Peer row and keeps scroll', () => {
  const ui = mountUi({ onLoadContacts: async () => contacts([]) });
  try {
    ui.app.setContacts(contacts([
      friend(PEER_A, { name: 'Alice', connection: 'connected' }),
      friend(PEER_B, { name: 'Bob' }),
    ]));
    const rows = [...ui.list.querySelectorAll('button[data-contact-peer]')];
    assert.equal(rows.length, 2);
    const focused = rows[0];
    focused.focus();
    assert.equal(ui.active(), focused);
    ui.page.scrollTop = 180;
    ui.list.scrollTop = 40;

    ui.app.setContacts(contacts([
      friend(PEER_A, { name: 'Alice（已更新）', connection: 'disconnected' }),
      friend(PEER_B, { name: 'Bob', connection: 'connected' }),
    ]));

    const refreshed = ui.list.querySelector(`button[data-contact-peer="${PEER_A}"]`);
    assert.equal(refreshed, focused, 'the focused row must be the same DOM node');
    assert.equal(ui.active(), focused, 'focus must remain on the contact row');
    assert.match(refreshed.textContent, /Alice（已更新）/);
    assert.equal(refreshed.querySelector('.rm-contact-state').textContent, '未连接');
    assert.deepEqual(
      [...ui.list.querySelectorAll('button[data-contact-peer]')].map((row) => row.dataset.contactPeer),
      [PEER_A, PEER_B],
    );
    assert.equal(ui.page.scrollTop, 180, 'polling must not reset the page scroll');
    assert.equal(ui.list.scrollTop, 40, 'polling must not reset the list scroll');

    // The same retained rows and focus survive a failed refresh; the list says
    // it is stale and offers a reachable retry instead of disappearing.
    ui.app.setContactsError(new Error('daemon unavailable'));
    assert.equal(ui.list.querySelector(`button[data-contact-peer="${PEER_A}"]`), focused);
    assert.equal(ui.active(), focused, 'a failed refresh must keep the focused row');
    assert.equal(ui.list.querySelectorAll('button[data-contact-peer]').length, 2);
    assert.equal(ui.meta.hidden, false);
    assert.match(ui.meta.textContent, /刷新失败/);
    assert.equal(ui.metaRetry.hidden, false);
    assert.equal(ui.page.scrollTop, 180);
  } finally {
    ui.close();
  }
});

test('search-empty with a failed refresh keeps old data, stale feedback and focus', async () => {
  let retries = 0;
  const ui = mountUi({
    onLoadContacts: async () => {
      retries += 1;
      return contacts([friend(PEER_A, { name: 'Alice' })]);
    },
  });
  try {
    ui.app.setContacts(contacts([friend(PEER_A, { name: 'Alice' })]));
    ui.query.value = '不存在的联系人';
    ui.query.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));

    assert.equal(ui.stateTitle.textContent, '没有找到匹配的联系人');
    const clear = ui.stateAction;
    clear.focus();
    assert.equal(ui.active(), clear);

    // The daemon read now fails. The query and the old list snapshot stay; the
    // no-result card must say the list may be stale and offer a retry.
    ui.app.setContactsError(new Error('daemon unavailable'));
    assert.equal(ui.stateTitle.textContent, '没有找到匹配的联系人');
    assert.equal(ui.stateAction, clear, 'the clear-search button must be reused');
    assert.equal(ui.active(), clear, 'a failed refresh must not drop focus to the body');
    assert.match(ui.meta.textContent, /列表可能不是最新/);
    assert.match(ui.meta.textContent, /刷新失败/);
    assert.equal(ui.meta.hidden, false);
    assert.equal(ui.stateRetry.hidden, false);
    assert.equal(ui.stateRetry.textContent, '重试读取');

    // A second 4s refresh failure repeats the same state without replacing the
    // focused action node.
    ui.app.setContactsError(new Error('daemon unavailable again'));
    assert.equal(ui.stateAction, clear);
    assert.equal(ui.active(), clear);

    // The retry action is reachable from the no-result card. It keeps the
    // query and the old snapshot while the host re-reads.
    ui.stateRetry.focus();
    ui.stateRetry.click();
    await Promise.resolve();
    assert.equal(retries, 1);
    assert.equal(ui.query.value, '不存在的联系人');
    assert.equal(ui.stateTitle.textContent, '没有找到匹配的联系人');
    assert.equal(ui.active(), ui.stateRetry);

    // Retaining the snapshot is not just cosmetic: clearing the search after
    // the failure shows the previous real rows instead of an empty list.
    clear.click();
    assert.equal(ui.query.value, '');
    assert.equal(ui.list.querySelectorAll('button[data-contact-peer]').length, 1);
    assert.equal(retries, 1, 'clearing search is local and must not re-read');
  } finally {
    ui.close();
  }
});

test('an empty list whose latest read failed keeps its old read time', () => {
  const ui = mountUi({ onLoadContacts: async () => contacts([]) });
  try {
    const at = Date.now() - 5000;
    ui.app.setContacts(contacts([], { at }));
    ui.app.setContactsError(new Error('daemon unavailable'));

    assert.equal(ui.stateTitle.textContent, '这次没有读到联系人');
    assert.match(ui.stateBody.textContent, /上次成功读取/);
    assert.match(ui.stateBody.textContent, /当时没有联系人/);
    assert.match(ui.stateBody.textContent, /不代表现在也没有/);
    assert.equal(ui.stateAction.textContent, '重试读取');
    assert.equal(ui.stateAction.hidden, false);

    ui.stateAction.focus();
    ui.app.setContactsError(new Error('daemon unavailable again'));
    assert.equal(ui.active(), ui.stateAction, 'the retry action survives another failed refresh');
  } finally {
    ui.close();
  }
});

test('a stale empty snapshot is not presented as a current empty list', () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ui = mountUi({ onLoadContacts: () => gate });
  try {
    const at = Date.now() - 5000;
    ui.app.setContacts(contacts([], { at, freshness: 'stale', connectionFreshness: 'unknown' }));

    assert.notEqual(ui.stateTitle.textContent, '还没有联系人');
    assert.match(ui.stateTitle.textContent, /过期|无法确认/);
    assert.match(ui.stateBody.textContent, /上次成功读取/);
    assert.match(ui.stateBody.textContent, /当时没有联系人/);
    assert.match(ui.stateBody.textContent, /不代表现在也没有/);
    assert.equal(ui.stateAction.textContent, '重试读取');
    assert.equal(ui.stateAction.hidden, false);
    ui.stateAction.focus();
    assert.equal(ui.active(), ui.stateAction);

    // A refresh with no new result keeps the old timestamp and retry action,
    // and does not turn the old empty snapshot into "no contacts now".
    ui.app.setContacts(contacts([], { at, freshness: 'stale', connectionFreshness: 'unknown' }));
    assert.equal(ui.active(), ui.stateAction);
    assert.match(ui.stateBody.textContent, /上次成功读取/);

    // Retrying does not clear the snapshot before the host answers.
    ui.stateAction.click();
    assert.equal(ui.stateTitle.textContent, '联系人列表可能已过期');
    assert.match(ui.stateBody.textContent, /上次成功读取/);
    assert.equal(ui.stateAction.textContent, '正在重试…');

    const success = contacts([friend(PEER_A, { name: 'New peer' })]);
    release(success);
    // The host adapter applies its own read result through setContacts, exactly
    // like loadContacts() in panel-runtime.
    ui.app.setContacts(success);
    assert.equal(ui.stateTitle.closest('#contactsState').hidden, true);
    assert.equal(ui.list.querySelectorAll('button[data-contact-peer]').length, 1);
    assert.equal(ui.active(), ui.list.querySelector('button[data-contact-peer]'), 'successful retry moves focus into the restored list');
  } catch (error) {
    ui.close();
    throw error;
  }
});

test('a failed connection keeps focus on retry, blocks duplicates, and success moves to the view action', async () => {
  const pending = [];
  const calls = [];
  const ui = mountUi({
    onConnect: (input) => {
      calls.push(input);
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
  });
  const address = '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';
  try {
    // jsdom 31 does not blur a focused control when it is disabled, so this
    // test deliberately regression-checks the implementation strategy: busy
    // state must stay focusable (aria-disabled/readonly) instead of native
    // disabled. The real Chromium behavior is covered by the browser check.
    ui.addTrigger.focus();
    ui.addTrigger.click();
    assert.equal(ui.addDialog.open, true);
    assert.equal(ui.active(), ui.addInput, 'opening the form focuses the input');

    ui.addInput.value = address;
    ui.addSubmit.focus();
    ui.addSubmit.click();
    assert.equal(calls.length, 1);
    assert.equal(ui.active(), ui.addSubmit, 'busy must not drop focus to the document body');
    assert.equal(ui.addSubmit.disabled, false, 'busy submit must remain focusable');
    assert.equal(ui.addSubmit.getAttribute('aria-disabled'), 'true');
    assert.equal(ui.addInput.disabled, false, 'busy input must remain focusable');
    assert.equal(ui.addInput.readOnly, true);

    // A second click and a form submit while the first request is outstanding
    // must be ignored, not start another dial.
    ui.addSubmit.click();
    ui.addForm.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(calls.length, 1, 'duplicate submissions are guarded');

    pending[0].resolve({ ok: false, error: 'dial tcp 127.0.0.1:1: connect: connection refused' });
    await settle();
    assert.equal(ui.active(), ui.addSubmit, 'failure keeps keyboard focus on retry');
    assert.equal(ui.addSubmit.textContent, '重试连接');
    assert.equal(ui.addSubmit.getAttribute('aria-disabled'), null);
    assert.equal(ui.addInput.readOnly, false);
    assert.equal(ui.addFeedbackTitle.textContent, '连接没有完成');
    assert.match(ui.addFeedback.textContent, /connection refused/);

    // Retry from the still-focused button, then succeed.
    ui.addSubmit.click();
    assert.equal(calls.length, 2);
    pending[1].resolve({
      ok: true,
      peerId: '12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe',
      route: 'direct',
      transport: 'tcp',
      reused: false,
      contact: { ok: true, found: true },
      status: { ok: true },
    });
    await settle();
    assert.equal(ui.addView.hidden, false);
    assert.equal(ui.addSubmit.hidden, true);
    assert.equal(ui.addInput.readOnly, true, 'a completed field stays non-editable without becoming unfocusable');
    assert.equal(ui.active(), ui.addView, 'success moves focus to 查看联系人');

    // Enter on the focused success action is the natural next step.
    const peerId = '12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';
    ui.app.setContacts(contacts([friend(peerId, { name: 'Connected peer' })]));
    ui.addView.click();
    assert.equal(ui.addDialog.open, false);
    assert.equal(ui.active(), ui.list.querySelector(`button[data-contact-peer="${peerId}"]`));
  } finally {
    ui.close();
  }
});

test('a settled request never steals focus from a control the user moved to', async () => {
  const request = deferred();
  const ui = mountUi({ onConnect: () => request.promise });
  try {
    ui.addTrigger.click();
    ui.addInput.value = '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';
    ui.addSubmit.focus();
    ui.addSubmit.click();

    ui.addClose.focus();
    assert.equal(ui.active(), ui.addClose, 'the user moved to the close button while waiting');
    request.resolve({
      ok: true,
      peerId: '12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe',
      route: 'direct',
      transport: 'tcp',
      contact: { ok: true, found: true },
      status: { ok: true },
    });
    await settle();
    assert.equal(ui.addView.hidden, false);
    assert.equal(ui.active(), ui.addClose, 'the late result must not steal focus back');
  } finally {
    ui.close();
  }
});

test('a late result after close and reopen neither updates nor focuses the new form', async () => {
  const request = deferred();
  const ui = mountUi({ onConnect: () => request.promise });
  try {
    ui.addTrigger.click();
    ui.addInput.value = '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';
    ui.addSubmit.focus();
    ui.addSubmit.click();

    ui.addClose.click();
    assert.equal(ui.addDialog.open, false);
    assert.equal(ui.active(), ui.addTrigger, 'closing the form restores its trigger');

    ui.addTrigger.click();
    assert.equal(ui.addDialog.open, true);
    assert.equal(ui.active(), ui.addInput, 'the new form starts empty and focused');
    assert.equal(ui.addFeedback.hidden, true);

    request.resolve({
      ok: true,
      peerId: '12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe',
      route: 'direct',
      transport: 'tcp',
      contact: { ok: true, found: true },
      status: { ok: true },
    });
    await settle();
    assert.equal(ui.active(), ui.addInput, 'the old result must not focus the new form');
    assert.equal(ui.addFeedback.hidden, true, 'the old result must not overwrite the new form');
    assert.equal(ui.addSubmit.hidden, false);
    assert.equal(ui.addView.hidden, true);
  } finally {
    ui.close();
  }
});

test('destroying the panel before a connection result settles has no focus target', async () => {
  const request = deferred();
  const ui = mountUi({ onConnect: () => request.promise });
  try {
    ui.addTrigger.click();
    ui.addInput.value = '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';
    ui.addSubmit.focus();
    ui.addSubmit.click();
    ui.app.destroy();
    assert.equal(ui.shadow.querySelector('#addContactDialog'), null);

    request.resolve({
      ok: true,
      peerId: '12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe',
      route: 'direct',
      transport: 'tcp',
      contact: { ok: true, found: true },
      status: { ok: true },
    });
    await settle();
    assert.equal(ui.shadow.querySelector('#addContactView'), null);
    assert.equal(ui.active(), null);
  } finally {
    ui.close();
  }
});

test('the contact re-check keeps its focus while busy and moves to 查看联系人 on success', async () => {
  const check = deferred();
  let checks = 0;
  const ui = mountUi({
    onConnect: async () => ({
      ok: true,
      peerId: '12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe',
      route: 'direct',
      transport: 'tcp',
      contact: { ok: true, found: false },
      status: { ok: true },
    }),
    onCheckContact: () => {
      checks += 1;
      return check.promise;
    },
  });
  try {
    ui.addTrigger.click();
    ui.addInput.value = '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';
    ui.addSubmit.focus();
    ui.addSubmit.click();
    await settle();
    assert.equal(ui.addCheck.hidden, false);
    assert.equal(ui.active(), ui.addCheck, 'a partial success focuses the re-check action');

    ui.addCheck.click();
    assert.equal(checks, 1);
    assert.equal(ui.active(), ui.addCheck, 're-check busy must keep focus');
    assert.equal(ui.addCheck.disabled, false);
    assert.equal(ui.addCheck.getAttribute('aria-disabled'), 'true');
    ui.addCheck.click();
    assert.equal(checks, 1, 'duplicate re-checks are guarded');

    check.resolve({ ok: true, found: true, contacts: contacts([]) });
    await settle();
    assert.equal(ui.addCheck.hidden, true);
    assert.equal(ui.addView.hidden, false);
    assert.equal(ui.active(), ui.addView, 're-check success moves focus to 查看联系人');
  } finally {
    ui.close();
  }
});
