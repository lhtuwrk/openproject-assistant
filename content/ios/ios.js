// ios.js — iOS skin switch for OpenProject work-package and Backlogs pages.
// Toggles html classes and tags elements; every visual rule lives in content/ios/*.css
// and is scoped under html.blm-ios, so switch off = native OpenProject. It also makes
// clicks answer at once (see "Optimistic UI").
// Registered by background.js for the configured host on work-package, Backlogs, sign-in, project-list, notification and wiki routes.

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
  // group title rows, for list.css rules that reach every element inside them
  // (`tr[class*="group-header"] *` would restyle whole subtrees on any class change)
  setAttr(tr, 'data-blm-i-group', tr.className.includes('group-header'));
}

// The element that holds relation rows / notification entries, for its card style
// (was `:has(> …)` on every element of the page).
const REL_ROW = 'wp-relation-row, .relation-row';
const NOTIF_ROW = 'op-in-app-notification-entry';
const WATCH_ROW = 'wp-watcher-entry';   // watchers tab (detail.css)
const LIST_KINDS = [['data-blm-i-rel-list', REL_ROW], ['data-blm-i-notif-list', NOTIF_ROW], ['data-blm-i-watch-list', WATCH_ROW]];
function tagListParent(row) {
  const p = row.parentElement;
  if (!p) return;
  for (const [attr, sel] of LIST_KINDS) if (row.matches(sel)) setAttr(p, attr, true);
}
function recheckListParent(p) {
  for (const [attr, sel] of LIST_KINDS) {
    if (p.hasAttribute(attr)) setAttr(p, attr, [...p.children].some(c => c.matches(sel)));
  }
}

