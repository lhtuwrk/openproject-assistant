// ui2.js — UI 2.0 (liquid glass) switch for OpenProject work-package pages.
// Only toggles html classes; every visual rule lives in content/ui2/*.css and is
// scoped under html.blm-ui2, so switch off = native OpenProject.
// Registered by background.js for the configured host on work-package routes.

(() => {
'use strict';

const CFG_UI2   = '__blm_ui2';
const CFG_THEME = '__blm_theme';   // 'dark' | 'light', mirrored from the Settings theme picker
const ROOT_CLASS = 'blm-ui2';
const WP_CLASS   = 'blm-ui2-wp';

let enabled = false;
let theme = 'dark';
try { theme = localStorage.getItem('__blm_theme') === 'light' ? 'light' : 'dark'; } catch { /* storage blocked */ }

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
    if (leaf.dataset.blmTone !== tone) {
      leaf.classList.add('blm-g-chip');
      leaf.dataset.blmTone = tone;
    }
  }
  // Status button in the split view / full page (wp-status-button is an Angular element, not a class).
  for (const btn of document.querySelectorAll(
    'wp-status-button button, .wp-status-button button, button[class*="__hl_background_status"]'
  )) {
    const tone = statusTone(btn.textContent.trim().toLowerCase());
    if (btn.dataset.blmTone !== tone) {
      btn.classList.add('blm-g-status');
      btn.dataset.blmTone = tone;
    }
  }
}

function untagCells() {
  document.querySelectorAll('.blm-g-chip, .blm-g-status').forEach(el => {
    el.classList.remove('blm-g-chip', 'blm-g-status');
    delete el.dataset.blmTone;
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
  if (enabled) root.dataset.blmUi2Theme = theme;
  else delete root.dataset.blmUi2Theme;
}

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
  window.navigation.addEventListener('navigatesuccess', apply);
}
})();
