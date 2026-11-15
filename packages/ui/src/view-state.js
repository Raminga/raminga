// Host-agnostic workspace view state.
//
// The DSH main panel is unmounted whenever the user selects the conversation
// or another global panel. The adapter owns one of these plain objects and
// hands it back on every mount, so navigation, search/filter text, scroll
// positions and (for the later chat stage) drafts survive panel switches
// without keeping subscriptions or DOM alive.
import { MAIN_PAGES } from './router.js';

const MAX_QUERY = 200;
const MAX_DRAFT = 8192;
const FILTERS = new Set(['all', 'familiar']);

function text(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function scroll(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function draftKey(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9._:/-]{1,128}$/.test(value)
    && value !== '__proto__'
    && value !== 'prototype'
    && value !== 'constructor';
}

function peerId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value) ? value : '';
}

function messageId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160) return '';
  return /[\u0000-\u001f\u007f]/.test(value) ? '' : value;
}

function anchorOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-4000, Math.min(4000, Math.round(number)));
}

function key(value, max = 128) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return '';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '';
  return value;
}

function expandedMap(value, isValidKey) {
  const out = {};
  if (!record(value)) return out;
  let count = 0;
  for (const [entry, open] of Object.entries(value)) {
    if (count >= 100) break;
    if (!isValidKey(entry) || open !== true) continue;
    out[entry] = true;
    count += 1;
  }
  return out;
}

function defaults() {
  return {
    version: 1,
    page: 'explore',
    profile: { peerId: '', returnPage: '', returnPeer: '', triggerId: '' },
    pages: {
      explore: { filter: 'all', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} },
      contacts: { query: '', scroll: 0 },
      raminga: { scroll: 0, expandedSessions: {} },
      messages: {
        scroll: 0,
        peerId: '',
        query: '',
        chatScrolls: {},
        chatAnchors: {},
        returnPage: '',
        returnPeer: '',
      },
      mine: { scroll: 0 },
    },
    drafts: {},
  };
}

/** A fresh, serializable view state with the five fixed pages. */
export function createViewState() {
  return defaults();
}

/** Accepted page names, used by hosts that need to point at one page. */
export const VIEW_STATE_PAGES = [...MAIN_PAGES];

/**
 * Coerce any value (including stale or hostile persisted state) into the
 * current view-state shape. Unknown fields are dropped and text is bounded.
 */
