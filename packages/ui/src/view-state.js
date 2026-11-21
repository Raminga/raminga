// Host-agnostic workspace view state (v2).
//
// The DSH main panel is unmounted whenever the user selects the conversation
// or another global panel. The adapter owns one of these plain objects and
// hands it back on every mount, so navigation, search/filter text, scroll
// positions and chat drafts survive panel switches without keeping
// subscriptions or DOM alive.
import { MAIN_PAGES, SUB_PAGES, normalizePageName } from './router.js';

const MAX_QUERY = 200;
const MAX_DRAFT = 8192;
const EXPLORE_FILTERS = new Set(['all', 'familiar', 'mine']);
const CONTACT_FILTERS = new Set(['all', 'unread']);
const SETTINGS_TABS = new Set(['public', 'files', 'private', 'memory', 'favorites', 'node']);
const PROFILE_TABS = new Set(['interactions', 'posts', 'address']);
const CHAT_RETURN_PAGES = new Set(['explore', 'home', 'contacts', 'messages', 'settings', 'journey', 'profile']);
const INDEX_RETURN_PAGES = new Set(['explore', 'home', 'contacts']);
const SETTINGS_RETURN_PAGES = new Set(['explore', 'home', 'contacts', 'messages']);
const PROFILE_RETURN_PAGES = new Set(['explore', 'home', 'contacts', 'messages', 'settings', 'post', 'journeys', 'journey']);
const ANCHORS = new Set(['top', 'human', 'activity', 'journeys']);

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

function sessionKey(value) {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== '__proto__';
}

function defaults() {
  return {
    version: 2,
    page: 'home',
    home: {
      scroll: 0,
      agentAnchor: 'top',
      expandedJourneys: {},
      activityExpanded: false,
    },
    settings: { tab: 'public', index: true, scroll: 0, returnPage: 'home' },
    pages: {
      explore: { filter: 'all', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} },
      contacts: { filter: 'all', query: '', scroll: 0 },
      journeys: { query: '', scroll: 0, focusKey: '' },
      messages: {
        scroll: 0,
        peerId: '',
        query: '',
        chatScrolls: {},
        chatAnchors: {},
        returnPage: '',
        returnPeer: '',
        returnJourneyId: '',
        returnJourneyEvent: 0,
        returnJourneyMessage: '',
        // A chat opened from a contact profile returns to the same tab and
        // reading position instead of dropping the profile or guessing a
        // different list. These fields survive host remounts with the chat.
        returnProfileTab: 'interactions',
        returnProfileScroll: 0,
        returnFocus: '',
        indexReturnPage: 'home',
      },
    },
    contactProfile: { peerId: '', tab: 'interactions', returnPage: '', returnPeer: '', triggerId: '' },
    post: {
      id: '', peerId: '', path: '', sha256: '', sizeBytes: 0,
      source: 'explore', filter: 'all', query: '', scroll: 0, profileScroll: 0, returnFocus: '',
    },
    journey: {
      id: '', source: 'journeys', scroll: 0, highlightSeq: 0,
      activityOperationId: '', returnFocus: '',
    },
    drafts: {},
  };
}

/** A fresh, serializable view state with three primary pages. */
export function createViewState() {
  return defaults();
}

/** Accepted page names, used by hosts that need to point at one page. */
export const VIEW_STATE_PAGES = [...MAIN_PAGES, ...SUB_PAGES];

function migrateLegacyPage(input) {
  const raw = String(input?.page ?? '');
  if (MAIN_PAGES.includes(raw) || SUB_PAGES.includes(raw)) return raw;
  return normalizePageName(raw) || 'home';
}

/**
 * Coerce any value (including a stale v1 host object) into the current
 * view-state shape. Unknown fields are dropped and text is bounded. Legacy
 * `mine`/`raminga` pages, scroll positions, expanded Journeys and drafts are
 * migrated without requiring the caller to rebuild local data.
 */
