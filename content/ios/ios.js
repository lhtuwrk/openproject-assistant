// ios.js — iOS skin switch for OpenProject work-package and Backlogs pages.
// Toggles html classes and tags elements; every visual rule lives in content/ios/*.css
// and is scoped under html.blm-ios, so switch off = native OpenProject. It also makes
// clicks answer at once (see "Optimistic UI").
// Registered by background.js for the configured host on work-package, Backlogs, sign-in, project-list and notification routes.

(() => {
'use strict';

// Once per page: background.js also injects this file into open tabs when the skin
// is switched on, and a tab loaded while it was on already has it.
if (globalThis.__blmIosLoaded) return;
globalThis.__blmIosLoaded = true;

const CFG_IOS   = '__blm_ios';
const CFG_THEME = '__blm_theme';   // 'dark' | 'light', mirrored from the Settings theme picker
const ROOT_CLASS = 'blm-ios';
const WP_CLASS   = 'blm-ios-wp';
const BL_CLASS   = 'blm-ios-bl';
const LOGIN_CLASS = 'blm-ios-login';
const PROJECTS_CLASS = 'blm-ios-projects';
const NOTIF_CLASS = 'blm-ios-notif';
const WIKI_CLASS = 'blm-ios-wiki';

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
const onWikiPage        = () => /^\/projects\/[^/]+\/wiki(\/|$)/.test(location.pathname);

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

// Tagging is rule based so it can run on just the part of the page that changed:
// each rule is a selector and an idempotent function for one matching element.
// A second pass over tagged elements changes nothing.
function tagStatusCell(cell) {
  const leaf = textLeaf(cell);
  if (!leaf) return;
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

function tagChip(el) {
  const tone = statusTone(el.textContent.trim().toLowerCase());
  if (el.dataset.blmITone !== tone) {
    el.classList.add('blm-i-chip');
    el.dataset.blmITone = tone;
  }
}

// A list row that ends its card (last row, or the one before a group header or the
// "create" row). Tagged here so list.css needs no `tr:has(+ tr…)`, which Chrome
// re-checks on every row whenever any row is added or removed.
const CARD_BREAK = 'tr[class*="group-header"], tr.wp-inline-create-button-row';
function tagLastRow(tr) {
  const next = tr.nextElementSibling;
  setAttr(tr, 'data-blm-i-last', !next || next.matches(CARD_BREAK));
}

// The element that holds relation rows / notification entries, for its card style
// (was `:has(> …)` on every element of the page).
const REL_ROW = 'wp-relation-row, .relation-row';
const NOTIF_ROW = 'op-in-app-notification-entry';
function tagListParent(row) {
  const p = row.parentElement;
  if (!p) return;
  if (row.matches(REL_ROW)) setAttr(p, 'data-blm-i-rel-list', true);
  else setAttr(p, 'data-blm-i-notif-list', true);
}
function recheckListParent(p) {
  if (p.hasAttribute('data-blm-i-rel-list')) setAttr(p, 'data-blm-i-rel-list', [...p.children].some(c => c.matches(REL_ROW)));
  if (p.hasAttribute('data-blm-i-notif-list')) setAttr(p, 'data-blm-i-notif-list', [...p.children].some(c => c.matches(NOTIF_ROW)));
}

const DETAIL_VIEWS = '.work-packages--details, .work-packages--show-view';

const RULES = [
  // List: priority gets a tone for its dot, lone "-" cells go quiet, and a
  // group's "(6)" count becomes a bare number for its capsule.
  ['.work-package-table td.priority .inline-edit--display-field', (f) => {
    const tone = prioTone(f.textContent.trim().toLowerCase());
    if (f.dataset.blmIPrio !== tone) f.dataset.blmIPrio = tone;
  }],
  // Priority picker of a row being edited: the same dot on its value and on each
  // option (list.css only shows the option dots while that picker is open).
  ['.work-package-table td.priority ng-select .ng-value, .ng-dropdown-panel .ng-option', (o) => {
    const tone = prioTone(o.textContent.trim().toLowerCase());
    if (o.dataset.blmIPrio !== tone) o.dataset.blmIPrio = tone;
  }],
  ['.work-package-table tr.wp-table--row > td', (td) => {
    const dash = /^[-–—]$/.test(td.textContent.trim());
    if (td.classList.contains('blm-i-dash') !== dash) td.classList.toggle('blm-i-dash', dash);
  }],
  ['.work-package-table tr[class*="group-header"] .count', (c) => {
    const n = c.textContent.replace(/[()\s]/g, '');
    if (c.dataset.blmICount !== n) c.dataset.blmICount = n;
  }],
  ['.work-package-table tbody > tr', tagLastRow],
  ['td.status', tagStatusCell],
  // Status button in the split view / full page (wp-status-button is an Angular element, not a class).
  ['wp-status-button button, .wp-status-button button, button[class*="__hl_background_status"]', (btn) => {
    if (btn.dataset.blmIPending) return;   // showing the status just picked (instant apply)
    const tone = statusTone(btn.textContent.trim().toLowerCase());
    if (btn.dataset.blmITone !== tone) {
      btn.classList.add('blm-i-status');
      btn.dataset.blmITone = tone;
    }
  }],
  // Notification rows: the status badge is a solid OpenProject colour; give it a tone
  // so notifications.css can draw the same soft chip as the list.
  ['.op-ian-item [class*="__hl_background_status"], .relation-row .inline-edit--display-field.status', tagChip],
  [`${REL_ROW}, ${NOTIF_ROW}`, tagListParent],
  ['[data-blm-i-rel-list], [data-blm-i-notif-list]', recheckListParent],
  // Backlogs: a story's status text sits in .t (its stored id in a hidden .v), and
  // a sprint's blank dates hold whitespace, so :empty never matches them.
  ['#rb li.story > .status_id > .t', tagChip],
  // "User story: " → "User story", shown by backlogs.css in place of the text
  ['#rb li.story > .type_id > .t', (t) => {
    const name = t.textContent.trim().replace(/:$/, '').trim();
    if (t.dataset.blmIType !== name) t.dataset.blmIType = name;
  }],
  ['#rb .backlog > .header .date', (d) => {
    const blank = !d.textContent.trim();
    if (d.classList.contains('blm-i-blank') !== blank) d.classList.toggle('blm-i-blank', blank);
  }],
  [`:is(${DETAIL_VIEWS}) .attributes-group:not(.description-group)`, (g) => tagGroup(g)],
];

// Run every rule on `root`: its own matching ancestor (closest() includes root)
// and everything matching inside it.
function tagIn(root) {
  for (const [sel, fn] of RULES) {
    const up = root.closest(sel);
    if (up) fn(up);
    for (const el of root.querySelectorAll(sel)) fn(el);
  }
}

// Page-wide states the CSS used to find with `html:has(…)`. Such a selector is
// re-matched against the whole document after every DOM change, which was the
// main cost while OpenProject renders; a few querySelector calls per frame are not.
const OPEN_SELECT_IN = {
  'blm-i-open-status': '.work-package-table td.status',
  'blm-i-open-type':   '.work-package-table td.type',
  'blm-i-open-priority': '.work-package-table td.priority',
  'blm-i-open-field':  '.attributes-key-value--value-container, wp-watchers-tab, .detail-panel-watchers',
};
const PAGE_FLAGS = ['blm-i-has-table', 'blm-i-show-view', ...Object.keys(OPEN_SELECT_IN)];

// Pop-ups the CSS used to recognise with `:is(#id .x, .x:has(…)) descendant`: such a
// selector in an ancestor position re-walks every ancestor's ancestors for every
// element on the page. Tagged here once instead (they are few and small).
//   .blm-i-projsel   the header's "Select a project" pull-down (base.css, every route)
//   .blm-i-menu      the list's view-settings and Create-type menus (list.css)
//   .blm-i-type-menu the Create-type menu alone
//   .blm-i-logtime   the Log time dialog (base.css), found the way jira-skin.js
//                    finds it: a small dialog titled "Log time" that asks for hours;
//   .blm-i-logtime-overlay its dimmed backdrop, when it is the dialog's parent
function tagPopups() {
  for (const m of document.querySelectorAll('.spot-modal, .op-modal--modal-container, .op-modal')) {
    const text = m.textContent.replace(/\s+/g, ' ').trim();
    const on = text.length < 600 && /log\s*time/i.test(text.slice(0, 120)) && /hours/i.test(text)
      && !m.querySelector('.spot-modal, .op-modal--modal-container, .op-modal');   // innermost only
    if (m.classList.contains('blm-i-logtime') !== on) m.classList.toggle('blm-i-logtime', on);
    const ov = m.parentElement;
    if (ov && /overlay/.test(ov.className) && ov.classList.contains('blm-i-logtime-overlay') !== on) ov.classList.toggle('blm-i-logtime-overlay', on);
  }
  for (const b of document.querySelectorAll('.spot-drop-modal--body')) {
    const on = !!(b.closest('.op-app-header, #top-menu') || b.querySelector('[class*="header-project-select"]'));
    if (b.classList.contains('blm-i-projsel') !== on) b.classList.toggle('blm-i-projsel', on);
  }
  for (const m of document.querySelectorAll('.dropdown-menu')) {
    const type = !!(m.closest('#types-context-menu') || m.querySelector(':scope > li [class*="__hl_inline_type"]'));
    const menu = type || !!(m.closest('#settingsDropdown') || m.querySelector(':scope > li .icon-group-by'));
    if (m.classList.contains('blm-i-menu') !== menu) m.classList.toggle('blm-i-menu', menu);
    if (m.classList.contains('blm-i-type-menu') !== type) m.classList.toggle('blm-i-type-menu', type);
  }
}
function tagPage() {
  const root = document.documentElement;
  const want = new Set();
  if (document.querySelector('.work-package-table')) want.add('blm-i-has-table');
  if (document.querySelector('.work-packages--show-view')) want.add('blm-i-show-view');
  for (const sel of document.querySelectorAll('ng-select.ng-select-opened')) {
    for (const [flag, inside] of Object.entries(OPEN_SELECT_IN)) if (sel.closest(inside)) want.add(flag);
  }
  for (const flag of PAGE_FLAGS) {
    if (root.classList.contains(flag) !== want.has(flag)) root.classList.toggle(flag, want.has(flag));
  }
}

// Work-package detail: rows whose value is empty ("-") are hidden behind a
// "Show N empty fields" footer after their group's card. Required fields and a
// row being edited always stay visible. Which groups are open is kept by group
// title for this tab, so it survives Angular re-rendering the group.
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

function tagGroup(group) {
  const card = group.querySelector('.wp-attribute-group');
  if (!card) return;
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
  if (!empty) { toggle?.remove(); return; }
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'blm-i-empty-toggle';
    toggle.addEventListener('click', () => {
      const t = group.querySelector('.attributes-group--header-text')?.textContent.trim() ?? '';
      if (openEmptyGroups.has(t)) openEmptyGroups.delete(t); else openEmptyGroups.add(t);
      tagGroup(group);
    });
  }
  if (toggle.previousElementSibling !== card) card.after(toggle);
  const label = open ? 'Hide empty fields'
    : `Show ${empty} empty field${empty === 1 ? '' : 's'}`;
  if (toggle.textContent !== label) toggle.textContent = label;
  toggle.setAttribute('aria-expanded', String(open));
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
  const ATTRS = ['data-blm-i-empty', 'data-blm-i-show-empty', 'data-blm-i-all-empty',
    'data-blm-i-last', 'data-blm-i-rel-list', 'data-blm-i-notif-list'];
  document.querySelectorAll(ATTRS.map(a => `[${a}]`).join(', ')).forEach(el => {
    for (const a of ATTRS) el.removeAttribute(a);
  });
  document.documentElement.classList.remove(...PAGE_FLAGS);
  document.querySelectorAll('.blm-i-projsel, .blm-i-menu, .blm-i-type-menu, .blm-i-logtime, .blm-i-logtime-overlay')
    .forEach(el => el.classList.remove('blm-i-projsel', 'blm-i-menu', 'blm-i-type-menu', 'blm-i-logtime', 'blm-i-logtime-overlay'));
  document.querySelectorAll('[data-blm-i-pending]').forEach(el => { delete el.dataset.blmIPending; });
  clearRing();
  document.querySelectorAll('.blm-i-committing, .blm-i-shake, .blm-i-flash, .blm-i-opening, .blm-i-switching, .blm-i-pressed')
    .forEach(el => el.classList.remove('blm-i-committing', 'blm-i-shake', 'blm-i-flash', 'blm-i-opening', 'blm-i-switching', 'blm-i-pressed'));
}

// ── Optimistic UI ───────────────────────────────────────────────────────────
// Every click answers at once; the server catches up behind it. Same contract as
// UI 2.0 (content/ui2/ui2.js), drawn by content/ios/*.css. progress-hook.js (page
// world) announces each work-package save: 'wp-save-start', 'wp-updated',
// 'wp-save-failed'.
//   · an option picked, Enter in a one-line field, or the check button → that
//     editor drops its chrome and reads as the applied value (.blm-i-committing);
//   · a status picked from the status button's menu shows on the button at once,
//     in its tone (data-blm-i-pending);
//   · saved  → OpenProject re-renders the field; it glows once (.blm-i-flash);
//   · failed → the editor comes back as it was, with a short shake.
// A list row opens its story with the row chosen and the old panel dimmed first
// (.blm-i-opening / .blm-i-switching), and anything pressable dips on pointerdown.
const EDIT_FIELD = '.inline-edit--active-field';
const SAVE_MSG = 'blm-progress-hook';
const noAnim = () => document.documentElement.classList.contains('blm-no-anim');
let statusBtn = null;   // the status button whose menu is open

// Mark an editor as applied; if no save ever answers (validation kept it open,
// nothing changed), give it back after a while so it is never stuck read-only.
const savedSpots = new Set();   // .inline-edit--container of editors being saved
function markCommitting(f) {
  if (!f || f.classList.contains('blm-i-committing')) return;
  f.classList.add('blm-i-committing');
  const spot = f.closest('.inline-edit--container');
  if (spot) savedSpots.add(spot);
  setTimeout(() => {
    if (f.isConnected && f.classList.contains('blm-i-committing')) f.classList.remove('blm-i-committing');
  }, 10000);
}
const activeFieldOf = (el) => el?.closest?.(EDIT_FIELD);

document.addEventListener('click', (e) => {
  if (!enabled) return;
  const t = e.target;
  // Status button → its menu → a status
  const btn = t.closest?.('.blm-i-status');
  if (btn) { statusBtn = btn; return; }
  const item = t.closest?.('.dropdown-menu .menu-item[class*="__hl_inline_status_"]');
  if (item && statusBtn?.isConnected) {
    const label = item.textContent.trim();
    statusBtn.dataset.blmIPending = label;
    statusBtn.dataset.blmITone = statusTone(label.toLowerCase());
    setTimeout(() => clearPending(statusBtn), 10000);   // never stuck if no save follows
    return;
  }
  // An option picked in a single-select editor (the panel is appended to <body>)
  if (t.closest?.('.ng-dropdown-panel .ng-option:not(.ng-option-disabled)')) {
    const sel = document.querySelector(`${EDIT_FIELD} .ng-select-opened:not(.ng-select-multiple)`);
    markCommitting(activeFieldOf(sel));
    return;
  }
  if (t.closest?.('.inplace-edit--control--save')) markCommitting(activeFieldOf(t));
}, true);

// Enter in a one-line editor (title, numbers), or picking with the keyboard in a select
document.addEventListener('keydown', (e) => {
  if (!enabled || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  const f = activeFieldOf(e.target);
  if (!f || e.target.closest('.ck-editor__editable, .document-editor__editable, textarea, .ng-select-multiple')) return;
  markCommitting(f);
}, true);

function clearPending(only) {
  const btns = only ? [only] : document.querySelectorAll('.blm-i-status[data-blm-i-pending]');
  for (const b of btns) { delete b.dataset.blmIPending; dirty.add(b); }
  schedule();   // retag tones from what OpenProject now shows
}
function rollback() {
  savedSpots.clear();
  document.querySelectorAll('.blm-i-committing').forEach(f => {
    f.classList.remove('blm-i-committing');
    f.classList.add('blm-i-shake');
    setTimeout(() => f.classList.remove('blm-i-shake'), 450);
  });
  document.querySelectorAll('.blm-i-status[data-blm-i-pending]').forEach(b => {
    b.classList.add('blm-i-shake');
    setTimeout(() => b.classList.remove('blm-i-shake'), 450);
  });
  clearPending();
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== SAVE_MSG || !enabled) return;
  const { type } = e.data;
  if (type === 'wp-save-start') {
    document.querySelectorAll(EDIT_FIELD).forEach(f => {
      if (!f.contains(document.activeElement) || f.classList.contains('blm-i-committing')) markCommitting(f);
    });
  } else if (type === 'wp-updated') {
    // OpenProject swaps the editors for display fields; anything it kept open stays usable
    setTimeout(() => {
      document.querySelectorAll('.blm-i-committing').forEach(f => f.classList.remove('blm-i-committing'));
      clearPending();
      for (const spot of savedSpots) {
        const shown = spot.isConnected && spot.querySelector('.inline-edit--display-field');
        if (shown) {
          shown.classList.remove('blm-i-flash'); void shown.offsetWidth; shown.classList.add('blm-i-flash');
          setTimeout(() => shown.classList.remove('blm-i-flash'), 950);
        }
      }
      savedSpots.clear();
    }, 60);
  } else if (type === 'wp-save-failed') {
    rollback();
  }
});

// Press feedback: buttons, tabs, rows and menu items dip the moment the pointer
// goes down, before the click (and whatever request it starts) even fires.
const PRESSABLE = [
  'button', '.button', 'a.op-tab-row--link', '.menu-item', '.ng-option',
  '.inline-edit--display-field', '.blm-i-empty-toggle',
  '.work-package-table tr.wp-table--row', '#rb li.story', '#rb .backlog > .header .toggler',
].join(', ');
let pressed = null;
const release = () => { pressed?.classList.remove('blm-i-pressed'); pressed = null; };
document.addEventListener('pointerdown', (e) => {
  if (!enabled || e.button !== 0) return;
  const el = e.target.closest?.(PRESSABLE);
  if (!el || el.matches(':disabled, [aria-disabled="true"]')) return;
  release();
  pressed = el;
  el.classList.add('blm-i-pressed');
}, { capture: true, passive: true });
for (const type of ['pointerup', 'pointercancel', 'dragstart']) {
  document.addEventListener(type, () => setTimeout(release, 90), { capture: true, passive: true });
}

// Open a story without the freeze: OpenProject builds the whole story panel in one
// go (~0.5 s with nothing painted). The click is held for one frame so the row
// shows as chosen and the open panel dims first, then the same click goes on to
// OpenProject. Plain clicks only: modified clicks, links, buttons, inline-editable
// cells and the context-menu cell pass straight through.
const replayed = new WeakSet();
let lastStoryId = null;
document.addEventListener('click', (e) => {
  if (!enabled || replayed.has(e) || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const row = e.target.closest?.('.work-package-table tr.wp-table--row');
  if (!row || e.target.closest('a, button, input, select, textarea, label, .inline-edit--display-field, .inline-edit--active-field, .wp-table--context-menu-td, .wp-table--cell-td.__internal-sorthandle')) return;
  if (row.classList.contains('-checked')) return;   // already open
  row.classList.add('blm-i-opening');
  document.querySelector('.work-packages--details')?.classList.add('blm-i-switching');
  if (noAnim()) return;   // feedback only, no held click
  e.preventDefault();
  e.stopImmediatePropagation();
  const target = e.target;
  const init = { bubbles: true, cancelable: true, composed: true, view: window, detail: e.detail,
    screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY, button: 0, buttons: 0 };
  let sent = false;
  const go = () => {
    if (sent) return;
    sent = true;
    const again = new MouseEvent('click', init);
    replayed.add(again);
    target.dispatchEvent(again);
  };
  requestAnimationFrame(() => requestAnimationFrame(go));   // after the feedback has been painted
  setTimeout(go, 100);   // never hold the click longer, even when no frames are drawn
  setTimeout(() => {
    row.classList.remove('blm-i-opening');
    document.querySelector('.work-packages--details.blm-i-switching')?.classList.remove('blm-i-switching');
  }, 3000);   // safety net; the story change in syncOpening() clears it sooner
}, true);

// The new story is in: the dimmed panel brightens back and the row loses its flash.
function syncOpening() {
  const storyId = location.pathname.match(/work_packages\/(?:details\/)?(\d+)/)?.[1] ?? null;
  if (storyId === lastStoryId) return;
  lastStoryId = storyId;
  document.querySelectorAll('.blm-i-opening').forEach(r => r.classList.remove('blm-i-opening'));
  document.querySelector('.work-packages--details.blm-i-switching')?.classList.remove('blm-i-switching');
}

// Angular re-renders rows on scroll, grouping and query switch: re-tag once per
// frame, and only where the page changed. The observer notes each added element
// (and the one before it, whose "last row" may have changed), the node in front
// of anything removed, and the parent of any text that changed. Too many changes
// in one frame, or a route switch, fall back to one pass over the whole page.
let frame = 0;
let fullPass = true;
const dirty = new Set();
const MAX_DIRTY = 400;

function noteMutations(records) {
  if (fullPass) return;
  for (const r of records) {
    if (r.type === 'characterData') {   // Angular updates bound text in place
      if (r.target.parentElement) dirty.add(r.target.parentElement);
      continue;
    }
    let text = false;
    for (const n of r.addedNodes) {
      if (n.nodeType !== 1) { text = true; continue; }
      dirty.add(n);
      if (n.previousElementSibling) dirty.add(n.previousElementSibling);
    }
    if (r.removedNodes.length) {
      const before = r.previousSibling;
      dirty.add(before?.nodeType === 1 ? before : r.target);
    }
    if (text) dirty.add(r.target);
    if (dirty.size > MAX_DIRTY) { fullPass = true; dirty.clear(); return; }
  }
}

// Keep only the outermost of nested roots: tagging a root covers what is inside it.
function outermost(nodes) {
  const out = [];
  for (const n of nodes) {
    if (!n.isConnected || n.nodeType !== 1) continue;
    let p = n.parentElement, covered = false;
    while (p) { if (nodes.has(p)) { covered = true; break; } p = p.parentElement; }
    if (!covered) out.push(n);
  }
  return out;
}

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const full = fullPass;
    const roots = full ? [document.documentElement] : outermost(dirty);
    fullPass = false;
    dirty.clear();
    if (!enabled) return;
    tagPopups();
    if (!(onWorkPackagePage() || onBacklogsPage() || onNotificationsPage())) return;
    tagPage();
    for (const root of roots) tagIn(root);
    syncOpening();
  });
}
function observe() {
  new MutationObserver((records) => {
    if (!enabled) return;
    noteMutations(records);
    schedule();
  }).observe(document.body, { childList: true, characterData: true, subtree: true });
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
  root.classList.toggle(WIKI_CLASS, enabled && onWikiPage());
  if (enabled) { fullPass = true; schedule(); }
  else untagCells();
  // own attribute: jira-skin.js deletes data-blm-theme when it switches off
  if (enabled) root.dataset.blmIosTheme = theme;
  else delete root.dataset.blmIosTheme;
}