// A relation row's cell that holds the subject link takes the row's free width
// (was `.relation-row--grid > :has(a.relation-row--grid-subject)`, a descendant
// search Chrome ran from every element of the page on each style pass).
function tagGrowCell(a) {
  const grid = a.closest('.relation-row--grid');
  let cell = a;
  while (cell && cell.parentElement !== grid) cell = cell.parentElement;
  if (cell && cell !== a) setAttr(cell, 'data-blm-i-grow', true);
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
    setAttr(td, 'data-blm-i-cf', td.className.includes('customField'));
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
  [`${REL_ROW}, ${NOTIF_ROW}, ${WATCH_ROW}`, tagListParent],
  ['[data-blm-i-rel-list], [data-blm-i-notif-list], [data-blm-i-watch-list]', recheckListParent],
  ['.relation-row--grid a.relation-row--grid-subject', tagGrowCell],
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
  // Parts OpenProject names inconsistently, matched here by class fragment so the
  // CSS can use a stable marker (see tagPopups for why not `[class*="…"]` in CSS).
  ['[class*="relations"] [class*="group-by"] .button', (b) => setClass(b, 'blm-i-groupby', true)],
  ['[class*="activities"] li, [class*="activity-contents"] li', (li) => setAttr(li, 'data-blm-i-act', true)],
  ['#main-menu [class*="sidemenu--title"]', (t) => setClass(t, 'blm-i-side-title', true)],
  ['[class*="ian-center"] [class*="empty"]', (e) => setClass(e, 'blm-i-empty-state', true)],
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
  // a row's person cells share the details view's people pull-down (list.css styles the cell's field)
  'blm-i-open-field':  '.attributes-key-value--value-container, wp-watchers-tab, .detail-panel-watchers, .work-package-table :is(td.assignee, td.responsible)',
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
//
// Parts inside them that OpenProject names inconsistently are tagged here too,
// because the CSS must not find them by class fragment. A `[class*="…"]` selector
// in an ancestor position (`[class*="footer"] .x *`, `:not([class*="header"] *)`)
// keys an invalidation set on the class attribute itself, so Chrome then restyles
// the whole subtree of ANY element whose class changes — a hover class on a row, a
// flag on <html> — which made plain mouse moves over the list restyle the page.
//   [data-blm-i-lt~=…] the Log time dialog's outermost header / body / footer
//   .blm-i-search, .blm-i-foot the project picker's search field and footer
//   .blm-i-hl          a type name in the Create-type menu
const LT_PARTS = [['header', /header/], ['body', /body/], ['footer', /footer|action-bar/]];
function tagLogTimeParts(m) {
  const all = m.querySelectorAll('[class*="header"], [class*="body"], [class*="footer"], [class*="action-bar"]');
  for (const el of all) {
    const cls = typeof el.className === 'string' ? el.className : '';
    const up = [];   // class strings of its ancestors inside the dialog
    for (let a = el.parentElement; a && a !== m; a = a.parentElement) up.push(typeof a.className === 'string' ? a.className : '');
    // outermost of its kind: no ancestor inside the dialog has the same fragment
    const tokens = LT_PARTS.filter(([, re]) => re.test(cls) && !up.some(c => re.test(c))).map(([part]) => part);
    if (!up.some(c => LT_PARTS.some(([, re]) => re.test(c)))) tokens.push('part');
    const v = tokens.join(' ');
    if ((el.dataset.blmILt ?? '') !== v) { if (v) el.dataset.blmILt = v; else delete el.dataset.blmILt; }
  }
}
function setClass(el, cls, on) {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}
function tagPopups() {
  for (const m of document.querySelectorAll('.spot-modal, .op-modal--modal-container, .op-modal')) {
    const text = m.textContent.replace(/\s+/g, ' ').trim();
    const on = text.length < 600 && /log\s*time/i.test(text.slice(0, 120)) && /hours/i.test(text)
      && !m.querySelector('.spot-modal, .op-modal--modal-container, .op-modal');   // innermost only
    if (m.classList.contains('blm-i-logtime') !== on) m.classList.toggle('blm-i-logtime', on);
    if (on) tagLogTimeParts(m);
    const ov = m.parentElement;
    if (ov && /overlay/.test(ov.className) && ov.classList.contains('blm-i-logtime-overlay') !== on) ov.classList.toggle('blm-i-logtime-overlay', on);
  }
  for (const b of document.querySelectorAll('.spot-drop-modal--body')) {
    const on = !!(b.closest('.op-app-header, #top-menu') || b.querySelector('[class*="header-project-select"]'));
    if (b.classList.contains('blm-i-projsel') !== on) b.classList.toggle('blm-i-projsel', on);
    if (!on) continue;
    for (const s of b.querySelectorAll('[class*="--search"]')) setClass(s, 'blm-i-search', true);
    for (const f of b.querySelectorAll('footer, [class*="footer"], .spot-action-bar')) setClass(f, 'blm-i-foot', true);
  }
  for (const m of document.querySelectorAll('.dropdown-menu')) {
    const type = !!(m.closest('#types-context-menu') || m.querySelector(':scope > li [class*="__hl_inline_type"]'));
    if (type) for (const h of m.querySelectorAll('[class*="__hl_inline_type"]')) setClass(h, 'blm-i-hl', true);
    // a work package's ⋮ menu (detail page toolbar, or a table row's context menu)
    const wp = !type && !!(m.closest('#work-package-context-menu') || m.querySelector(':scope > li :is(.icon-log_time, .icon-move, [class*="icon-export-atom"])'));
    const menu = type || wp || !!(m.closest('#settingsDropdown') || m.querySelector(':scope > li .icon-group-by'));
    if (m.classList.contains('blm-i-menu') !== menu) m.classList.toggle('blm-i-menu', menu);
    if (m.classList.contains('blm-i-wp-menu') !== wp) m.classList.toggle('blm-i-wp-menu', wp);
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
    'data-blm-i-last', 'data-blm-i-rel-list', 'data-blm-i-notif-list', 'data-blm-i-watch-list', 'data-blm-i-grow',
    'data-blm-i-group', 'data-blm-i-cf', 'data-blm-i-act', 'data-blm-i-lt'];
  document.querySelectorAll(ATTRS.map(a => `[${a}]`).join(', ')).forEach(el => {
    for (const a of ATTRS) el.removeAttribute(a);
  });
  document.documentElement.classList.remove(...PAGE_FLAGS);
  const MARKS = ['blm-i-projsel', 'blm-i-menu', 'blm-i-wp-menu', 'blm-i-type-menu', 'blm-i-logtime', 'blm-i-logtime-overlay',
    'blm-i-search', 'blm-i-foot', 'blm-i-hl', 'blm-i-groupby', 'blm-i-side-title', 'blm-i-empty-state'];
  document.querySelectorAll(MARKS.map(c => `.${c}`).join(', ')).forEach(el => el.classList.remove(...MARKS));
  document.querySelectorAll('[data-blm-i-pending]').forEach(el => { delete el.dataset.blmIPending; });
  clearRing();
  document.querySelectorAll('.blm-i-committing, .blm-i-shake, .blm-i-flash, .blm-i-opening, .blm-i-switching, .blm-i-pressed')
    .forEach(el => el.classList.remove('blm-i-committing', 'blm-i-shake', 'blm-i-flash', 'blm-i-opening', 'blm-i-switching', 'blm-i-pressed'));
  untagThumbs();
  untagWikiActions();
}

// ── Wiki attachments: image previews ──────────────────────────────────────────
// Each image tile in a wiki page's attachment list (li.op-file-list--item) gets a
// preview above its name: an <a class="blm-i-thumb"> to the file (a click opens the
// lightbox below; a modified click still opens a tab), holding an <img>
// of its download URL (OpenProject has no thumbnail endpoint). The URL comes from
// the tile's own /api/v3/attachments/<id>/content link, so nothing is fetched up
// front. The image loads lazily (only near the viewport), decodes off the main
// thread at low priority, and a failed load drops the preview back to the icon.
// Non-images and tiles whose link hasn't rendered yet are left as they are and
// re-checked on the next change (data-blm-i-thumb marks the done ones).
const ATTACHMENT_HREF_RE = /\/api\/v3\/attachments\/\d+\/content/;
const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
function tagThumbs() {
  for (const li of document.querySelectorAll('.op-file-list--item:not([data-blm-i-thumb])')) {
    const name = (li.querySelector('.op-file-list--item-title')?.textContent ?? '').trim();
    if (!name) continue;
    if (!IMAGE_NAME_RE.test(name)) { li.dataset.blmIThumb = 'none'; continue; }
    const href = [...li.querySelectorAll('[href]')].map(a => a.getAttribute('href')).find(h => ATTACHMENT_HREF_RE.test(h));
    if (!href) continue;
    li.dataset.blmIThumb = 'image';
    const link = document.createElement('a');
    link.className = 'blm-i-thumb';
    link.href = href;
    link.target = '_blank';   // a modified click (Ctrl/⌘/Shift/middle) still opens a tab
    link.rel = 'noopener';
    link.setAttribute('aria-label', `Preview ${name}`);
    link.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) return;
      e.preventDefault();
      const all = [...document.querySelectorAll('.op-file-list--item .blm-i-thumb')];
      openLightbox(all.map(a => ({ src: a.getAttribute('href'), name: a.getAttribute('aria-label').replace(/^Preview /, '') })),
        Math.max(0, all.indexOf(link)), link);
    });
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.draggable = false;
    img.addEventListener('error', () => { link.remove(); li.dataset.blmIThumb = 'none'; }, { once: true });
    img.src = href;
    link.append(img);
    li.prepend(link);
  }
}
function untagThumbs() {
  document.querySelector('.blm-i-lightbox')?.blmClose?.();
  document.querySelectorAll('.blm-i-thumb, .blm-i-att-toggle').forEach(el => el.remove());
  document.querySelectorAll('[data-blm-i-thumb]').forEach(el => { delete el.dataset.blmIThumb; });
  document.querySelectorAll('[data-blm-i-collapsed]').forEach(el => { delete el.dataset.blmICollapsed; });
}