export function normalizeViewState(input) {
  const next = defaults();
  if (!record(input)) return next;
  next.page = migrateLegacyPage(input);

  if (record(input.pages)) {
    const explore = input.pages.explore;
    if (record(explore)) {
      if (EXPLORE_FILTERS.has(explore.filter)) next.pages.explore.filter = explore.filter;
      next.pages.explore.query = text(explore.query, MAX_QUERY);
      next.pages.explore.searchOpen = explore.searchOpen === true;
      next.pages.explore.scroll = scroll(explore.scroll);
      next.pages.explore.expanded = expandedMap(explore.expanded, (entry) => /^[A-Za-z0-9._:-]{1,64}$/.test(entry) && !entry.includes('..'));
      next.pages.explore.sourceOpen = expandedMap(explore.sourceOpen, (entry) => /^[A-Za-z0-9._:-]{1,64}$/.test(entry) && !entry.includes('..'));
    }
    const contacts = input.pages.contacts;
    if (record(contacts)) {
      if (CONTACT_FILTERS.has(contacts.filter)) next.pages.contacts.filter = contacts.filter;
      next.pages.contacts.query = text(contacts.query, MAX_QUERY);
      next.pages.contacts.scroll = scroll(contacts.scroll);
    }
    const messages = input.pages.messages;
    if (record(messages)) {
      next.pages.messages.scroll = scroll(messages.scroll);
      next.pages.messages.peerId = peerId(messages.peerId);
      next.pages.messages.query = text(messages.query, MAX_QUERY);
      if (INDEX_RETURN_PAGES.has(messages.indexReturnPage)) next.pages.messages.indexReturnPage = messages.indexReturnPage;
      // Remember which surface opened the current chat, so the back action can
      // return to the contact search, conversation index or home/settings after
      // the host remounts the panel. v1 `raminga`/`mine` normalize to home.
      const chatReturn = messages.returnPage === 'raminga' || messages.returnPage === 'mine'
        ? 'home'
        : messages.returnPage;
      if (CHAT_RETURN_PAGES.has(chatReturn)) {
        const returnPeer = peerId(messages.returnPeer);
        if (chatReturn === 'journey') {
          const returnJourney = key(messages.returnJourneyId, 128);
          const returnEvent = Number(messages.returnJourneyEvent);
          if (returnJourney && next.pages.messages.peerId === returnPeer) {
            next.pages.messages.returnPage = 'journey';
            next.pages.messages.returnPeer = returnPeer;
            next.pages.messages.returnJourneyId = returnJourney;
            next.pages.messages.returnJourneyEvent = Number.isSafeInteger(returnEvent) && returnEvent > 0 ? returnEvent : 0;
            next.pages.messages.returnJourneyMessage = messageId(messages.returnJourneyMessage);
          }
        } else if (returnPeer && next.pages.messages.peerId === returnPeer) {
          next.pages.messages.returnPage = chatReturn;
          next.pages.messages.returnPeer = returnPeer;
          if (chatReturn === 'profile') {
            next.pages.messages.returnProfileTab = PROFILE_TABS.has(messages.returnProfileTab)
              ? messages.returnProfileTab
              : 'interactions';
            next.pages.messages.returnProfileScroll = scroll(messages.returnProfileScroll);
            // A source button key includes both the timeline item and message
            // ids; older 160-char keys remain valid and unchanged.
            next.pages.messages.returnFocus = key(messages.returnFocus, 512);
          }
        }
      }
      if (record(messages.chatScrolls)) {
        let count = 0;
        for (const [entry, value] of Object.entries(messages.chatScrolls)) {
          if (count >= 128) break;
          if (!peerId(entry)) continue;
          next.pages.messages.chatScrolls[entry] = scroll(value);
          count += 1;
        }
      }
      // A message ID anchor is what makes a reopened conversation restore the
      // actual reading row (or exposes a clear path to it) instead of applying
      // an old pixel offset to a different, latest-only window.
      if (record(messages.chatAnchors)) {
        let count = 0;
        for (const [entry, value] of Object.entries(messages.chatAnchors)) {
          if (count >= 128) break;
          if (!peerId(entry) || !record(value)) continue;
          const id = messageId(value.messageId);
          if (!id) continue;
          const anchor = { messageId: id, offset: anchorOffset(value.offset) };
          // A reader who was at the bottom keeps that intent across a host
          // remount. The flag is separate from the row anchor so a later
          // "回到最新" does not depend on the old row still being retained.
          if (value.atBottom === true) anchor.atBottom = true;
          next.pages.messages.chatAnchors[entry] = anchor;
          count += 1;
        }
      }
    }
    // v1 `mine` and `raminga` scroll/expanded maps become v2 home state.
    if (record(input.pages.mine)) next.home.scroll = scroll(input.pages.mine.scroll);
    if (record(input.pages.raminga)) {
      next.home.scroll = Math.max(next.home.scroll, scroll(input.pages.raminga.scroll));
      next.home.expandedJourneys = expandedMap(input.pages.raminga.expandedSessions, sessionKey);
    }
    if (record(input.pages.home)) {
      next.home.scroll = scroll(input.pages.home.scroll);
      if (ANCHORS.has(input.pages.home.agentAnchor)) next.home.agentAnchor = input.pages.home.agentAnchor;
      next.home.expandedJourneys = expandedMap(input.pages.home.expandedJourneys, sessionKey);
      next.home.activityExpanded = input.pages.home.activityExpanded === true;
    }
  }
  // v2 stores settings at the top level; older drafts of this plan nested it
  // under pages, so accept both without creating a second state source.
  const settingsInput = record(input.settings) ? input.settings : (record(input.pages?.settings) ? input.pages.settings : null);
  if (record(settingsInput)) {
    if (SETTINGS_TABS.has(settingsInput.tab)) next.settings.tab = settingsInput.tab;
    next.settings.index = settingsInput.index !== false;
    next.settings.scroll = scroll(settingsInput.scroll);
    if (SETTINGS_RETURN_PAGES.has(settingsInput.returnPage)) next.settings.returnPage = settingsInput.returnPage;
  }

  // v1 exposed this as `profile`; v2 names the contact/profile surface
  // explicitly. Legacy values keep their source when it still exists.
  const profileInput = record(input.contactProfile) ? input.contactProfile : (record(input.profile) ? input.profile : null);
  if (record(profileInput)) {
    const peer = peerId(profileInput.peerId);
    if (peer) {
      const rawReturn = profileInput.returnPage;
      const returnPage = PROFILE_RETURN_PAGES.has(rawReturn)
        ? rawReturn
        : (normalizePageName(rawReturn) || 'explore');
      const returnPeer = peerId(profileInput.returnPeer);
      next.contactProfile = {
        peerId: peer,
        tab: PROFILE_TABS.has(profileInput.tab) ? profileInput.tab : 'interactions',
        returnPage,
        returnPeer: returnPage === 'messages' ? returnPeer : '',
        triggerId: key(profileInput.triggerId, 160),
      };
    }
  }

  // One independent post detail keeps the exact Feed/list source. It is a
  // sub-page, never a fourth primary navigation entry; only a route with a
  // recognizable post identity is restored after a host remount.
  if (record(input.post)) {
    const raw = input.post;
    const source = raw.source === 'mine' ? 'mine' : raw.source === 'peer' ? 'peer' : 'explore';
    const postPath = key(raw.path, 256);
    const postSha = /^[a-f0-9]{64}$/i.test(String(raw.sha256 ?? '')) ? String(raw.sha256).toLowerCase() : '';
    const postId = key(raw.id, 160);
    if (postPath.startsWith('posts/') || postId.length > 0) {
      next.post = {
        id: postId,
        peerId: peerId(raw.peerId),
        path: postPath,
        sha256: postSha,
        sizeBytes: Math.max(0, Math.min(128 * 1024 * 1024, Math.floor(Number(raw.sizeBytes) || 0))),
        source,
        filter: EXPLORE_FILTERS.has(raw.filter) ? raw.filter : next.pages.explore.filter,
        query: text(raw.query, MAX_QUERY),
        scroll: scroll(raw.scroll),
        // The contact profile is an overlay; this is its own posts-tab scroll,
        // not the hidden source page's list position.
        profileScroll: scroll(raw.profileScroll),
        returnFocus: key(raw.returnFocus, 512),
      };
    }
  }

  // The independent recent-records list keeps its query, scroll and exact
  // return target across panel remounts.
  if (record(input.pages) && record(input.pages.journeys)) {
    next.pages.journeys.query = text(input.pages.journeys.query, MAX_QUERY);
    next.pages.journeys.scroll = scroll(input.pages.journeys.scroll);
    next.pages.journeys.focusKey = key(input.pages.journeys.focusKey, 180);
  }
  if (record(input.journey)) {
    const id = key(input.journey.id, 128);
    if (id) {
      next.journey = {
        id,
        source: ['home', 'journeys', 'activity', 'memory'].includes(input.journey.source) ? input.journey.source : 'journeys',
        scroll: scroll(input.journey.scroll),
        highlightSeq: Math.max(0, Math.min(100000, Math.floor(Number(input.journey.highlightSeq) || 0))),
        activityOperationId: key(input.journey.activityOperationId, 160),
        returnFocus: key(input.journey.returnFocus, 180),
      };
    }
  }

  // Legacy page 'mine' opened the human profile position; 'raminga' opened
  // the agent/Journey top. Preserve that context without reversing visual
  // hierarchy: every home render still starts with the Agent hero.
  if (String(input.page) === 'mine') next.home.agentAnchor = 'human';
  if (String(input.page) === 'raminga') next.home.agentAnchor = 'top';

  if (record(input.drafts)) {
    for (const [draft, value] of Object.entries(input.drafts)) {
      if (typeof value !== 'string' || value.length === 0) continue;
      if (!draftKey(draft)) continue;
      next.drafts[draft] = value.slice(0, MAX_DRAFT);
    }
  }

  // A profile page without a usable Peer is not a real route; keep drafts and
  // fall back to the Agent-led home page.
  // A profile return source is only usable together with the same profile
  // identity. A stale or mismatched object falls back to the conversation
  // index instead of reopening another contact's page.
  if (next.pages.messages.returnPage === 'profile'
    && next.contactProfile.peerId !== next.pages.messages.returnPeer) {
    next.pages.messages.returnPage = '';
    next.pages.messages.returnPeer = '';
    next.pages.messages.returnProfileTab = 'interactions';
    next.pages.messages.returnProfileScroll = 0;
    next.pages.messages.returnFocus = '';
  }
  if (next.page === 'profile' && next.contactProfile.peerId.length === 0) next.page = 'home';
  if (next.page === 'post'
    && next.post.id.length === 0
    && (next.post.path.length === 0 || next.post.peerId.length === 0)) {
    next.page = 'explore';
  }
  // A peer-post route needs its exact Peer and the profile return context; a
  // stale mismatch must not reopen a detail with no trustworthy way back.
  if (next.page === 'post' && next.post.source === 'peer'
    && (next.post.peerId.length === 0 || next.contactProfile.peerId !== next.post.peerId)) {
    next.page = 'explore';
  }
  if (next.page === 'journey' && next.journey.id.length === 0) {
    next.page = next.pages.journeys.query.length > 0 ? 'journeys' : 'home';
  }
  return next;
}

/** Write the current state back into the adapter-owned plain object. */
export function copyViewState(target, source) {
  if (!record(target)) return;
  target.version = source.version;
  target.page = source.page;
  target.home = {
    ...source.home,
    expandedJourneys: { ...source.home.expandedJourneys },
  };
  target.settings = { ...source.settings };
  target.pages = {
    explore: {
      ...source.pages.explore,
      expanded: { ...source.pages.explore.expanded },
      sourceOpen: { ...source.pages.explore.sourceOpen },
    },
    contacts: { ...source.pages.contacts },
    messages: {
      ...source.pages.messages,
      chatScrolls: { ...source.pages.messages.chatScrolls },
      chatAnchors: { ...source.pages.messages.chatAnchors },
    },
  };
  target.contactProfile = { ...source.contactProfile };
  target.post = { ...source.post };
  target.pages.journeys = { ...source.pages.journeys };
  target.journey = { ...source.journey };
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
