import { navIdForPage } from '../router.js';

// Five fixed pages in the accepted order:
// 动态 · 联系人 · Raminga Logo · 对话 · 我的.
export const NAV_ITEMS = [
  {
    id: 'home',
    label: '动态',
    icon: '<span class="rm-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15.7 8.3-2.2 5.2-5.2 2.2 2.2-5.2z"/></svg></span>',
  },
  {
    id: 'contacts',
    label: '联系人',
    icon: '<span class="rm-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/></svg></span>',
  },
  {
    id: 'raminga',
    label: 'Raminga',
    icon: '<span class="rm-nav-mark"><img src="assets/raminga-mark-gradient.svg" width="34" height="34" alt=""></span>',
  },
  {
    id: 'messages',
    label: '对话',
    icon: '<span class="rm-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z"/><path d="M7 10h8M7 14h5"/></svg></span>',
  },
  {
    id: 'mine',
    label: '我的',
    icon: '<span class="rm-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg></span>',
  },
];

/** Render one navigation copy; desktop and narrow screens show the same order. */
export function renderPrimaryNav(activePage = 'explore') {
  const active = navIdForPage(activePage);
  return NAV_ITEMS.map(({ id, label, icon }) => {
    const current = id === active ? ' aria-current="page"' : '';
    const raminga = id === 'raminga';
    return `<button type="button" data-nav="${id}"${current}${raminga ? ' aria-label="Raminga · 我的 Agent" title="Raminga · 我的 Agent"' : ''}>${icon}${raminga ? '' : `<span class="rm-nav-label">${label}</span>`}</button>`;
  }).join('');
}

/** Update both rendered navigation copies without re-creating buttons. */
export function updatePrimaryNav(root, activePage) {
  const active = navIdForPage(activePage);
  root.querySelectorAll('button[data-nav]').forEach((button) => {
    if (button.dataset.nav === active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}
