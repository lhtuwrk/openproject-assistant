// ui2.js — UI 2.0 (Linear/Jira hybrid) switch for OpenProject.
// Toggles html classes and adds two small widgets: the status quick-filter tabs
// in the work-package toolbar and the icon rail shown when the main menu is
// collapsed. Every visual rule lives in content/ui2/*.css under html.blm-ui2, so
// switch off = native OpenProject. The type/priority icons, status pills and Child
// work items come from jira-skin.js, which runs its DOM work when UI 2.0 is on.
// Registered by background.js for the configured host on every page.

(() => {
'use strict';

const CFG_UI2   = '__blm_ui2';
const CFG_THEME = '__blm_theme';   // 'dark' | 'light', mirrored from the Settings theme picker
const ROOT_CLASS = 'blm-ui2';
const WP_CLASS   = 'blm-ui2-wp';
const TABS_CLASS = 'blm-ui2-tabs';
const RAIL_CLASS = 'blm-ui2-rail';
const FILTER_STYLE_ID = 'blm-ui2-groupfilter';

let enabled = false;
let theme = 'dark';
let activeGroup = null;   // data-group-index of the selected status tab, null = All
let tabsSig = '';
let railSig = '';
try { theme = localStorage.getItem('__blm_theme') === 'light' ? 'light' : 'dark'; } catch { /* storage blocked */ }

const onWorkPackagePage = () => /\/work_packages(\/|$)/.test(location.pathname);

// ── Status quick-filter tabs ─────────────────────────────────────────────────
// One tab per group header of a grouped list; hiding is a single <style> rule, so
// Angular's own row rendering is never touched.

function groupsOnPage() {
  return [...document.querySelectorAll('tr.wp-table--group-header')].map(tr => {
    const count = tr.querySelector('.count')?.textContent.trim() ?? '';
    const value = tr.querySelector('.group--value');
    const name = (value?.textContent ?? '').replace(count, '').trim();
    return { idx: tr.dataset.groupIndex, name, count: count.replace(/[()]/g, '') };
  }).filter(g => g.idx !== undefined);
}

function setGroupFilter(idx) {
  activeGroup = idx;
  let style = document.getElementById(FILTER_STYLE_ID);
  if (idx === null) { style?.remove(); return; }
  if (!style) {
    style = document.createElement('style');
    style.id = FILTER_STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  const i = CSS.escape(idx);
  style.textContent =
    `tr[class*="__row-group-"]:not(.__row-group-${i}),` +
    `tr.wp-table--group-header:not([data-group-index="${i}"]) { display: none !important; }`;
}

function removeTabs() {
  document.querySelector('.blm-ui2-has-tabs')?.classList.remove('blm-ui2-has-tabs');
  document.querySelector(`.${TABS_CLASS}`)?.remove();
  document.getElementById(FILTER_STYLE_ID)?.remove();
  tabsSig = '';
  activeGroup = null;
}

function syncTabs() {
  const anchor = document.querySelector('.toolbar-container');
  const groups = onWorkPackagePage() && anchor ? groupsOnPage() : [];
  if (!groups.length) { removeTabs(); return; }
  if (activeGroup !== null && !groups.some(g => g.idx === activeGroup)) setGroupFilter(null);
  const sig = groups.map(g => `${g.idx}|${g.name}|${g.count}`).join(';') + '#' + activeGroup;
  const existing = document.querySelector(`.${TABS_CLASS}`);
  if (existing && sig === tabsSig && existing.parentElement === anchor) return;
  const hadFocus = existing?.contains(document.activeElement);
  existing?.remove();
  tabsSig = sig;

  const nav = document.createElement('div');
  nav.className = TABS_CLASS;
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'Filter by group');
  const total = groups.reduce((n, g) => n + (parseInt(g.count, 10) || 0), 0);
  const add = (label, count, idx) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(activeGroup === idx));
    b.append(label + ' ');
    const n = document.createElement('span');
    n.textContent = count;
    b.append(n);
    b.addEventListener('click', () => { setGroupFilter(idx); syncTabs(); });
    nav.append(b);
  };
  add('All', String(total), null);
  for (const g of groups) add(g.name, g.count, g.idx);
  anchor.classList.add('blm-ui2-has-tabs');
  anchor.append(nav);   // inside the toolbar: a new sibling would shift OpenProject's table layout
  if (hadFocus) nav.querySelector('[aria-pressed="true"]')?.focus();   // rebuilt on click: keep keyboard focus
}