// Wiki edit / new page: the Save / Cancel row sits under a long editor, so it is
// pinned to the bottom of the viewport (CSS: .blm-i-wiki-actions, position: sticky)
// and stays in reach while typing. The row is the submit button's parent; when
// the buttons sit straight in the form, they are wrapped in a div we own
// (data-blm-i-wrap) that untagWikiActions unwraps again.
const WIKI_FORM_SEL = ':is(#wiki_form, .wiki-page--form, form.edit_content, form.new_page, form[id^="wiki"])';
function tagWikiActions() {
  for (const form of document.querySelectorAll(WIKI_FORM_SEL)) {
    if (form.querySelector('.blm-i-wiki-actions')) continue;
    const submits = form.querySelectorAll(':is(button, input)[type="submit"]');
    const save = submits[submits.length - 1];
    if (!save) continue;
    let row = save.parentElement;
    if (row === form) {
      row = document.createElement('div');
      row.dataset.blmIWrap = '1';
      save.before(row);
      const group = [save];
      for (let n = save.nextElementSibling; n?.matches('a.button, .button, button'); n = n.nextElementSibling) group.push(n);
      row.append(...group);
    }
    row.classList.add('blm-i-wiki-actions');
  }
}
function untagWikiActions() {
  for (const row of document.querySelectorAll('.blm-i-wiki-actions')) {
    if (row.dataset.blmIWrap) row.replaceWith(...row.childNodes);
    else row.classList.remove('blm-i-wiki-actions');
  }
}

