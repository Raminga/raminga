// The five stable workspace pages. Detail views (chat/profile) are intentionally
// absent until their data sources exist; the host panel stays on these pages.
export const MAIN_PAGES = ['explore', 'contacts', 'raminga', 'messages', 'mine'];

const NAV_TO_PAGE = {
  home: 'explore',
  contacts: 'contacts',
  raminga: 'raminga',
  messages: 'messages',
  mine: 'mine',
};

const PAGE_TO_NAV = {
  explore: 'home',
  contacts: 'contacts',
  raminga: 'raminga',
  messages: 'messages',
  mine: 'mine',
};

export function isMainPage(value) {
  return MAIN_PAGES.includes(value);
}

export function pageForNav(navId) {
  return NAV_TO_PAGE[navId] ?? 'explore';
}

export function navIdForPage(pageName) {
  return PAGE_TO_NAV[pageName] ?? 'home';
}
