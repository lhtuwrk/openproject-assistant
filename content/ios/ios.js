// ios.js — iOS skin switch for OpenProject work-package and Backlogs pages.
// Only toggles html classes; every visual rule lives in content/ios/*.css and is
// scoped under html.blm-ios, so switch off = native OpenProject.
// Registered by background.js for the configured host on work-package, Backlogs, sign-in, project-list and notification routes.

(() => {
'use strict';

const CFG_IOS   = '__blm_ios';
const CFG_THEME = '__blm_theme';   // 'dark' | 'light', mirrored from the Settings theme picker
const ROOT_CLASS = 'blm-ios';
const WP_CLASS   = 'blm-ios-wp';
const BL_CLASS   = 'blm-ios-bl';
const LOGIN_CLASS = 'blm-ios-login';
const PROJECTS_CLASS = 'blm-ios-projects';
const NOTIF_CLASS = 'blm-ios-notif';

// The switch and theme are cached in the host page's localStorage so the first
// paint is already right; chrome.storage is async and lands after it.
const cached = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const cache  = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
let enabled = cached(CFG_IOS) === '1';
let theme = cached(CFG_THEME) === 'light' ? 'light' : 'dark';

const onWorkPackagePage = () => /\/work_packages(\/|$)/.test(location.pathname);
const onBacklogsPage    = () => /\/backlogs(\/|$)/.test(location.pathname);
const onLoginPage       = () => /^\/login(\/|$)/.test(location.pathname);
const onProjectsPage    = () => /^\/projects\/?$/.test(location.pathname);
// The notification centre opens work packages in a split view: it also gets the
// work-package class, so that pane and the toolbar share list.css and detail.css.
const onNotificationsPage = () => /^\/notifications(\/|$)/.test(location.pathname);

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

// Priority names vary per instance: anything urgent-sounding is "urgent".
function prioTone(text) {
  if (/immediate|urgent|blocker|critical|highest/.test(text)) return 'urgent';
  if (/high/.test(text)) return 'high';
  if (/low/.test(text)) return 'low';
  return 'normal';
}

// Idempotent: a second pass over tagged rows changes nothing.
function tagCells() {
  // List: priority gets a tone for its dot, lone "-" cells go quiet, and a
  // group's "(6)" count becomes a bare number for its capsule.
  for (const f of document.querySelectorAll('.work-package-table td.priority .inline-edit--display-field')) {
    const tone = prioTone(f.textContent.trim().toLowerCase());
    if (f.dataset.blmIPrio !== tone) f.dataset.blmIPrio = tone;
  }
  for (const td of document.querySelectorAll('.work-package-table tr.wp-table--row > td')) {
    const dash = /^[-–—]$/.test(td.textContent.trim());
    if (td.classList.contains('blm-i-dash') !== dash) td.classList.toggle('blm-i-dash', dash);
  }
  for (const c of document.querySelectorAll('.work-package-table tr[class*="group-header"] .count')) {
    const n = c.textContent.replace(/[()\s]/g, '');
    if (c.dataset.blmICount !== n) c.dataset.blmICount = n;
  }
  for (const cell of document.querySelectorAll('td.status')) {
    const leaf = textLeaf(cell);
    if (!leaf) continue;
    const text = leaf.textContent.trim();
    const tone = statusTone(text.toLowerCase());
    if (leaf.dataset.blmITone !== tone) {
      leaf.classList.add('blm-i-chip');
      leaf.dataset.blmITone = tone;
    }
    // The status it shows, kept on the cell: once clicked, the cell's editor is
    // empty until its options load, and list.css shows this chip meanwhile.
    if (leaf.matches('.inline-edit--display-field')) {
      const was = JSON.stringify(text);
      if (cell.style.getPropertyValue('--blm-i-was') !== was) cell.style.setProperty('--blm-i-was', was);
      if (cell.dataset.blmIWasTone !== tone) cell.dataset.blmIWasTone = tone;
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
  // Notification rows: the status badge is a solid OpenProject colour; give it a tone
  // so notifications.css can draw the same soft chip as the list.
  for (const b of document.querySelectorAll('.op-ian-item [class*="__hl_background_status"]')) {
    const tone = statusTone(b.textContent.trim().toLowerCase());
    if (b.dataset.blmITone !== tone) {
      b.classList.add('blm-i-chip');
      b.dataset.blmITone = tone;
    }
  }
  tagEmptyFields();
  tagBacklogs();
}

// Backlogs: a story's status text sits in .t (its stored id in a hidden .v), and
// a sprint's blank dates hold whitespace, so :empty never matches them.
function tagBacklogs() {
  for (const t of document.querySelectorAll('#rb li.story > .status_id > .t')) {
    const tone = statusTone(t.textContent.trim().toLowerCase());
    if (t.dataset.blmITone !== tone) {
      t.classList.add('blm-i-chip');
      t.dataset.blmITone = tone;
    }
  }
  // "User story: " → "User story", shown by backlogs.css in place of the text
  for (const t of document.querySelectorAll('#rb li.story > .type_id > .t')) {
    const name = t.textContent.trim().replace(/:$/, '').trim();
    if (t.dataset.blmIType !== name) t.dataset.blmIType = name;
  }
  for (const d of document.querySelectorAll('#rb .backlog > .header .date')) {
    const blank = !d.textContent.trim();
    if (d.classList.contains('blm-i-blank') !== blank) d.classList.toggle('blm-i-blank', blank);
  }
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
  document.querySelectorAll('.blm-i-dash').forEach(el => el.classList.remove('blm-i-dash'));
  document.querySelectorAll('.blm-i-blank').forEach(el => el.classList.remove('blm-i-blank'));
  document.querySelectorAll('[data-blm-i-was-tone]').forEach(el => {
    el.style.removeProperty('--blm-i-was');
    delete el.dataset.blmIWasTone;
  });
  document.querySelectorAll('[data-blm-i-prio], [data-blm-i-count], [data-blm-i-type]').forEach(el => {
    delete el.dataset.blmIPrio;
    delete el.dataset.blmICount;
    delete el.dataset.blmIType;
  });
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
    if (enabled && (onWorkPackagePage() || onBacklogsPage() || onNotificationsPage())) tagCells();
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
  root.classList.toggle(WP_CLASS, enabled && (onWorkPackagePage() || onNotificationsPage()));
  root.classList.toggle(BL_CLASS, enabled && onBacklogsPage());
  root.classList.toggle(LOGIN_CLASS, enabled && onLoginPage());
  root.classList.toggle(PROJECTS_CLASS, enabled && onProjectsPage());
  root.classList.toggle(NOTIF_CLASS, enabled && onNotificationsPage());
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
