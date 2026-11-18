// ios.js — iOS skin switch for OpenProject work-package pages.
// Only toggles html classes; every visual rule lives in content/ios/*.css and is
// scoped under html.blm-ios, so switch off = native OpenProject.
// Registered by background.js for the configured host on work-package routes.

(() => {
'use strict';

const CFG_IOS   = '__blm_ios';
const CFG_THEME = '__blm_theme';   // 'dark' | 'light', mirrored from the Settings theme picker
const ROOT_CLASS = 'blm-ios';
const WP_CLASS   = 'blm-ios-wp';

// The switch and theme are cached in the host page's localStorage so the first
// paint is already right; chrome.storage is async and lands after it.
const cached = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const cache  = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
let enabled = cached(CFG_IOS) === '1';
let theme = cached(CFG_THEME) === 'light' ? 'light' : 'dark';

const onWorkPackagePage = () => /\/work_packages(\/|$)/.test(location.pathname);

// Status chips: tag the text leaf of each td.status with a tone. The tone is
// guessed from English status names (same heuristic as the Jira skin); unknown
// names fall back to "todo".
const DONE_STATUSES = new Set(['resolved', 'closed', 'done', 'rejected']);
const PROGRESS_RE   = /progress|review|test|develop|implement/;

function statusTone(text) {
  if (DONE_STATUSES.has(text)) return 'done';
  if (PROGRESS_RE.test(text))  return 'progress';
  return 'todo';
}

function textLeaf(cell) {
  let leaf = null;
  for (const el of cell.querySelectorAll('*')) {
    if (!el.children.length && el.textContent.trim()) leaf = el;
  }
  return leaf;
}

// Idempotent: a second pass over tagged rows changes nothing.
function tagCells() {
  for (const cell of document.querySelectorAll('td.status')) {
    const leaf = textLeaf(cell);
    if (!leaf) continue;
    const tone = statusTone(leaf.textContent.trim().toLowerCase());
    if (leaf.dataset.blmITone !== tone) {
      leaf.classList.add('blm-i-chip');
      leaf.dataset.blmITone = tone;
    }
  }
  // Status button in the split view / full page (wp-status-button is an Angular element, not a class).
  for (const btn of document.querySelectorAll(
    'wp-status-button button, .wp-status-button button, button[class*="__hl_background_status"]'
  )) {
    const tone = statusTone(btn.textContent.trim().toLowerCase());
    if (btn.dataset.blmITone !== tone) {
      btn.classList.add('blm-i-status');
      btn.dataset.blmITone = tone;
    }
  }
  tagEmptyFields();
}

// Work-package detail: rows whose value is empty ("-") are hidden behind a
// "Show N empty fields" footer after their group's card. Required fields and a
// row being edited always stay visible. Which groups are open is kept by group
// title for this tab, so it survives Angular re-rendering the group.
const DETAIL_VIEWS = '.work-packages--details, .work-packages--show-view';
const openEmptyGroups = new Set();

function isEmptyRow(row) {
  if (row.querySelector('.inline-edit--container.-active')) return false;
  const key = row.querySelector('.attributes-key-value--key')?.textContent ?? '';
  if (key.includes('*')) return false;
  const field = row.querySelector('.attributes-key-value--value-container .inline-edit--display-field');
  if (!field || field.closest('[hidden]')) return false;
  const text = field.textContent.trim();
  return (text === '-' || text === '') && !field.querySelector('img, .op-avatar');
}

function setAttr(el, name, on) {
  if (on) { if (!el.hasAttribute(name)) el.setAttribute(name, ''); }
  else if (el.hasAttribute(name)) el.removeAttribute(name);
}

function tagEmptyFields() {
  for (const group of document.querySelectorAll(
    `:is(${DETAIL_VIEWS}) .attributes-group:not(.description-group)`
  )) {
    const card = group.querySelector('.wp-attribute-group');
    if (!card) continue;
    const rows = [...card.querySelectorAll(':scope > .wp-attribute-group--attribute')];
    let empty = 0;
    for (const row of rows) {
      const isEmpty = isEmptyRow(row);
      setAttr(row, 'data-blm-i-empty', isEmpty);
      if (isEmpty) empty++;
    }
    const title = group.querySelector('.attributes-group--header-text')?.textContent.trim() ?? '';
    const open = openEmptyGroups.has(title);
    setAttr(group, 'data-blm-i-show-empty', open);
    setAttr(group, 'data-blm-i-all-empty', rows.length > 0 && empty === rows.length);

    let toggle = group.querySelector(':scope > .blm-i-empty-toggle');
    if (!empty) { toggle?.remove(); continue; }
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'blm-i-empty-toggle';
      toggle.addEventListener('click', () => {
        const t = group.querySelector('.attributes-group--header-text')?.textContent.trim() ?? '';
        if (openEmptyGroups.has(t)) openEmptyGroups.delete(t); else openEmptyGroups.add(t);
        tagEmptyFields();
      });
    }
    if (toggle.previousElementSibling !== card) card.after(toggle);
    const label = open ? 'Hide empty fields'
      : `Show ${empty} empty field${empty === 1 ? '' : 's'}`;
    if (toggle.textContent !== label) toggle.textContent = label;
    toggle.setAttribute('aria-expanded', String(open));
  }
}

function untagCells() {
  document.querySelectorAll('.blm-i-chip, .blm-i-status').forEach(el => {
    el.classList.remove('blm-i-chip', 'blm-i-status');
    delete el.dataset.blmITone;
  });
  document.querySelectorAll('.blm-i-empty-toggle').forEach(el => el.remove());
  document.querySelectorAll('[data-blm-i-empty], [data-blm-i-show-empty], [data-blm-i-all-empty]').forEach(el => {
    el.removeAttribute('data-blm-i-empty');
    el.removeAttribute('data-blm-i-show-empty');
    el.removeAttribute('data-blm-i-all-empty');
  });
}

// Angular re-renders rows on scroll, grouping and query switch: re-tag once per frame.
let frame = 0;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (enabled && onWorkPackagePage()) tagCells();
  });
}
function observe() {
  new MutationObserver(() => { if (enabled) schedule(); })
    .observe(document.body, { childList: true, subtree: true });
}
if (document.body) observe();
else document.addEventListener('DOMContentLoaded', observe, { once: true });

function apply() {
  const root = document.documentElement;
  root.classList.toggle(ROOT_CLASS, enabled);
  root.classList.toggle(WP_CLASS, enabled && onWorkPackagePage());
  if (enabled) schedule();
  else untagCells();
  // own attribute: jira-skin.js deletes data-blm-theme when it switches off
  if (enabled) root.dataset.blmIosTheme = theme;
  else delete root.dataset.blmIosTheme;
}

apply();   // document_start: right theme before first paint
chrome.storage.local.get([CFG_IOS, CFG_THEME]).then(s => {
  enabled = s[CFG_IOS] ?? false;
  theme = s[CFG_THEME] === 'light' ? 'light' : 'dark';
  cache(CFG_IOS, enabled ? '1' : '0');
  cache(CFG_THEME, theme);
  apply();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (CFG_IOS in changes) {
    enabled = changes[CFG_IOS].newValue ?? false;
    cache(CFG_IOS, enabled ? '1' : '0');
  }
  if (CFG_THEME in changes) {
    theme = changes[CFG_THEME].newValue === 'light' ? 'light' : 'dark';
    cache(CFG_THEME, theme);
  }
  apply();
});
// OpenProject is a SPA: re-check the route after in-app navigation.
if (typeof window.navigation !== 'undefined') {
  window.navigation.addEventListener('navigatesuccess', apply);
}
})();
