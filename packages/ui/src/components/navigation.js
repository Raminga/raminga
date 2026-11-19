import { navIdForPage } from '../router.js';

// Three accepted primary pages in fixed order: 动态 · 主页 · 联系人.
// Conversations and settings are sub-pages reached from these surfaces.
export const NAV_ITEMS = [
  {
    id: 'explore',
    label: '动态',
    icon: '<span class="rm-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15.7 8.3-2.2 5.2-5.2 2.2 2.2-5.2z"/></svg></span>',
  },
  {
    id: 'home',
    label: '主页',
    // The centre entry is the real Raminga mark used by the top-left brand.
    // Its accessible name comes from the button plus the visually hidden label.
    icon: '<span class="rm-nav-mark" aria-hidden="true"><img src="assets/raminga-mark-gradient.svg" width="36" height="36" alt=""></span>',
    brand: true,
  },
  {
    id: 'contacts',
    label: '联系人',
    icon: '<span class="rm-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/></svg></span>',
  },
];

/** Render one navigation copy; desktop and narrow screens show the same order. */
export function renderPrimaryNav(activePage = 'home') {
  const active = navIdForPage(activePage);
  return NAV_ITEMS.map(({ id, label, icon, brand }) => {
    const current = id === active ? ' aria-current="page"' : '';
    const text = brand ? `<span class="rm-sr-only">${label}</span>` : `<span class="rm-nav-label">${label}</span>`;
    return `<button type="button" data-nav="${id}" aria-label="${label}" title="${label}"${current}>${icon}${text}<span class="rm-nav-badge" data-nav-badge="${id}" hidden></span></button>`;
  }).join('');
}

/** Show one unread count on the contacts nav copy, if any. */
export function updateNavUnread(root, totalUnread) {
  const count = Number.isFinite(Number(totalUnread)) ? Math.max(0, Number(totalUnread)) : 0;
  root.querySelectorAll('[data-nav-badge]').forEach((badge) => {
    if (badge.dataset.navBadge !== 'contacts' || count <= 0) {
      badge.hidden = true;
      badge.textContent = '';
      return;
    }
    badge.hidden = false;
    badge.textContent = count > 99 ? '99+' : String(count);
  });
}

/** Update both rendered navigation copies without re-creating buttons. */
export function updatePrimaryNav(root, activePage) {
  const active = navIdForPage(activePage);
  // Only the primary nav owns the current-page state. The top-left brand is
  // another way back home, not a second navigation set.
  root.querySelectorAll('nav.rm-nav button[data-nav]').forEach((button) => {
    if (button.dataset.nav === active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}
