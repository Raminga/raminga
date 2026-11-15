// Focused DOM behavior for the one local-contact edit form. These fields are
// local labels published in friends.json; editing must never touch a remote
// profile, and a blank value must be an explicit clear that does not erase the
// other field.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRamingaApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');
const PEER_A = '12D3KooWFriendEditPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function friend(overrides = {}) {
  return {
    peerId: PEER_A,
    name: 'alice',
    description: 'music and tea',
    connection: 'connected',
    paused: false,
    ...overrides,
  };
}

function contacts(rows) {
  return {
    friends: rows,
    at: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    connectionFreshness: 'live',
    total: rows.length,
  };
}

function mountUi(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const host = dom.window.document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = template;
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
    list: shadow.querySelector('#contactList'),
    menu: shadow.querySelector('#contactQuickMenu'),
    dialog: shadow.querySelector('#editContactDialog'),
    form: shadow.querySelector('#editContactForm'),
    peer: shadow.querySelector('#editContactPeerId'),
    name: shadow.querySelector('#editContactName'),
    nameClear: shadow.querySelector('#editContactNameClear'),
    description: shadow.querySelector('#editContactDescription'),
    descriptionClear: shadow.querySelector('#editContactDescriptionClear'),
    save: shadow.querySelector('#editContactSave'),
    feedback: shadow.querySelector('#editContactFeedback'),
    active: () => shadow.activeElement,
    close: () => { app.destroy(); dom.window.close(); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('one form edits and independently clears name and description from contacts', async () => {
  const calls = [];
  const ui = mountUi({
    onSetFriendName: async (peerId, name) => {
      calls.push(['name', peerId, name]);
      return friend({ name });
    },
    onSetFriendDescription: async (peerId, description) => {
      calls.push(['description', peerId, description]);
      return friend({ description });
    },
  });
  try {
    ui.app.setContacts(contacts([friend()]));
    const row = ui.list.querySelector('[data-contact-row]');
    assert.equal(row.querySelectorAll('button').length, 3, 'avatar, entry and quick-menu trigger stay separate');

    row.querySelector('[data-quick-peer]').click();
    assert.equal(ui.menu.hidden, false);
    assert.equal(ui.active()?.dataset.quickAction, 'edit');
    ui.active().click();
    assert.equal(ui.dialog.open, true);
    assert.equal(ui.peer.textContent, PEER_A);
    assert.equal(ui.name.value, 'alice');
    assert.equal(ui.description.value, 'music and tea');

    // Clear only the name. The description is untouched and must not be sent.
    ui.nameClear.click();
    assert.equal(ui.name.value, '');
    ui.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual(calls, [['name', PEER_A, '']]);
    assert.equal(ui.dialog.open, false, 'a complete save closes the form');
    assert.equal(ui.list.querySelector('[data-contact-row] .rm-contact-name b').textContent, PEER_A.slice(0, 10) + '…' + PEER_A.slice(-8));
    assert.match(ui.list.querySelector('.rm-contact-note').textContent, /music and tea/);

    // Reopen and clear only the description; the name remains blank (a valid
    // explicit state), and only the description RPC is issued.
    ui.list.querySelector('[data-quick-peer]').click();
    ui.active().click();
    ui.descriptionClear.click();
    ui.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual(calls, [['name', PEER_A, ''], ['description', PEER_A, '']]);
    assert.equal(ui.dialog.open, false);
    assert.equal(ui.list.querySelector('.rm-contact-note'), null, 'an explicitly blank note has no reserved row');
    assert.equal(ui.list.querySelector('[data-contact-row] .rm-contact-name b').textContent.includes('…'), true);
  } finally {
    ui.close();
  }
});

test('the same form opens from the chat quick menu and the profile main action', async () => {
  let profileReads = 0;
  const ui = mountUi({
    onLoadPeerProfile: async (peerId) => {
      profileReads += 1;
      return { peerId, localName: 'alice', remoteName: 'remote', found: false, text: '', files: [], at: Date.now(), error: null, freshness: 'live', agentCard: { state: 'unavailable' } };
    },
    onSetFriendName: async (_peerId, name) => friend({ name }),
    onSetFriendDescription: async (_peerId, description) => friend({ description }),
  });
  try {
    ui.app.onLeaseReady();
    ui.app.setContacts(contacts([friend()]));
    ui.list.querySelector('[data-contact-peer]').click();
    await settle();
    const menu = ui.shadow.querySelector('#conversationMenu');
    assert.equal(menu.hidden, false);
    menu.click();
    ui.menu.querySelector('[data-quick-action="edit"]').click();
    assert.equal(ui.dialog.open, true);
    ui.shadow.querySelector('#editContactDialog [data-close-dialog]').click();
    assert.equal(ui.dialog.open, false);

    ui.shadow.querySelector('#conversationAvatar').click();
    await settle();
    assert.equal(profileReads, 1);
    const profileEdit = ui.shadow.querySelector('#profileEditContact');
    assert.equal(profileEdit.hidden, false, 'the contact profile main action edits the local label only');
    profileEdit.click();
    assert.equal(ui.dialog.open, true);
    assert.equal(ui.save.textContent, '保存');
  } finally {
    ui.close();
  }
});

test('invalid or duplicate non-empty names stay in the form with their draft', async () => {
  let nameCalls = 0;
  const ui = mountUi({
    onSetFriendName: async (_peerId, name) => {
      nameCalls += 1;
      if (name === 'taken') throw new Error('storage: friend name already used');
      return friend({ name });
    },
    onSetFriendDescription: async (_peerId, description) => friend({ description }),
  });
  try {
    ui.app.setContacts(contacts([friend()]));
    ui.list.querySelector('[data-quick-peer]').click();
    ui.active().click();

    ui.name.value = 'Bad Name';
    ui.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(nameCalls, 0, 'local syntax validation avoids a known-bad request');
    assert.equal(ui.dialog.open, true);
    assert.match(ui.feedback.textContent, /只允许小写字母/);

    ui.name.value = 'taken';
    ui.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(nameCalls, 1);
    assert.equal(ui.dialog.open, true, 'a uniqueness failure does not close or discard the draft');
    assert.match(ui.feedback.textContent, /名称：.*already used/);
    assert.equal(ui.name.value, 'taken');
  } finally {
    ui.close();
  }
});
