// The three accepted workspace home pages. Conversations, settings, profiles,
// post details and Journey details are sub-pages, not primary navigation.
export const MAIN_PAGES = ['explore', 'home', 'contacts'];
export const SUB_PAGES = ['messages', 'settings', 'profile', 'post', 'journeys', 'journey'];
export const VIEW_STATE_PAGES = [...MAIN_PAGES, ...SUB_PAGES];

const NAV_TO_PAGE = {
  explore: 'explore',
  home: 'home',
  contacts: 'contacts',
};

const PAGE_TO_NAV = {
  explore: 'explore',
  home: 'home',
  contacts: 'contacts',
  // Sub-pages keep their nearest primary section selected while open.
  // Conversations and chats belong to the contacts relationship surface.
  messages: 'contacts',
  settings: 'home',
  profile: 'contacts',
  post: 'explore',
  journeys: 'home',
  journey: 'home',
};

/** Legacy v1 page names normalize to a v2 primary page. */
const LEGACY_PAGES = {
  raminga: 'home',
  mine: 'home',
};

export function isMainPage(value) {
  return MAIN_PAGES.includes(value);
}

export function isSubPage(value) {
  return SUB_PAGES.includes(value);
}

export function normalizePageName(value) {
  if (MAIN_PAGES.includes(value) || SUB_PAGES.includes(value)) return value;
  return LEGACY_PAGES[value] ?? '';
}

export function pageForNav(navId) {
  return NAV_TO_PAGE[navId] ?? 'home';
}

export function navIdForPage(pageName) {
  return PAGE_TO_NAV[pageName] ?? 'home';
}
