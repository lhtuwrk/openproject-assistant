// jira-skin.js — Jira-style look for OpenProject.
//
// Runs on: every page of the configured backlog host (registered by background.js)
//   html.blm-jira     the top header bar, on every page
//   html.blm-jira-wp  work-package lists, the split view and the full page
//   html.blm-jira-bl  the Backlogs page
//
// Adds a stylesheet and tags status, type and priority values so they render as
// Jira lozenges and icons. Its only writes to OpenProject are a child work item's
// assignee and status, changed in the Child work items section (see writeWp).
// Toggled from Settings ("Jira style"); the Children-table Assignee column has
// its own switch ("Assign from the Children table"), and so does the Activity
// filter ("Activity filter"); both work without the skin.

// Wrapped in its own scope: content scripts on a page share one global scope,
// and content.js declares some of the same names.
(() => {
'use strict';

const CFG_JIRA_SKIN = '__blm_jira_skin';
const CFG_THEME     = '__blm_theme';   // 'dark' | 'light', mirrored from the Settings theme picker
const ROOT_CLASS    = 'blm-jira';
const WP_CLASS      = 'blm-jira-wp';
const BL_CLASS      = 'blm-jira-bl';

let skinEnabled = true;

// "Animations": entrance animations and hover transitions of the skin; on by default.
const CFG_ANIMATION = '__blm_jira_animation';
let animationEnabled = true;
// Cached by the page's own localStorage so the first paint already has the right theme
function cachedTheme() {
  try { return localStorage.getItem('__blm_theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}
let theme       = cachedTheme();

// "Assign from the Children table": an Assignee column in OpenProject's own
// Children table (Relations tab). Independent of Jira style, so it also works on
// the plain OpenProject UI; html.blm-assign carries its tokens and styles then.
const CFG_CHILD_ASSIGN = '__blm_children_assign';
const AS_CLASS         = 'blm-assign';
let assignEnabled = true;

// "Activity filter": the Show All · Comments · History bar on the Activity tab.
// Also independent of Jira style; html.blm-activity carries its tokens and styles.
const CFG_ACTIVITY_ON = '__blm_activity_filter_on';
const ACT_CLASS       = 'blm-activity';
let activityEnabled = true;

// "Quote of the day": a random quote in the work-package list's bottom bar, new on
// every entry into the work-package pages. Independent of Jira style.
const CFG_QUOTE = '__blm_quote';
let quoteEnabled = true;
let quote = null;   // { quote, author } picked by pickQuote()
let quoteEl = null;   // the inserted element; lets renderQuote skip its lookups while it is in place
function pickQuote() {
  const pool = globalThis.__blmQuotes ?? [];
  quote = pool[Math.floor(Math.random() * pool.length)] ?? null;
  removeQuote();   // renderQuote re-inserts it with the new text
}
pickQuote();

function renderQuote() {
  if (quote && quoteEl?.isConnected && quoteEl.parentElement?.matches('.op-pagination')) return;
  const host = document.querySelector('.op-pagination');
  removeQuote();
  if (!quote || !host) return;
  quoteEl = Object.assign(document.createElement('span'), { className: 'blm-quote', textContent: `“${quote.quote}” — ${quote.author}` });
  host.append(quoteEl);
}

function removeQuote() {
  quoteEl?.remove();
  quoteEl = null;
}

// "Attachment cards": Jira-style cards in the Files tab. Also independent of Jira
// style; html.blm-files carries its tokens and styles.
const CFG_FILES_ON = '__blm_file_cards';
const FILES_CLASS  = 'blm-files';
let filesEnabled = true;

// ─── Cell classification ────────────────────────────────────────────────────────

const DONE_STATUSES = new Set(['resolved', 'closed', 'done', 'rejected']);
const PROGRESS_RE   = /progress|review|test|develop|implement/;

function statusTone(text) {
  if (DONE_STATUSES.has(text)) return 'done';
  if (PROGRESS_RE.test(text))  return 'progress';
  return 'todo';
}

function typeKind(text) {
  if (text.includes('bug'))     return 'bug';
  if (text.includes('epic'))    return 'epic';
  if (text.includes('story'))   return 'story';
  if (text.includes('feature')) return 'feature';
  if (text.includes('task'))    return 'task';
  return 'other';
}

function priorityLevel(text) {
  if (/immediate|urgent|highest|blocker|critical/.test(text)) return 'highest';
  if (text.includes('high'))                                   return 'high';
  if (/low|minor|trivial/.test(text))                          return 'low';
  return 'medium';
}

/** The innermost element of a cell that holds its text, or null. */
function textLeaf(cell) {
  let leaf = null;
  for (const el of cell.querySelectorAll('*')) {
    if (el.classList.contains('blm-jx-icon')) continue;
    if (!el.children.length && el.textContent.trim()) leaf = el;
  }
  return leaf;
}

function ensureIcon(leaf, kind, value) {
  const prev = leaf.previousElementSibling;
  if (prev?.classList.contains('blm-jx-icon') && prev.dataset[kind] === value) return;
  if (prev?.classList.contains('blm-jx-icon')) prev.remove();
  const icon = document.createElement('span');
  icon.className = 'blm-jx-icon';
  icon.dataset[kind] = value;
  icon.setAttribute('aria-hidden', 'true');
  leaf.before(icon);
}

// Idempotent: a second pass over the same rows changes nothing, so the
// observer below settles after one extra frame.
function tagCells() {
  for (const cell of document.querySelectorAll('td.status')) {
    const leaf = textLeaf(cell);
    if (!leaf) continue;
    const tone = statusTone(leaf.textContent.trim().toLowerCase());
    if (leaf.dataset.blmTone !== tone) {
      leaf.classList.add('blm-jx-lozenge');
      leaf.dataset.blmTone = tone;
    }
  }
  for (const cell of document.querySelectorAll('td.type')) {
    const leaf = textLeaf(cell);
    if (leaf) ensureIcon(leaf, 'type', typeKind(leaf.textContent.trim().toLowerCase()));
  }
  for (const cell of document.querySelectorAll('td.priority')) {
    const leaf = textLeaf(cell);
    if (leaf) ensureIcon(leaf, 'priority', priorityLevel(leaf.textContent.trim().toLowerCase()));
  }

  // Backlogs page rows (server-rendered, not Angular).
  for (const t of document.querySelectorAll('#rb li.story > .status_id > .t')) {
    const tone = statusTone(t.textContent.trim().toLowerCase());
    if (t.dataset.blmTone !== tone) {
      t.classList.add('blm-jx-lozenge');
      t.dataset.blmTone = tone;
    }
  }
  for (const t of document.querySelectorAll('#rb li.story > .type_id > .t')) {
    const text = t.textContent.trim().toLowerCase();
    if (text) ensureIcon(t, 'type', typeKind(text));
  }

  // Type field beside the summary (split view and full page): tagged only;
  // the icon is drawn by CSS on the field itself.
  for (const f of document.querySelectorAll('.work-packages--type-selector .inline-edit--display-field')) {
    const kind = typeKind(f.textContent.trim().toLowerCase());
    if (f.dataset.blmType !== kind) f.dataset.blmType = kind;
  }

  // Icons stay inside the table: in the work-package header they become extra
  // layout items, and detail priorities already carry OpenProject's own dot.
  // wp-status-button is an Angular element, not a class.
  for (const btn of document.querySelectorAll(
    'wp-status-button button, .wp-status-button button, button[class*="__hl_background_status"]'
  )) {
    const tone = statusTone(btn.textContent.trim().toLowerCase());
    if (btn.dataset.blmTone !== tone) {
      btn.classList.add('blm-jx-status');
      btn.dataset.blmTone = tone;
    }
  }
}

// The signed-in user, read once per page load, for the "Welcome back" greeting
// beside the list title.
let meName = null;
let meRequested = false;
let welcomeEl = null;   // the greeting beside the list title

function renderWelcome() {
  if (welcomeEl?.isConnected && welcomeEl.previousElementSibling?.matches('.title-container')) return;
  const host = document.querySelector('.toolbar-container .title-container');
  welcomeEl?.remove();
  welcomeEl = null;
  if (!host) return;
  welcomeEl = Object.assign(document.createElement('span'), { className: 'blm-welcome', textContent: `Welcome back, ${meName}` });
  host.after(welcomeEl);
}

function greet() {
  if (!meRequested) {
    meRequested = true;
    loadMe().then(me => {
      if (!me?.name) return;
      meName = me.name;
      schedule();
    });
  }
  if (!meName) return;
  renderWelcome();
}

function untagCells() {
  welcomeEl?.remove();
  welcomeEl = null;
  document.querySelectorAll('.blm-jx-icon').forEach(el => el.remove());
  document.querySelectorAll('[data-blm-type]').forEach(el => { delete el.dataset.blmType; });
  document.querySelectorAll('.blm-jx-lozenge, .blm-jx-status').forEach(el => {
    el.classList.remove('blm-jx-lozenge', 'blm-jx-status');
    delete el.dataset.blmTone;
  });
}

// ─── Stylesheet ─────────────────────────────────────────────────────────────────

// Glyphs are masks, so their colour comes from tokens, not the SVG.
const svg = body =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`
  )}")`;

const GLYPH = {
  story:   svg(`<path d='M5 3.5h6v9l-3-2.2-3 2.2z' fill='black'/>`),
  bug:     svg(`<circle cx='8' cy='8' r='3' fill='black' stroke='none'/>`),
  task:    svg(`<path d='M4.5 8.2 7 10.5l4.5-5'/>`),
  epic:    svg(`<path d='M9 2.5 4.5 9H8l-1 4.5L11.5 7H8z' fill='black' stroke-width='1'/>`),
  feature: svg(`<path d='M8 3.5v9M3.5 8h9'/>`),
  other:   svg(`<rect x='5' y='5' width='6' height='6' rx='1' fill='black' stroke='none'/>`),
  highest: svg(`<path d='M4 8.5 8 4.5l4 4M4 12.5l4-4 4 4'/>`),
  high:    svg(`<path d='M4 10.5l4-4 4 4'/>`),
  medium:  svg(`<path d='M3.5 6h9M3.5 10h9'/>`),
  low:     svg(`<path d='M4 5.5l4 4 4-4'/>`),
};

const CSS = `
/* Hallmark · scope: injected skin · reference: Jira (top bar, list view, issue view) · genre: modern-minimal
 * theme: studied-DNA (source: Jira) · paper #fff · accent blue
 * pre-emit critique: P4 H4 E4 S4 R5 V4
 */
html.${ROOT_CLASS}, html.${AS_CLASS}, html.${ACT_CLASS}, html.${FILES_CLASS} {
  --jx-font: ui-sans-serif, -apple-system, "Segoe UI", system-ui, Roboto, "Helvetica Neue", sans-serif;
  --jx-text: #172b4d;
  --jx-text-subtle: #44546f;
  --jx-text-subtlest: #626f86;
  --jx-link: #0c66e4;
  --jx-link-hover: #0055cc;
  --jx-surface: #ffffff;
  --jx-surface-sunken: #f7f8f9;
  --jx-hover: rgba(9, 30, 66, 0.06);
  --jx-selected: #e9f2ff;
  --jx-selected-hover: #cce0ff;
  --jx-border: rgba(9, 30, 66, 0.14);
  --jx-btn: rgba(9, 30, 66, 0.06);
  --jx-btn-hover: rgba(9, 30, 66, 0.14);
  --jx-btn-press: rgba(9, 30, 66, 0.22);
  --jx-primary: #0c66e4;
  --jx-primary-hover: #0055cc;
  --jx-primary-press: #09326c;
  --jx-on-primary: #ffffff;
  --jx-focus: #388bff;
  --jx-todo-bg: rgba(9, 30, 66, 0.08);
  --jx-todo-fg: #44546f;
  --jx-progress-bg: #e9f2ff;
  --jx-progress-fg: #0055cc;
  --jx-done-bg: #dcfff1;
  --jx-done-fg: #216e4e;
  --jx-done-bar: #22a06b;
  --jx-error: #c9372c;
  --jx-col-assignee: 200px;
  --jx-col-status: 120px;
  --jx-avatar-0: #0055cc;
  --jx-avatar-1: #216e4e;
  --jx-avatar-2: #a54800;
  --jx-avatar-3: #5e4db2;
  --jx-avatar-4: #ae2e24;
  --jx-avatar-5: #206a83;
  --jx-shadow-raised: 0 8px 12px rgba(9, 30, 66, 0.15), 0 0 1px rgba(9, 30, 66, 0.31);
  --jx-todo-bg-hover: rgba(9, 30, 66, 0.14);
  --jx-progress-bg-hover: #cce0ff;
  --jx-done-bg-hover: #baf3db;
  --jx-type-story: #22a06b;
  --jx-type-bug: #e34935;
  --jx-type-task: #1d7afc;
  --jx-type-epic: #8270db;
  --jx-type-feature: #2898bd;
  --jx-type-other: #8590a2;
  --jx-on-icon: #ffffff;
  --jx-prio-highest: #c9372c;
  --jx-prio-high: #e34935;
  --jx-prio-medium: #e2b203;
  --jx-prio-low: #1d7afc;
  --jx-radius: 3px;
  --jx-radius-panel: 6px;
  --jx-space-1: 4px;
  --jx-space-2: 8px;
  --jx-space-3: 12px;
  --jx-space-4: 16px;
  --jx-space-6: 24px;
  --jx-space-8: 32px;
  --jx-side-w: clamp(320px, 32%, 440px);
  --jx-dur: 120ms;
  --jx-ease-out: cubic-bezier(0.2, 0, 0, 1);
}

/* Top header bar: white, hairline border, grey icons (every page).
   OpenProject draws the bar from these design variables; the direct rules
   below cover builds that hard-code the colours. */
html.${ROOT_CLASS} {
  --header-bg-color: var(--jx-surface);
  --header-item-font-color: var(--jx-text-subtle);
  --header-item-font-hover-color: var(--jx-text);
  --header-item-bg-hover-color: var(--jx-btn-hover);
  --header-border-bottom-color: var(--jx-border);
  --header-border-bottom-width: 1px;
  --header-search-field-bg-color: var(--jx-surface);
  --header-search-field-font-color: var(--jx-text);
  --header-search-field-border: none;   /* the frame is drawn once, on .top-menu-search--input */
}
html.${ROOT_CLASS} .op-app-header,
html.${ROOT_CLASS} #top-menu {
  background: var(--jx-surface) !important;
  border-bottom: 1px solid var(--jx-border) !important;
  box-shadow: none !important;
  font-family: var(--jx-font);
}
html.${ROOT_CLASS} .op-app-header a,
html.${ROOT_CLASS} .op-app-header button,
html.${ROOT_CLASS} .op-app-header .op-app-menu--item-action,
html.${ROOT_CLASS} .op-app-header .op-app-header--primer-button,
html.${ROOT_CLASS} .op-app-header [class*="icon"],
html.${ROOT_CLASS} .op-app-header svg,
html.${ROOT_CLASS} #top-menu a,
html.${ROOT_CLASS} #top-menu button,
html.${ROOT_CLASS} #top-menu [class*="icon"] {
  color: var(--jx-text-subtle) !important;
  fill: currentColor;
  font-family: var(--jx-font);
}
html.${ROOT_CLASS} .op-app-header .op-app-menu--item-action,
html.${ROOT_CLASS} .op-app-header .op-app-header--primer-button,
html.${ROOT_CLASS} #top-menu .op-app-menu--item-action {
  border-radius: var(--jx-radius);
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${ROOT_CLASS} .op-app-header .op-app-menu--item-action:hover,
html.${ROOT_CLASS} .op-app-header .op-app-header--primer-button:hover,
html.${ROOT_CLASS} #top-menu .op-app-menu--item-action:hover {
  background: var(--jx-btn-hover) !important;
  color: var(--jx-text) !important;
}
html.${ROOT_CLASS} .op-app-header a:focus-visible,
html.${ROOT_CLASS} .op-app-header button:focus-visible {
  outline: 2px solid var(--jx-focus); outline-offset: 2px;
}
/* The green quick-add "+" becomes Jira's blue Create */
html.${ROOT_CLASS} .op-app-header .op-quick-add-menu--icon,
html.${ROOT_CLASS} .op-app-header .op-quick-add-menu [class*="icon"],
html.${ROOT_CLASS} #top-menu .op-quick-add-menu--icon {
  color: var(--jx-primary) !important;
}
/* Search: a single Jira-style field. The frame is OpenProject's search wrapper;
   everything inside it (the input, its select box, the search button) is
   borderless, so there is no box inside a box. */
html.${ROOT_CLASS} .top-menu-search--input {
  display: flex !important; align-items: center; gap: var(--jx-space-1);
  box-sizing: border-box; height: 32px !important; min-width: 200px;
  padding: 0 var(--jx-space-1) 0 var(--jx-space-2) !important;
  background: var(--jx-surface) !important;
  border: 2px solid var(--jx-border) !important; border-radius: var(--jx-radius) !important;
  box-shadow: none !important; font-family: var(--jx-font);
  transition: border-color var(--jx-dur) var(--jx-ease-out);
}
html.${ROOT_CLASS} .top-menu-search--input:hover { border-color: var(--jx-btn-press) !important; }
html.${ROOT_CLASS} .top-menu-search--input:focus-within { border-color: var(--jx-focus) !important; }
html.${ROOT_CLASS} .top-menu-search--input *,
html.${ROOT_CLASS} .top-menu-search--input input {
  border: 0 !important; box-shadow: none !important; outline: none !important;
  background: transparent !important;
}
html.${ROOT_CLASS} .top-menu-search--input input {
  flex: 1 1 auto; min-width: 0; height: 28px !important; padding: 0 !important; margin: 0 !important;
  color: var(--jx-text) !important; font-family: var(--jx-font); font-size: 14px;
}
html.${ROOT_CLASS} .top-menu-search--input input::placeholder { color: var(--jx-text-subtlest); }
html.${ROOT_CLASS} .top-menu-search--input .ng-select,
html.${ROOT_CLASS} .top-menu-search--input .ng-select-container {
  flex: 1 1 auto; min-width: 0; min-height: 0 !important; height: 28px !important;
}
html.${ROOT_CLASS} .top-menu-search--input button,
html.${ROOT_CLASS} .top-menu-search--input .top-menu-search--button {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0 !important; margin: 0 !important;
  border-radius: var(--jx-radius) !important; color: var(--jx-text-subtle) !important; cursor: pointer;
}
html.${ROOT_CLASS} .top-menu-search--input button:hover { background: var(--jx-btn-hover) !important; color: var(--jx-text) !important; }
html.${ROOT_CLASS} .top-menu-search--input button:focus-visible { outline: 2px solid var(--jx-focus) !important; outline-offset: 1px; }

/* Left sidebar (main menu): light, grey items, blue-tinted current page.
   Driven by OpenProject's main-menu design variables, like the top bar. */
html.${ROOT_CLASS} {
  --main-menu-bg-color: var(--jx-surface-sunken);
  --main-menu-bg-selected-background: var(--jx-selected);
  --main-menu-bg-hover-background: var(--jx-hover);
  --main-menu-font-color: var(--jx-text-subtle);
  --main-menu-selected-font-color: var(--jx-link-hover);
  --main-menu-hover-font-color: var(--jx-text);
  --main-menu-border-color: var(--jx-border);
  --main-menu-border-width: 1px;
  --main-menu-sidebar-font-color: var(--jx-text-subtle);
  --main-menu-sidebar-h3-color: var(--jx-text-subtlest);
  --main-menu-sidebar-h3-border-top-color: var(--jx-border);
  --main-menu-sidebar-link-color: var(--jx-text-subtle);
  --main-menu-resizer-color: var(--jx-border);
  --main-menu-fieldset-header-color: var(--jx-text-subtlest);
}
html.${ROOT_CLASS} #main-menu {
  background: var(--jx-surface-sunken) !important;
  border-right: 1px solid var(--jx-border) !important;
  font-family: var(--jx-font);
}
html.${ROOT_CLASS} #main-menu a,
html.${ROOT_CLASS} #main-menu [class*="icon"],
html.${ROOT_CLASS} #main-menu .menu-item--title {
  color: var(--jx-text-subtle) !important;
}
html.${ROOT_CLASS} #main-menu a {
  font-size: 14px; font-weight: 500; border-radius: var(--jx-radius);
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${ROOT_CLASS} #main-menu a:hover {
  background: var(--jx-hover) !important; color: var(--jx-text) !important;
}
html.${ROOT_CLASS} #main-menu a:hover [class*="icon"] { color: var(--jx-text) !important; }
html.${ROOT_CLASS} #main-menu a.selected,
html.${ROOT_CLASS} #main-menu .selected > a,
html.${ROOT_CLASS} #main-menu a.selected:hover {
  background: var(--jx-selected) !important; color: var(--jx-link-hover) !important;
  box-shadow: inset 2px 0 0 var(--jx-link);
}
html.${ROOT_CLASS} #main-menu a.selected [class*="icon"],
html.${ROOT_CLASS} #main-menu .selected > a [class*="icon"] { color: var(--jx-link-hover) !important; }
html.${ROOT_CLASS} #main-menu a:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: -2px; }
html.${ROOT_CLASS} #main-menu input[type="text"],
html.${ROOT_CLASS} #main-menu input[type="search"] {
  background: var(--jx-surface) !important; color: var(--jx-text) !important;
  border: 2px solid var(--jx-border) !important; border-radius: var(--jx-radius) !important;
  box-shadow: none !important;
}
html.${ROOT_CLASS} #main-menu input:focus { border-color: var(--jx-focus) !important; outline: none; }
html.${ROOT_CLASS} #main-menu h3,
html.${ROOT_CLASS} #main-menu .op-sidemenu--title {
  color: var(--jx-text-subtlest) !important; font-size: 11px; font-weight: 700;
  letter-spacing: 0.03em; text-transform: uppercase;
}

/* Page title and toolbar */
html.${WP_CLASS} .toolbar-container,
html.${WP_CLASS} #toolbar { font-family: var(--jx-font); }
html.${WP_CLASS} .toolbar-container .title-container,
html.${WP_CLASS} .toolbar-container .title-container *,
html.${WP_CLASS} .toolbar-container h2 {
  font-family: var(--jx-font); font-size: 24px; font-weight: 500;
  font-style: normal; letter-spacing: -0.01em; color: var(--jx-text);
}

html.${WP_CLASS} .toolbar-items .button,
html.${WP_CLASS} .toolbar-container .button {
  font-family: var(--jx-font); font-size: 14px; font-weight: 500;
  height: 32px; min-height: 32px; padding: 0 10px; border: 0;
  border-radius: var(--jx-radius); background: var(--jx-btn);
  color: var(--jx-text-subtle); box-shadow: none; white-space: nowrap;
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${WP_CLASS} .toolbar-items .button:hover,
html.${WP_CLASS} .toolbar-container .button:hover { background: var(--jx-btn-hover); color: var(--jx-text); }
html.${WP_CLASS} .toolbar-items .button:active,
html.${WP_CLASS} .toolbar-container .button:active { background: var(--jx-btn-press); }
html.${WP_CLASS} .toolbar-items .button.-active,
html.${WP_CLASS} .toolbar-container .button.-active { background: var(--jx-selected); color: var(--jx-link-hover); }
html.${WP_CLASS} .toolbar-items .button:disabled,
html.${WP_CLASS} .toolbar-items .button.-disabled { opacity: 0.5; cursor: not-allowed; }
html.${WP_CLASS} .toolbar-items .button .button--icon,
html.${WP_CLASS} .toolbar-items .button .icon { color: inherit; }
html.${WP_CLASS} .toolbar-items .button.-alt-highlight,
html.${WP_CLASS} .toolbar-items .button.-highlight,
html.${WP_CLASS} .toolbar-items .button.-primary {
  background: var(--jx-primary); color: var(--jx-on-primary);
}
html.${WP_CLASS} .toolbar-items .button.-alt-highlight:hover,
html.${WP_CLASS} .toolbar-items .button.-highlight:hover,
html.${WP_CLASS} .toolbar-items .button.-primary:hover { background: var(--jx-primary-hover); color: var(--jx-on-primary); }
html.${WP_CLASS} .toolbar-items .button.-alt-highlight:active,
html.${WP_CLASS} .toolbar-items .button.-highlight:active,
html.${WP_CLASS} .toolbar-items .button.-primary:active { background: var(--jx-primary-press); }
html.${WP_CLASS} .toolbar-items .button .badge {
  background: var(--jx-text-subtle); color: var(--jx-on-primary);
  border-radius: 8px; font-size: 11px; font-weight: 700; padding: 0 5px; margin-left: 4px;
}
html.${WP_CLASS} .toolbar-items .button:focus-visible,
html.${WP_CLASS} .toolbar-container .button:focus-visible {
  outline: 2px solid var(--jx-focus); outline-offset: 2px;
}

/* Table */
html.${WP_CLASS} .work-package-table {
  font-family: var(--jx-font); font-size: 14px; color: var(--jx-text);
  background: var(--jx-surface); border-collapse: separate; border-spacing: 0;
}
html.${WP_CLASS} .work-package-table thead th {
  background: var(--jx-surface); border: 0; border-bottom: 1px solid var(--jx-border);
  height: 36px; padding: 0 8px; vertical-align: middle;
}
/* One continuous hairline: OpenProject's own per-column underlines would show as dashes */
html.${WP_CLASS} .work-package-table thead th *,
html.${WP_CLASS} .work-package-table thead th *::before,
html.${WP_CLASS} .work-package-table thead th *::after { border-bottom: 0; box-shadow: none; }
html.${WP_CLASS} .work-package-table thead th,
html.${WP_CLASS} .work-package-table thead th a,
html.${WP_CLASS} .work-package-table thead th span {
  font-family: var(--jx-font); font-size: 12px; font-weight: 600;
  text-transform: none; letter-spacing: 0; color: var(--jx-text-subtlest);
}
html.${WP_CLASS} .work-package-table thead th a:hover { color: var(--jx-text); text-decoration: none; }

html.${WP_CLASS} .work-package-table tbody td {
  height: 40px; padding: 0 8px; vertical-align: middle;
  border: 0; border-bottom: 1px solid var(--jx-border);
  background: transparent; color: var(--jx-text);
}
html.${WP_CLASS} .work-package-table tbody tr.wp-table--row:hover > td { background: var(--jx-hover); }
html.${WP_CLASS} .work-package-table tbody tr.wp-table--row.-checked > td { background: var(--jx-selected); }
html.${WP_CLASS} .work-package-table tbody tr.wp-table--row.-checked:hover > td { background: var(--jx-selected-hover); }

/* Key and subject */
html.${WP_CLASS} .work-package-table td.id a {
  color: var(--jx-link); font-weight: 500; text-decoration: none;
  font-variant-numeric: tabular-nums;
}
html.${WP_CLASS} .work-package-table td.id a:hover { color: var(--jx-link-hover); text-decoration: underline; }
html.${WP_CLASS} .work-package-table td.subject,
html.${WP_CLASS} .work-package-table td.subject * { color: var(--jx-text); font-weight: 400; }

/* Quieter columns */
html.${WP_CLASS} .work-package-table td.priority *,
html.${WP_CLASS} .work-package-table td.type *,
html.${WP_CLASS} .work-package-table td.version *,
html.${WP_CLASS} .work-package-table td[class*="customField"] * { color: var(--jx-text-subtle); }
html.${WP_CLASS} .work-package-table td.storyPoints,
html.${WP_CLASS} .work-package-table td.spentTime,
html.${WP_CLASS} .work-package-table td.estimatedTime { font-variant-numeric: tabular-nums; }
html.${WP_CLASS} .work-package-table td.spentTime a { color: var(--jx-link); }

/* Type: icon + plain label, replacing the coloured upper-case text */
html.${WP_CLASS} .work-package-table td.type * {
  text-transform: none; font-weight: 400; letter-spacing: 0;
}

/* Icons (type and priority), inserted before the cell text */
html.${ROOT_CLASS} .blm-jx-icon {
  display: inline-block; position: relative; flex: none;
  width: 16px; height: 16px; margin-right: 6px; vertical-align: -3px;
}
html.${ROOT_CLASS} .blm-jx-icon[data-type] { border-radius: var(--jx-radius); }
html.${ROOT_CLASS} .blm-jx-icon::after {
  content: ""; position: absolute; inset: 0;
  -webkit-mask: var(--jx-glyph) center / 12px no-repeat;
          mask: var(--jx-glyph) center / 12px no-repeat;
  background: var(--jx-on-icon);
}
html.${ROOT_CLASS} .blm-jx-icon[data-priority]::after { -webkit-mask-size: 16px; mask-size: 16px; }
${['story', 'bug', 'task', 'epic', 'feature', 'other'].map(k => `
html.${ROOT_CLASS} .blm-jx-icon[data-type="${k}"] { background: var(--jx-type-${k}); --jx-glyph: ${GLYPH[k]}; }`).join('')}
${['highest', 'high', 'medium', 'low'].map(k => `
html.${ROOT_CLASS} .blm-jx-icon[data-priority="${k}"] { --jx-glyph: ${GLYPH[k]}; }
html.${ROOT_CLASS} .blm-jx-icon[data-priority="${k}"]::after { background: var(--jx-prio-${k}); }`).join('')}

/* Status lozenges */
html.${WP_CLASS} .work-package-table .blm-jx-lozenge {
  display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  padding: 0 4px; border-radius: var(--jx-radius);
  font-family: var(--jx-font); font-size: 11px; font-weight: 700; line-height: 16px;
  text-transform: uppercase; letter-spacing: 0; white-space: nowrap; vertical-align: middle;
  background: var(--jx-todo-bg); color: var(--jx-todo-fg);
}
html.${WP_CLASS} .work-package-table .blm-jx-lozenge[data-blm-tone="progress"] {
  background: var(--jx-progress-bg); color: var(--jx-progress-fg);
}
html.${WP_CLASS} .work-package-table .blm-jx-lozenge[data-blm-tone="done"] {
  background: var(--jx-done-bg); color: var(--jx-done-fg);
}

/* Assignee avatars */
html.${WP_CLASS} .work-package-table td.assignee .op-principal--avatar,
html.${WP_CLASS} .work-package-table td.assignee .op-avatar,
html.${WP_CLASS} .work-package-table td.assignee img {
  box-sizing: border-box; flex: none; width: 24px; height: 24px; min-width: 24px; max-width: 24px;
  aspect-ratio: 1; border-radius: 50%; object-fit: cover; background-size: cover; background-position: center;
}
html.${WP_CLASS} .work-package-table td.assignee * { color: var(--jx-text); }

/* Group headers ("New (1)", "Specified (18)") and sum rows */
html.${WP_CLASS} .work-package-table tr.-group-header > td,
html.${WP_CLASS} .work-package-table tr[class*="group-header"] > td {
  height: 40px; background: var(--jx-surface-sunken);
  border-bottom: 1px solid var(--jx-border); padding: 0 8px;
}
html.${WP_CLASS} .work-package-table tr.-group-header .group--value,
html.${WP_CLASS} .work-package-table tr[class*="group-header"] .group--value {
  font-family: var(--jx-font); font-size: 14px; font-weight: 600; color: var(--jx-text);
}
html.${WP_CLASS} .work-package-table tr.-group-header .count,
html.${WP_CLASS} .work-package-table tr[class*="group-header"] .count {
  display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 8px;
  background: var(--jx-todo-bg); color: var(--jx-text-subtle);
  font-size: 12px; font-weight: 600; line-height: 16px; font-variant-numeric: tabular-nums;
}
html.${WP_CLASS} .work-package-table tr.-group-header .expander,
html.${WP_CLASS} .work-package-table tr[class*="group-header"] .expander { color: var(--jx-text-subtle); }
html.${WP_CLASS} .work-package-table tr[class*="sums"] > td {
  height: 32px; background: var(--jx-surface); color: var(--jx-text-subtlest);
  font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
}

/* Type and priority values: plain ink, not OpenProject's highlight colour
   (the icon carries the colour, as in Jira). */
html.${WP_CLASS} .work-package-table [class*="__hl_inline_type"],
html.${WP_CLASS} .work-package-table [class*="__hl_inline_priority"] {
  color: var(--jx-text) !important;
  text-transform: none !important; font-weight: 400 !important; letter-spacing: 0 !important;
}
html.${WP_CLASS} .work-package-table td.type [class*="__hl_inline_type"],
html.${WP_CLASS} .work-package-table td.priority [class*="__hl_inline_priority"] {
  color: var(--jx-text-subtle) !important;
}

/* Work-package view: split pane and full page */
html.${WP_CLASS} .work-packages--details,
html.${WP_CLASS} .work-packages--show-view,
html.${WP_CLASS} .work-packages-full-view--split-container,
html.${WP_CLASS} .work-packages--details-content {
  font-family: var(--jx-font); color: var(--jx-text); background: var(--jx-surface);
}
html.${WP_CLASS} .work-packages--details { border-left: 1px solid var(--jx-border); }
html.${WP_CLASS} .wp-info-wrapper .work-packages--info-row { margin-left: var(--jx-space-3); }

/* Breadcrumb, key and type above the subject */
html.${WP_CLASS} .work-packages--info-row,
html.${WP_CLASS} .work-packages--info-row *,
html.${WP_CLASS} .wp-breadcrumb,
html.${WP_CLASS} .wp-breadcrumb * {
  font-family: var(--jx-font); font-size: 14px; color: var(--jx-text-subtle);
}
html.${WP_CLASS} .work-packages--info-row a,
html.${WP_CLASS} .wp-breadcrumb a { color: var(--jx-text-subtle); text-decoration: none; }
html.${WP_CLASS} .work-packages--info-row a:hover,
html.${WP_CLASS} .wp-breadcrumb a:hover { color: var(--jx-link); text-decoration: underline; }


/* Status button: Jira's status dropdown, tinted like the list lozenges */
html.${WP_CLASS} .blm-jx-status {
  display: inline-flex !important; align-items: center; gap: var(--jx-space-2);
  height: 32px !important; min-height: 32px !important; line-height: 1 !important;
  padding: 0 var(--jx-space-2) 0 var(--jx-space-3) !important; margin: 0 !important;
  border: 0 !important; border-radius: var(--jx-radius) !important;
  box-shadow: none !important; white-space: nowrap; cursor: pointer;
  font-family: var(--jx-font) !important; font-size: 14px !important; font-weight: 500 !important;
  text-transform: none !important; letter-spacing: 0 !important;
  background: var(--jx-todo-bg) !important; color: var(--jx-todo-fg) !important;
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${WP_CLASS} .blm-jx-status:hover { background: var(--jx-todo-bg-hover) !important; }
html.${WP_CLASS} .blm-jx-status[data-blm-tone="progress"] {
  background: var(--jx-progress-bg) !important; color: var(--jx-progress-fg) !important;
}
html.${WP_CLASS} .blm-jx-status[data-blm-tone="progress"]:hover { background: var(--jx-progress-bg-hover) !important; }
html.${WP_CLASS} .blm-jx-status[data-blm-tone="done"] {
  background: var(--jx-done-bg) !important; color: var(--jx-done-fg) !important;
}
html.${WP_CLASS} .blm-jx-status[data-blm-tone="done"]:hover { background: var(--jx-done-bg-hover) !important; }
html.${WP_CLASS} .blm-jx-status:active { filter: brightness(0.92); }
html.${WP_CLASS} .blm-jx-status:disabled { opacity: 0.5; cursor: not-allowed; }
html.${WP_CLASS} .blm-jx-status * {
  color: inherit !important; font: inherit !important;
  margin: 0 !important; padding: 0 !important; line-height: 1 !important;
}
html.${WP_CLASS} .blm-jx-status .op-icon--wrapper,
html.${WP_CLASS} .blm-jx-status .button--icon {
  display: inline-flex !important; align-items: center;
  font-size: 10px !important; opacity: 0.8;
}
html.${WP_CLASS} .blm-jx-status:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 2px; }

/* Tabs (Overview, Activity, Files, Relations, Watchers) */
html.${WP_CLASS} .op-tab-row--link,
html.${WP_CLASS} .tabrow li a {
  font-family: var(--jx-font); font-size: 14px; font-weight: 500;
  color: var(--jx-text-subtle); text-transform: none; letter-spacing: 0;
  border: 0; box-shadow: none; text-decoration: none;
}
html.${WP_CLASS} .op-tab-row--link:hover,
html.${WP_CLASS} .tabrow li a:hover { color: var(--jx-text); }
html.${WP_CLASS} .op-tab-row--link_selected,
html.${WP_CLASS} .op-tab-row--link_selected:hover,
html.${WP_CLASS} .tabrow li.selected a {
  color: var(--jx-link); box-shadow: inset 0 -2px 0 var(--jx-link);
}
html.${WP_CLASS} .op-tab-row,
html.${WP_CLASS} .tabrow { border-bottom: 2px solid var(--jx-border); }

/* Attribute groups ("Details", "People", "Estimates and time") */
html.${WP_CLASS} .attributes-group--header {
  border-bottom: 1px solid var(--jx-border); margin-bottom: 8px; padding-bottom: 6px;
}
html.${WP_CLASS} .attributes-group--header-text,
html.${WP_CLASS} .attributes-group--header h3 {
  font-family: var(--jx-font); font-size: 16px !important; font-weight: 600 !important;
  font-style: normal; text-transform: none !important; letter-spacing: 0 !important;
  color: var(--jx-text);
}
html.${WP_CLASS} .attributes-key-value--key {
  font-family: var(--jx-font); font-size: 14px; font-weight: 600;
  color: var(--jx-text-subtle); text-transform: none;
}
html.${WP_CLASS} .attributes-key-value--value-container,
html.${WP_CLASS} .attributes-key-value--value-container * {
  font-family: var(--jx-font); font-size: 14px; color: var(--jx-text);
}
html.${WP_CLASS} .attributes-key-value--value-container .inline-edit--display-field {
  border-radius: var(--jx-radius);
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${WP_CLASS} .attributes-key-value--value-container .inline-edit--display-field:hover {
  background: var(--jx-hover);
}
html.${WP_CLASS} .attributes-key-value--value-container a { color: var(--jx-link); }

/* Description and comments */
html.${WP_CLASS} .work-packages--details .op-uc-container,
html.${WP_CLASS} .work-packages--show-view .op-uc-container {
  font-family: var(--jx-font); font-size: 14px; line-height: 1.714; color: var(--jx-text);
}
html.${WP_CLASS} .op-user-activity--user-name,
html.${WP_CLASS} .user-comment--user { font-weight: 600; color: var(--jx-text); }
html.${WP_CLASS} .op-user-activity--date,
html.${WP_CLASS} .user-comment--date { color: var(--jx-text-subtlest); }

/* ── Full work-package page laid out like Jira's issue view ─────────────────
   OpenProject: left = status, description, attribute groups; right = tabs.
   Jira:        left = summary, description, activity; right = status + Details.
   arrangeFullView() moves the status block and the attribute groups into
   aside.blm-jx-side; the split container becomes a two-column grid. */
html.${WP_CLASS} .work-packages--show-view .work-packages-full-view--split-container {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) var(--jx-side-w);
  grid-template-rows: auto 1fr;
  column-gap: var(--jx-space-8);
  align-items: start;
  overflow-y: auto !important;
  padding: 0 var(--jx-space-6) var(--jx-space-6);
}
html.${WP_CLASS} .work-packages--show-view .work-packages-full-view--split-left,
html.${WP_CLASS} .work-packages--show-view .work-packages-full-view--split-right,
html.${WP_CLASS} .work-packages--show-view .work-packages--panel-inner,
html.${WP_CLASS} .work-packages--show-view wp-single-view,
html.${WP_CLASS} .work-packages--show-view .work-package--single-view {
  display: block !important;
  position: static !important;
  width: auto !important; max-width: none !important; min-width: 0 !important;
  height: auto !important; overflow: visible !important;
  flex: none !important; border: 0 !important; padding: 0 !important; margin: 0 !important;
}
html.${WP_CLASS} .work-packages--show-view .work-packages-full-view--split-left { grid-column: 1; grid-row: 1; }
html.${WP_CLASS} .work-packages--show-view .work-packages-full-view--split-right { grid-column: 1; grid-row: 2; }
html.${WP_CLASS} .work-packages--show-view .work-packages-full-view--resizer { display: none !important; }

/* Right column: status, then one panel per attribute group */
html.${WP_CLASS} .blm-jx-side {
  grid-column: 2; grid-row: 1 / span 2;
  display: flex; flex-direction: column; gap: var(--jx-space-3);
  min-width: 0; padding-top: var(--jx-space-4);
}
html.${WP_CLASS} .blm-jx-side .wp-info-wrapper {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--jx-space-2);
  margin: 0 !important; padding: 0 !important;
}
html.${WP_CLASS} .blm-jx-side .work-packages--info-row {
  flex-basis: 100%; order: 2; margin: 0 !important;
  font-size: 12px; line-height: 1.33; color: var(--jx-text-subtlest);
}
html.${WP_CLASS} .blm-jx-side .work-packages--info-row * {
  font-size: 12px; color: var(--jx-text-subtlest);
}
html.${WP_CLASS} .blm-jx-side .attributes-group {
  margin: 0 !important; padding: 0 !important;
  border: 1px solid var(--jx-border); border-radius: var(--jx-radius-panel);
  background: var(--jx-surface);
}
html.${WP_CLASS} .blm-jx-side .attributes-group--header {
  margin: 0 !important; padding: var(--jx-space-3) var(--jx-space-4) !important;
  border-bottom: 1px solid var(--jx-border);
}
html.${WP_CLASS} .blm-jx-side .wp-attribute-group {
  display: block !important; columns: auto !important;
  margin: 0 !important; padding: var(--jx-space-2) var(--jx-space-4) var(--jx-space-3) !important;
}
html.${WP_CLASS} .blm-jx-side .attributes-key-value {
  display: flex !important; align-items: flex-start; gap: var(--jx-space-3);
  width: auto !important; max-width: none !important;
  margin: 0 !important; padding: var(--jx-space-1) 0 !important;
}
html.${WP_CLASS} .blm-jx-side .attributes-key-value--key {
  flex: 0 0 40%; min-width: 0; max-width: none !important;
  margin: 0 !important; padding: var(--jx-space-1) 0 0 !important;
  overflow-wrap: anywhere;
}
html.${WP_CLASS} .blm-jx-side .attributes-key-value--value-container {
  flex: 1 1 auto; min-width: 0; width: auto !important; max-width: none !important;
  margin: 0 !important;
}

/* Left column: description, then activity */
html.${WP_CLASS} .work-packages--show-view .description-group {
  margin: 0 !important; padding: var(--jx-space-4) 0 0 !important;
}
html.${WP_CLASS} .work-packages--show-view .description-group::before,
html.${WP_CLASS} .work-packages--show-view op-wp-tabs::before {
  display: block; margin-bottom: var(--jx-space-2);
  font-family: var(--jx-font); font-size: 16px; font-weight: 600; color: var(--jx-text);
}
html.${WP_CLASS} .work-packages--show-view .description-group::before { content: "Description"; }
html.${WP_CLASS} .work-packages--show-view .description-group .op-uc-container { padding: 0 !important; }
html.${WP_CLASS} .work-packages--show-view op-wp-tabs { display: block; padding-top: var(--jx-space-6); }
html.${WP_CLASS} .work-packages--show-view op-wp-tabs::before { content: "Activity"; }
html.${WP_CLASS} .work-packages--show-view .tabcontent { padding: var(--jx-space-4) 0 0 !important; }

/* Header: back · type · summary on one line, actions to the right */
html.${WP_CLASS} .work-packages--show-view .toolbar-container {
  padding: var(--jx-space-2) var(--jx-space-6) 0;
  border-bottom: 0 !important;
}
html.${WP_CLASS} .work-packages--show-view wp-breadcrumb { display: block; padding: var(--jx-space-1) var(--jx-space-6) 0; line-height: 1; }
html.${WP_CLASS} .work-packages--show-view wp-breadcrumb :is(.op-wp-breadcrumb, .wp-breadcrumb, ul, li, div) { margin: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; min-height: 0 !important; }html.${WP_CLASS} .work-packages--show-view .wp-show--header-container {
  display: flex; align-items: center; gap: var(--jx-space-3); min-width: 0;
}
html.${WP_CLASS} .work-packages--show-view .subject-header { flex: 1 1 auto; min-width: 0; }
/* Type marker and summary centred on one line, in the split view and the full page */
html.${WP_CLASS} .work-packages--subject-type-row {
  display: flex !important; align-items: center; gap: var(--jx-space-2); min-width: 0;
}
/* The wrappers OpenProject puts around the type and the summary centre their
   content and add no vertical offset, so the two line up whatever the markup.
   The innermost divs (read view / editor) keep OpenProject's own display, which
   is what hides the read view while the summary or type is being edited. */
html.${WP_CLASS} .work-packages--subject-type-row > .work-packages--subject-element,
html.${WP_CLASS} .work-packages--subject-type-row op-editable-attribute-field,
html.${WP_CLASS} .work-packages--subject-type-row .inline-edit--container {
  display: flex !important; align-items: center !important; min-width: 0;
  margin-top: 0 !important; margin-bottom: 0 !important;
  padding-top: 0 !important; padding-bottom: 0 !important;
  top: auto !important; vertical-align: middle !important;
}
html.${WP_CLASS} .work-packages--subject-type-row .inline-edit--container > div {
  margin-top: 0 !important; margin-bottom: 0 !important; min-width: 0;
}
html.${WP_CLASS} .work-packages--subject-type-row > .work-packages--type-selector { flex: none; }
/* While the type is being edited, its select needs room: a flex item with
   min-width 0 would otherwise collapse it (and its drop-down) to nothing.
   OpenProject's drop-down panel may be placed inside this row; nothing above
   targets it (only the two known children are flexed), so it keeps its layout. */
html.${WP_CLASS} .work-packages--subject-type-row > .work-packages--type-selector:has(.ng-select, select) .inline-edit--container > div:has(.ng-select, select) {
  min-width: 200px !important; flex: 0 0 auto;
}
html.${WP_CLASS} .work-packages--subject-type-row .work-packages--type-selector .ng-select { min-width: 200px; }
/* OpenProject appends the type's drop-down panel to this row: keep it a plain
   block so its options list lays out normally. */
html.${WP_CLASS} .work-packages--subject-type-row > .ng-dropdown-panel { display: block !important; }
/* The summary takes the rest of the line, so its editor is full width. */
html.${WP_CLASS} .work-packages--subject-type-row > .work-packages--details--subject,
html.${WP_CLASS} .work-packages--subject-type-row .work-packages--details--subject op-editable-attribute-field,
html.${WP_CLASS} .work-packages--subject-type-row .inline-edit--container.work-packages--details--subject,
html.${WP_CLASS} .work-packages--subject-type-row .inline-edit--container.work-packages--details--subject > div {
  flex: 1 1 auto; width: 100%;
}
html.${WP_CLASS} .work-packages--subject-type-row .work-packages--details--subject input {
  width: 100% !important; box-sizing: border-box;
}
/* Type next to the summary: Jira's icon + grey label. Drawn with pseudo-elements
   on OpenProject's own field, so it stays clickable and the row keeps its layout. */
html.${WP_CLASS} .work-packages--type-selector .inline-edit--display-field[data-blm-type] {
  position: relative;   /* display left to OpenProject: it hides this while the type is edited */
  font-family: var(--jx-font) !important; font-size: 14px !important; font-weight: 500 !important;
  line-height: 16px !important; text-transform: none !important; letter-spacing: 0 !important;
  white-space: nowrap; color: var(--jx-text-subtle) !important;
}
html.${WP_CLASS} .work-packages--type-selector .inline-edit--display-field[data-blm-type],
html.${WP_CLASS} .work-packages--type-selector .inline-edit--display-field[data-blm-type]:focus {
  border: 0 !important; outline: 0; box-shadow: none !important; background: transparent !important;
  border-radius: var(--jx-radius); padding: var(--jx-space-1) var(--jx-space-2) var(--jx-space-1) 30px !important;
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${WP_CLASS} .inline-edit--container.work-packages--type-selector:not(:focus-within),
html.${WP_CLASS} .inline-edit--container.work-packages--type-selector:not(:focus-within) > div {
  border-color: transparent !important; box-shadow: none !important; background: transparent !important;
}
html.${WP_CLASS} .work-packages--type-selector .inline-edit--display-field[data-blm-type]:hover {
  background: var(--jx-hover) !important; color: var(--jx-text) !important;
}
html.${WP_CLASS} .work-packages--type-selector .inline-edit--display-field[data-blm-type]:focus-visible {
  outline: 2px solid var(--jx-focus); outline-offset: 2px;
}
html.${WP_CLASS} .work-packages--type-selector .inline-edit--display-field[data-blm-type]::before,
html.${WP_CLASS} .work-packages--type-selector .inline-edit--display-field[data-blm-type]::after {
  content: ""; position: absolute; left: var(--jx-space-2); top: 50%;
  width: 16px; height: 16px; margin-top: -8px; border-radius: var(--jx-radius);
}
html.${WP_CLASS} .work-packages--type-selector .inline-edit--display-field[data-blm-type]::before {
  background: var(--jx-type-c);
}
html.${WP_CLASS} .work-packages--type-selector .inline-edit--display-field[data-blm-type]::after {
  -webkit-mask: var(--jx-glyph) center / 12px no-repeat;
          mask: var(--jx-glyph) center / 12px no-repeat;
  background: var(--jx-on-icon);
}
${['story', 'bug', 'task', 'epic', 'feature', 'other'].map(k => `
html.${WP_CLASS} .work-packages--type-selector .inline-edit--display-field[data-blm-type="${k}"] { --jx-type-c: var(--jx-type-${k}); --jx-glyph: ${GLYPH[k]}; }`).join('')}
html.${WP_CLASS} .work-packages--show-view .work-packages--details--subject .inline-edit--display-field.subject {
  font-family: var(--jx-font); font-size: 24px !important; font-weight: 500 !important;
  font-style: normal; line-height: 1.25; letter-spacing: -0.01em; color: var(--jx-text);
  overflow-wrap: anywhere;
}
html.${WP_CLASS} .work-packages--show-view .op-back-button {
  width: 32px; height: 32px; padding: 0; justify-content: center;
}

/* Narrow windows: one column, sidebar between description and activity */
@media (max-width: 1011px) {
  html.${WP_CLASS} .work-packages--show-view .work-packages-full-view--split-container {
    grid-template-columns: minmax(0, 1fr); grid-template-rows: none;
    padding: 0 var(--jx-space-4) var(--jx-space-4);
  }
  html.${WP_CLASS} .blm-jx-side { grid-column: 1; grid-row: 2; }
  html.${WP_CLASS} .work-packages--show-view .work-packages-full-view--split-right { grid-row: 3; }
}

/* ── Backlogs page laid out like Jira's backlog ─────────────────────────────
   Each version is a grey sprint container holding a white list of rows:
   type icon · key · summary · status lozenge · story-point pill. */
html.${BL_CLASS} .toolbar-container .title-container h2 {
  font-family: var(--jx-font); font-size: 24px; font-weight: 500; font-style: normal;
  letter-spacing: -0.01em; color: var(--jx-text);
}
html.${BL_CLASS} #rb { font-family: var(--jx-font); font-size: 14px; color: var(--jx-text); }
html.${BL_CLASS} #rb li.story > .id,
html.${BL_CLASS} #rb li.story > .id *,
html.${BL_CLASS} #rb li.story > .subject,
html.${BL_CLASS} #rb li.story > .subject * {
  font-family: var(--jx-font); font-size: 14px; line-height: 20px;
}
html.${BL_CLASS} #rb .backlog {
  background: var(--jx-surface-sunken) !important;
  border: 0 !important; border-radius: var(--jx-radius-panel);
  padding: var(--jx-space-2) !important; margin: 0 0 var(--jx-space-4) !important;
  box-shadow: none !important;
}

/* Sprint header: chevron · name · dates … velocity */
html.${BL_CLASS} #rb .backlog > .header {
  display: flex !important; align-items: center; gap: var(--jx-space-2);
  min-height: 32px; padding: 0 var(--jx-space-2) var(--jx-space-2) !important;
  background: transparent !important; border: 0 !important; color: var(--jx-text);
}
html.${BL_CLASS} #rb .backlog > .header .toggler {
  flex: none; float: none !important; color: var(--jx-text-subtle); cursor: pointer;
}
html.${BL_CLASS} #rb .backlog > .header .sprint {
  flex: 1 1 auto; min-width: 0; float: none !important;
  display: flex !important; align-items: center;
}
html.${BL_CLASS} #rb .backlog > .header .sprint .show {
  display: flex !important; align-items: center; gap: var(--jx-space-3);
  flex: 1 1 auto; min-width: 0; float: none !important;
}
html.${BL_CLASS} #rb .backlog > .header .sprint .name {
  order: 1; flex: 0 1 auto; min-width: 0; float: none !important;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 14px; font-weight: 600; color: var(--jx-text);
}
html.${BL_CLASS} #rb .backlog > .header .sprint .start_date { order: 2; }
html.${BL_CLASS} #rb .backlog > .header .sprint .effective_date { order: 3; }
html.${BL_CLASS} #rb .backlog > .header .sprint .date {
  float: none !important; width: auto !important;
  font-size: 12px; font-weight: 400; color: var(--jx-text-subtlest);
  font-variant-numeric: tabular-nums;
}
html.${BL_CLASS} #rb .backlog > .header .sprint .start_date:not(:empty)::after {
  content: "–"; margin-left: var(--jx-space-3); color: var(--jx-text-subtlest);
}
html.${BL_CLASS} #rb .backlog > .header .sprint .date:empty { display: none !important; }
html.${BL_CLASS} #rb .backlog > .header .sprint .id { display: none !important; }
html.${BL_CLASS} #rb .backlog > .header .velocity {
  flex: none; float: none !important;
  display: inline-flex; align-items: center; gap: var(--jx-space-1);
  padding: 0 var(--jx-space-2); border-radius: 8px;
  background: var(--jx-todo-bg); color: var(--jx-text-subtle);
  font-size: 12px; font-weight: 600; line-height: 20px; font-variant-numeric: tabular-nums;
}

/* Rows */
html.${BL_CLASS} #rb ul.stories {
  margin: 0 !important; padding: 0 !important; list-style: none;
  background: var(--jx-surface); border: 1px solid var(--jx-border);
  border-radius: var(--jx-radius); overflow: hidden;
}
html.${BL_CLASS} #rb li.story {
  display: flex !important; align-items: center; gap: var(--jx-space-3);
  min-height: 40px; padding: 0 var(--jx-space-3) !important; margin: 0 !important;
  background: var(--jx-surface) !important; color: var(--jx-text);
  border: 0 !important; border-bottom: 1px solid var(--jx-border) !important;
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${BL_CLASS} #rb li.story:last-child { border-bottom: 0 !important; }
html.${BL_CLASS} #rb li.story:hover { background: var(--jx-hover) !important; }
html.${BL_CLASS} #rb li.story > * {
  order: 3; float: none !important; position: static;
  width: auto !important; margin: 0 !important;
}
html.${BL_CLASS} #rb li.story > .type_id { order: 1; flex: none; }
html.${BL_CLASS} #rb li.story > .id { order: 2; flex: none; min-width: 56px; }
html.${BL_CLASS} #rb li.story > .subject {
  order: 3; flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
html.${BL_CLASS} #rb li.story > .status_id { order: 4; flex: none; }
html.${BL_CLASS} #rb li.story > .story_points { order: 5; flex: none; }
html.${BL_CLASS} #rb li.story .id a {
  color: var(--jx-text-subtle); font-weight: 500; text-decoration: none;
  font-variant-numeric: tabular-nums;
}
html.${BL_CLASS} #rb li.story .id a:hover { color: var(--jx-link); text-decoration: underline; }
html.${BL_CLASS} #rb li.story .id a:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 2px; }
html.${BL_CLASS} #rb li.story.closed,
html.${BL_CLASS} #rb li.story.closed * { text-decoration: none !important; }

/* Type: icon only, as in Jira (the label stays for screen readers) */
html.${BL_CLASS} #rb li.story > .type_id {
  display: inline-flex !important; align-items: center;
}
html.${BL_CLASS} #rb li.story > .type_id .blm-jx-icon { margin-right: 0; vertical-align: middle; }
html.${BL_CLASS} #rb li.story > .type_id:has(.blm-jx-icon) > .t {
  position: absolute !important; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap;
}

/* Status lozenge and story-point pill */
html.${BL_CLASS} #rb li.story .blm-jx-lozenge {
  display: inline-block; max-width: 160px; overflow: hidden; text-overflow: ellipsis;
  padding: 0 4px; border-radius: var(--jx-radius);
  font-size: 11px; font-weight: 700; line-height: 16px;
  text-transform: uppercase; white-space: nowrap; vertical-align: middle;
  background: var(--jx-todo-bg); color: var(--jx-todo-fg);
}
html.${BL_CLASS} #rb li.story .blm-jx-lozenge[data-blm-tone="progress"] {
  background: var(--jx-progress-bg); color: var(--jx-progress-fg);
}
html.${BL_CLASS} #rb li.story .blm-jx-lozenge[data-blm-tone="done"] {
  background: var(--jx-done-bg); color: var(--jx-done-fg);
}
html.${BL_CLASS} #rb li.story > .story_points {
  min-width: 24px; text-align: center;
}
html.${BL_CLASS} #rb li.story > .story_points .t:not(:empty) {
  display: inline-block; min-width: 24px; padding: 0 6px; box-sizing: border-box;
  border-radius: 8px; background: var(--jx-todo-bg); color: var(--jx-text-subtle);
  font-size: 12px; font-weight: 600; line-height: 16px; text-align: center;
  font-variant-numeric: tabular-nums;
}

/* Child work items: a section under the description (full page and split view),
   as in Jira's issue view; OpenProject keeps them in the Relations tab.
   Built by renderChildren(); the assignee button opens the picker. */
html.${WP_CLASS} .blm-jx-children { padding-top: var(--jx-space-6); }
html.${WP_CLASS} .blm-jx-jump {
  position: fixed; right: 32px; bottom: 72px; z-index: 50;
  padding: 8px 14px; border: 0; border-radius: 999px; cursor: pointer;
  font: 600 13px/16px var(--jx-font); color: #fff; background: var(--jx-primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
html.${WP_CLASS} .blm-jx-jump:hover { filter: brightness(1.1); }
html.${WP_CLASS} .blm-jx-jump:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 2px; }
html.${WP_CLASS} .blm-jx-children-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--jx-space-3);
  margin-bottom: var(--jx-space-2);
}
html.${WP_CLASS} .blm-jx-children-title {
  font-family: var(--jx-font); font-size: 16px; font-weight: 600; font-style: normal;
  color: var(--jx-text); margin: 0;
}
html.${WP_CLASS} .blm-jx-children-sum {
  margin-left: auto;
  font-size: 12px; color: var(--jx-text-subtlest); font-variant-numeric: tabular-nums; white-space: nowrap;
}
html.${WP_CLASS} .blm-jx-children-actions { display: inline-flex; gap: var(--jx-space-1); margin-left: var(--jx-space-2); }
html.${WP_CLASS} .blm-jx-children-head { flex-wrap: wrap; }
html.${WP_CLASS} .blm-jx-children-note { flex-basis: 100%; font-size: 12px; color: var(--jx-error); text-align: right; }
html.${WP_CLASS} .blm-jx-children-action {
  height: 28px; padding: 0 var(--jx-space-2); margin: 0; border: 0; border-radius: var(--jx-radius); cursor: pointer;
  background: transparent; color: var(--jx-text-subtle); font-family: var(--jx-font); font-size: 13px; font-weight: 500;
  white-space: nowrap; transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${WP_CLASS} .blm-jx-children-action:hover { background: var(--jx-btn-hover); color: var(--jx-text); }
html.${WP_CLASS} .blm-jx-children-action:active { background: var(--jx-btn-press); }
html.${WP_CLASS} .blm-jx-children-action:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 1px; }
/* Relations tab: the children are listed in Child work items, so its Children
   heading and table are hidden; OpenProject's create / add-existing controls stay. */
html.${WP_CLASS} wp-relations-hierarchy .wp-relations--children > .attributes-group--header,
html.${WP_CLASS} wp-relations-hierarchy .wp-relations--children table.work-package-table,
html.${WP_CLASS} wp-relations-hierarchy .wp-relations--children .work-package-table { display: none !important; }
/* New-item row for + Create child */
html.${WP_CLASS} .blm-jx-children li.blm-jx-create-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--jx-space-2);
  padding: var(--jx-space-2) var(--jx-space-3); background: var(--jx-surface-sunken);
}
html.${WP_CLASS} .blm-jx-create-type,
html.${WP_CLASS} .blm-jx-create-input {
  height: 32px; box-sizing: border-box; margin: 0; padding: 0 var(--jx-space-2);
  border: 2px solid var(--jx-border); border-radius: var(--jx-radius);
  background: var(--jx-surface); color: var(--jx-text); font-family: var(--jx-font); font-size: 14px;
}
html.${WP_CLASS} .blm-jx-create-type { flex: none; max-width: 140px; }
html.${WP_CLASS} .blm-jx-create-input { flex: 1 1 200px; min-width: 0; }
html.${WP_CLASS} .blm-jx-create-type:focus,
html.${WP_CLASS} .blm-jx-create-input:focus { border-color: var(--jx-focus); outline: none; }
html.${WP_CLASS} .blm-jx-create-go,
html.${WP_CLASS} .blm-jx-create-cancel {
  height: 32px; padding: 0 var(--jx-space-3); margin: 0; border: 0; border-radius: var(--jx-radius); cursor: pointer;
  font-family: var(--jx-font); font-size: 14px; font-weight: 500;
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${WP_CLASS} .blm-jx-create-go { background: var(--jx-primary); color: var(--jx-on-primary); }
html.${WP_CLASS} .blm-jx-create-go:hover { background: var(--jx-primary-hover); }
html.${WP_CLASS} .blm-jx-create-go:active { background: var(--jx-primary-press); }
html.${WP_CLASS} .blm-jx-create-go:disabled { opacity: 0.6; cursor: progress; }
html.${WP_CLASS} .blm-jx-create-cancel { background: transparent; color: var(--jx-text-subtle); }
html.${WP_CLASS} .blm-jx-create-cancel:hover { background: var(--jx-btn-hover); color: var(--jx-text); }
html.${WP_CLASS} .blm-jx-create-go:focus-visible,
html.${WP_CLASS} .blm-jx-create-cancel:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 2px; }
html.${WP_CLASS} .blm-jx-create-error { flex-basis: 100%; margin: 0; font-size: 12px; color: var(--jx-error); }
html.${WP_CLASS} .blm-jx-children-empty { margin: 0; font-family: var(--jx-font); font-size: 14px; color: var(--jx-text-subtlest); }
html.${WP_CLASS} .blm-jx-children.empty .blm-jx-children-head { margin-bottom: var(--jx-space-1); }
html.${WP_CLASS} .blm-jx-children-bar {
  display: flex; height: 6px; margin-bottom: var(--jx-space-3);
  border-radius: 3px; overflow: hidden; background: var(--jx-todo-bg);
}
html.${WP_CLASS} .blm-jx-children-bar > .done { background: var(--jx-done-bar); }
html.${WP_CLASS} .blm-jx-children-bar > .progress { background: var(--jx-primary); }
html.${WP_CLASS} .blm-jx-children ul {
  list-style: none; margin: 0; padding: 0;
  border: 1px solid var(--jx-border); border-radius: var(--jx-radius); overflow: hidden;
}
/* Fixed columns (type · key · subject · assignee · status) so names and
   lozenges line up from row to row, whatever their length. */
html.${WP_CLASS} .blm-jx-children li {
  display: grid; align-items: center; gap: var(--jx-space-3);
  grid-template-columns: 16px 64px minmax(0, 1fr) var(--jx-col-assignee) var(--jx-col-status);
  min-height: 40px; padding: 0 var(--jx-space-3);
  border-bottom: 1px solid var(--jx-border); background: var(--jx-surface);
  font-family: var(--jx-font); font-size: 14px; color: var(--jx-text);
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${WP_CLASS} .blm-jx-children li:last-child { border-bottom: 0; }
html.${WP_CLASS} .blm-jx-children li:hover { background: var(--jx-hover); }
html.${WP_CLASS} .blm-jx-children .blm-jx-icon { margin-right: 0; }
html.${WP_CLASS} .blm-jx-children .key {
  flex: none; min-width: 56px; color: var(--jx-text-subtle); font-weight: 500;
  font-variant-numeric: tabular-nums; text-decoration: none;
}
html.${WP_CLASS} .blm-jx-children .subject {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--jx-text); text-decoration: none;
}
html.${WP_CLASS} .blm-jx-children a:hover { color: var(--jx-link); text-decoration: underline; }
html.${WP_CLASS} .blm-jx-children a:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 2px; }
html.${WP_CLASS} .blm-jx-children .assignee {
  flex: none; display: inline-flex; align-items: center; gap: var(--jx-space-2);
  max-width: 220px; min-width: 0; white-space: nowrap;
  height: 32px; padding: 0 var(--jx-space-2) 0 var(--jx-space-1); margin: 0; border: 0; border-radius: var(--jx-radius);
  background: transparent; cursor: pointer;
  font-family: var(--jx-font); font-size: 12px; font-weight: 500; color: var(--jx-text-subtle);
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${WP_CLASS} .blm-jx-children .assignee:hover { background: var(--jx-btn-hover); color: var(--jx-text); }
html.${WP_CLASS} .blm-jx-children .assignee:active { background: var(--jx-btn-press); }
html.${WP_CLASS} .blm-jx-children .assignee[aria-expanded="true"] { background: var(--jx-selected); color: var(--jx-link-hover); }
html.${WP_CLASS} .blm-jx-children .assignee:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 1px; }
html.${WP_CLASS} .blm-jx-children .assignee.none { color: var(--jx-text-subtlest); }
html.${WP_CLASS} .blm-jx-children li > .assignee,
html.${WP_CLASS} .blm-jx-children li > .blm-jx-lozenge { justify-self: start; max-width: 100%; }
html.${WP_CLASS} .blm-jx-children .key { min-width: 0; }
html.${WP_CLASS} .blm-jx-children .assignee .name,
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker-option .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* Avatars: initials first, the picture fades in over them once loaded */
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-avatar {
  position: relative; flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 50%; overflow: hidden;
  background: var(--jx-avatar-0); color: var(--jx-on-primary);
  font-family: var(--jx-font); font-size: 10px; font-weight: 700; line-height: 1; letter-spacing: 0;
  text-transform: uppercase;
}
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-avatar.small { width: 20px; height: 20px; font-size: 9px; }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-avatar[data-tone="1"] { background: var(--jx-avatar-1); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-avatar[data-tone="2"] { background: var(--jx-avatar-2); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-avatar[data-tone="3"] { background: var(--jx-avatar-3); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-avatar[data-tone="4"] { background: var(--jx-avatar-4); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-avatar[data-tone="5"] { background: var(--jx-avatar-5); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-avatar img {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  opacity: 0; transition: opacity var(--jx-dur) var(--jx-ease-out);
}
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-avatar.loaded img { opacity: 1; }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-avatar.none {
  background: transparent; border: 1.5px dashed var(--jx-text-subtlest); box-sizing: border-box;
}
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker-option { display: flex; align-items: center; gap: var(--jx-space-2); }
html.${WP_CLASS} .blm-jx-children .assignee.saving { opacity: 0.6; cursor: progress; }
html.${WP_CLASS} .blm-jx-children .assignee[aria-disabled="true"]:hover { background: transparent; }
html.${WP_CLASS} .blm-jx-children .assignee.error { color: var(--jx-error); box-shadow: inset 0 0 0 1px var(--jx-error); }

/* Assignee picker (fixed, appended to body) */
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker {
  position: fixed; z-index: 2147483646; width: 260px; padding: var(--jx-space-2);
  background: var(--jx-surface); border: 1px solid var(--jx-border); border-radius: var(--jx-radius-panel);
  box-shadow: var(--jx-shadow-raised); font-family: var(--jx-font); font-size: 14px; color: var(--jx-text);
}
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker input {
  display: block; width: 100%; box-sizing: border-box; height: 32px; margin: 0 0 var(--jx-space-1);
  padding: 0 var(--jx-space-2); border: 2px solid var(--jx-border); border-radius: var(--jx-radius);
  background: var(--jx-surface); color: var(--jx-text); font: inherit;
}
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker input:focus { border-color: var(--jx-focus); outline: none; }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker ul { list-style: none; margin: 0; padding: 0; max-height: 264px; overflow-y: auto; }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker-option {
  padding: var(--jx-space-2); border-radius: var(--jx-radius); cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker-option.active,
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker-option:hover { background: var(--jx-hover); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker-option.current { color: var(--jx-link-hover); font-weight: 600; }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker-option[data-blm-tone]::before {
  content: ""; display: inline-block; width: 8px; height: 8px; margin-right: var(--jx-space-2);
  border-radius: 50%; vertical-align: 1px; background: var(--jx-todo-fg);
}
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker-option[data-blm-tone="progress"]::before { background: var(--jx-primary); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker-option[data-blm-tone="done"]::before { background: var(--jx-done-bar); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-jx-picker-note { padding: var(--jx-space-2); color: var(--jx-text-subtlest); font-size: 12px; }
html.${WP_CLASS} .blm-jx-children .blm-jx-lozenge {
  flex: none; display: inline-block; max-width: 140px; overflow: hidden; text-overflow: ellipsis;
  height: 20px; padding: 0 6px; margin: 0; border: 0; border-radius: var(--jx-radius); cursor: pointer;
  font-family: var(--jx-font); font-size: 11px; font-weight: 700; line-height: 20px;
  text-transform: uppercase; white-space: nowrap;
  background: var(--jx-todo-bg); color: var(--jx-todo-fg);
  transition: filter var(--jx-dur) var(--jx-ease-out);
}
html.${WP_CLASS} .blm-jx-children .blm-jx-lozenge:hover { filter: brightness(0.94); }
html.${WP_CLASS} .blm-jx-children .blm-jx-lozenge:active { filter: brightness(0.86); }
html.${WP_CLASS} .blm-jx-children .blm-jx-lozenge[aria-expanded="true"] { box-shadow: inset 0 0 0 1px var(--jx-focus); }
html.${WP_CLASS} .blm-jx-children .blm-jx-lozenge:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 1px; }
html.${WP_CLASS} .blm-jx-children .blm-jx-lozenge.saving { opacity: 0.6; cursor: progress; }
html.${WP_CLASS} .blm-jx-children .blm-jx-lozenge.error { box-shadow: inset 0 0 0 1px var(--jx-error); }
html.${WP_CLASS} .blm-jx-children .blm-jx-lozenge[data-blm-tone="progress"] {
  background: var(--jx-progress-bg); color: var(--jx-progress-fg);
}
html.${WP_CLASS} .blm-jx-children .blm-jx-lozenge[data-blm-tone="done"] {
  background: var(--jx-done-bg); color: var(--jx-done-fg);
}
@media (max-width: 640px) {
  html.${WP_CLASS} .blm-jx-children li {
    grid-template-columns: 16px 56px minmax(0, 1fr) 32px var(--jx-col-status);
  }
  html.${WP_CLASS} .blm-jx-children .assignee { max-width: 32px; padding: 0; }
  html.${WP_CLASS} .blm-jx-children .assignee .name { display: none; }
}

/* Assignee column in OpenProject's Children table (Relations tab) */
:is(html.${WP_CLASS}, html.${AS_CLASS}) .work-package-table .blm-assign-th { white-space: nowrap; }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .work-package-table td.blm-assign-cell { width: 1%; white-space: nowrap; }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-assign-cell .assignee {
  display: inline-flex; align-items: center; gap: var(--jx-space-2);
  max-width: 220px; min-width: 0; height: 28px; white-space: nowrap;
  padding: 0 var(--jx-space-2) 0 var(--jx-space-1); margin: 0; border: 0; border-radius: var(--jx-radius);
  background: transparent; cursor: pointer;
  font: inherit; font-size: 13px; color: var(--jx-text-subtle);
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-assign-cell .assignee:hover { background: var(--jx-btn-hover); color: var(--jx-text); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-assign-cell .assignee:active { background: var(--jx-btn-press); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-assign-cell .assignee[aria-expanded="true"] { background: var(--jx-selected); color: var(--jx-link-hover); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-assign-cell .assignee:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 1px; }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-assign-cell .assignee.none { color: var(--jx-text-subtlest); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-assign-cell .assignee.saving { opacity: 0.6; cursor: progress; }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-assign-cell .assignee.error { color: var(--jx-error); box-shadow: inset 0 0 0 1px var(--jx-error); }
:is(html.${WP_CLASS}, html.${AS_CLASS}) .blm-assign-cell .assignee .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* Activity filter bar (Show All · Comments · History, Hide automatic updates) */
html.${ACT_CLASS} .detail-activity .activity-comments--toggler { display: none !important; }
html.${ACT_CLASS} .work-package-details-activities-activity.blm-jx-hidden { display: none !important; }
html.${ACT_CLASS} .work-package-details-activities-activity.blm-jx-date-dup > .activity-date { display: none !important; }
html.${ACT_CLASS} .blm-jx-activity-filter { margin: 0 0 var(--jx-space-3); }
html.${ACT_CLASS} .blm-jx-activity-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--jx-space-2) var(--jx-space-4);
  font-family: var(--jx-font); font-size: 14px; color: var(--jx-text-subtle);
}
html.${ACT_CLASS} .blm-jx-activity-label { font-weight: 600; color: var(--jx-text); }
html.${ACT_CLASS} .blm-jx-seg { position: relative; display: inline-flex; gap: var(--jx-space-1); }
/* Clicking a label focuses its radio; pinned inside the bar (not left at some far
   static position) so the browser never scrolls the page to reach it. */
html.${ACT_CLASS} .blm-jx-seg input {
  position: absolute; top: 0; left: 0; width: 1px; height: 1px; margin: 0;
  opacity: 0; pointer-events: none;
}
html.${ACT_CLASS} .blm-jx-seg label {
  display: inline-flex; align-items: center; gap: var(--jx-space-1);
  height: 32px; padding: 0 var(--jx-space-3); border-radius: var(--jx-radius); cursor: pointer;
  background: var(--jx-btn); color: var(--jx-text-subtle); font-weight: 500; white-space: nowrap;
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${ACT_CLASS} .blm-jx-seg label:hover { background: var(--jx-btn-hover); color: var(--jx-text); }
html.${ACT_CLASS} .blm-jx-seg input:checked + label { background: var(--jx-selected); color: var(--jx-link-hover); }
html.${ACT_CLASS} .blm-jx-seg input:focus-visible + label { outline: 2px solid var(--jx-focus); outline-offset: 2px; }
html.${ACT_CLASS} .blm-jx-seg .count,
html.${ACT_CLASS} .blm-jx-auto .count {
  font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--jx-text-subtlest);
}
html.${ACT_CLASS} .blm-jx-seg input:checked + label .count { color: var(--jx-link-hover); }
html.${ACT_CLASS} .blm-jx-auto { display: inline-flex; align-items: center; gap: var(--jx-space-2); cursor: pointer; white-space: nowrap; }
html.${ACT_CLASS} .blm-jx-auto[hidden] { display: none; }
html.${ACT_CLASS} .blm-jx-auto input { width: 16px; height: 16px; margin: 0; accent-color: var(--jx-primary); cursor: pointer; }
html.${ACT_CLASS} .blm-jx-auto input:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 2px; }
html.${ACT_CLASS} .blm-jx-activity-empty {
  margin: var(--jx-space-4) 0 0; color: var(--jx-text-subtlest); font-family: var(--jx-font); font-size: 14px;
}

/* Files tab: Jira-style attachment cards */
html.${FILES_CLASS}[data-blm-file-view="grid"] .op-files-tab .blm-jx-files-on > op-attachment-list { display: none !important; }
.blm-jx-lightbox {
  position: fixed; inset: 0; z-index: 2147483646; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.8); cursor: zoom-out;
}
.blm-jx-lightbox-hint {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); padding: 6px 12px;
  border-radius: 4px; background: rgba(0, 0, 0, 0.65); color: #fff; font: 13px/1.2 sans-serif;
  pointer-events: none; user-select: none;
}
.blm-jx-lightbox-nav {
  position: fixed; top: 50%; transform: translateY(-50%); width: 44px; height: 64px; border: 0; border-radius: 4px;
  background: rgba(0, 0, 0, 0.5); color: #fff; font: 32px/1 sans-serif; cursor: pointer;
}
.blm-jx-lightbox-nav:hover { background: rgba(0, 0, 0, 0.8); }
.blm-jx-lightbox-nav.prev { left: 16px; }
.blm-jx-lightbox-nav.next { right: 16px; }
.blm-jx-lightbox img { max-width: 92vw; max-height: 92vh; object-fit: contain; touch-action: none; cursor: grab; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); }
.blm-jx-lightbox.dragging, .blm-jx-lightbox.dragging img { cursor: grabbing; }
html.${FILES_CLASS} .blm-jx-files { margin: 0 0 var(--jx-space-4); font-family: var(--jx-font); color: var(--jx-text); }
html.${FILES_CLASS} .blm-jx-files-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--jx-space-3);
  margin-bottom: var(--jx-space-3);
}
html.${FILES_CLASS} .blm-jx-files-title { margin: 0; font-size: 16px; font-weight: 600; font-style: normal; color: var(--jx-text); }
html.${FILES_CLASS} .blm-jx-files-title .count { margin-left: var(--jx-space-1); font-size: 14px; font-weight: 500; color: var(--jx-text-subtlest); }
html.${FILES_CLASS} .blm-jx-files-view { display: inline-flex; gap: var(--jx-space-1); }
html.${FILES_CLASS} .blm-jx-files-view button {
  height: 28px; padding: 0 var(--jx-space-3); margin: 0; border: 0; border-radius: var(--jx-radius); cursor: pointer;
  background: var(--jx-btn); color: var(--jx-text-subtle); font: inherit; font-size: 13px; font-weight: 500;
  transition: background-color var(--jx-dur) var(--jx-ease-out);
}
html.${FILES_CLASS} .blm-jx-files-view button:hover { background: var(--jx-btn-hover); color: var(--jx-text); }
html.${FILES_CLASS} .blm-jx-files-view button[aria-pressed="true"] { background: var(--jx-selected); color: var(--jx-link-hover); }
html.${FILES_CLASS} .blm-jx-files-view button:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 2px; }
html.${FILES_CLASS} .blm-jx-files-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 168px), 1fr));
  gap: var(--jx-space-3); margin: 0; padding: 0; list-style: none;
}
html.${FILES_CLASS}[data-blm-file-view="list"] .blm-jx-files-grid { display: none; }
html.${FILES_CLASS} .blm-jx-file {
  display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  border: 1px solid var(--jx-border); border-radius: var(--jx-radius-panel);
  background: var(--jx-surface); color: inherit; text-decoration: none;
  transition: box-shadow var(--jx-dur) var(--jx-ease-out), border-color var(--jx-dur) var(--jx-ease-out);
}
html.${FILES_CLASS} .blm-jx-file:hover { border-color: var(--jx-focus); box-shadow: var(--jx-shadow-raised); text-decoration: none; }
html.${FILES_CLASS} .blm-jx-file:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: 2px; }
html.${FILES_CLASS} .blm-jx-file-thumb {
  position: relative; display: flex; align-items: center; justify-content: center;
  height: 104px; background: var(--jx-surface-sunken); overflow: hidden;
}
html.${FILES_CLASS} .blm-jx-file-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
html.${FILES_CLASS} .blm-jx-file-ext {
  min-width: 48px; padding: 0 var(--jx-space-2); height: 56px; border-radius: var(--jx-radius);
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--jx-type-other); color: var(--jx-on-icon);
  font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
}
html.${FILES_CLASS} .blm-jx-file-ext[data-kind="pdf"]   { background: var(--jx-type-bug); }
html.${FILES_CLASS} .blm-jx-file-ext[data-kind="doc"]   { background: var(--jx-type-task); }
html.${FILES_CLASS} .blm-jx-file-ext[data-kind="sheet"] { background: var(--jx-type-story); }
html.${FILES_CLASS} .blm-jx-file-ext[data-kind="slide"] { background: var(--jx-prio-medium); }
html.${FILES_CLASS} .blm-jx-file-ext[data-kind="archive"] { background: var(--jx-type-epic); }
html.${FILES_CLASS} .blm-jx-file-meta { display: flex; flex-direction: column; gap: 2px; padding: var(--jx-space-2) var(--jx-space-3); min-width: 0; }
html.${FILES_CLASS} .blm-jx-file-name {
  font-size: 13px; font-weight: 500; color: var(--jx-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
html.${FILES_CLASS} .blm-jx-file-sub {
  font-size: 12px; color: var(--jx-text-subtlest); font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  html.${ROOT_CLASS} *, html.${ROOT_CLASS} *::after,
  html.${AS_CLASS} .blm-assign-cell *, html.${AS_CLASS} .blm-jx-picker *,
  html.${ACT_CLASS} .blm-jx-activity-filter *,
  html.${FILES_CLASS} .blm-jx-files, html.${FILES_CLASS} .blm-jx-files * { transition: none !important; }
}
`;

// ─── Full work-package page: Jira two-column layout ─────────────────────────────

const SIDE_ITEMS = '.wp-info-wrapper, .attributes-group:not(.description-group)';

/** Moves the status block and attribute groups into a sidebar beside the
 *  description and activity. Idempotent; only moves nodes not yet moved, so
 *  groups Angular re-renders in their old place are picked up on the next pass. */
function arrangeFullView() {
  const split  = document.querySelector('.work-packages--show-view .work-packages-full-view--split-container');
  const single = split?.querySelector('.work-package--single-view');
  if (!single) return;
  const items = [...single.children].filter(el => el.matches(SIDE_ITEMS));
  if (!items.length) return;
  let side = split.querySelector(':scope > .blm-jx-side');
  if (!side) {
    side = document.createElement('aside');
    side.className = 'blm-jx-side';
    split.appendChild(side);
  }
  for (const el of items) {
    if (el.matches('.wp-info-wrapper')) side.prepend(el);
    else side.appendChild(el);
  }
}

/** Puts the sidebar's nodes back where OpenProject rendered them. */
function restoreFullView() {
  for (const side of document.querySelectorAll('.blm-jx-side')) {
    const single = side.parentElement?.querySelector('.work-package--single-view');
    if (single) {
      for (const el of [...side.children]) {
        if (el.matches('.wp-info-wrapper')) single.prepend(el);
        else single.appendChild(el);
      }
    }
    side.remove();
  }
}

// ─── Work-package views: child work items ───────────────────────────────────────
//  A Jira-style section under the description, on the full page and in the split
//  view. Each child's assignee and status can be changed from here — the skin's
//  only writes to OpenProject. They are sent by progress-hook.js in the page's
//  MAIN world (writeWp below), so they go through the same hooks as the app's own
//  edits (Confirm open subtasks, Auto 100 % on resolve) and are announced the same
//  way. They bypass OpenProject's own cache, though: a child row still open in the
//  list table keeps its old lockVersion until the page is reloaded.

const API_BASE = location.origin;   // only ever injected on the configured backlog host

/** wpId -> kids array once fetched, null while in flight, { failedAt } after an error. */
const childCache = new Map();
let lastChildWp = null;
const RETRY_AFTER_MS = 30_000;
/** `${kidId}:${field}` -> { name, href } while that write is in flight. */
const pendingWrites = new Map();
/** `${kidId}:${field}` -> message of the last failed write, shown on that control. */
const writeErrors = new Map();
const FIELD_LABEL = { assignee: 'assignee', status: 'status' };

/** The work package shown in the split view or on the full page, or null. */
function viewWpId() {
  return /\/work_packages\/(?:details\/)?(\d+)/.exec(location.pathname)?.[1] ?? null;
}

/** Where the section goes: right after the description, split view first. */
function childAnchor() {
  for (const sel of ['.work-packages--details', '.work-packages--show-view']) {
    const desc = document.querySelector(sel)?.querySelector('.description-group');
    if (desc) return desc;
  }
  return null;
}

const JSON_HEADERS = { Accept: 'application/hal+json' };

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', cache: 'no-store', headers: JSON_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function writeHeaders() {
  const headers = { ...JSON_HEADERS, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  if (csrf) headers['X-CSRF-TOKEN'] = csrf;
  return headers;
}

async function fetchChildren(wpId) {
  const filters = encodeURIComponent(JSON.stringify([{ parent: { operator: '=', values: [wpId] } }]));
  const sort    = encodeURIComponent('[["id","asc"]]');
  const elements = [];
  for (let offset = 1; ; offset++) {
    const data = await getJson(`/api/v3/work_packages?filters=${filters}&pageSize=200&offset=${offset}&sortBy=${sort}`);
    const page = data._embedded?.elements ?? [];
    elements.push(...page);
    if (page.length < 200) break;
  }
  return elements.map(kid => ({
    id:           String(kid.id),
    subject:      kid.subject ?? `#${kid.id}`,
    type:         kid._links?.type?.title ?? '',
    status:       kid._links?.status?.title ?? '',
    statusHref:   kid._links?.status?.href ?? null,
    assignee:     kid._links?.assignee?.title ?? '',
    assigneeHref: kid._links?.assignee?.href ?? null,
    projectHref:  kid._links?.project?.href ?? null,
  }));
}

/** The child's edit-form schema: what OpenProject's own editor uses for its
 *  allowed statuses (workflow) and assignees. Read-only — a form POST saves nothing. */
async function fetchSchema(kidId) {
  const { lockVersion } = await getJson(`/api/v3/work_packages/${kidId}`);
  const res = await fetch(`${API_BASE}/api/v3/work_packages/${kidId}/form`, {
    method: 'POST', credentials: 'include', headers: writeHeaders(), body: JSON.stringify({ lockVersion }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json())._embedded?.schema ?? {};
}

/** [{ href, name }] for a schema field: inline allowedValues, or a link to a collection. */
async function allowedValues(field) {
  const allowed = field?._links?.allowedValues;
  if (Array.isArray(allowed)) return allowed.map(v => ({ href: v.href, name: v.title ?? '' })).filter(v => v.href);
  if (!allowed?.href) throw new Error('no allowed values');
  const sep  = allowed.href.includes('?') ? '&' : '?';
  const data = await getJson(`${allowed.href}${sep}pageSize=500`);
  return (data._embedded?.elements ?? [])
    .map(u => ({ href: u._links?.self?.href, name: u.name ?? '' }))
    .filter(u => u.href)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Writes via progress-hook.js (MAIN world) ─────────────────────────────────

let writeSeq = 0;
const writeWaiters = new Map();   // reqId -> { resolve, reject, timer }

window.addEventListener('message', e => {
  if (e.source !== window || e.data?.source !== 'blm-progress-hook' || e.data.type !== 'write-result') return;
  const waiter = writeWaiters.get(e.data.reqId);
  if (!waiter) return;
  writeWaiters.delete(e.data.reqId);
  clearTimeout(waiter.timer);
  if (e.data.ok) waiter.resolve();
  else waiter.reject(new Error(e.data.message || `HTTP ${e.data.status}`));
});

/** Sets one link (status or assignee) on a work package; href null clears it. */
function writeWp(kidId, field, href) {
  const reqId = `w${++writeSeq}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      writeWaiters.delete(reqId);
      reject(new Error('no answer from the page (reload it)'));
    }, 60_000);   // long enough for a "Confirm open subtasks" dialog
    writeWaiters.set(reqId, { resolve, reject, timer });
    window.postMessage({ source: 'blm-jira-skin', type: 'write-wp', reqId, id: kidId, field, href }, location.origin);
  });
}

// ─── Section ────────────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ─── Avatars ────────────────────────────────────────────────────────────────────
//  Initials on a colour picked from the name show at once; the user's picture
//  replaces them when it loads. Pictures already loaded show without the swap,
//  and failed ones (no avatar set) aren't requested again on the next rebuild.

const AVATAR_TONES = 6;
const avatarLoaded = new Set();
const avatarFailed = new Set();

function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const first = [...words[0]][0] ?? '';
  const last  = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : ([...words[0]][1] ?? '');
  return (first + last).toUpperCase();
}

function avatarTone(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return String(h % AVATAR_TONES);
}

/** A 24 px (or 20 px with `small`) avatar for a principal href; null href = unassigned. */
function avatar(name, href, { small = false } = {}) {
  const wrap = el('span', `blm-jx-avatar${small ? ' small' : ''}`);
  wrap.setAttribute('aria-hidden', 'true');
  if (!href) { wrap.classList.add('none'); return wrap; }
  wrap.dataset.tone = avatarTone(name);
  wrap.append(el('span', 'initials', initials(name)));

  const userId = /^\/api\/v3\/users\/(\d+)$/.exec(href)?.[1];
  if (!userId) return wrap;                            // groups, placeholder users: initials only
  const src = `${API_BASE}/api/v3/users/${userId}/avatar`;
  if (avatarFailed.has(src)) return wrap;
  const img = el('img');
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';    // a long people list fetches pictures only as they scroll in
  img.addEventListener('load', () => { avatarLoaded.add(src); wrap.classList.add('loaded'); });
  img.addEventListener('error', () => { avatarFailed.add(src); img.remove(); });
  if (avatarLoaded.has(src)) wrap.classList.add('loaded');
  img.src = src;
  wrap.append(img);
  return wrap;
}

/** A row control (assignee or status) that opens the picker. */
function fieldButton(k, field, cls, text, content) {
  const key = `${k.id}:${field}`;
  const pending = pendingWrites.has(key);
  const error = writeErrors.get(key);
  const b = el('button', cls, content ? null : text);
  if (content) b.append(...content);
  b.type = 'button';
  b.dataset.kid = k.id;
  b.dataset.field = field;
  b.dataset.focus = field;
  b.setAttribute('aria-haspopup', 'listbox');
  b.setAttribute('aria-expanded', 'false');
  b.setAttribute('aria-label', `${field === 'status' ? 'Status' : 'Assignee'} of #${k.id}: ${text}. Change`);
  // aria-disabled, not disabled: a disabled button can't keep keyboard focus.
  if (pending) { b.classList.add('saving'); b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-busy', 'true'); }
  if (error) { b.classList.add('error'); b.title = `Couldn't change the ${FIELD_LABEL[field]}: ${error}`; }
  return b;
}

/** Builds the section with DOM APIs only: subjects and names come from the API. */
function buildChildren(wpId, kids) {
  const section = el('section', 'blm-jx-children');
  section.dataset.wp = wpId;
  section.setAttribute('aria-labelledby', 'blm-jx-children-title');

  const tones = kids.map(k => statusTone(k.status.toLowerCase()));
  const done = tones.filter(t => t === 'done').length;
  const prog = tones.filter(t => t === 'progress').length;

  const head = el('div', 'blm-jx-children-head');
  const title = el('h3', 'blm-jx-children-title', 'Child work items');
  title.id = 'blm-jx-children-title';
  const actions = el('div', 'blm-jx-children-actions');
  for (const [kind, label] of [['create', '+ Create child'], ['existing', 'Add existing']]) {
    const b = el('button', 'blm-jx-children-action', label);
    b.type = 'button';
    b.dataset.childAction = kind;
    actions.append(b);
  }
  head.append(title, el('span', 'blm-jx-children-sum', kids.length ? `${done} of ${kids.length} done` : ''), actions);

  const bar = el('div', 'blm-jx-children-bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${done} done, ${prog} in progress, ${kids.length - done - prog} to do`);
  const doneSeg = el('span', 'done');
  doneSeg.style.width = `${(done / kids.length) * 100}%`;
  const progSeg = el('span', 'progress');
  progSeg.style.width = `${(prog / kids.length) * 100}%`;
  bar.append(doneSeg, progSeg);

  const list = el('ul');
  kids.forEach((k, i) => {
    const li = el('li');
    const icon = el('span', 'blm-jx-icon');
    icon.dataset.type = typeKind(k.type.toLowerCase());
    icon.title = k.type;
    const href = `/work_packages/${k.id}/activity`;
    const key = el('a', 'key', `#${k.id}`);
    key.href = href;
    const subject = el('a', 'subject', k.subject);
    subject.href = href;
    subject.title = k.subject;
    key.dataset.kid = subject.dataset.kid = k.id;
    key.dataset.focus = 'key';
    subject.dataset.focus = 'subject';

    const name = k.assignee || 'Unassigned';
    const who = fieldButton(k, 'assignee', `assignee${k.assignee ? '' : ' none'}`, name,
      [avatar(k.assignee, k.assigneeHref), el('span', 'name', name)]);
    const status = fieldButton(k, 'status', 'blm-jx-lozenge', k.status);
    status.dataset.blmTone = tones[i];
    li.append(icon, key, subject, who, status);
    list.append(li);
  });

  if (createState.wpId === wpId) list.append(buildCreateRow());
  // No children yet: just the heading with the two actions, so the first child
  // can be created here (the Relations tab's Children part is hidden).
  if (!kids.length) {
    section.classList.add('empty');
    section.append(head);
    if (list.children.length) section.append(list);
    else section.append(el('p', 'blm-jx-children-empty', 'No child work items yet.'));
    return section;
  }
  section.append(head, bar, list);
  return section;
}

/** The viewed work package's children, or null while loading / after a recent
 *  failure (a fetch is started when needed). Opening another work package, or
 *  leaving work packages (wpId null), drops the cache so each visit is fresh. */
function childrenFor(wpId) {
  if (wpId !== lastChildWp) { childCache.clear(); writeErrors.clear(); lastChildWp = wpId; closePicker(); }
  if (!wpId) return null;
  const cached = childCache.get(wpId);
  if (cached === undefined || (cached?.failedAt && Date.now() - cached.failedAt > RETRY_AFTER_MS)) {
    childCache.set(wpId, null);
    fetchChildren(wpId)
      .then(kids => {
        // A refetch during a save must not show the old value.
        childCache.set(wpId, kids.map(k => {
          let out = k;
          for (const field of ['assignee', 'status']) {
            const p = pendingWrites.get(`${k.id}:${field}`);
            if (p) out = { ...out, [field]: p.name, [`${field}Href`]: p.href };
          }
          return out;
        }));
        schedule();
      })
      .catch(() => childCache.set(wpId, { failedAt: Date.now() }));
    return null;
  }
  return Array.isArray(cached) ? cached : null;        // in flight, or failed recently
}

/** Shows the children after the description. Nothing while loading, on error,
 *  Without children it still shows the heading and its actions, so the first
 *  child can be created here. */
function renderChildren() {
  const wpId   = viewWpId();
  const anchor = childAnchor();
  const shown  = document.querySelector('.blm-jx-children');
  // No description on screen (another tab, or not a work package): no section,
  // but the cache stays — the Relations tab's table column uses it too.
  if (!wpId || !anchor) { shown?.remove(); return; }
  if (shown && shown.dataset.wp !== wpId) shown.remove();

  const kids = childrenFor(wpId);
  if (!kids) return;
  prefetchPeople(kids);
  const current = document.querySelector('.blm-jx-children');
  if (createState.wpId && createState.wpId !== wpId) createState.wpId = null;   // another work package
  if (current?.dataset.wp === wpId && current.previousElementSibling === anchor && current._kids === kids
      && current._createSig === createSig(wpId)) return;

  const focused  = document.activeElement?.closest?.('.blm-jx-children [data-focus]');
  const focusSel = focused && `[data-kid="${focused.dataset.kid}"][data-focus="${focused.dataset.focus}"]`;
  current?.remove();
  const section = buildChildren(wpId, kids);
  section._kids = kids;
  section._createSig = createSig(wpId);
  anchor.after(section);
  if (focusSel) section.querySelector(focusSel)?.focus();
  else if (createState.wpId === wpId && !current?.querySelector('.blm-jx-create-row')) section.querySelector('.blm-jx-create-input')?.focus();

  // Keep an open picker attached to the rebuilt button.
  if (picker) {
    const btn = picker.field === 'existing'
      ? section.querySelector('[data-child-action="existing"]')
      : section.querySelector(`[data-kid="${picker.kidId}"][data-field="${picker.field}"]`);
    if (btn) { picker.button = btn; btn.setAttribute('aria-expanded', 'true'); }
    else closePicker();
  }
}

// Floating button that scrolls the child work items into view, for stories with a
// long description. It shows as soon as the description is on screen (the section
// itself only exists after the children load) and while the section's top is below
// the fold. Scroll is listened to in the capture phase so the split-view pane's own
// scroll container counts too.
let jumpBtn = null;

function jumpTarget() {
  return document.querySelector('.blm-jx-children') ?? childAnchor();
}

function updateJump() {
  if (!jumpBtn) return;
  const target = jumpTarget();
  if (!target) { jumpBtn.hidden = true; return; }
  const rect = target.getBoundingClientRect();
  // Section: its top is below the fold. Description (children still loading): its end is.
  const edge = target.classList.contains('blm-jx-children') ? rect.top : rect.bottom;
  jumpBtn.hidden = edge < window.innerHeight - 80;
}

function syncJump() {
  const on = skinEnabled && onWorkPackagePage() && viewWpId() && childAnchor();
  if (!on) {
    jumpBtn?.remove();
    jumpBtn = null;
    return;
  }
  if (!jumpBtn) {
    jumpBtn = el('button', 'blm-jx-jump', '↓ Child work items');
    jumpBtn.type = 'button';
    jumpBtn.addEventListener('click', () => {
      const section = document.querySelector('.blm-jx-children');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else childAnchor()?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }
  if (!jumpBtn.isConnected) document.body.append(jumpBtn);
  updateJump();
}
document.addEventListener('scroll', updateJump, { capture: true, passive: true });
window.addEventListener('resize', updateJump);

/** Replaces one child in the cache with a new object, so the next pass rebuilds. */
function updateKid(wpId, kidId, patch) {
  const kids = childCache.get(wpId);
  if (!Array.isArray(kids)) return;
  childCache.set(wpId, kids.map(k => (k.id === kidId ? { ...k, ...patch } : k)));
  schedule();
}

// Optimistic: the control shows the new value at once (dimmed while saving).
// On success the list is refetched, so it ends up showing what OpenProject
// actually saved (a cancelled "Confirm open subtasks" keeps the old status).
// On failure it reverts, with the reason on the control. Silent on success.
async function changeField(wpId, kidId, field, value) {
  const cached = childCache.get(wpId);
  const before = Array.isArray(cached) ? cached.find(k => k.id === kidId) : null;
  if (!before || before[`${field}Href`] === value.href) return;
  const key = `${kidId}:${field}`;
  writeErrors.delete(key);
  pendingWrites.set(key, value);
  updateKid(wpId, kidId, { [field]: value.name, [`${field}Href`]: value.href });
  try {
    await writeWp(kidId, field, value.href);
    pendingWrites.delete(key);
    if (viewWpId() === wpId) childCache.delete(wpId);   // refetch the truth
    schedule();
  } catch (err) {
    pendingWrites.delete(key);
    writeErrors.set(key, err.message || 'request failed');
    updateKid(wpId, kidId, { [field]: before[field], [`${field}Href`]: before[`${field}Href`] });
  }
}

// ─── Picker (assignee or status) ──────────────────────────────────────────────

let meCache = null;                 // { href, name } | undefined once known
const optionsCache = new Map();     // `${kidId}:${field}` -> [{ href, name }]
let picker = null;                  // { el, button, wpId, kidId, field, options, active, state }

let mePromise = null;              // one request, however many callers
function loadMe() {
  if (meCache !== null) return Promise.resolve(meCache);
  mePromise ??= getJson('/api/v3/users/me')
    .then(me => { meCache = { href: me._links?.self?.href, name: me.name }; return meCache; })
    .catch(() => { meCache = undefined; return meCache; });
  return mePromise;
}

// People are the same for every child of a project, so they are fetched once per
// project (its assignable members) and ahead of time, as soon as a list of
// children is on screen; the picker then opens with names straight away. The
// child's edit form is the fallback when a project's list can't be read.
const peopleCache = new Map();   // projectHref -> Promise<[{ href, name }]>
const peopleReady = new Map();   // projectHref -> [{ href, name }] once resolved

function peopleFor(projectHref) {
  if (!/^\/api\/v3\/projects\/[^/?#]+$/.test(projectHref ?? '')) return null;
  if (!peopleCache.has(projectHref)) {
    peopleCache.set(projectHref, allowedValues({ _links: { allowedValues: { href: `${projectHref}/available_assignees` } } })
      .then(people => { peopleReady.set(projectHref, people); return people; })
      .catch(err => { peopleCache.delete(projectHref); throw err; }));
  }
  return peopleCache.get(projectHref);
}

/** kidId -> projectHref, kept while the children list refetches (after a write),
 *  so the picker can still use the project's people instead of the slow form. */
const kidProjects = new Map();

function kidProject(kidId) {
  const kids = childCache.get(viewWpId());
  const kid = Array.isArray(kids) ? kids.find(k => k.id === kidId) : null;
  if (kid?.projectHref) kidProjects.set(kidId, kid.projectHref);
  return kidProjects.get(kidId) ?? null;
}

/** Loads people (and the signed-in user) for every project among these children. */
function prefetchPeople(kids) {
  for (const k of kids) if (k.projectHref) kidProjects.set(k.id, k.projectHref);
  const projects = [...new Set(kids.map(k => k.projectHref).filter(Boolean))].filter(h => !peopleCache.has(h));
  if (!projects.length && (meCache !== null || mePromise)) return;
  // Right away (one small request per project), so even a quick click finds them.
  loadMe();
  for (const h of projects) peopleFor(h)?.catch(() => { /* the picker retries */ });
}

async function loadOptions(kidId, field) {
  const key = `${kidId}:${field}`;
  if (field === 'assignee') {
    const fromProject = peopleFor(kidProject(kidId));
    if (fromProject) {
      try { return await fromProject; } catch { /* fall back to the form below */ }
    }
  }
  if (!optionsCache.has(key)) {
    optionsCache.set(key, fetchSchema(kidId)
      .then(schema => allowedValues(schema[field]))
      .catch(err => { optionsCache.delete(key); throw err; }));
  }
  return optionsCache.get(key);
}

function closePicker({ refocus = false } = {}) {
  if (!picker) return;
  const { el: pop, button } = picker;
  picker = null;
  pop.remove();
  if (button.isConnected) {
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  }
}

function placePicker() {
  if (!picker) return;
  if (!picker.button.isConnected) { closePicker(); return; }
  const r = picker.button.getBoundingClientRect();
  const w = picker.el.offsetWidth;
  const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
  const below = r.bottom + 4;
  const fitsBelow = below + picker.el.offsetHeight < innerHeight - 8;
  picker.el.style.left = `${left}px`;
  picker.el.style.top  = `${fitsBelow ? below : Math.max(8, r.top - 4 - picker.el.offsetHeight)}px`;
}

function renderPickerList(values, status) {
  const { el: pop, kidId, wpId, field } = picker;
  const list  = pop.querySelector('ul');
  const query = pop.querySelector('input').value.trim().toLowerCase();
  const cached = childCache.get(wpId);
  const current = (Array.isArray(cached) ? cached.find(k => k.id === kidId)?.[`${field}Href`] : null) ?? null;
  list.replaceChildren();

  if (status) { list.append(el('li', 'blm-jx-picker-note', status)); picker.options = []; picker.active = -1; return; }

  const options = [];
  if (!query && field === 'assignee') {
    if (meCache?.href && values.some(p => p.href === meCache.href)) options.push({ href: meCache.href, name: meCache.name, label: 'Assign to me' });
    options.push({ href: null, name: '', label: 'Unassigned' });
  }
  for (const v of values) if (!query || v.name.toLowerCase().includes(query)) options.push({ ...v, label: v.name });

  if (!options.length) list.append(el('li', 'blm-jx-picker-note', field === 'status' ? 'No matching status' : 'No matching people'));
  options.forEach((o, i) => {
    const li = el('li', 'blm-jx-picker-option', field === 'assignee' ? null : o.label);
    if (field === 'assignee') li.append(avatar(o.name, o.href, { small: true }), el('span', 'name', o.label));
    li.id = `blm-jx-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    if (field === 'status') li.dataset.blmTone = statusTone(o.name.toLowerCase());
    if (o.href === current) { li.classList.add('current'); li.setAttribute('aria-current', 'true'); }
    li.addEventListener('mousedown', e => e.preventDefault());     // keep focus in the search box
    li.addEventListener('mouseenter', () => { if (picker && picker.active !== i) { picker.active = i; markActive({ scroll: false }); } });
    li.addEventListener('click', () => choose(o));
    list.append(li);
  });
  picker.options = options;
  const cur = options.findIndex(o => o.href === current && o.label !== 'Assign to me');
  picker.active = options.length ? Math.max(0, query ? 0 : cur) : -1;
  markActive();
}

function markActive({ scroll = true } = {}) {
  const items = picker.el.querySelectorAll('.blm-jx-picker-option');
  items.forEach((li, i) => {
    li.classList.toggle('active', i === picker.active);
    li.setAttribute('aria-selected', String(i === picker.active));
  });
  const input = picker.el.querySelector('input');
  if (picker.active >= 0) {
    input.setAttribute('aria-activedescendant', `blm-jx-opt-${picker.active}`);
    if (scroll) items[picker.active]?.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function choose(option) {
  const { wpId, kidId, field } = picker;
  closePicker({ refocus: true });
  changeField(wpId, kidId, field, { href: option.href, name: option.name });
}

async function openPicker(button) {
  closePicker();
  const wpId  = viewWpId();
  const kidId = button.dataset.kid;
  const field = button.dataset.field;
  if (!/^\d+$/.test(kidId ?? '') || !FIELD_LABEL[field]) return;

  const pop = el('div', 'blm-jx-picker');
  const input = el('input');
  input.type = 'search';
  input.placeholder = field === 'status' ? 'Search statuses' : 'Search people';
  input.setAttribute('aria-label', field === 'status' ? `New status for #${kidId}` : `Assign #${kidId} to`);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'blm-jx-picker-list');
  const list = el('ul');
  list.id = 'blm-jx-picker-list';
  list.setAttribute('role', 'listbox');
  pop.append(input, list);
  document.body.append(pop);

  picker = { el: pop, button, wpId, kidId, field, options: [], active: -1, state: 'loading' };
  button.setAttribute('aria-expanded', 'true');
  writeErrors.delete(`${kidId}:${field}`);
  button.classList.remove('error');
  button.removeAttribute('title');

  const notes = {
    loading: field === 'status' ? 'Loading statuses…' : 'Loading people…',
    error:   (msg) => `Couldn't load ${field === 'status' ? 'statuses' : 'people'} (${msg}). Close and try again.`,
  };
  const ready = field === 'assignee' ? peopleReady.get(kidProject(kidId)) : null;
  let values = ready ?? [];
  let errorNote = '';
  if (ready) { picker.state = 'ready'; renderPickerList(values); }
  else renderPickerList([], notes.loading);
  placePicker();
  input.focus();

  input.addEventListener('input', () => {
    if (!picker) return;
    renderPickerList(values, picker.state === 'loading' ? notes.loading : picker.state === 'error' ? errorNote : undefined);
  });
  input.addEventListener('keydown', e => {
    if (!picker) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!picker.options.length) return;
      const n = picker.options.length;
      picker.active = (picker.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      markActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (picker.active >= 0) choose(picker.options[picker.active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePicker({ refocus: true });
    } else if (e.key === 'Tab') {
      // Back on the button first, so Tab continues along the row.
      closePicker({ refocus: true });
    }
  });

  if (ready) { loadMe().then(() => { if (picker?.el === pop && !input.value) renderPickerList(values); }); return; }
  try {
    [values] = await Promise.all([loadOptions(kidId, field), field === 'assignee' ? loadMe() : null]);
    if (picker?.el === pop) { picker.state = 'ready'; renderPickerList(values); placePicker(); }
  } catch (err) {
    if (picker?.el === pop) {
      picker.state = 'error';
      errorNote = notes.error(err.message || 'request failed');
      renderPickerList([], errorNote);
    }
  }
}

document.addEventListener('click', e => {
  const button = e.target.closest?.('.blm-jx-children [data-field]');
  if (button && skinEnabled) { togglePicker(button); return; }
  if (picker && !picker.el.contains(e.target)) closePicker();
});
// OpenProject's own inline editors (assignee, status, ...) stay open when you click
// away, and the skin's cells stop their clicks from reaching OpenProject's outside-click
// handling. Escape cancels an unchanged edit, so send it on any outside press.
document.addEventListener('mousedown', e => {
  if (!skinEnabled) return;
  const field = document.querySelector('.inline-edit--active-field');
  if (!field || field.closest('.inline-edit--container')?.contains(e.target)) return;
  if (e.target.closest?.('.ng-dropdown-panel, .op-modal, .spot-modal, [role="dialog"]')) return;
  const input = field.querySelector('input, select, textarea') ?? field;
  input.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
}, true);
addEventListener('resize', () => closePicker());
addEventListener('scroll', e => { if (picker && !picker.el.contains(e.target)) closePicker(); }, true);

// OpenProject writes announced by progress-hook.js refetch the list: any of them
// may add, move or change a child.
window.addEventListener('message', e => {
  if (e.source !== window || e.data?.source !== 'blm-progress-hook' || e.data.type !== 'wp-updated') return;
  const wpId = viewWpId();
  if (!wpId || childCache.get(wpId) === null) return;
  childCache.delete(wpId);
  if (anyEnabled()) schedule();
});

// ─── Assignee column in OpenProject's Children table ────────────────────────────

/** The work-package id of a table row. */
function tableRowId(row) {
  return row.getAttribute('data-work-package-id') ?? /wp-row-(\d+)/.exec(row.id || '')?.[1] ?? null;
}

/** Opens or closes the picker for a button (shared by the section and the table). */
function togglePicker(button) {
  if (button.getAttribute('aria-disabled') === 'true') return;
  if (picker?.button === button) closePicker({ refocus: true });
  else openPicker(button);
}

/** Adds an Assignee cell before Status in each row of the Children table. A table
 *  only counts as that when every one of its rows is a child of the viewed work
 *  package, so other embedded tables are never touched. */
function renderTableAssignees() {
  const wpId = viewWpId();
  const views = document.querySelectorAll('.work-packages--details, .work-packages--show-view');
  const tables = [...views].flatMap(v => [...v.querySelectorAll('.work-package-table')]);
  if (!wpId || !tables.length) return;
  const kids = childrenFor(wpId);
  if (!kids) return;
  prefetchPeople(kids);
  const byId = new Map(kids.map(k => [k.id, k]));

  for (const table of tables) {
    const rows = [...table.querySelectorAll('tbody tr')].filter(r => tableRowId(r));
    if (!rows.length || !rows.every(r => byId.has(tableRowId(r)))) continue;

    const headRow = table.querySelector('thead tr');
    if (headRow && !headRow.querySelector('.blm-assign-th')) {
      const status = rows[0].querySelector(':scope > td.status');
      const idx = status && !rows[0].querySelector(':scope > td.blm-assign-cell') ? status.cellIndex : -1;
      const th = el('th', 'blm-assign-th');
      const outer = el('div', 'generic-table--sort-header-outer');
      outer.append(el('span', 'generic-table--sort-header', 'Assignee'));
      th.append(outer);
      const before = idx >= 0 ? headRow.children[idx] : null;
      before ? before.before(th) : headRow.append(th);
    }

    for (const row of rows) {
      const k = byId.get(tableRowId(row));
      const key = `${k.id}:assignee`;
      const sig = [k.assigneeHref, k.assignee, pendingWrites.has(key), writeErrors.get(key) ?? ''].join('|');
      const cell = row.querySelector(':scope > td.blm-assign-cell');
      if (cell?.dataset.sig === sig) continue;

      const fresh = el('td', 'blm-assign-cell');
      fresh.dataset.sig = sig;
      const name = k.assignee || 'Unassigned';
      const btn = fieldButton(k, 'assignee', `assignee${k.assignee ? '' : ' none'}`, name,
        [avatar(k.assignee, k.assigneeHref), el('span', 'name', name)]);
      // OpenProject's table reacts to clicks and keys on its rows (select, open,
      // inline edit); this cell keeps them to itself.
      btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); togglePicker(btn); });
      for (const type of ['mousedown', 'dblclick', 'keydown', 'keyup']) fresh.addEventListener(type, e => e.stopPropagation());
      fresh.append(btn);

      const hadFocus = cell?.contains(document.activeElement);
      if (cell) cell.replaceWith(fresh);
      else {
        const status = row.querySelector(':scope > td.status');
        status ? status.before(fresh) : row.append(fresh);
      }
      if (hadFocus) btn.focus();
      if (picker && picker.kidId === k.id && picker.field === 'assignee' && !picker.button.isConnected) {
        picker.button = btn;
        btn.setAttribute('aria-expanded', 'true');
      }
    }
  }
}

function removeTableAssignees() {
  document.querySelectorAll('.blm-assign-cell, .blm-assign-th').forEach(n => n.remove());
}

// ─── Activity tab: Jira-style filter ────────────────────────────────────────────
//  A bar above the list: Show All · Comments · History, plus "Hide automatic
//  updates" (entries OpenProject writes when a child changes the parent's
//  progress). Entries are only hidden, never removed; a date heading shows on the
//  first visible entry of each day. The choice is remembered per browser.

const CFG_ACTIVITY = '__blm_activity_filter';
let activityPref = { tab: 'all', hideAuto: true };
chrome.storage.local.get(CFG_ACTIVITY).then(s => {
  activityPref = { ...activityPref, ...(s[CFG_ACTIVITY] ?? {}) };
  schedule();
});
function saveActivityPref() {
  try { chrome.storage.local.set({ [CFG_ACTIVITY]: activityPref }); } catch { /* context gone */ }
}

const AUTO_NOTE_RE = /^\s*updated automatically\b/i;

/** { comment, changes, auto } for one activity entry. */
function classifyActivity(item) {
  const note = (item.querySelector('.user-comment .op-uc-container')?.textContent ?? '').trim();
  const auto = AUTO_NOTE_RE.test(note);
  return {
    auto,
    comment: !!note && !auto,
    changes: item.querySelectorAll('.work-package-details-activities-messages > li').length > 0,
  };
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

function buildActivityBar() {
  const bar = el('div', 'blm-jx-activity-bar');
  bar.append(el('span', 'blm-jx-activity-label', 'Show'));
  const seg = el('div', 'blm-jx-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', 'Show activity');
  for (const [value, label] of [['all', 'All'], ['comments', 'Comments'], ['history', 'History']]) {
    const input = el('input');
    input.type = 'radio';
    input.name = 'blm-jx-activity';
    input.id = `blm-jx-act-${value}`;
    input.value = value;
    const lab = el('label');
    lab.htmlFor = input.id;
    lab.append(el('span', null, label), el('span', 'count'));
    seg.append(input, lab);
  }
  seg.addEventListener('change', e => {
    activityPref.tab = e.target.value;
    saveActivityPref();
    // OpenProject's own "comments only" mode would leave All / History empty.
    if (activityPref.tab !== 'comments') {
      const opToggle = document.querySelector('.detail-activity .activity-comments--toggler');
      if (opToggle && /show all/i.test(opToggle.textContent)) opToggle.click();
    }
    schedule();
  });

  const auto = el('label', 'blm-jx-auto');
  const box = el('input');
  box.type = 'checkbox';
  box.className = 'blm-jx-auto-box';
  auto.append(box, el('span', null, 'Hide automatic updates'), el('span', 'count'));
  box.addEventListener('change', () => { activityPref.hideAuto = box.checked; saveActivityPref(); schedule(); });

  bar.append(seg, auto);
  const empty = el('p', 'blm-jx-activity-empty');
  empty.hidden = true;
  const wrap = el('div', 'blm-jx-activity-filter');
  wrap.append(bar, empty);
  return wrap;
}

function renderActivityFilter() {
  const list = document.querySelector('.detail-activity .work-package-details-activities-list');
  if (!list) return;
  let wrap = list.previousElementSibling?.classList.contains('blm-jx-activity-filter') ? list.previousElementSibling : null;
  if (!wrap) {
    document.querySelectorAll('.blm-jx-activity-filter').forEach(n => n.remove());
    wrap = buildActivityBar();
    list.before(wrap);
  }

  const items = [...list.querySelectorAll(':scope > .work-package-details-activities-activity')];
  const kinds = items.map(classifyActivity);
  const counts = {
    all:      kinds.filter(k => !(activityPref.hideAuto && k.auto)).length,
    comments: kinds.filter(k => k.comment).length,
    history:  kinds.filter(k => (k.changes || !k.comment) && !(activityPref.hideAuto && k.auto)).length,
    auto:     kinds.filter(k => k.auto).length,
  };
  const shows = k => {
    if (activityPref.hideAuto && k.auto) return false;
    if (activityPref.tab === 'comments') return k.comment;
    if (activityPref.tab === 'history') return k.changes || !k.comment;
    return true;
  };

  let lastDate = null;
  items.forEach((item, i) => {
    const show = shows(kinds[i]);
    item.classList.toggle('blm-jx-hidden', !show);
    const label = item.querySelector('.activity-date--label')?.textContent.trim() ?? '';
    const dup = show && label && label === lastDate;
    item.classList.toggle('blm-jx-date-dup', !!dup);
    if (show) lastDate = label;
  });

  for (const input of wrap.querySelectorAll('.blm-jx-seg input')) {
    const checked = input.value === activityPref.tab;
    if (input.checked !== checked) input.checked = checked;
    setText(input.nextElementSibling.querySelector('.count'), String(counts[input.value]));
  }
  const box = wrap.querySelector('.blm-jx-auto-box');
  if (box.checked !== activityPref.hideAuto) box.checked = activityPref.hideAuto;
  setText(wrap.querySelector('.blm-jx-auto .count'), String(counts.auto));
  wrap.querySelector('.blm-jx-auto').hidden = counts.auto === 0;

  const empty = wrap.querySelector('.blm-jx-activity-empty');
  const none = items.length > 0 && counts[activityPref.tab] === 0;
  if (empty.hidden === none) empty.hidden = !none;
  setText(empty, activityPref.tab === 'comments' ? 'No comments yet.' : 'Nothing to show with these filters.');
}

function removeActivityFilter() {
  document.querySelectorAll('.blm-jx-activity-filter').forEach(n => n.remove());
  document.querySelectorAll('.blm-jx-hidden, .blm-jx-date-dup').forEach(n => n.classList.remove('blm-jx-hidden', 'blm-jx-date-dup'));
}

// ─── Files tab: Jira-style attachment cards ─────────────────────────────────────
//  Cards (image thumbnail or file-type tile, name, size · date · uploader) built
//  from the work package's attachments, in the order of OpenProject's own list,
//  which stays in the DOM and returns with the List toggle (it keeps delete).
//  Upload stays OpenProject's drop zone; the cards follow its list as it changes.

const CFG_FILE_VIEW = '__blm_file_view';
let fileView = 'grid';
chrome.storage.local.get(CFG_FILE_VIEW).then(s => {
  if (s[CFG_FILE_VIEW] === 'list') fileView = 'list';
  schedule();
});

/** wpId -> { sig, files } once fetched for that list signature; { sig, pending } while loading. */
const fileCache = new Map();

const ATTACHMENT_ID_RE = /\/api\/v3\/attachments\/(\d+)\/content/;

function fileKind(name, type) {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toLowerCase();
  if (/^image\//.test(type)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (/^(docx?|odt|rtf|txt|md)$/.test(ext)) return 'doc';
  if (/^(xlsx?|ods|csv)$/.test(ext)) return 'sheet';
  if (/^(pptx?|odp)$/.test(ext)) return 'slide';
  if (/^(zip|rar|7z|tar|gz)$/.test(ext)) return 'archive';
  return 'other';
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function fetchAttachments(wpId) {
  const data = await getJson(`/api/v3/work_packages/${wpId}/attachments`);
  return (data._embedded?.elements ?? []).map(a => ({
    id:      String(a.id),
    name:    a.fileName ?? `attachment ${a.id}`,
    size:    a.fileSize,
    type:    a.contentType ?? '',
    created: a.createdAt,
    author:  a._links?.author?.title ?? '',
    href:    a._links?.downloadLocation?.href ?? `/api/v3/attachments/${a.id}/content`,
  }));
}

/** Full-size image over the page; a click or Esc closes it, left/right arrows step through `srcs`. */
function openLightbox(srcs, index) {
  const box = el('div', 'blm-jx-lightbox');
  const img = el('img');
  img.src = srcs[index];
  box.append(img, el('div', 'blm-jx-lightbox-hint', 'Ctrl + wheel to zoom · ← → for other images · drag to pan · double-click to reset · Esc to close'));
  let scale = 1, x = 0, y = 0, drag = null, moved = false;
  const show = step => {
    index = (index + step + srcs.length) % srcs.length;
    img.src = srcs[index];
    scale = 1; x = 0; y = 0; apply();
  };
  if (srcs.length > 1) {
    for (const [cls, label, step] of [['prev', '‹', -1], ['next', '›', 1]]) {
      const b = el('button', `blm-jx-lightbox-nav ${cls}`, label);
      b.type = 'button';
      b.setAttribute('aria-label', step < 0 ? 'Previous image' : 'Next image');
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.addEventListener('click', e => { e.stopPropagation(); show(step); });
      box.append(b);
    }
  }
  const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  box.addEventListener('wheel', e => {
    e.preventDefault();                                  // stop the browser's page zoom and the page scrolling behind
    if (!e.ctrlKey) return;
    scale = Math.min(8, Math.max(0.2, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    apply();
  }, { passive: false });
  img.addEventListener('dblclick', () => { scale = 1; x = 0; y = 0; apply(); });
  img.draggable = false;
  box.addEventListener('pointerdown', e => {
    if (e.button) return;
    drag = { x: e.clientX - x, y: e.clientY - y, sx: e.clientX, sy: e.clientY };
    moved = false;
    box.setPointerCapture(e.pointerId);
    box.classList.add('dragging');
  });
  box.addEventListener('pointermove', e => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) moved = true;
    x = e.clientX - drag.x;
    y = e.clientY - drag.y;
    apply();
  });
  box.addEventListener('pointerup', () => { drag = null; box.classList.remove('dragging'); });
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (srcs.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault(); e.stopPropagation();
      show(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };
  box.addEventListener('click', e => { if (e.target === box && !moved) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
}

function buildFileCard(f, _i, all) {
  const card = el('a', 'blm-jx-file');
  card.href = f.href;
  card.target = '_blank';
  card.rel = 'noopener';
  card.title = f.name;
  if (fileKind(f.name, f.type) === 'image') {
    card.addEventListener('click', e => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;   // modified clicks still open a tab
      e.preventDefault();
      const imgs = all.filter(g => fileKind(g.name, g.type) === 'image');
      openLightbox(imgs.map(g => g.href), imgs.indexOf(f));
    });
  }
  const thumb = el('span', 'blm-jx-file-thumb');
  const kind = fileKind(f.name, f.type);
  if (kind === 'image') {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = f.href;
    thumb.append(img);
  } else {
    const ext = el('span', 'blm-jx-file-ext', (/\.([a-z0-9]{1,5})$/i.exec(f.name)?.[1] ?? 'file'));
    ext.dataset.kind = kind;
    thumb.append(ext);
  }
  const meta = el('span', 'blm-jx-file-meta');
  const date = f.created ? new Date(f.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  meta.append(el('span', 'blm-jx-file-name', f.name),
              el('span', 'blm-jx-file-sub', [formatSize(f.size), date, f.author].filter(Boolean).join(' · ')));
  card.append(thumb, meta);
  const li = el('li');
  li.append(card);
  return li;
}

function renderFileCards() {
  document.documentElement.dataset.blmFileView = fileView;
  const section = document.querySelector('.op-files-tab op-attachments');
  const list = section?.querySelector('op-attachment-list');
  const wpId = viewWpId();
  const shown = document.querySelector('.blm-jx-files');
  if (!section || !list || !wpId) { shown?.remove(); return; }

  // The list's attachment ids, in its order: the cards follow every upload/delete.
  const ids = [...list.querySelectorAll('a[href]')]
    .map(a => ATTACHMENT_ID_RE.exec(a.getAttribute('href'))?.[1]).filter(Boolean);
  const order = [...new Set(ids)];
  const sig = `${wpId}:${order.join(',')}`;
  if (!order.length) { shown?.remove(); section.classList.remove('blm-jx-files-on'); return; }

  const cached = fileCache.get(wpId);
  if (!cached || cached.sig !== sig) {
    if (!cached?.pending || cached.sig !== sig) {
      fileCache.set(wpId, { sig, pending: true });
      fetchAttachments(wpId)
        .then(files => { if (fileCache.get(wpId)?.sig === sig) { fileCache.set(wpId, { sig, files }); schedule(); } })
        .catch(() => { if (fileCache.get(wpId)?.sig === sig) fileCache.set(wpId, { sig, failed: true }); });
    }
    return;                                            // OpenProject's list shows meanwhile
  }
  if (!cached.files) return;                           // failed: keep OpenProject's list

  if (shown?.dataset.sig === sig && shown.parentElement === section) {
    for (const b of shown.querySelectorAll('.blm-jx-files-view button')) {
      const on = String(b.dataset.view === fileView);
      if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on);
    }
    return;
  }

  const byId = new Map(cached.files.map(f => [f.id, f]));
  const files = order.map(id => byId.get(id)).filter(Boolean);
  const wrap = el('div', 'blm-jx-files');
  wrap.dataset.sig = sig;
  const head = el('div', 'blm-jx-files-head');
  const title = el('h3', 'blm-jx-files-title', 'Attachments');
  title.append(el('span', 'count', String(files.length)));
  const view = el('div', 'blm-jx-files-view');
  view.setAttribute('role', 'group');
  view.setAttribute('aria-label', 'Attachment view');
  for (const [value, label] of [['grid', 'Grid'], ['list', 'List']]) {
    const b = el('button', null, label);
    b.type = 'button';
    b.dataset.view = value;
    b.setAttribute('aria-pressed', String(value === fileView));
    b.addEventListener('click', () => {
      fileView = value;
      try { chrome.storage.local.set({ [CFG_FILE_VIEW]: fileView }); } catch { /* context gone */ }
      schedule();
    });
    view.append(b);
  }
  head.append(title, view);
  const grid = el('ul', 'blm-jx-files-grid');
  grid.append(...files.map(buildFileCard));
  wrap.append(head, grid);

  shown?.remove();
  section.prepend(wrap);
  section.classList.add('blm-jx-files-on');
}

function removeFileCards() {
  document.querySelectorAll('.blm-jx-files').forEach(n => n.remove());
  document.querySelectorAll('.blm-jx-files-on').forEach(n => n.classList.remove('blm-jx-files-on'));
  delete document.documentElement.dataset.blmFileView;
}

// ─── Children actions: + Create child · Add existing ────────────────────────────
//  With Jira style on, the Relations tab's Children table is hidden (the Child
//  work items section lists them), so the section carries the two actions itself:
//  Create child opens OpenProject's new-work-package form with this work package
//  as parent; Add existing searches the project and sets the chosen work
//  package's parent (sent through progress-hook.js like the other writes;
//  OpenProject rejects invalid moves, e.g. a cycle, and the reason is shown).

/** Shows a short message under the section's buttons for a few seconds. */
function childActionNote(button, text) {
  const head = button.closest('.blm-jx-children-head');
  if (!head) return;
  let note = head.querySelector('.blm-jx-children-note');
  if (!note) { note = el('span', 'blm-jx-children-note'); note.setAttribute('role', 'status'); head.append(note); }
  note.textContent = text;
  clearTimeout(note._t);
  note._t = setTimeout(() => note.remove(), 6000);
}

/** { id, identifier } of the viewed work package's project. */
const projectOfWp = new Map();
async function wpProject(wpId) {
  if (!projectOfWp.has(wpId)) {
    projectOfWp.set(wpId, (async () => {
      const wp = await getJson(`/api/v3/work_packages/${wpId}`);
      const href = wp._links?.project?.href ?? '';
      const project = await getJson(href);
      return { id: String(project.id), identifier: project.identifier, href };
    })().catch(err => { projectOfWp.delete(wpId); throw err; }));
  }
  return projectOfWp.get(wpId);
}

// + Create child: a new-item row at the end of the list (type · subject ·
// Create / Cancel), like OpenProject's own Children table. Enter creates the
// child and keeps the row open for the next one; Escape closes it. The row's
// state lives here so it survives the list being rebuilt after each create.
const createState = { wpId: null, draft: '', typeHref: null, types: null, busy: false, error: '' };
const typesOfProject = new Map();   // projectHref -> Promise<[{ href, name }]>

function projectTypes(projectHref) {
  if (!typesOfProject.has(projectHref)) {
    typesOfProject.set(projectHref, getJson(`${projectHref}/types`)
      .then(d => (d._embedded?.elements ?? []).map(t => ({ href: t._links?.self?.href, name: t.name ?? '' })).filter(t => t.href))
      .catch(err => { typesOfProject.delete(projectHref); throw err; }));
  }
  return typesOfProject.get(projectHref);
}

const createSig = wpId => createState.wpId === wpId
  ? `${createState.busy}|${createState.error}|${createState.types?.length ?? -1}` : '';

async function createChild(button) {
  const wpId = viewWpId();
  if (!wpId) return;
  if (createState.wpId === wpId) {                     // already open: just focus it
    document.querySelector('.blm-jx-create-row input')?.focus();
    return;
  }
  Object.assign(createState, { wpId, draft: '', busy: false, error: '', types: null });
  schedule();
  try {
    const { href } = await wpProject(wpId);
    const types = await projectTypes(href);
    if (createState.wpId !== wpId) return;
    createState.types = types;
    createState.typeHref ??= (types.find(t => /^task$/i.test(t.name)) ?? types[0])?.href ?? null;
    if (!types.some(t => t.href === createState.typeHref)) createState.typeHref = (types.find(t => /^task$/i.test(t.name)) ?? types[0])?.href ?? null;
  } catch (err) {
    childActionNote(button, `Couldn't load the work package types (${err.message || 'request failed'}).`);
    createState.wpId = null;
  }
  schedule();
}

function closeCreateRow() {
  createState.wpId = null;
  createState.error = '';
  schedule();
}

async function submitCreate() {
  const wpId = createState.wpId;
  const subject = createState.draft.trim();
  if (!wpId || !subject || createState.busy) return;
  createState.busy = true;
  createState.error = '';
  schedule();
  try {
    const { href: projectHref } = await wpProject(wpId);
    const headers = writeHeaders();
    const body = { subject, _links: { parent: { href: `/api/v3/work_packages/${wpId}` }, project: { href: projectHref } } };
    if (createState.typeHref) body._links.type = { href: createState.typeHref };
    const res = await fetch(`${API_BASE}/api/v3/work_packages`, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message ?? ''; } catch { /* not JSON */ }
      throw new Error(msg || `HTTP ${res.status}`);
    }
    createState.draft = '';
    childCache.delete(wpId);                           // the new child shows after the refetch
  } catch (err) {
    createState.error = err.message || 'request failed';
  } finally {
    createState.busy = false;
    schedule();
  }
}

/** The new-item row (built inside the section, rebuilt with it). */
function buildCreateRow() {
  const li = el('li', 'blm-jx-create-row');
  const types = createState.types;
  const select = el('select', 'blm-jx-create-type');
  select.setAttribute('aria-label', 'Type of the new child');
  select.dataset.kid = 'new';
  select.dataset.focus = 'create-type';
  if (!types) select.append(el('option', null, 'Loading…'));
  else for (const t of types) {
    const o = el('option', null, t.name);
    o.value = t.href;
    o.selected = t.href === createState.typeHref;
    select.append(o);
  }
  select.disabled = !types || createState.busy;
  select.addEventListener('change', () => { createState.typeHref = select.value; });

  const input = el('input', 'blm-jx-create-input');
  input.type = 'text';
  input.placeholder = 'What needs to be done?';
  input.setAttribute('aria-label', 'Subject of the new child');
  input.value = createState.draft;
  input.dataset.kid = 'new';
  input.dataset.focus = 'create';
  input.readOnly = createState.busy;
  input.addEventListener('input', () => { createState.draft = input.value; });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitCreate(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCreateRow(); }
  });

  const create = el('button', 'blm-jx-create-go', createState.busy ? 'Creating…' : 'Create');
  create.type = 'button';
  create.disabled = createState.busy;
  create.addEventListener('click', submitCreate);
  const cancel = el('button', 'blm-jx-create-cancel', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', closeCreateRow);

  li.append(select, input, create, cancel);
  if (createState.error) {
    const err = el('p', 'blm-jx-create-error', `Couldn't create: ${createState.error}`);
    err.setAttribute('role', 'alert');
    li.append(err);
  }
  return li;
}

/** Work packages in the project matching an ID or subject words, minus the
 *  viewed one and its current children. */
async function searchCandidates(wpId, query) {
  const { id: projectId } = await wpProject(wpId);
  const filters = encodeURIComponent(JSON.stringify([
    { subjectOrId: { operator: '**', values: [query] } },
    { project: { operator: '=', values: [projectId] } },
  ]));
  const data = await getJson(`/api/v3/work_packages?filters=${filters}&pageSize=20`);
  const kids = new Set((childCache.get(wpId) ?? []).map?.(k => k.id) ?? []);
  return (data._embedded?.elements ?? [])
    .filter(w => String(w.id) !== wpId && !kids.has(String(w.id)))
    .map(w => ({ id: String(w.id), subject: w.subject ?? '', type: w._links?.type?.title ?? '' }));
}

function openAddExisting(button) {
  closePicker();
  const wpId = viewWpId();
  if (!wpId) return;
  const pop = el('div', 'blm-jx-picker');
  const input = el('input');
  input.type = 'search';
  input.placeholder = 'Search by ID or subject';
  input.setAttribute('aria-label', `Add an existing work package as a child of #${wpId}`);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'blm-jx-picker-list');
  const list = el('ul');
  list.id = 'blm-jx-picker-list';
  list.setAttribute('role', 'listbox');
  pop.append(input, list);
  document.body.append(pop);
  picker = { el: pop, button, wpId, kidId: null, field: 'existing', options: [], active: -1, state: 'ready' };
  button.setAttribute('aria-expanded', 'true');

  const note = text => { list.replaceChildren(el('li', 'blm-jx-picker-note', text)); picker.options = []; picker.active = -1; };
  const choose = async o => {
    closePicker({ refocus: true });
    try {
      await writeWp(o.id, 'parent', `/api/v3/work_packages/${wpId}`);
      childCache.delete(wpId);
      schedule();
    } catch (err) {
      childActionNote(button, `Couldn't add #${o.id}: ${err.message || 'request failed'}`);
    }
  };
  const show = results => {
    if (!picker || picker.el !== pop) return;
    list.replaceChildren();
    if (!results.length) { note('No matching work packages'); return; }
    results.forEach((o, i) => {
      const li = el('li', 'blm-jx-picker-option');
      li.id = `blm-jx-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const icon = el('span', 'blm-jx-icon');
      icon.dataset.type = typeKind(o.type.toLowerCase());
      li.append(icon, el('span', 'name', `#${o.id} ${o.subject}`));
      li.title = `#${o.id} ${o.subject}`;
      li.addEventListener('mousedown', e => e.preventDefault());
      li.addEventListener('mouseenter', () => { if (picker && picker.active !== i) { picker.active = i; markActive({ scroll: false }); } });
      li.addEventListener('click', () => choose(o));
      list.append(li);
    });
    picker.options = results;
    picker.active = 0;
    markActive();
  };

  note('Type an ID or words from the subject');
  placePicker();
  input.focus();
  let timer = 0, seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim().replace(/^#/, '');
    if (!q) { note('Type an ID or words from the subject'); return; }
    note('Searching…');
    timer = setTimeout(() => {
      const mine = ++seq;
      searchCandidates(wpId, q)
        .then(r => { if (mine === seq) show(r); })
        .catch(err => { if (mine === seq) note(`Couldn't search (${err.message || 'request failed'}).`); });
    }, 250);
  });
  input.addEventListener('keydown', e => {
    if (!picker) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!picker.options.length) return;
      const n = picker.options.length;
      picker.active = (picker.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      markActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (picker.active >= 0) choose(picker.options[picker.active]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      closePicker({ refocus: true });
    }
  });
}

document.addEventListener('click', e => {
  const b = e.target.closest?.('.blm-jx-children [data-child-action]');
  if (!b || !skinEnabled) return;
  e.preventDefault();
  e.stopPropagation();          // the document handler below would close the picker at once
  if (b.dataset.childAction === 'create') createChild(b);
  else if (picker?.button === b) closePicker({ refocus: true });
  else openAddExisting(b);
}, true);

// ─── Relations tab count without the children ───────────────────────────────────
//  OpenProject's "Relations (N)" counts children too. With Jira style on they
//  live in the Child work items section, so the label counts only the other
//  relations ("Relations" alone when there are none). The original text is kept
//  on the element and restored when the skin is turned off.

function relationsTab() {
  return [...document.querySelectorAll('.op-tab-row--link')].find(a => /^\s*relations\b/i.test(a.textContent)) ?? null;
}

/** The innermost element of the tab whose text holds the number. */
function relationsCountEl(link) {
  let best = null;
  for (const e of [link, ...link.querySelectorAll('*')]) {
    if (/\d/.test(e.textContent) && ![...e.children].some(c => /\d/.test(c.textContent))) best = e;
  }
  return best;
}

function adjustRelationsCount() {
  const link = relationsTab();
  const kids = childCache.get(viewWpId());
  if (!link || !Array.isArray(kids)) return;
  const node = relationsCountEl(link);
  if (!node) return;
  // OpenProject rewrote it (relations changed): take its text as the new original.
  if (node.dataset.blmShown === undefined || node.textContent !== node.dataset.blmShown) {
    node.dataset.blmOrig = node.textContent;
  }
  const orig = node.dataset.blmOrig;
  const total = Number(/(\d+)/.exec(orig)?.[1]);
  if (!Number.isFinite(total)) return;
  const others = Math.max(0, total - kids.length);
  const shown = others
    ? orig.replace(/\d+/, String(others))
    : orig.replace(/\s*\(\s*\d+\s*\)/, '').replace(/\d+/, '').trimEnd();
  node.dataset.blmShown = shown;
  if (node.textContent !== shown) node.textContent = shown;
}

function restoreRelationsCount() {
  for (const n of document.querySelectorAll('[data-blm-orig]')) {
    n.textContent = n.dataset.blmOrig;
    delete n.dataset.blmOrig;
    delete n.dataset.blmShown;
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

/** Lists, the split view and the full work-package page. */
function onWorkPackagePage() {
  return /\/work_packages(\/|$)/.test(location.pathname);
}

function onBacklogsPage() {
  return /\/backlogs(\/|$)/.test(location.pathname);
}

// Dark theme: the skin is token-driven, so dark is a second set of tokens plus
// OpenProject's own design variables (body, forms, menus, tables, editor) and a
// short list of surfaces that hard-code white. Palette: Catppuccin Mocha.
const D = `html.${ROOT_CLASS}[data-blm-theme="dark"]`;
const DARK = `
${D} {
  color-scheme: dark;
  --jx-text: #cdd6f4;
  --jx-text-subtle: #a6adc8;
  --jx-text-subtlest: #a1a8c3;
  --jx-link: #89b4fa;
  --jx-link-hover: #b4befe;
  --jx-surface: #1e1e2e;
  --jx-surface-sunken: #181825;
  --jx-surface-raised: #313244;
  --jx-hover: rgba(205, 214, 244, 0.05);
  --jx-selected: rgba(137, 180, 250, 0.14);
  --jx-selected-hover: rgba(137, 180, 250, 0.22);
  --jx-border: rgba(205, 214, 244, 0.09);
  --jx-btn: rgba(205, 214, 244, 0.07);
  --jx-btn-hover: rgba(205, 214, 244, 0.13);
  --jx-btn-press: rgba(205, 214, 244, 0.19);
  --jx-primary: #89b4fa;
  --jx-primary-hover: #b4befe;
  --jx-primary-press: #74c7ec;
  --jx-on-primary: #11111b;
  --jx-focus: #89b4fa;
  --jx-todo-bg: rgba(205, 214, 244, 0.09);
  --jx-todo-fg: #bac2de;
  --jx-progress-bg: rgba(137, 180, 250, 0.16);
  --jx-progress-fg: #89b4fa;
  --jx-done-bg: rgba(166, 227, 161, 0.15);
  --jx-done-fg: #a6e3a1;
  --jx-todo-bg-hover: rgba(205, 214, 244, 0.15);
  --jx-progress-bg-hover: rgba(137, 180, 250, 0.26);
  --jx-done-bg-hover: rgba(166, 227, 161, 0.25);
  --jx-type-story: #a6e3a1;
  --jx-type-bug: #f38ba8;
  --jx-type-task: #89b4fa;
  --jx-type-epic: #cba6f7;
  --jx-type-feature: #94e2d5;
  --jx-type-other: #7f849c;
  --jx-on-icon: #11111b;
  --jx-prio-highest: #f38ba8;
  --jx-prio-high: #fab387;
  --jx-prio-medium: #f9e2af;
  --jx-prio-low: #89b4fa;

  /* OpenProject's own design variables */
  --body-background: var(--jx-surface);
  --body-font-color: var(--jx-text);
  --h1-font-color: var(--jx-text);
  --h2-font-color: var(--jx-text);
  --h3-font-color: var(--jx-text);
  --h4-font-color: var(--jx-text);
  --content-link-color: var(--jx-link);
  --content-link-hover-active-color: var(--jx-link-hover);
  --content-icon-color: var(--jx-link);
  --content-icon-link-color: var(--jx-text-subtle);
  --content-icon-link-hover-color: var(--jx-link-hover);
  --content-default-border-color: var(--jx-border);
  --content-form-bg-color: var(--jx-surface-sunken);
  --content-form-input-border: 1px solid rgba(205, 214, 244, 0.32);
  --content-form-input-hover-border: 1px solid rgba(205, 214, 244, 0.34);
  --content-form-separator-color: var(--jx-border);
  --content-form-error-color: #f38ba8;
  --header-drop-down-bg-color: var(--jx-surface-raised);
  --header-drop-down-border-color: var(--jx-border);
  --header-drop-down-item-font-color: var(--jx-text);
  --header-drop-down-item-font-hover-color: var(--jx-link-hover);
  --header-drop-down-projects-search-font-color: var(--jx-text);
  --header-drop-down-projects-search-bg-color: var(--jx-surface-sunken);
  --header-drop-down-projects-search-input-bg-color: var(--jx-surface);
  --header-drop-down-projects-search-input-border-color: var(--jx-border);
  --drop-down-unselected-font-color: var(--jx-text);
  --drop-down-selected-font-color: var(--jx-link-hover);
  --drop-down-selected-bg-color: var(--jx-selected);
  --drop-down-hover-bg-color: var(--jx-hover);
  --action-menu-bg-color: var(--jx-surface-raised);
  --toolbar-title-color: var(--jx-text);
  --toolbar-item--bg-color: var(--jx-btn);
  --toolbar-item--bg-color-pressed: var(--jx-btn-press);
  --toolbar-item--border-color: var(--jx-border);
  --breadcrumb-bg-color: var(--jx-surface-sunken);
  --breadcrumb-border-color: var(--jx-border);
  --breadcrumb-font-color: var(--jx-text-subtle);
  --table-row-border-color: var(--jx-border);
  --table-row-highlighting-color: var(--jx-selected);
  --table-row-highlighting-outline-color: var(--jx-focus);
  --table-row-relations-row-background-color: rgba(137, 180, 250, 0.08);
  --table-row-hierarchies-row-font-color: var(--jx-text-subtle);
  --table-header-border-color: var(--jx-border);
  --table-header-shadow-color: var(--jx-border);
  --button--font-color: var(--jx-text);
  --button--background-color: var(--jx-btn);
  --button--background-hover-color: var(--jx-btn-hover);
  --button--border-color: var(--jx-border);
  --button--active-font-color: var(--jx-text);
  --button--active-background-color: var(--jx-btn-press);
  --button--active-border-color: var(--jx-border);
  --inplace-edit--border-color: var(--jx-border);
  --inplace-edit--dark-background: var(--jx-surface-sunken);
  --inplace-edit--color--very-dark: var(--jx-text-subtle);
  --inplace-edit--bg-color--disabled: var(--jx-surface-sunken);
  --inplace-edit--color--disabled: var(--jx-text-subtlest);
  --widget-box-block-bg-color: var(--jx-surface);
  --widget-box-block-border-color: var(--jx-border);
  --grid-background-color: var(--jx-surface-sunken);
  --loading-indicator-bg-color: var(--jx-surface);
  --user-avatar-default-bg-color: var(--jx-surface-raised);
  --timeline--grid-color: rgba(205, 214, 244, 0.07);
  --ck-color-base-foreground: var(--jx-surface-raised);
  --ck-color-base-background: var(--jx-surface-sunken);
  --ck-color-base-border: rgba(205, 214, 244, 0.32);
  --ck-color-base-text: var(--jx-text);
  --ck-color-input-border: rgba(205, 214, 244, 0.32);
  --ck-color-input-disabled-background: var(--jx-surface);
  --ck-color-input-disabled-text: var(--jx-text-subtlest);
  --ck-color-button-default-hover-background: var(--jx-btn-hover);
  --ck-color-button-default-active-background: var(--jx-btn-press);
  --ck-color-button-on-background: var(--jx-selected);
  --ck-color-button-on-hover-background: var(--jx-selected-hover);
  --ck-color-tooltip-background: #cdd6f4;
  --ck-color-tooltip-text: #1e1e2e;
  --ck-color-engine-placeholder-text: var(--jx-text-subtlest);
  --ck-color-link-default: var(--jx-link);
}
${D},
${D} body { background: var(--jx-surface); color: var(--jx-text); }

/* Surfaces that hard-code white */
${D} #content,
${D} #content-wrapper,
${D} .work-packages-page,
${D} .work-packages-page--ui-view,
${D} .work-packages--list-container,
${D} .wp-table--container,
${D} .generic-table--container { background: var(--jx-surface) !important; color: var(--jx-text); }
${D} .work-packages--filters-optional-container,
${D} .work-packages--filters-container,
${D} .advanced-filters--container { background: var(--jx-surface-sunken) !important; border-color: var(--jx-border) !important; }
${D} input:is([type="text"], [type="search"], [type="email"], [type="number"], [type="password"], [type="url"], [type="tel"], [type="date"], [type="time"], [type="datetime-local"], :not([type])),
${D} select,
${D} textarea,
${D} .ng-select .ng-select-container {
  background-color: var(--jx-surface-sunken) !important; color: var(--jx-text) !important;
  border-color: rgba(205, 214, 244, 0.32) !important;
}
${D} input:is([type="text"], [type="search"], [type="email"], [type="number"], [type="password"], [type="url"], [type="tel"], [type="date"], [type="time"], [type="datetime-local"], :not([type])):focus,
${D} select:focus,
${D} textarea:focus,
${D} .ng-select.ng-select-focused > .ng-select-container { border-color: var(--jx-focus) !important; box-shadow: none !important; }
${D} ::placeholder { color: var(--jx-text-subtlest) !important; opacity: 1; }
${D} .ng-dropdown-panel,
${D} .dropdown-menu,
${D} .op-modal,
${D} .spot-modal,
${D} .op-modal--modal-container,
${D} .contextMenu-container,
${D} .dropdown-menu--container,
${D} .op-hover-card,
${D} .flatpickr-calendar,
${D} .op-datepicker-modal {
  background: var(--jx-surface-raised) !important; color: var(--jx-text) !important;
  border-color: var(--jx-border) !important;
  box-shadow: 0 8px 24px rgba(17, 17, 27, 0.6) !important;
}
${D} .ng-dropdown-panel .ng-option,
${D} .dropdown-menu a,
${D} .contextMenu-container a { color: var(--jx-text) !important; background: transparent; }
${D} .ng-dropdown-panel .ng-option.ng-option-marked,
${D} .ng-dropdown-panel .ng-option:hover,
${D} .dropdown-menu a:hover,
${D} .contextMenu-container a:hover { background: var(--jx-hover) !important; color: var(--jx-link-hover) !important; }
${D} .ng-dropdown-panel .ng-option.ng-option-selected { background: var(--jx-selected) !important; }
${D} .flatpickr-day:not(.prevMonthDay):not(.nextMonthDay):not(.flatpickr-disabled):not(.startRange):not(.endRange) { color: var(--jx-text); }
${D} .flatpickr-day:is(.prevMonthDay, .nextMonthDay, .flatpickr-disabled) { color: var(--jx-text-subtlest); }
${D} .flatpickr-day:is(.startRange, .endRange) { background: var(--jx-primary); color: var(--jx-on-primary); border-color: var(--jx-primary); }
${D} .flatpickr-day:hover { background: var(--jx-hover); border-color: transparent; }
${D} .flatpickr-day.selected { background: var(--jx-primary); color: var(--jx-on-primary); border-color: var(--jx-primary); }
${D} .flatpickr-months .flatpickr-month,
${D} .flatpickr-weekday,
${D} .flatpickr-current-month input.cur-year { color: var(--jx-text) !important; fill: var(--jx-text); background: transparent !important; }
${D} .work-packages--details,
${D} .work-packages--show-view,
${D} .work-packages-full-view--split-container,
${D} .work-packages--details-content,
${D} .work-package--single-view,
${D} .work-packages--panel-inner,
${D} .tabcontent,
${D} .op-uc-container { background: var(--jx-surface) !important; color: var(--jx-text); }
${D} .op-uc-container code,
${D} .op-uc-container pre { background: var(--jx-surface-sunken); color: var(--jx-text); border-color: var(--jx-border); }
${D} .op-uc-container table td,
${D} .op-uc-container table th { border-color: var(--jx-border) !important; }
${D} .wp-table--hierarchy-span { color: var(--jx-text-subtle); }
${D} hr { border-color: var(--jx-border); }
${D} .op-avatar,
${D} .op-principal--avatar { background-color: var(--jx-surface-raised); }
${D} { scrollbar-color: rgba(205, 214, 244, 0.28) transparent; scrollbar-width: thin; }

/* Group headers ("New (1)"), plain rows and the hovered row keep OpenProject's white
   out of the table */
${D} .work-package-table tr.-group-header,
${D} .work-package-table tr.-group-header > td,
${D} .work-package-table tr[class*="group-header"],
${D} .work-package-table tr[class*="group-header"] > td,
${D} .work-package-table .group--value,
${D} .work-package-table .group-header { background: var(--jx-surface-sunken) !important; color: var(--jx-text); }
${D} .work-package-table .count { color: var(--jx-text-subtle); }
${D} .work-package-table tbody tr,
${D} .work-package-table tbody tr:hover { background-color: transparent !important; }
${D} .work-package-table th,
${D} .work-package-table td { background-color: transparent !important; }
${D} .work-package-table tbody tr.wp-table--row:hover > td { background-color: var(--jx-hover) !important; }
${D} .work-package-table tbody tr.wp-table--row.-checked > td,
${D} .work-package-table tbody tr.wp-table--row.-checked:hover > td { background-color: var(--jx-selected) !important; }
${D} .work-package-table tr[class*="group-header"] > td,
${D} .work-package-table tr.-group-header > td { background-color: var(--jx-surface-sunken) !important; }

/* Activity tab: change lines ("Status changed from New to Specified") are grey in
   OpenProject and nearly vanish on dark */
${D} [class*="activities"] li,
${D} [class*="activities"] li :not(a):not(a *):not(.op-avatar),
${D} [class*="activity-contents"] li,
${D} [class*="activity-contents"] li :not(a):not(a *):not(.op-avatar),
${D} .journal-details li,
${D} .journal-details li :not(a):not(a *) { color: var(--jx-text) !important; }
${D} [class*="activities"] li::marker,
${D} [class*="activity-contents"] li::marker { color: var(--jx-text-subtle); }
/* Modals (Log time, Create...): header, body and the button bar are separate white
   panels in OpenProject */
${D} :is(.spot-modal, .op-modal, .op-modal--modal-container) :is([class*="header"], [class*="body"], [class*="footer"], [class*="action-bar"], [class*="buttons"]) {
  background: transparent !important; color: var(--jx-text);
}
${D} :is(.spot-modal, .op-modal, .op-modal--modal-container) [class*="header"] { border-color: var(--jx-border) !important; }
${D} :is(.spot-modal, .op-modal, .op-modal--modal-container) [class*="footer"],
${D} :is(.spot-modal, .op-modal, .op-modal--modal-container) [class*="action-bar"] { border-color: var(--jx-border) !important; }
${D} :is(.spot-modal, .op-modal, .op-modal--modal-container) :is(label, legend, h1, h2, h3, span:not([class*="error"]):not([class*="required"]):not([class*="warning"])) { color: var(--jx-text); }
${D} :is(.spot-modal, .op-modal, .op-modal--modal-container) .button:not(.-highlight):not(.-primary):not(.-alt-highlight) { background: var(--jx-btn) !important; color: var(--jx-text) !important; border-color: var(--jx-border) !important; }

/* Split view / full page: the bottom toolbar (Watch, More) and the tables on the
   Relations tab (Children, Parent) */
${D} :is(.work-packages--details, .work-packages--show-view) [class*="toolbar"]:not(.toolbar-container) { background: var(--jx-surface-sunken) !important; border-color: var(--jx-border) !important; }
${D} :is(.work-packages--details, .work-packages--show-view) [class*="toolbar"] .button:not(.-highlight):not(.-primary):not(.-alt-highlight) { background: var(--jx-btn) !important; color: var(--jx-text) !important; border-color: var(--jx-border) !important; }
${D} :is(.work-packages--details, .work-packages--show-view) :is(table, thead, tbody, tr, td, th, [class*="wp-table--cell"], [class*="sort-header"], [class*="relation"]) { background-color: transparent !important; color: var(--jx-text); }
${D} :is(.work-packages--details, .work-packages--show-view) :is(th, th *) { color: var(--jx-text-subtlest); }
${D} :is(.work-packages--details, .work-packages--show-view) :is(td, tr) { border-color: var(--jx-border) !important; }

/* Time and costs report: the result table paints grey cells and light-blue links
   that vanish on dark */
${D} #result-table :is(table, thead, tbody, tr, td, th) { background-color: transparent !important; color: var(--jx-text) !important; border-color: var(--jx-border) !important; }
${D} #result-table :is(th, td.top, td.inner) { background-color: var(--jx-surface-sunken) !important; }
${D} #result-table :is(th, th *) { color: var(--jx-text-subtle) !important; }
${D} #result-table a { color: var(--jx-link) !important; }
${D} #result-table td.result,
${D} #result-table tr.result td { background-color: var(--jx-surface-raised) !important; }
${D} #result-table :is(td, th, tr):is(:hover, .hover, .highlight, .highlighted, [class*="hover"]) { background: var(--jx-hover) !important; }
${D} #result-table :is(td, th) { background-image: none !important; }
${D} #result-table :is(tr, td, th, div, span, p):hover,
${D} #result-table :is(tr, td, th):hover > * { background-color: var(--jx-hover) !important; background-image: none !important; color: var(--jx-text) !important; }
${D} #result-table tr:hover :is(td, th) { background-color: var(--jx-hover) !important; }
${D} #result-table td[style] { background: transparent !important; color: var(--jx-text) !important; }
${D} #result-table td:not(:hover) *:not(a) { color: var(--jx-text) !important; background: transparent !important; }
${D} .report-form-container :is(label, legend, h2, h3, .filter-label, .form--label, .form--field-container),
${D} #query_form :is(label, legend, .form--label, .form--radio-button-container) { color: var(--jx-text) !important; }
/* Group-by bars: light-grey strips holding the selected attribute chips */
${D} :is(#group-by--container, .group-by--container) :is(.group-by--selected-elements, .group-by--selected-elements *:not(.group-by--selected-element):not(.group-by--selected-element *), .group-by--add-container) { background: var(--jx-surface-sunken) !important; }
${D} :is(#group-by--container, .group-by--container) :is(select, .group-by--add-element) { background: var(--jx-surface-sunken) !important; color: var(--jx-text) !important; }

/* The header is sticky: it needs a solid background or rows scroll through it.
   The column that gets highlighted white on header hover is painted by a <col> or by
   a header pseudo-element, not by the cells */
${D} .work-package-table thead th { background-color: var(--jx-surface) !important; }
/* Hovered column name: OpenProject whitens the inner sort-header box */
${D} .work-package-table thead th * { background-color: transparent !important; }
${D} .work-package-table thead th:hover { background-color: var(--jx-surface-raised) !important; }
${D} .work-package-table thead th:hover,
${D} .work-package-table thead th:hover * { color: var(--jx-text) !important; }
${D} table col,
${D} table colgroup { background: transparent !important; }
${D} table th::before,
${D} table th::after { background-color: transparent !important; box-shadow: none !important; }

/* Include projects popover */
${D} :is([class*="project-list"], [class*="include-projects"], [class*="project-select"], [class*="projects-menu"]):is(div, section, dialog, ul) {
  background-color: var(--jx-surface-raised) !important; color: var(--jx-text) !important; border-color: var(--jx-border) !important;
}
${D} :is([class*="project-list"], [class*="include-projects"], [class*="project-select"]) :is(div, header, footer, section, ul, li, label, span, h1, h2, h3):not([class*="button"]):not([class*="checkbox"]):not(.op-avatar) {
  background-color: transparent !important; color: var(--jx-text) !important; border-color: var(--jx-border) !important;
}
${D} :is([class*="project-list"], [class*="include-projects"], [class*="project-select"]) :is(footer, [class*="footer"]) { background-color: var(--jx-surface-sunken) !important; }
${D} :is([class*="project-list"], [class*="include-projects"], [class*="project-select"]) .button:not(.-primary):not(.-highlight) { background: var(--jx-btn) !important; color: var(--jx-text) !important; border-color: var(--jx-border) !important; }

/* Filter panel: labels, selected-value pills, the divider */
${D} :is([class*="advanced-filters"], [class*="filters-container"], .work-packages--filters-optional-container) :is(label, [class*="filter-name"], [class*="name"], [class*="label"]) { color: var(--jx-text-subtle) !important; }
${D} :is([class*="advanced-filters"], [class*="filters-container"], .work-packages--filters-optional-container) :is(hr, div, form, ul, li, fieldset) { border-color: var(--jx-border) !important; }
${D} .ng-select .ng-value,
${D} .ng-select .ng-value-container .ng-value { background-color: var(--jx-btn-press) !important; color: var(--jx-text) !important; border-radius: var(--jx-radius); }
${D} .ng-select .ng-value .ng-value-label,
${D} .ng-select .ng-value .ng-value-icon { color: var(--jx-text) !important; background: transparent !important; }
${D} .ng-select .ng-value .ng-value-icon:hover { background: var(--jx-btn-hover) !important; }
${D} .ng-select .ng-arrow-wrapper .ng-arrow { border-top-color: var(--jx-text-subtle) !important; }
${D} .ng-select .ng-clear-wrapper .ng-clear { color: var(--jx-text-subtle) !important; }

/* Spot components (Include projects drop-down, tooltips, lists, checkboxes) */
${D} .spot-drop-modal--body,
${D} .spot-tooltip--body {
  background: var(--jx-surface-raised) !important; color: var(--jx-text) !important;
  border: 1px solid var(--jx-border) !important; box-shadow: 0 8px 24px rgba(17, 17, 27, 0.6) !important;
}
${D} .spot-drop-modal--body :is(.spot-container, .spot-list, .spot-list--item, form) { background: transparent !important; color: var(--jx-text); }
${D} .spot-action-bar { background: var(--jx-surface-sunken) !important; border-color: var(--jx-border) !important; color: var(--jx-text); }
${D} .spot-list--item-action:hover { background: var(--jx-hover) !important; }
${D} .spot-list--item-action_disabled .spot-list--item-title { color: var(--jx-text-subtle) !important; }
${D} :is(.spot-list--item-title, .spot-body-small, .spot-body, .op-project-include--include-all-text) { color: var(--jx-text) !important; }
${D} .spot-text-field { background: var(--jx-surface-sunken) !important; border-color: rgba(205, 214, 244, 0.32) !important; color: var(--jx-text); }
${D} .spot-text-field:focus-within { border-color: var(--jx-focus) !important; }
${D} .spot-text-field--input { background: transparent !important; color: var(--jx-text) !important; border: 0 !important; }
${D} .spot-icon { color: var(--jx-text-subtle); }
${D} .spot-checkbox--fake { background: var(--jx-surface-sunken) !important; border-color: rgba(205, 214, 244, 0.4) !important; }
${D} .spot-checkbox--input:checked ~ .spot-checkbox--fake { background: var(--jx-primary) !important; border-color: var(--jx-primary) !important; color: var(--jx-on-primary); }
${D} .spot-checkbox--input:checked ~ .spot-checkbox--fake::before,
${D} .spot-checkbox--input:checked ~ .spot-checkbox--fake::after { border-color: var(--jx-on-primary) !important; color: var(--jx-on-primary) !important; }
${D} .spot-checkbox--input:disabled ~ .spot-checkbox--fake { opacity: 0.55; }
${D} .spot-drop-modal--close-button { color: var(--jx-text-subtle); background: transparent; }

/* Primary buttons: icon and label share the dark-on-pastel contrast */
${D} :is(.button.-alt-highlight, .button.-highlight, .button.-primary) :is(.spot-icon, .button--icon, .button--text, .button--dropdown-indicator, op-icon, i, span) {
  color: var(--jx-on-primary) !important; border-color: currentColor;
}
${D} :is(.button.-alt-highlight, .button.-highlight, .button.-primary) .spot-icon::before { color: var(--jx-on-primary) !important; }

/* Header project switcher: rows and the current project */
${D} :is([class*="project-list"], [class*="project-select"]) :is(a, button, li, label):not([class*="button"]):not([class*="checkbox"]) { background-color: transparent !important; color: var(--jx-text) !important; }
${D} :is([class*="project-list"], [class*="project-select"]) :is(a, button, li, label):not([class*="button"]):not([class*="checkbox"]):hover { background-color: var(--jx-hover) !important; color: var(--jx-link-hover) !important; }
${D} :is([class*="project-list"], [class*="project-select"]) :is(a, button, li, label)[class*="active"]:not([class*="button"]),
${D} :is([class*="project-list"], [class*="project-select"]) :is(a, button, li, label)[class*="selected"]:not([class*="button"]),
${D} :is([class*="project-list"], [class*="project-select"]) :is(a, button, li, label)[class*="current"]:not([class*="button"]),
${D} :is([class*="project-list"], [class*="project-select"]) :is(a, button, li, label)[aria-selected="true"]:not([class*="button"]),
${D} :is([class*="project-list"], [class*="project-select"]) :is(a, button, li, label)[aria-current]:not([class*="button"]) { background-color: var(--jx-selected) !important; color: var(--jx-link-hover) !important; }
${D} :is([class*="project-list"], [class*="project-select"]) :is(a, button, li, label) :is(span, div):not([class*="checkbox"]) { color: inherit !important; }

/* Borders and dividers: OpenProject draws many of them with currentColor or white, which
   reads as hard white lines on dark. Containers get a hairline; the detail pane gets a
   soft shadow for depth instead of an outline. Only block-level elements are touched, so
   focus rings, tab underlines, pills and form controls keep their own colours. */
${D} :is(
  .work-packages--details, .work-packages--show-view, .work-packages-partitioned-page--content-right,
  .work-packages-partitioned-page--content-left, .work-packages-partitioned-query-space--container,
  .work-packages--details-form, .work-package--single-view, .toolbar-container,
  .op-scrollable-tabs, .op-wp-breadcrumb, .main-menu, .main-menu--resizer,
  .work-packages--resizer, .work-packages--details--resizer, .work-packages--tabletimeline--timeline--resizer,
  .op-app-header, .op-sidemenu, .searchable-menu, .spot-modal, .op-modal
),
${D} :is(
  .work-packages--details, .work-packages--show-view, .work-packages-partitioned-page--content-right,
  .work-packages-partitioned-query-space--container, .work-packages--details-form,
  .work-package--single-view, .op-scrollable-tabs, #main-menu, .main-menu
) :is(div, section, header, footer, nav, aside, ul, ol, li, table, thead, tbody, tr, td, th, form, fieldset, hr, edit-form, wp-single-view),
${D} :is(hr, .spot-divider, .op-menu--separator) { border-color: var(--jx-border) !important; }
${D} #main-menu { border-color: var(--jx-border) !important; }
${D} :is(.work-packages--details, .work-packages--show-view, .work-packages-partitioned-page--content-right) { outline: 0 !important; }
${D} .work-packages--details { border-left: 1px solid var(--jx-border) !important; box-shadow: -14px 0 28px -18px rgba(17, 17, 27, 0.75); }
${D} .work-packages--details-header,
${D} .op-scrollable-tabs { box-shadow: none !important; }
${D} .work-packages--details-header { border-bottom: 1px solid var(--jx-border) !important; }
${D} .op-scrollable-tabs { border-bottom: 1px solid var(--jx-border) !important; }
${D} .work-packages--details-toolbar-container,
${D} .work-packages--details-toolbar { border-top: 1px solid var(--jx-border) !important; border-color: var(--jx-border) !important; }
${D} :is(.work-packages--resizer, .work-packages--details--resizer, .main-menu--resizer) { background-color: transparent !important; color: var(--jx-text-subtlest); }
${D} :is(.work-packages--resizer, .work-packages--details--resizer, .main-menu--resizer):hover { color: var(--jx-link); }

/* Detail pane leftovers: editable fields flash white on hover, tab links and section
   headings keep currentColor/white borders, relation and watcher rows light up white */
${D} :is(.work-packages--details, .work-packages--show-view) :is(h1, h2, h3, h4, span, a, label, button, p, [class*="attributes-group"], [class*="op-tab-row"], [class*="form--"], [class*="-editable"], [class*="inline-edit"], [class*="op-principal"], [class*="wp-relations"], [class*="user-comment"], [class*="activity"]):not(.button):not(:focus-visible) { border-color: var(--jx-border); }
${D} :is(.work-packages--details, .work-packages--show-view) :is([class*="-editable"], [class*="inline-edit--display-field"], [class*="inline-edit--container"], [class*="op-tab-row--link"], [class*="wp-relations"] [class*="row"], [class*="op-principal"], [class*="user-comment"], [class*="activity"] li, [class*="attributes-group"] [class*="key-value"], li, tr):hover:not(.button) { background-color: var(--jx-hover) !important; color: var(--jx-text); box-shadow: none !important; border-color: var(--jx-border); }
${D} :is(.work-packages--details, .work-packages--show-view) .inline-edit--display-field:hover { border-color: rgba(205, 214, 244, 0.22) !important; }
${D} :is(.work-packages--details, .work-packages--show-view) :is([class*="user-comment"], [class*="comment-container"], [class*="activity-comment"]) { background-color: transparent !important; }
${D} .op-tab-row--link { color: var(--jx-text-subtle); }
${D} .op-tab-row--link:hover { color: var(--jx-text); }
${D} .op-tab-row--link_selected, ${D} .op-tab-row--link_selected:hover { color: var(--jx-link-hover); }

/* Files tab: drop zone and attachment rows */
${D} :is([class*="drop-box"], [class*="dropzone"], [class*="drop-zone"], [class*="attachments--drop"], [class*="attachment-drop"]) {
  background: var(--jx-surface-sunken) !important; border: 1px dashed rgba(205, 214, 244, 0.32) !important;
  color: var(--jx-text-subtle) !important; border-radius: var(--jx-radius-panel);
  transition: border-color var(--jx-dur) var(--jx-ease-out), background-color var(--jx-dur) var(--jx-ease-out);
}
${D} :is([class*="drop-box"], [class*="dropzone"], [class*="drop-zone"], [class*="attachments--drop"], [class*="attachment-drop"]):is(:hover, [class*="drag"], [class*="active"]) {
  border-color: var(--jx-link) !important; background: var(--jx-selected) !important; color: var(--jx-link-hover) !important;
}
${D} :is([class*="drop-box"], [class*="dropzone"], [class*="drop-zone"], [class*="attachments--drop"], [class*="attachment-drop"]) :is(span, p, a, i) { color: inherit !important; background: transparent !important; }
${D} :is([class*="file-list"], [class*="attachment-list"], [class*="attachments"]) :is(li, tr, td) { background-color: transparent !important; border-color: var(--jx-border) !important; }

/* OpenProject's own progress bar (rows without subtasks) */
${D} .progress-bar { background: rgba(205, 214, 244, 0.1) !important; border-color: rgba(205, 214, 244, 0.22) !important; }

/* Pagination and per-page boxes */
${D} li.op-pagination--item,
${D} .op-pagination--item-link { background: var(--jx-surface-raised) !important; color: var(--jx-text) !important; border-color: var(--jx-border) !important; }
${D} .op-pagination--items,
${D} .op-pagination--pages,
${D} .op-pagination--options,
${D} .op-pagination--range,
${D} .work-packages-split-view--tabletimeline-footer { background: transparent !important; color: var(--jx-text-subtle); }
${D} li.op-pagination--item_current,
${D} .op-pagination--item-link:hover { background: var(--jx-selected) !important; color: var(--jx-link-hover) !important; }

/* The editable page title is only boxed while it has focus */
${D} .toolbar-container .title-container input:not(:focus) { background: transparent !important; border-color: transparent !important; }

/* Subtask bar and popover from content.js */
${D} .blm-native-bar { background: rgba(205, 214, 244, 0.08) !important; border-color: rgba(205, 214, 244, 0.22) !important; }
${D} .blm-native-bar > .blm-native-done { background: #a6e3a1; }
${D} .blm-native-bar > .blm-native-prog { background: #f9e2af; }
${D} .blm-native-bar > .blm-count { color: var(--jx-text); text-shadow: 0 0 2px #11111b, 0 0 4px #11111b; }
${D} .blm-native-host:hover > .blm-native-bar { border-color: var(--jx-focus) !important; box-shadow: 0 0 0 3px rgba(137, 180, 250, 0.2); }
${D} .blm-warn { background: rgba(249, 226, 175, 0.12); border-color: rgba(249, 226, 175, 0.4); color: #f9e2af; }
${D} .blm-pop { background: var(--jx-surface-raised); color: var(--jx-text); border-color: var(--jx-border); box-shadow: 0 10px 30px rgba(17, 17, 27, 0.65); }
${D} .blm-pop-head { color: var(--jx-text-subtlest); border-bottom-color: var(--jx-border); }
${D} .blm-pop-head .dot.other { background: #585b70; }
${D} .blm-pop-note { background: rgba(249, 226, 175, 0.12); color: #f9e2af; }
${D} .blm-pop li + li { border-top-color: var(--jx-border); }
${D} .blm-pop .pop-id { color: var(--jx-text-subtle); }
${D} .blm-pop .pop-id:hover,
${D} .blm-fix-msg a { color: var(--jx-link-hover); }
${D} .blm-pop .pop-pct { color: #fab387; }
${D} .blm-pop .pop-status { background: var(--jx-todo-bg); color: var(--jx-todo-fg); }
${D} .blm-pop .pop-status.done { background: var(--jx-done-bg); color: var(--jx-done-fg); }
${D} .blm-pop .pop-status.prog { background: rgba(249, 226, 175, 0.16); color: #f9e2af; }
${D} .blm-fix-btn { background: var(--jx-primary); border-color: var(--jx-primary); color: var(--jx-on-primary); }
${D} .blm-fix-btn:hover { background: var(--jx-primary-hover); }
`;

// Motion and feedback. Only opacity, translate, scale and colours animate (cheap, no
// layout); everything sits behind prefers-reduced-motion. 'translate' and 'scale' are
// the individual properties, so they never fight OpenProject's own 'transform'.
const MOTION = `
@media (prefers-reduced-motion: no-preference) {
  @keyframes blm-pop-in   { from { opacity: 0; translate: 0 6px; scale: 0.985; } to { opacity: 1; translate: 0 0; scale: 1; } }
  @keyframes blm-fade-in  { from { opacity: 0; } to { opacity: 1; } }
  @keyframes blm-row-in   { from { opacity: 0; translate: 0 3px; } to { opacity: 1; translate: 0 0; } }

  /* Menus, drop-downs, popovers and dialogs ease in instead of snapping */
  html.${ROOT_CLASS} .spot-drop-modal--body,
  html.${ROOT_CLASS} .spot-tooltip--body,
  html.${ROOT_CLASS} .ng-dropdown-panel,
  html.${ROOT_CLASS} .op-app-menu--dropdown,
  html.${ROOT_CLASS} .contextMenu-container,
  html.${ROOT_CLASS} .dropdown-menu,
  html.${ROOT_CLASS} .flatpickr-calendar.open,
  html.${ROOT_CLASS} .op-hover-card { animation: blm-pop-in 150ms var(--jx-ease-out) backwards; transform-origin: top center; }
  html.${ROOT_CLASS} .spot-modal,
  html.${ROOT_CLASS} .op-modal,
  html.${ROOT_CLASS} .op-modal--modal-container { animation: blm-pop-in 180ms var(--jx-ease-out) backwards; }
  html.${ROOT_CLASS} .op-modal-overlay,
  html.${ROOT_CLASS} .spot-modal-overlay,
  html.${ROOT_CLASS} .op-modal--overlay { animation: blm-fade-in 160ms ease-out backwards; }


  /* Hover and press feedback */
  html.${ROOT_CLASS} .button,
  html.${ROOT_CLASS} .op-app-menu--item-action,
  html.${ROOT_CLASS} .op-tab-row--link,
  html.${ROOT_CLASS} .op-pagination--item-link,
  html.${ROOT_CLASS} .spot-list--item-action,
  html.${ROOT_CLASS} .op-sidemenu--item-action,
  html.${ROOT_CLASS} .wp-table-context-menu-icon,
  html.${ROOT_CLASS} .wp-table--details-link {
    transition: background-color var(--jx-dur) var(--jx-ease-out), color var(--jx-dur) var(--jx-ease-out),
                border-color var(--jx-dur) var(--jx-ease-out), box-shadow var(--jx-dur) var(--jx-ease-out),
                scale 90ms var(--jx-ease-out);
  }
  html.${ROOT_CLASS} .button:not(:disabled):not(.-disabled):active,
  html.${ROOT_CLASS} .op-app-menu--item-action:active,
  html.${ROOT_CLASS} .op-pagination--item-link:active { scale: 0.97; }
  html.${ROOT_CLASS} .toolbar-items .button.-alt-highlight:hover,
  html.${ROOT_CLASS} .toolbar-items .button.-highlight:hover { box-shadow: 0 2px 10px color-mix(in srgb, var(--jx-primary) 35%, transparent); }

  html.${ROOT_CLASS} .work-package-table tbody td { transition: background-color var(--jx-dur) var(--jx-ease-out); }
  html.${ROOT_CLASS} .work-package-table td.assignee .op-avatar { transition: scale 140ms var(--jx-ease-out); }
  html.${ROOT_CLASS} .work-package-table tr:hover td.assignee .op-avatar { scale: 1.08; }
  html.${ROOT_CLASS} .work-package-table .blm-jx-lozenge { transition: background-color var(--jx-dur) var(--jx-ease-out), color var(--jx-dur) var(--jx-ease-out); }
  html.${ROOT_CLASS} .op-tab-row--link { border-bottom: 2px solid transparent; }
  /* Selected tab: the underline draws itself in each time a tab becomes current */
  @keyframes blm-underline { from { background-size: 0 2px; } to { background-size: 100% 2px; } }
  html.${ROOT_CLASS} .op-tab-row--link_selected {
    border-bottom-color: transparent;
    background-image: linear-gradient(var(--jx-link), var(--jx-link));
    background-repeat: no-repeat; background-position: left bottom; background-size: 100% 2px;
    animation: blm-underline 260ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  }
  /* Panels glide in with an ease-out-quint curve: quick to arrive, soft to settle */
  @keyframes blm-slide-right { from { opacity: 0; translate: -14px 0; } to { opacity: 1; translate: 0 0; } }
  @keyframes blm-slide-left  { from { opacity: 0; translate: 22px 0; }  to { opacity: 1; translate: 0 0; } }
  @keyframes blm-rise        { from { opacity: 0; translate: 0 10px; }  to { opacity: 1; translate: 0 0; } }

  /* Side menu: runs each time the menu is revealed (the wrapper loses hidden-navigation) */
  html.${ROOT_CLASS} #wrapper:not(.hidden-navigation) #main-menu { animation: blm-slide-right 260ms cubic-bezier(0.22, 1, 0.36, 1) backwards; }
  html.${ROOT_CLASS} #wrapper:not(.hidden-navigation) #main-menu .menu_root > li { animation: blm-slide-right 300ms cubic-bezier(0.22, 1, 0.36, 1) backwards; }
  html.${ROOT_CLASS} #wrapper:not(.hidden-navigation) #main-menu .menu_root > li:nth-child(2) { animation-delay: 25ms; }
  html.${ROOT_CLASS} #wrapper:not(.hidden-navigation) #main-menu .menu_root > li:nth-child(3) { animation-delay: 50ms; }
  html.${ROOT_CLASS} #wrapper:not(.hidden-navigation) #main-menu .menu_root > li:nth-child(4) { animation-delay: 75ms; }
  html.${ROOT_CLASS} #wrapper:not(.hidden-navigation) #main-menu .menu_root > li:nth-child(n+5) { animation-delay: 100ms; }

  /* Story detail: the split pane slides in from the right; its content fades when you
     switch story or tab, and the full page rises into place */
  html.${ROOT_CLASS} .work-packages--details { animation: blm-slide-left 280ms cubic-bezier(0.22, 1, 0.36, 1) backwards; }
  html.${ROOT_CLASS} .work-packages--details-header { animation: blm-fade-in 200ms ease-out backwards; }
  html.${ROOT_CLASS} .work-packages--show-view { animation: blm-rise 260ms cubic-bezier(0.22, 1, 0.36, 1) backwards; }
  html.${ROOT_CLASS} .op-user-activity,
  html.${ROOT_CLASS} .wp-relations--children-table { animation: blm-fade-in 220ms ease-out backwards; }
}

/* Keyboard users get a clear, immediate ring on the editable cells too */
html.${ROOT_CLASS} .inline-edit--display-field:focus-visible,
html.${ROOT_CLASS} .wp-table--row:focus-visible { outline: 2px solid var(--jx-focus); outline-offset: -2px; border-radius: var(--jx-radius); }

/* The row that is open in the split view carries a quiet accent edge */
html.${ROOT_CLASS} .work-package-table tbody tr.wp-table--row.-checked > td:first-child { box-shadow: inset 2px 0 0 var(--jx-link); }
`;
// No transitions or animations while a drag is in progress, or when the Animations
// switch is off. Durations are zeroed rather than `animation: none`, so turning
// them back on does not replay finished entrance animations.
const DRAG = `
html.blm-dragging *, html.blm-dragging *::before, html.blm-dragging *::after,
html.blm-no-anim *, html.blm-no-anim *::before, html.blm-no-anim *::after {
  transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important;
}
html.blm-dragging .work-packages--details { box-shadow: none !important; }
`;
// Welcome greeting beside the list title, and the quote of the day in the bottom bar.
const EXTRAS = `
.toolbar-container .title-container:has(+ .blm-welcome) { flex: 0 1 auto !important; }
.blm-welcome {
  flex: 0 0 auto; margin: 0 auto 0 16px; align-self: center; white-space: nowrap;
  padding: 3px 12px; border-radius: 999px; font: 600 13px/1.4 var(--jx-font, system-ui, sans-serif);
  background: var(--jx-selected, #e9f2ff); color: var(--jx-link, #0c66e4);
}
.op-pagination:has(> .blm-quote) { position: relative; }
.blm-quote {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  max-width: 45%; text-align: center; pointer-events: none;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden;
  font: italic 500 16px/1.45 var(--jx-font, system-ui, sans-serif); color: var(--jx-text, #172b4d);
}
`;
const STYLE = CSS + DARK + MOTION + DRAG + EXTRAS;

function ensureStyle() {
  let s = document.getElementById('__blm-jira-style');
  if (!s) {
    s = document.createElement('style');
    s.id = '__blm-jira-style';
    s.textContent = STYLE;
    (document.head || document.documentElement).appendChild(s);
  }
}

function applyClasses() {
  const root = document.documentElement;
  root.classList.toggle(ROOT_CLASS, skinEnabled);
  if (skinEnabled && root.dataset.blmTheme !== theme) root.dataset.blmTheme = theme;
  root.classList.toggle('blm-no-anim', !animationEnabled);
  root.classList.toggle(WP_CLASS, skinEnabled && onWorkPackagePage());
  root.classList.toggle(BL_CLASS, skinEnabled && onBacklogsPage());
  root.classList.toggle(AS_CLASS, assignEnabled && onWorkPackagePage());
  root.classList.toggle(ACT_CLASS, activityEnabled && onWorkPackagePage());
  root.classList.toggle(FILES_CLASS, filesEnabled && onWorkPackagePage());
  if (anyEnabled()) ensureStyle();
}

const anyEnabled = () => skinEnabled || assignEnabled || activityEnabled || quoteEnabled || filesEnabled;

// Sub-tab switch (Overview, Activity, Files...): OpenProject reuses the content
// container, so animate it whenever the selected tab changes.
let lastTab = null;
let lastTabIdx = -1;
function animateTabSwitch() {
  const sel = document.querySelector('.op-tab-row--link_selected');
  const tab = sel ? (sel.getAttribute('href') || sel.textContent.trim()) : null;
  const idx = sel ? [...document.querySelectorAll('.op-tab-row--link')].indexOf(sel) : -1;
  const prev = lastTab, prevIdx = lastTabIdx;
  lastTab = tab; lastTabIdx = idx;
  if (!tab || !prev || tab === prev || !animationEnabled || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const pane = document.querySelector('.work-packages--details-content, .work-package-details-tab, .tabcontent');
  // Content enters from the side the new tab sits on
  const from = idx < prevIdx ? '-12px' : '12px';
  if (pane) pane.animate(
    [{ opacity: 0, translate: from + ' 0' }, { opacity: 1, translate: '0 0' }],
    { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
}

// Drag state: set on the first mousemove after a mousedown, cleared on release.
// Angular mutates the DOM on every drag tick; re-skinning then makes it stutter,
// so schedule() is held back until the drag ends.
let dragging = false;
let downX = 0, downY = 0;
const DRAG_PX = 4;
function endDrag() {
  document.removeEventListener('mousemove', startDrag, true);
  if (!dragging) return;
  dragging = false;
  document.documentElement.classList.remove('blm-dragging');
  schedule();
}
function startDrag(e) {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) < DRAG_PX) return;   // a click, not a drag
  document.removeEventListener('mousemove', startDrag, true);
  dragging = true;
  document.documentElement.classList.add('blm-dragging');
}
document.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  downX = e.clientX; downY = e.clientY;
  document.addEventListener('mousemove', startDrag, { capture: true, passive: true });
}, true);
for (const type of ['mouseup', 'dragend']) window.addEventListener(type, endDrag, true);
window.addEventListener('blur', endDrag);   // not captured: element blurs would end the drag early

let frame = 0;
let wasOnWp = false;
function schedule() {
  if (frame || dragging) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    applyClasses();
    if (!anyEnabled() || !document.body) { syncJump(); return; }
    if (skinEnabled) animateTabSwitch();
    if (!onWorkPackagePage() || !viewWpId()) childrenFor(null);   // left: drop cache, close picker
    const onWp = onWorkPackagePage();
    if (onWp && !wasOnWp) pickQuote();
    wasOnWp = onWp;
    if (onWp) {
      if (skinEnabled) { tagCells(); greet(); arrangeFullView(); renderChildren(); syncJump(); adjustRelationsCount(); }
      if (assignEnabled) renderTableAssignees();
      if (activityEnabled) renderActivityFilter();
      if (quoteEnabled) renderQuote();
      if (filesEnabled) renderFileCards();
    } else {
      syncJump();
      if (skinEnabled && onBacklogsPage()) tagCells();
    }
  });
}

function disable() {
  document.documentElement.classList.remove(ROOT_CLASS, WP_CLASS, BL_CLASS);
  delete document.documentElement.dataset.blmTheme;
  untagCells();
  restoreFullView();
  restoreRelationsCount();
  syncJump();
  if (picker?.button.closest('.blm-jx-children')) closePicker();
  document.querySelector('.blm-jx-children')?.remove();
}

function disableQuote() {
  removeQuote();
}

function disableFiles() {
  document.documentElement.classList.remove(FILES_CLASS);
  removeFileCards();
}

function disableActivity() {
  document.documentElement.classList.remove(ACT_CLASS);
  removeActivityFilter();
}

function disableAssign() {
  document.documentElement.classList.remove(AS_CLASS);
  if (picker?.button.closest('.blm-assign-cell')) closePicker();
  removeTableAssignees();
}

// Runs at document_start: applied before the first paint so the header never
// flashes OpenProject blue, then corrected once the stored switch is read.
applyClasses();
chrome.storage.local.get([CFG_JIRA_SKIN, CFG_CHILD_ASSIGN, CFG_ACTIVITY_ON, CFG_FILES_ON, CFG_THEME, CFG_ANIMATION, CFG_QUOTE]).then(s => {
  quoteEnabled = s[CFG_QUOTE] ?? true;
  if (!quoteEnabled) disableQuote();
  animationEnabled = s[CFG_ANIMATION] ?? true;
  skinEnabled     = s[CFG_JIRA_SKIN] ?? true;
  assignEnabled   = s[CFG_CHILD_ASSIGN] ?? true;
  activityEnabled = s[CFG_ACTIVITY_ON] ?? true;
  filesEnabled    = s[CFG_FILES_ON] ?? true;
  theme = s[CFG_THEME] === 'light' ? 'light' : 'dark';
  try { localStorage.setItem('__blm_theme', theme); } catch { /* storage blocked */ }
  if (!skinEnabled)     disable();
  if (!assignEnabled)   disableAssign();
  if (!activityEnabled) disableActivity();
  if (!filesEnabled)    disableFiles();
  schedule();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (CFG_THEME in changes) {
    theme = changes[CFG_THEME].newValue === 'light' ? 'light' : 'dark';
    try { localStorage.setItem('__blm_theme', theme); } catch { /* storage blocked */ }
  }
  if (CFG_QUOTE in changes) {
    quoteEnabled = changes[CFG_QUOTE].newValue ?? true;
    if (!quoteEnabled) disableQuote();
  }
  if (CFG_ANIMATION in changes) animationEnabled = changes[CFG_ANIMATION].newValue ?? true;
  if (CFG_JIRA_SKIN in changes) {
    skinEnabled = changes[CFG_JIRA_SKIN].newValue ?? true;
    if (!skinEnabled) disable();
  }
  if (CFG_CHILD_ASSIGN in changes) {
    assignEnabled = changes[CFG_CHILD_ASSIGN].newValue ?? true;
    if (!assignEnabled) disableAssign();
  }
  if (CFG_ACTIVITY_ON in changes) {
    activityEnabled = changes[CFG_ACTIVITY_ON].newValue ?? true;
    if (!activityEnabled) disableActivity();
  }
  if (CFG_FILES_ON in changes) {
    filesEnabled = changes[CFG_FILES_ON].newValue ?? true;
    if (!filesEnabled) disableFiles();
  }
  schedule();
});

// Angular re-renders rows on scroll, grouping, inline edit, query switch and
// when a work package opens in the split view.
function observe() {
  new MutationObserver(() => { if (anyEnabled()) schedule(); })
    .observe(document.body, { childList: true, subtree: true });
  schedule();
}
if (document.body) observe();
else document.addEventListener('DOMContentLoaded', observe, { once: true });
if (typeof window.navigation !== 'undefined') {
  window.navigation.addEventListener('navigatesuccess', () => { if (anyEnabled()) schedule(); });
}
})();