// A disclosure row above each wiki attachment list ("› Attachments  24"), the list
// collapsed by default on every page load: two dozen screenshots shouldn't push the
// page's end down, and a hidden list's previews don't load at all. The count
// follows uploads/deletes; a list Angular re-renders gets a new row and starts
// collapsed again, and a row whose list is gone is removed.
let attToggleSeq = 0;
function tagAttachmentToggles() {
  for (const btn of document.querySelectorAll('.blm-i-att-toggle')) {
    if (!btn.nextElementSibling?.matches('.op-file-list')) btn.remove();
  }
  for (const list of document.querySelectorAll('.op-file-list')) {
    let btn = list.previousElementSibling;
    if (!btn?.matches('.blm-i-att-toggle')) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'blm-i-att-toggle';
      btn.innerHTML = '<svg class="blm-i-att-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + '<span class="blm-i-att-label">Attachments</span><span class="blm-i-att-count"></span>';
      if (!list.id) list.id = `blm-i-att-list-${++attToggleSeq}`;
      btn.setAttribute('aria-controls', list.id);
      btn.addEventListener('click', () => {
        const open = list.dataset.blmICollapsed === '1';
        list.dataset.blmICollapsed = open ? '0' : '1';
        btn.setAttribute('aria-expanded', String(open));
      });
      if (!list.dataset.blmICollapsed) list.dataset.blmICollapsed = '1';
      btn.setAttribute('aria-expanded', String(list.dataset.blmICollapsed !== '1'));
      list.before(btn);
    }
    const n = String(list.querySelectorAll(':scope > .op-file-list--item').length);
    const count = btn.querySelector('.blm-i-att-count');
    if (count.textContent !== n) count.textContent = n;   // unchanged text: no new mutation, no loop
  }
}