export function normalizeViewState(input) {
  const next = defaults();
  if (!record(input)) return next;
  if (MAIN_PAGES.includes(input.page)) next.page = input.page;
  if (record(input.pages)) {
    const explore = input.pages.explore;
    if (record(explore)) {
      if (FILTERS.has(explore.filter)) next.pages.explore.filter = explore.filter;
      next.pages.explore.query = text(explore.query, MAX_QUERY);
      next.pages.explore.searchOpen = explore.searchOpen === true;
      next.pages.explore.scroll = scroll(explore.scroll);
      next.pages.explore.expanded = expandedMap(explore.expanded, (entry) => /^[A-Za-z0-9._:-]{1,64}$/.test(entry) && !entry.includes('..'));
      next.pages.explore.sourceOpen = expandedMap(explore.sourceOpen, (entry) => /^[A-Za-z0-9._:-]{1,64}$/.test(entry) && !entry.includes('..'));
    }
    const contacts = input.pages.contacts;
    if (record(contacts)) {
      next.pages.contacts.query = text(contacts.query, MAX_QUERY);
      next.pages.contacts.scroll = scroll(contacts.scroll);
    }
    const messages = input.pages.messages;
    if (record(messages)) {
      next.pages.messages.scroll = scroll(messages.scroll);
      next.pages.messages.peerId = peerId(messages.peerId);
      next.pages.messages.query = text(messages.query, MAX_QUERY);
      // Remember which surface opened the current chat, so the back action can
      // return to the contact search or the conversation index after the host
      // remounts the panel. A trigger without a matching selected Peer is not a
      // usable source and falls back to the conversation index.
      if (messages.returnPage === 'contacts' || messages.returnPage === 'messages' || messages.returnPage === 'raminga') {
        const returnPeer = peerId(messages.returnPeer);
        if (returnPeer && next.pages.messages.peerId === returnPeer) {
          next.pages.messages.returnPage = messages.returnPage;
          next.pages.messages.returnPeer = returnPeer;
        }
      }
      if (record(messages.chatScrolls)) {
        let count = 0;
        for (const [key, value] of Object.entries(messages.chatScrolls)) {
          if (count >= 128) break;
          if (!peerId(key)) continue;
          next.pages.messages.chatScrolls[key] = scroll(value);
          count += 1;
        }
      }
      // A message ID anchor is what makes a reopened conversation restore the
      // actual reading row (or exposes a clear path to it) instead of applying
      // an old pixel offset to a different, latest-only window.
      if (record(messages.chatAnchors)) {
        let count = 0;
        for (const [key, value] of Object.entries(messages.chatAnchors)) {
          if (count >= 128) break;
          if (!peerId(key) || !record(value)) continue;
          const id = messageId(value.messageId);
          if (!id) continue;
          const anchor = {
            messageId: id,
            offset: anchorOffset(value.offset),
          };
          // A reader who was at the bottom keeps that intent across a host
          // remount. The flag is separate from the row anchor so a later
          // "回到最新" does not depend on the old row still being retained.
          if (value.atBottom === true) anchor.atBottom = true;
          next.pages.messages.chatAnchors[key] = anchor;
          count += 1;
        }
      }
    }
    if (record(input.pages.raminga)) {
      next.pages.raminga.scroll = scroll(input.pages.raminga.scroll);
      next.pages.raminga.expandedSessions = expandedMap(
        input.pages.raminga.expandedSessions,
        (entry) => /^[A-Za-z0-9._-]{1,128}$/.test(entry) && entry !== '__proto__',
      );
    }
    if (record(input.pages.mine)) next.pages.mine.scroll = scroll(input.pages.mine.scroll);
    if (record(input.profile)) {
      const peer = peerId(input.profile.peerId);
      if (peer) {
        const returnPage = MAIN_PAGES.includes(input.profile.returnPage) ? input.profile.returnPage : 'explore';
        const returnPeer = peerId(input.profile.returnPeer);
        next.profile = {
          peerId: peer,
          returnPage,
          returnPeer: input.profile.returnPage === 'messages' ? returnPeer : '',
          triggerId: key(input.profile.triggerId, 160),
        };
      }
    }
  }
  if (record(input.drafts)) {
    for (const [key, value] of Object.entries(input.drafts)) {
      if (typeof value !== 'string' || value.length === 0) continue;
      if (!draftKey(key)) continue;
      next.drafts[key] = value.slice(0, MAX_DRAFT);
    }
  }
  return next;
}

/** Write the current state back into the adapter-owned plain object. */
export function copyViewState(target, source) {
  if (!record(target)) return;
  target.version = source.version;
  target.page = source.page;
  target.profile = { ...source.profile };
  target.pages = {
    explore: {
      ...source.pages.explore,
      expanded: { ...source.pages.explore.expanded },
      sourceOpen: { ...source.pages.explore.sourceOpen },
    },
    contacts: { ...source.pages.contacts },
    raminga: { ...source.pages.raminga, expandedSessions: { ...source.pages.raminga.expandedSessions } },
    messages: {
      ...source.pages.messages,
      chatScrolls: { ...source.pages.messages.chatScrolls },
      chatAnchors: { ...source.pages.messages.chatAnchors },
    },
    mine: { ...source.pages.mine },
  };
  target.drafts = { ...source.drafts };
}

/** Store a draft without creating a second, host-specific persistence layer. */
export function setDraft(state, key, value) {
  if (!state || typeof key !== 'string' || key.length === 0) return;
  if (!draftKey(key)) return;
  const next = typeof value === 'string' ? value.slice(0, MAX_DRAFT) : '';
  if (next.length === 0) delete state.drafts[key];
  else state.drafts[key] = next;
}

export function getDraft(state, key) {
  if (!state || !record(state.drafts) || typeof key !== 'string') return '';
  const value = state.drafts[key];
  return typeof value === 'string' ? value : '';
}