// ── Focus rings that can't be covered ─────────────────────────────────────────
// The skin draws focus rings outside an element (outline, or a 2 px box-shadow on
// an ng-select). Inside anything that clips — table cells, scrolling panels,
// rounded cards with overflow hidden — or at the window edge, part of that ring
// is cut off. On every focus, check whether a ring 2 px outside the element would
// fit inside each clipping ancestor and the window; if not, tag the element
// .blm-i-ring-in and base.css draws the ring on its inside edge instead.
// An inside ring still needs the element's own box in view: a value pulled past
// its wrapper (list cells use a negative margin) is cut by an overflow:hidden
// wrapper, so such wrappers get .blm-i-unclip (overflow visible) while it has
// focus. Scroll containers (auto/scroll) are never touched, only hidden/clip.
const RING = 3;   // ring width plus a pixel of anti-aliasing
function clipCheck(box) {
  const out = { ring: false, unclip: [] };
  const r = box.getBoundingClientRect();
  if (!r.width && !r.height) return out;
  if (r.left - RING < 0 || r.top - RING < 0 || r.right + RING > innerWidth || r.bottom + RING > innerHeight) out.ring = true;
  for (let a = box.parentElement; a && a !== document.body; a = a.parentElement) {
    const cs = getComputedStyle(a);
    const clipX = cs.overflowX !== 'visible', clipY = cs.overflowY !== 'visible';
    if (!clipX && !clipY) continue;
    const b = a.getBoundingClientRect();   // clipping is at the padding edge
    const l = b.left + parseFloat(cs.borderLeftWidth), t = b.top + parseFloat(cs.borderTopWidth);
    const rr = b.right - parseFloat(cs.borderRightWidth), bb = b.bottom - parseFloat(cs.borderBottomWidth);
    const over = (m) => (clipX && (r.left - m < l || r.right + m > rr)) || (clipY && (r.top - m < t || r.bottom + m > bb));
    if (over(RING)) out.ring = true;
    if (over(0) && /^(hidden|clip)$/.test(cs.overflowX) && /^(hidden|clip)$/.test(cs.overflowY)) out.unclip.push(a);
  }
  return out;
}
let ringEl = null, unclipped = [];
function clearRing() {
  ringEl?.classList.remove('blm-i-ring-in'); ringEl = null;
  for (const a of unclipped) a.classList.remove('blm-i-unclip');
  unclipped = [];
}
document.addEventListener('focusin', (e) => {
  clearRing();
  if (!enabled || !(e.target instanceof Element)) return;
  // An ng-select draws its ring on .ng-select-container while its <input> has focus.
  const el = e.target.closest('.ng-select') ?? e.target;
  const box = el.matches('.ng-select') ? (el.querySelector('.ng-select-container') ?? el) : el;
  const { ring, unclip } = clipCheck(box);
  if (ring) { el.classList.add('blm-i-ring-in'); ringEl = el; }
  for (const a of unclip) a.classList.add('blm-i-unclip');
  unclipped = unclip;
}, true);
document.addEventListener('focusout', (e) => {
  if (ringEl && !ringEl.contains(e.relatedTarget)) clearRing();
}, true);

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