// The preview's lightbox: the full image over a dimmed, blurred page, with its
// name and "3 of 24" in a top bar, a close button and ‹ › when there are others.
// Esc / a click on the backdrop closes; ← → step; Ctrl + wheel (or a pinch) zooms
// round the pointer, drag pans while zoomed, double-click toggles 1× / 2×.
// Focus moves to the close button and returns to the preview it came from.
function openLightbox(items, index, opener) {
  document.querySelector('.blm-i-lightbox')?.blmClose?.();
  const box = document.createElement('div');
  box.className = 'blm-i-lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML = `
    <div class="blm-i-lb-bar">
      <span class="blm-i-lb-title"><span class="blm-i-lb-name"></span><span class="blm-i-lb-count"></span></span>
      <a class="blm-i-lb-btn blm-i-lb-open" target="_blank" rel="noopener" title="Open in new tab" aria-label="Open in new tab">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5V13a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 3 13V5a.5.5 0 0 1 .5-.5H7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
      <button type="button" class="blm-i-lb-btn blm-i-lb-close" title="Close (Esc)" aria-label="Close">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    </div>
    <div class="blm-i-lb-stage"><img alt="" draggable="false"></div>`;
  const img = box.querySelector('img');
  const stage = box.querySelector('.blm-i-lb-stage');
  const openLink = box.querySelector('.blm-i-lb-open');
  const nameEl = box.querySelector('.blm-i-lb-name');
  const countEl = box.querySelector('.blm-i-lb-count');
  if (items.length > 1) {
    for (const [cls, label, step, d] of [['prev', 'Previous image', -1, 'M10 3 5 8l5 5'], ['next', 'Next image', 1, 'M6 3l5 5-5 5']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `blm-i-lb-btn blm-i-lb-nav ${cls}`;
      b.setAttribute('aria-label', label);
      b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      b.addEventListener('click', (e) => { e.stopPropagation(); show(step); });
      box.append(b);
    }
  }

  let scale = 1, x = 0, y = 0, drag = null, moved = false;
  const transform = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    box.classList.toggle('zoomed', scale > 1.01);
  };
  const reset = () => { scale = 1; x = 0; y = 0; transform(); };
  function show(step) {
    index = (index + step + items.length) % items.length;
    const it = items[index];
    box.classList.add('loading');
    img.onload = img.onerror = () => box.classList.remove('loading');
    img.src = it.src;
    img.alt = it.name;
    openLink.href = it.src;
    nameEl.textContent = it.name;
    countEl.textContent = items.length > 1 ? `${index + 1} of ${items.length}` : '';
    box.setAttribute('aria-label', it.name);
    reset();
  }
  // Zoom keeping the point under the pointer still.
  const zoomAt = (factor, cx, cy) => {
    const next = Math.min(8, Math.max(1, scale * factor));
    const r = stage.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
    x = px - (px - x) * (next / scale);
    y = py - (py - y) * (next / scale);
    scale = next;
    if (scale === 1) { x = 0; y = 0; }
    transform();
  };
  box.addEventListener('wheel', (e) => {
    e.preventDefault();   // the page behind must not scroll or zoom
    if (e.ctrlKey) zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    else if (scale > 1) { x -= e.deltaX; y -= e.deltaY; transform(); }
  }, { passive: false });
  img.addEventListener('dblclick', (e) => { if (scale > 1) reset(); else zoomAt(2, e.clientX, e.clientY); });
  img.addEventListener('pointerdown', (e) => {
    if (e.button || scale <= 1) return;
    drag = { x: e.clientX - x, y: e.clientY - y };
    img.setPointerCapture(e.pointerId);
    box.classList.add('dragging');
  });
  img.addEventListener('pointermove', (e) => {
    if (!drag) return;
    moved = true;
    x = e.clientX - drag.x; y = e.clientY - drag.y;
    transform();
  });
  const endDrag = () => { drag = null; box.classList.remove('dragging'); };
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);
  box.addEventListener('pointerdown', () => { moved = false; });
  box.addEventListener('click', (e) => {
    if (moved) return;
    if (e.target === box || e.target === stage) close();
  });
  box.querySelector('.blm-i-lb-close').addEventListener('click', () => close());

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (items.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault(); e.stopPropagation();
      show(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === 'Tab') {   // keep focus inside the dialog
      const f = [...box.querySelectorAll('a[href], button')];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  };
  const overflow = document.documentElement.style.overflow;
  function close() {
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.style.overflow = overflow;
    box.remove();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }
  box.blmClose = close;
  document.addEventListener('keydown', onKey, true);
  document.documentElement.style.overflow = 'hidden';
  document.body.append(box);
  show(0);
  box.querySelector('.blm-i-lb-close').focus({ preventScroll: true });
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
  // Right after the frame that paints the feedback: a task queued from inside
  // rAF runs once that frame is out, a frame sooner than a second rAF would.
  requestAnimationFrame(() => setTimeout(go, 0));
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
    if (dirty.size > MAX_DIRTY) {
      // Opening a story inserts thousands of nodes, nearly all inside the new
      // panel: fold them into their outermost roots before giving up and
      // re-tagging the whole page (table included) every frame of the build.
      const kept = outermost(dirty);
      dirty.clear();
      if (kept.length > MAX_DIRTY / 2) { fullPass = true; return; }
      for (const n of kept) dirty.add(n);
    }
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
    if (onWikiPage()) { tagAttachmentToggles(); tagThumbs(); tagWikiActions(); }
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

// Runs on load, on a settings change and after every in-app navigation — which
// includes each click on a list row (the URL becomes …/details/<id>). Only a real
// change of skin, theme or route class may touch <html> or re-tag the whole page:
// a class or attribute written on <html>, even with the same value, can restyle
// every element, and a full pass walks the whole table while OpenProject is busy
// building the story panel. The panel itself is tagged from its mutations.
let appliedKey = null;
function apply() {
  const root = document.documentElement;
  const want = {
    [ROOT_CLASS]: enabled,
    [WP_CLASS]: enabled && (onWorkPackagePage() || onNotificationsPage()),
    [BL_CLASS]: enabled && onBacklogsPage(),
    [LOGIN_CLASS]: enabled && onLoginPage(),
    [PROJECTS_CLASS]: enabled && onProjectsPage(),
    [NOTIF_CLASS]: enabled && onNotificationsPage(),
    [WIKI_CLASS]: enabled && onWikiPage(),
  };
  for (const [cls, on] of Object.entries(want)) {
    if (root.classList.contains(cls) !== on) root.classList.toggle(cls, on);
  }
  // own attribute: jira-skin.js deletes data-blm-theme when it switches off
  if (enabled) { if (root.dataset.blmIosTheme !== theme) root.dataset.blmIosTheme = theme; }
  else if ('blmIosTheme' in root.dataset) delete root.dataset.blmIosTheme;
  const key = JSON.stringify(want);
  if (key === appliedKey) return;
  appliedKey = key;
  if (enabled) { fullPass = true; schedule(); }
  else untagCells();
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

// OpenProject's inline editors (assignee, status, type, priority...) close their
// list on an outside click but stay in edit mode until Escape. Escape cancels an
// unchanged edit, so send it on any outside press. jira-skin.js does the same for
// its own skin; the skins are exclusive, so only one of them sends it.
document.addEventListener('mousedown', (e) => {
  if (!enabled || !(e.target instanceof Element)) return;
  const field = document.querySelector('.inline-edit--active-field');
  if (!field || field.closest('.inline-edit--container')?.contains(e.target)) return;
  if (e.target.closest('.ng-dropdown-panel, .op-modal, .spot-modal, [role="dialog"], .flatpickr-calendar, .op-datepicker-modal')) return;
  if (document.querySelector('.op-modal, .spot-modal, .op-modal--modal-container')) return;   // a dialog is open: its popups live outside it
  const input = field.querySelector('input, select, textarea') ?? field;
  input.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
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