// ── Icon rail (main menu collapsed) ──────────────────────────────────────────

function removeRail() {
  document.querySelector(`.${RAIL_CLASS}`)?.remove();
  document.documentElement.style.removeProperty('--blm-ui2-header-h');
  railSig = '';
}

function syncRail() {
  const links = [...document.querySelectorAll(
    '#menu-sidebar > ul.menu_root > li > .main-item-wrapper > a.op-menu--item-action')];
  if (!links.length) { removeRail(); return; }
  const header = document.querySelector('.op-app-header');
  if (header) document.documentElement.style.setProperty('--blm-ui2-header-h', header.offsetHeight + 'px');
  const sig = links.map(a => `${a.getAttribute('href')}|${a.classList.contains('selected')}`).join(';');
  if (sig === railSig && document.querySelector(`.${RAIL_CLASS}`)) return;
  document.querySelector(`.${RAIL_CLASS}`)?.remove();
  railSig = sig;

  const nav = document.createElement('nav');
  nav.className = RAIL_CLASS;
  nav.setAttribute('aria-label', 'Main menu');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.title = 'Expand menu';
  toggle.setAttribute('aria-label', 'Expand menu');
  toggle.textContent = '☰';   // decorative: the button has an aria-label
  toggle.addEventListener('click', () => document.getElementById('main-menu-toggle')?.click());
  nav.append(toggle);
  for (const a of links) {
    const item = document.createElement('a');
    item.href = a.getAttribute('href');
    const title = a.querySelector('.op-menu--item-title')?.textContent.trim() ?? a.title;
    item.title = title;
    item.setAttribute('aria-label', title);
    if (a.classList.contains('selected')) item.setAttribute('aria-current', 'page');
    const icon = a.querySelector('i');
    if (icon) {
      const i = document.createElement('i');
      i.className = icon.className;
      i.setAttribute('aria-hidden', 'true');
      item.append(i);
    }
    nav.append(item);
  }
  document.body.append(nav);
}

// ── Apply ────────────────────────────────────────────────────────────────────

// Angular re-renders rows on scroll, grouping and query switch: refresh once per frame.
let frame = 0;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!enabled || !document.body) return;
    apply();
  });
}

function apply() {
  const root = document.documentElement;
  root.classList.toggle(ROOT_CLASS, enabled);
  root.classList.toggle(WP_CLASS, enabled && onWorkPackagePage());
  // own attribute: jira-skin.js deletes data-blm-theme when it switches off
  if (enabled) root.dataset.blmUi2Theme = theme;
  else delete root.dataset.blmUi2Theme;
  if (!enabled) { removeTabs(); removeRail(); return; }
  if (document.body) { syncTabs(); syncRail(); }
}

function observe() {
  new MutationObserver(() => { if (enabled) schedule(); })
    .observe(document.body, { childList: true, subtree: true });
  schedule();
}
if (document.body) observe();
else document.addEventListener('DOMContentLoaded', observe, { once: true });

apply();   // document_start: right theme before first paint
chrome.storage.local.get([CFG_UI2, CFG_THEME]).then(s => {
  enabled = s[CFG_UI2] ?? false;
  theme = s[CFG_THEME] === 'light' ? 'light' : 'dark';
  try { localStorage.setItem('__blm_theme', theme); } catch { /* storage blocked */ }
  apply();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (CFG_UI2 in changes) enabled = changes[CFG_UI2].newValue ?? false;
  if (CFG_THEME in changes) {
    theme = changes[CFG_THEME].newValue === 'light' ? 'light' : 'dark';
    try { localStorage.setItem('__blm_theme', theme); } catch { /* storage blocked */ }
  }
  apply();
});
// OpenProject is a SPA: re-check the route after in-app navigation.
if (typeof window.navigation !== 'undefined') {
  window.navigation.addEventListener('navigatesuccess', schedule);
}
})();
