// content.js — Backlog Monitor content script
//
// Runs on: <backlog host>/projects/<slug>/work_packages (registered by background.js)
//
// Responsibility (Plan A — single canonical pipeline):
//   When the user opens a work-package LIST view, silently ask the background
//   service worker to run its API-based sync (the same job the viewer's
//   "Sync Now" button triggers).  Background only syncs the versions the user
//   has chosen to track, so nothing else is touched.
//
// It does NOT scrape the DOM, write snapshots, or show any UI — the sync runs
// in the background with no toast.

'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Debounce after a URL change before reacting (let Angular settle). */
const NAVIGATION_DEBOUNCE_MS = 800;
/** Don't kick off more than one auto-sync per tab within this window. */
const SYNC_THROTTLE_MS = 60_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns false when the chrome extension context has been invalidated
 * (e.g. the extension was reloaded while this tab stayed open).
 * Calling chrome.* APIs in an invalidated context throws — guard against that.
 */
function isContextValid() {
  try {
    return !!chrome.runtime.id;
  } catch {
    return false;
  }
}

/**
 * True only on the work-packages LIST view of a saved query.
 * Detail pages (/work_packages/18233/activity) have no backlog to sync.
 */
function isListPage(url) {
  try {
    const parsed = url ? new URL(url) : new URL(location.href);
    const isList = /\/work_packages\/?$/.test(parsed.pathname);
    return isList && parsed.searchParams.has('query_id');
  } catch {
    return false;
  }
}

// ─── Sync trigger ──────────────────────────────────────────────────────────────

let lastSyncTriggerAt = 0;

/** Throttled entry point: silently ask background to sync on a list page. */
function maybeSync() {
  if (!isListPage()) {
    console.log('[BacklogMonitor] Not a backlog list page — skipping sync.');
    return;
  }
  const now = Date.now();
  if (now - lastSyncTriggerAt < SYNC_THROTTLE_MS) {
    console.log('[BacklogMonitor] Sync throttled (ran recently).');
    return;
  }
  lastSyncTriggerAt = now;
  if (!isContextValid()) return;
  try { chrome.runtime.sendMessage({ type: 'sync-now' }); } catch { /* sw may be asleep */ }
  console.log('[BacklogMonitor] Background sync triggered.');
}

// ─── SPA navigation detection ────────────────────────────────────────────────
//
// OpenProject is an Angular SPA: switching saved queries changes the URL and
// re-renders without a full reload, so the content script is never re-injected.
// We watch for URL changes and re-trigger (throttled) on each query switch.

let debounceTimer = null;

function onNavigationDetected() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    maybeSync();
    // Re-scan the (usually replaced) table for the new query. ensureRowObserver
    // rebinds on the new tbody and forces a decorate; scheduleDecorate here is a
    // safety net in case the tbody element was NOT replaced (only its rows were).
    if (typeof ensureRowObserver === 'function') ensureRowObserver();
    if (typeof scheduleDecorate   === 'function') scheduleDecorate();
  }, NAVIGATION_DEBOUNCE_MS);
}

// Method 1: Navigation API (Chrome 102+)
if (typeof window.navigation !== 'undefined') {
  window.navigation.addEventListener('navigate', (event) => {
    if (isListPage(event.destination.url)) onNavigationDetected();
  });
}

// Method 2: Patch history API (fallback for older Chrome builds / edge cases)
(function patchHistory() {
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);

  history.pushState = function (...args) {
    _push(...args);
    if (isListPage()) onNavigationDetected();
  };

  history.replaceState = function (...args) {
    _replace(...args);
    if (isListPage()) onNavigationDetected();
  };
})();

// ═══════════════════════════════════════════════════════════════════════════════
//  Subtask progress on OpenProject's native Progress (%) column
// ───────────────────────────────────────────────────────────────────────────────
//  For every parent work package visible in the table, fetch its direct children
//  and decorate the row's native Progress bar (display only, nothing is written):
//     yellow segment = share of in-progress subtasks, drawn after the native fill
//     hover          = bar lifts, then after a short delay a popover lists the
//                      subtasks (done / in progress / to do)
//  Results are cached per work-package id and re-applied as OpenProject virtualises
//  rows on scroll / group expand / query switch.
// ═══════════════════════════════════════════════════════════════════════════════

const API_BASE = location.origin;   // only ever injected on the configured backlog host

/** Child status → segment colour bucket. */
const DONE_STATUSES        = new Set(['resolved', 'closed', 'done', 'rejected']);
const IN_PROGRESS_STATUSES = new Set(['in progress']);

/** id -> { total, done, inProgress, other } | null while a fetch is in flight. */
const childStatsCache = new Map();
let statsFailAt = 0;                 // last failed children fetch; retries wait STATS_RETRY_MS
const STATS_RETRY_MS = 8000;

// Feature flag — toggled from the popup ("Show subtask progress"). Defaults to true so
// first-run users see the bars immediately; the popup writes an explicit boolean
// when the user changes the checkbox.
const CFG_SHOW_SUBTASK_BAR = '__blm_show_subtask_bar';
let subtaskBarEnabled = true;

/** Removes every decoration the feature has left on native progress bars. */
function tearDownBars() {
  for (const bar of document.querySelectorAll('.blm-native-bar')) unhostBar(bar);
  clearTimeout(popShowTimer);
  document.querySelector('.blm-pop')?.classList.remove('show');
}

// Load initial state, then react live to popup toggles.
chrome.storage.local.get(CFG_SHOW_SUBTASK_BAR).then(s => {
  subtaskBarEnabled = s[CFG_SHOW_SUBTASK_BAR] ?? true;
  if (subtaskBarEnabled) scheduleDecorate?.();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(CFG_SHOW_SUBTASK_BAR in changes)) return;
  subtaskBarEnabled = changes[CFG_SHOW_SUBTASK_BAR].newValue ?? true;
  if (subtaskBarEnabled) scheduleDecorate?.();
  else                   tearDownBars();
});

// ─── "Show burndown chart" toolbar button ─────────────────────────────────────
// Sits left of + Create on list pages and opens the Burndown page in the drawer
// from quick-settings-host.js (same isolated world, so its global is reachable).
const CFG_BURNDOWN_BUTTON = '__blm_burndown_button';
let burndownButtonEnabled = true;

/** Query string for the drawer: which version's burndown this list is about. The page
 *  gives up to three hints (viewer.js picks the version from them): the project's
 *  identifier in the path, the version ids of the list's own filter, and the list's title. */
function burndownDrawerParams() {
  const params = new URLSearchParams({ embedded: '1' });
  const project = /\/projects\/([^/]+)\/work_packages/.exec(location.pathname)?.[1];
  if (project) params.set('project', decodeURIComponent(project));
  try {
    const filters = JSON.parse(new URLSearchParams(location.search).get('query_props') ?? '{}').f ?? [];
    const ids = filters.filter(f => /^(version|fixedVersion|version_id)$/i.test(f.n)).flatMap(f => f.v ?? []);
    if (ids.length) params.set('versions', ids.join(','));
  } catch { /* no usable filter in the URL */ }
  const title = document.querySelector('.toolbar-container input.editable-toolbar-title--input')?.value
    ?? document.querySelector('.toolbar-container .title-container h2, .toolbar-container .editable-toolbar-title')?.textContent;
  if (title?.trim()) params.set('title', title.trim());
  return params.toString();
}

function ensureBurndownButton() {
  const existing = document.querySelector('.blm-burndown-item');
  if (!burndownButtonEnabled || !/\/work_packages\/?$/.test(location.pathname)) { existing?.remove(); return; }
  const create = document.querySelector('.toolbar-items wp-create-button, .toolbar-items .add-work-package');
  const anchor = create?.closest('.toolbar-items > li') ?? create;
  if (!anchor) return;
  if (existing?.nextElementSibling === anchor) return;
  existing?.remove();
  const item = document.createElement(anchor.tagName === 'LI' ? 'li' : 'span');
  item.className = 'toolbar-item blm-burndown-item';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'button';
  btn.textContent = 'Show burndown chart';
  btn.addEventListener('click', () => globalThis.blmOpenDrawer?.(
    chrome.runtime.getURL('pages/viewer.html') + '?' + burndownDrawerParams(), 'Burndown chart', '1100px'));
  item.append(btn);
  anchor.before(item);
}

chrome.storage.local.get(CFG_BURNDOWN_BUTTON).then(s => {
  burndownButtonEnabled = s[CFG_BURNDOWN_BUTTON] ?? true;
  ensureBurndownButton();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(CFG_BURNDOWN_BUTTON in changes)) return;
  burndownButtonEnabled = changes[CFG_BURNDOWN_BUTTON].newValue ?? true;
  ensureBurndownButton();
});

/** Extracts the trailing numeric id from a HAL href ("/api/v3/work_packages/20469"). */
function idFromHref(href) {
  const m = /(\d+)\s*$/.exec(href ?? '');
  return m ? m[1] : null;
}

/**
 * Fetches direct children for the given parent ids and returns
 * Map(parentId -> { total, done, inProgress, other }).
 * OpenProject's `parent` filter with `=` accepts many values at once, so all
 * children come back in one query (chunked + paginated for safety). Uses the
 * global work_packages endpoint since a child may live in another project.
 */
async function fetchChildStats(parentIds) {
  const ids   = [...new Set(parentIds.map(String))].filter(Boolean);
  const stats = new Map();
  const CHUNK = 100;

  for (let c = 0; c < ids.length; c += CHUNK) {
    const chunk  = ids.slice(c, c + CHUNK);
    const filter = encodeURIComponent(
      JSON.stringify([{ parent: { operator: '=', values: chunk } }])
    );

    let offset = 1;
    while (true) {
      const res = await fetch(
        `${API_BASE}/api/v3/work_packages?filters=${filter}&pageSize=200&offset=${offset}`,
        // no-store: re-fetches after an edit must not be answered from HTTP cache
        { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/hal+json' } }
      );
      if (!res.ok) throw new Error(`children fetch failed: ${res.status}`);
      const data     = await res.json();
      const elements = data._embedded?.elements ?? [];

      for (const kid of elements) {
        const pid = idFromHref(kid._links?.parent?.href);
        if (!pid) continue;
        if (!stats.has(pid)) stats.set(pid, { total: 0, done: 0, inProgress: 0, other: 0, children: [] });
        const e         = stats.get(pid);
        const statusRaw = kid._links?.status?.title ?? 'Unknown';
        const st        = statusRaw.toLowerCase();
        e.total++;
        if      (DONE_STATUSES.has(st))        e.done++;
        else if (IN_PROGRESS_STATUSES.has(st)) e.inProgress++;
        else                                   e.other++;
        e.children.push({
          id:      kid.id,
          subject: kid.subject ?? `#${kid.id}`,
          type:    kid._links?.type?.title ?? '',
          status:  statusRaw,
          pct:     kid.percentageDone ?? 0,
          bucket:  DONE_STATUSES.has(st) ? 'done'
                  : IN_PROGRESS_STATUSES.has(st) ? 'prog'
                  : 'other',
        });
      }

      // the server may cap pageSize below 200, so trust its own page size and total
      const pageSize = data.pageSize ?? 200;
      if (!elements.length || offset * pageSize >= (data.total ?? 0)) break;
      offset += 1;   // OpenProject's offset is a 1-based page number
    }
  }
  return stats;
}

// ─── DOM helpers (defensive — OpenProject markup varies across versions) ────────

/** Every rendered work-package row in the table. */
function wpRows() {
  return document.querySelectorAll(
    'tr[data-work-package-id], tr[id^="wp-row-"], tr.wp-table--row'
  );
}

/** The work-package id for a row, from its data attribute or its `wp-row-<id>-table` id. */
function rowWpId(row) {
  const attr = row.getAttribute('data-work-package-id');
  if (attr) return attr;
  const m = /wp-row-(\d+)/.exec(row.id || '');
  return m ? m[1] : null;
}

/** The row's type text ("Task", "Bug", "User story", …), lower-cased, if present. */
function rowType(row) {
  const cell = row.querySelector('td.type, td[class*="type"]');
  return (cell?.textContent || '').trim().toLowerCase();
}

// ─── Rendering ──────────────────────────────────────────────────────────────────

function ensureBarStyles() {
  if (document.getElementById('__blm-subtask-style')) return;
  const s = document.createElement('style');
  s.id = '__blm-subtask-style';
  s.textContent = `
    /* Hover target is the whole component (bar + %); feedback is a focus-style
       blue border + soft ring on the bar, no movement. */
    .blm-native-host, .blm-native-cell, .blm-native-cell * { cursor:default !important; }
    .blm-native-host:hover > .blm-native-bar { border-color:#1a67a3 !important;
      box-shadow:0 0 0 3px rgba(26,103,163,.18); }
    /* Taller than native so the count inside stays readable.
       OpenProject styles every span inside .progress-bar (inline/float), which
       would push ours after the fill — pin their positioning with !important. */
    .blm-native-bar { position:relative !important; box-sizing:border-box;
      height:12px !important; min-height:12px; overflow:hidden !important;
      transition:border-color .15s ease, box-shadow .15s ease; }
    /* The bar is drawn from subtask statuses; the native fill is hidden (its %
       text next to the bar stays OpenProject's own number). */
    .blm-native-bar > .inner-progress { visibility:hidden !important; }
    .blm-native-bar > .blm-native-done,
    .blm-native-bar > .blm-native-prog,
    .blm-native-bar > .blm-count { position:absolute !important; float:none !important;
      margin:0 !important; padding:0 !important; pointer-events:none; }
    .blm-native-bar > .blm-native-done,
    .blm-native-bar > .blm-native-prog { top:0 !important; bottom:0 !important;
      height:auto !important; }
    .blm-native-bar > .blm-native-done { left:0 !important; background:#b8dfb4; }
    .blm-native-bar > .blm-native-prog { background:#f2c94c; }
    @media (prefers-reduced-motion: no-preference) {
      .blm-native-bar > .blm-native-done, .blm-native-bar > .blm-native-prog {
        transition: width .45s cubic-bezier(.2,0,0,1), left .45s cubic-bezier(.2,0,0,1); }
    }
    /* Shown next to the % when OpenProject's number disagrees with the bar. */
    .blm-warn { display:inline-flex; align-items:center; justify-content:center;
      width:11px; height:11px; margin-left:4px; border-radius:50%; flex:none;
      box-sizing:border-box; border:1px solid #e2b977; background:#fffaf2;
      color:#c28a3a; font-size:8px; font-weight:700; line-height:1;
      vertical-align:middle; }
    .blm-native-bar > .blm-count { inset:0 !important; width:auto !important;
      height:auto !important; background:none !important; display:flex !important;
      align-items:center; justify-content:center; line-height:12px;
      text-box:trim-both cap alphabetic;   /* optical centre for the digits */
      font-size:9px; font-weight:700; letter-spacing:.02em; color:#24292f;
      font-variant-numeric:tabular-nums; white-space:nowrap; }

    .blm-pop { position:fixed; z-index:2147483647; max-width:420px; min-width:260px;
      background:#ffffff; color:#1f2328; border:1px solid #d0d7de; border-radius:8px;
      box-shadow:0 6px 20px rgba(0,0,0,.15); padding:10px 12px; font-size:12px;
      line-height:1.4; pointer-events:none; opacity:0; transform:translateY(4px);
      transition:opacity .15s ease-out, transform .15s ease-out; }
    .blm-pop.show { opacity:1; transform:none; pointer-events:auto; }
    .blm-pop-head { display:flex; gap:10px; font-weight:700; font-size:11px;
      color:#57606a; letter-spacing:.03em; text-transform:uppercase;
      border-bottom:1px solid #eaeef2; padding-bottom:6px; margin-bottom:8px; }
    .blm-pop-head .b { display:inline-flex; align-items:center; gap:4px; }
    .blm-pop-head .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
    .blm-pop-head .dot.done { background:#2ea44f; }
    .blm-pop-head .dot.prog { background:#f2c94c; }
    .blm-pop-head .dot.other { background:#c6cdd6; }
    .blm-pop-note { background:#fff4e5; color:#7a4100; border-radius:6px;
      padding:6px 8px; margin-bottom:8px; font-size:11px; line-height:1.45; }
    .blm-pop-note b { font-weight:700; }
    .blm-fix { display:flex; align-items:center; gap:8px; margin-top:6px; }
    .blm-fix-btn { font:inherit; font-size:11px; font-weight:700; cursor:pointer;
      padding:3px 10px; border-radius:4px; border:1px solid #1a67a3;
      background:#1a67a3; color:#fff; }
    .blm-fix-btn:hover { background:#155a8f; }
    .blm-fix-btn:disabled { opacity:.6; cursor:default; }
    .blm-fix-msg a { color:#1a67a3; }
    .blm-pop .pop-pct { font-size:10px; font-weight:700; color:#b35c00;
      font-variant-numeric:tabular-nums; white-space:nowrap; }
    .blm-pop ul { list-style:none; margin:0; padding:0; max-height:280px; overflow:auto; }
    .blm-pop li { display:flex; align-items:center; gap:8px; padding:3px 0; }
    .blm-pop li + li { border-top:1px solid #f4f6f8; }
    .blm-pop .pop-id:hover { color:#1a67a3; text-decoration:underline; }
    .blm-pop .pop-id { color:#57606a; text-decoration:none; font-variant-numeric:tabular-nums;
      font-weight:600; min-width:44px; }
    .blm-pop .pop-status { font-size:10px; font-weight:700; padding:1px 6px;
      border-radius:3px; background:#eaeef2; color:#57606a; white-space:nowrap; }
    .blm-pop .pop-status.done { background:#dcffe4; color:#116329; }
    .blm-pop .pop-status.prog { background:#fff5cf; color:#7d4e00; }
    .blm-pop .pop-subject { flex:1; min-width:0; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; }
  `;
  document.head.appendChild(s);
}

/** OpenProject's own Progress (%) bar in the row, if that column is shown. */
function nativeProgressBar(row) {
  return row.querySelector(
    'td.percentageDone .progress-bar, td[class*="percentageDone"] .progress-bar'
  );
}

/** The table cell / detail field that owns a Progress bar (OpenProject's inline-edit target). */
function progressCell(bar) {
  const td = bar.closest('td');
  if (td) return td;
  // Detail view: the outermost percentageDone wrapper, so its padding is covered too.
  let cell = null;
  for (let el = bar.parentElement; el; el = el.parentElement) {
    if (el.matches('[class*="percentageDone"]')) cell = el;
  }
  return cell;
}

// A work package with subtasks has derived Progress — clicking it opens inline edit
// and OpenProject answers "Editing Progress (%) is blocked for this resource".
// Swallow the clicks before Angular sees them (window capture runs first); hover
// still works since only click-type events are blocked.
for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
  window.addEventListener(type, (e) => {
    if (!e.target.closest?.('.blm-native-cell')) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

/** Hides a native tooltip while decorated (it would pop up over ours). */
function parkTitle(el) {
  if (el.dataset.blmTitle !== undefined || !el.hasAttribute('title')) return;
  el.dataset.blmTitle = el.getAttribute('title');
  el.removeAttribute('title');
}
function restoreTitle(el) {
  if (el.dataset.blmTitle === undefined) return;
  el.title = el.dataset.blmTitle;
  delete el.dataset.blmTitle;
}

/** Undoes paintBar's changes to a bar and its host component. */
function unhostBar(bar) {
  const host = bar.parentElement;
  for (const el of bar.querySelectorAll(':scope > .blm-native-done, :scope > .blm-native-prog, :scope > .blm-count')) el.remove();
  bar.classList.remove('blm-native-bar');
  restoreTitle(bar);
  progressCell(bar)?.classList.remove('blm-native-cell');
  if (host) {
    host.querySelector(':scope > .blm-warn')?.remove();
    host.classList.remove('blm-native-host');
    delete host._nativePct;
    restoreTitle(host);
    delete host._stats;
  }
}

/**
 * Display-only decoration of OpenProject's native Progress component (bar + "50%"):
 *   - the bar is redrawn from subtask statuses: green = done share, yellow =
 *     in-progress share (the native fill is hidden; the % text stays native)
 *   - an orange "!" next to the % when OpenProject's number disagrees with it
 *   - a "<done>/<total>" subtask count centred inside the bar
 *   - the whole component becomes the hover target for the subtask popover
 * Nothing is written to the work package.
 */
function paintNativeProgress(row, stats) {
  const bar = nativeProgressBar(row);
  if (bar) paintBar(bar, stats);
}

function paintBar(bar, stats) {
  const host = bar.parentElement;
  if (!host) return;
  if (!stats?.total) { unhostBar(bar); return; }

  ensureBarStyles();
  bar.classList.add('blm-native-bar');
  host.classList.add('blm-native-host');
  progressCell(bar)?.classList.add('blm-native-cell');
  host._stats = stats;   // read by the shared hover popover
  parkTitle(bar);
  parkTitle(host);

  const nativePct = [...bar.querySelectorAll(':scope > .inner-progress')]
    .reduce((sum, el) => sum + (parseFloat(el.style.width) || 0), 0);
  host._nativePct = nativePct;
  paintSegments(bar, stats);
  paintMismatch(host, stats, nativePct);

  let count = bar.querySelector(':scope > .blm-count');
  if (!count) {
    count = document.createElement('span');
    count.className = 'blm-count';
  }
  if (bar.lastElementChild !== count) bar.appendChild(count);   // stay above the segment
  const label = `${stats.done}/${stats.total}`;
  if (count.textContent !== label) count.textContent = label;

  // Popover open on this bar while its stats were refreshed — show the new list.
  if (popEl?._anchor === host && popEl.classList.contains('show') && popEl._stats !== stats) {
    popEl.innerHTML = renderPopover(stats, host._nativePct);
    popEl._stats = stats;
  }
}

/** Status-based fill: green done share, then the yellow in-progress share. */
function paintSegments(bar, stats) {
  const donePct = (stats.done / stats.total) * 100;
  const progPct = (stats.inProgress / stats.total) * 100;
  const seg = (cls) => {
    let el = bar.querySelector(`:scope > .${cls}`);
    if (!el) {
      el = document.createElement('span');
      el.className = cls;
      bar.appendChild(el);
    }
    return el;
  };
  seg('blm-native-done').style.width = `${donePct}%`;
  const prog = seg('blm-native-prog');
  prog.style.left  = `${donePct}%`;
  prog.style.width = `${progPct}%`;
}

/** Points differing by at least this much count as a mismatch worth flagging. */
const MISMATCH_TOLERANCE = 5;

function paintMismatch(host, stats, nativePct) {
  const statusPct = (stats.done / stats.total) * 100;
  let warn = host.querySelector(':scope > .blm-warn');
  if (Math.abs(statusPct - nativePct) < MISMATCH_TOLERANCE) { warn?.remove(); return; }
  if (!warn) {
    warn = document.createElement('span');
    warn.className = 'blm-warn';
    warn.textContent = '!';
    host.appendChild(warn);
  }
}


// ─── Hover popover (single reused node, delegated events) ───────────────────────

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

let popEl = null;
let popHideTimer = null;

function ensurePopover() {
  if (popEl) return popEl;
  popEl = document.createElement('div');
  popEl.className = 'blm-pop';
  document.body.appendChild(popEl);
  return popEl;
}

/** Explains why OpenProject's % differs from the status-based bar, if it does. */
function renderMismatchNote(stats, nativePct) {
  if (nativePct === undefined) return '';
  const statusPct = Math.round((stats.done / stats.total) * 100);
  const native    = Math.round(nativePct);
  if (Math.abs(statusPct - native) < MISMATCH_TOLERANCE) return '';

  const stale = (stats.children ?? []).filter(k => k.bucket === 'done' && k.pct < 100);
  // OpenProject averages each subtask's own Progress, so a subtask resolved without
  // setting it to 100% keeps pulling the parent's number down.
  const why = stale.length
    ? `${stale.length} done subtask${stale.length === 1 ? ' is' : 's are'} still below 100%.`
    : `OpenProject weights by estimated time.`;
  const fix = stale.length && !stats.recalculated
    ? `<div class="blm-fix"><button class="blm-fix-btn" type="button"
       title="Sets Progress to 100% on every done subtask below 100%, so OpenProject recalculates this one">Recalculate</button>
       <span class="blm-fix-msg"></span></div>`
    : '';
  return `<div class="blm-pop-note">OpenProject <b>${native}%</b> · by status
    <b>${statusPct}%</b>. ${why}${fix}</div>`;
}

function renderPopover(stats, nativePct) {
  const other = Math.max(0, stats.total - stats.done - stats.inProgress);
  // Sort: in-progress first (most actionable), then not-started, then done.
  const order  = { prog: 0, other: 1, done: 2 };
  const kids   = [...(stats.children ?? [])].sort((a, b) =>
    (order[a.bucket] - order[b.bucket]) || (a.id - b.id));

  const head = `
    <div class="blm-pop-head">
      <span class="b"><span class="dot done"></span>${stats.done} done</span>
      <span class="b"><span class="dot prog"></span>${stats.inProgress} in progress</span>
      <span class="b"><span class="dot other"></span>${other} to do</span>
    </div>`;

  const items = kids.map(k => `
    <li>
      <a class="pop-id" href="/work_packages/${k.id}">#${k.id}</a>
      <span class="pop-status ${k.bucket}">${escapeHtml(k.status)}</span>
      <span class="pop-subject" title="${escapeHtml(k.subject)}">${escapeHtml(k.subject)}</span>
      ${k.bucket === 'done' && k.pct < 100 ? `<span class="pop-pct" title="Progress of this subtask">${k.pct}%</span>` : ''}
    </li>`).join('');

  return head + renderMismatchNote(stats, nativePct) + `<ul>${items || '<li><span class="pop-subject">No subtasks fetched.</span></li>'}</ul>`;
}

/** Positions the popover so it doesn't fall off-screen. */
function positionPopover(anchorRect) {
  const pop      = popEl;
  const margin   = 8;
  const vw       = window.innerWidth;
  const vh       = window.innerHeight;
  const popRect  = pop.getBoundingClientRect();

  // Prefer below the bar; flip above if it would overflow bottom.
  let top = anchorRect.bottom + margin;
  if (top + popRect.height > vh - 4) top = Math.max(4, anchorRect.top - popRect.height - margin);

  let left = anchorRect.left;
  if (left + popRect.width > vw - 4) left = Math.max(4, vw - popRect.width - 4);

  pop.style.top  = `${top}px`;
  pop.style.left = `${left}px`;
}

function showPopoverFor(bar) {
  const stats = bar._stats;
  if (!stats || !stats.total) return;
  const pop = ensurePopover();
  clearTimeout(popHideTimer);
  pop.innerHTML = renderPopover(stats, bar._nativePct);
  pop._anchor = bar;
  pop._stats  = stats;
  pop.classList.add('show');
  // Two passes: render off-screen once so we can measure, then position.
  pop.style.top = '-9999px';
  pop.style.left = '-9999px';
  requestAnimationFrame(() => positionPopover(bar.getBoundingClientRect()));
}

/** Grace period so the mouse can travel from the bar into the popover. */
const POP_HIDE_GRACE_MS = 200;

function hidePopover() {
  if (!popEl) return;
  clearTimeout(popHideTimer);
  popHideTimer = setTimeout(() => {
    popEl.classList.remove('show');
    popEl._anchor = null;
  }, POP_HIDE_GRACE_MS);
}

// ─── "Set 100%" fix button (writes to OpenProject) ──────────────────────────────

/** Sets one work package's Progress to 100%, re-reading lockVersion first. */
async function setProgressDone(wpId) {
  const url = `${API_BASE}/api/v3/work_packages/${wpId}`;
  const cur = await fetch(url, { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/hal+json' } });
  if (!cur.ok) throw new Error(`HTTP ${cur.status}`);
  const { lockVersion } = await cur.json();

  const headers = {
    Accept:             'application/hal+json',
    'Content-Type':     'application/json',
    'X-Requested-With': 'XMLHttpRequest',   // OpenProject requires it for session auth
  };
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  if (csrf) headers['X-CSRF-TOKEN'] = csrf;

  const res = await fetch(url, {
    method: 'PATCH', credentials: 'include', headers,
    body: JSON.stringify({ lockVersion, percentageDone: 100 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// OpenProject averages each subtask's own Progress into the parent, so every done
// subtask still below 100% has to be set — one write each, done one after another
// (parallel PATCHes would race on the parent's recalculation).
document.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('.blm-fix-btn');
  if (!btn || !popEl?._anchor) return;
  const stats = popEl._anchor._stats;
  const msg   = btn.parentElement.querySelector('.blm-fix-msg');
  const stale = (stats?.children ?? []).filter(k => k.bucket === 'done' && k.pct < 100);

  btn.disabled = true;
  const failed = [];
  let fixed = 0;
  for (const k of stale) {
    msg.textContent = `Recalculating… ${fixed + failed.length + 1}/${stale.length}`;
    try {
      await setProgressDone(k.id);
      k.pct = 100;
      fixed++;
    } catch {
      failed.push(`#${k.id}`);
    }
  }

  if (!failed.length) {
    stats.recalculated = true;                     // no button on the next hover
    btn.remove();
    msg.innerHTML = `✓ Set ${fixed} subtask${fixed === 1 ? '' : 's'} to 100% · <a href="#" class="blm-reload">Reload</a>`;
    return;
  }
  btn.disabled = false;
  msg.innerHTML = `${fixed ? `Set ${fixed} to 100%. ` : ''}Failed (${failed.join(', ')}) — no edit permission?`
    + (fixed ? ` · <a href="#" class="blm-reload">Reload</a>` : '');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.blm-reload')) return;
  e.preventDefault();
  location.reload();
});

// ─── Detail view (split pane / full view "Progress (%)" field) ─────────────────

/** The work package shown in the detail view, from /work_packages/(details/)<id>. */
function detailWpId() {
  const m = /\/work_packages\/(?:details\/)?(\d+)/.exec(location.pathname);
  return m ? m[1] : null;
}

/** Native progress bars in the detail view (table rows are handled separately). */
function detailProgressBars() {
  return [...document.querySelectorAll('[class*="percentageDone"] .progress-bar')]
    .filter(bar => !bar.closest('tr'));
}

async function decorateDetail() {
  const id = detailWpId();
  if (!id || !detailProgressBars().length) return;

  let stats = childStatsCache.get(id);
  if (stats === null) return;                             // fetch in flight
  if (stats === undefined) {
    if (Date.now() - statsFailAt < STATS_RETRY_MS) return;
    childStatsCache.set(id, null);
    try {
      stats = (await fetchChildStats([id])).get(id) ?? { total: 0, done: 0, inProgress: 0, other: 0, children: [] };
    } catch {
      childStatsCache.delete(id);
      statsFailAt = Date.now();
      return;
    }
    childStatsCache.set(id, stats);
    scheduleDecorate();   // the list row of this work package may hold a stale bar
  }
  for (const bar of detailProgressBars()) paintBar(bar, stats);
}

// The detail pane lives outside the table, so it's watched from the body observer.
// Only bars not yet decorated trigger a pass (our own writes don't re-trigger it).
let detailFrame = 0;
function scheduleDetail() {
  if (detailFrame || !subtaskBarEnabled) return;
  detailFrame = requestAnimationFrame(() => {
    detailFrame = 0;
    if (detailProgressBars().some(bar => !bar.classList.contains('blm-native-bar'))) decorateDetail();
  });
}

// ─── Stale-cache refresh after edits ────────────────────────────────────────────
//
// progress-hook.js (page world) announces every successful work-package PATCH.
// Drop cached stats for that work package and for any parent that lists it as a
// subtask, then re-fetch what's on screen — otherwise e.g. reopening a subtask
// keeps showing the old "5/5" while OpenProject's own % already dropped.

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'blm-progress-hook') return;
  if (e.data.type !== 'wp-updated' || !subtaskBarEnabled) return;

  const id = String(e.data.id);
  let dropped = false;
  for (const [pid, stats] of childStatsCache) {
    if (!stats) continue;                                  // in flight — will be fresh
    if (pid === id || stats.children?.some(k => String(k.id) === id)) {
      childStatsCache.delete(pid);
      dropped = true;
    }
  }
  if (!dropped) return;
  refreshData();
  decorateDetail();
});

// Delegated hover — one listener for all bars, survives row re-renders. The bar
// lifts immediately (CSS); the popover follows after POP_DELAY_MS so skimming the
// column with the mouse doesn't flash popovers.
const POP_DELAY_MS = 500;
let popShowTimer = null;

document.addEventListener('mouseover', (e) => {
  // Inside the popover (e.g. to scroll or click a subtask): keep it open.
  if (e.target.closest?.('.blm-pop')) { clearTimeout(popHideTimer); return; }

  const bar = e.target.closest?.('.blm-native-host');
  if (!bar || bar.contains(e.relatedTarget)) return;
  clearTimeout(popShowTimer);
  if (popEl?._anchor === bar && popEl.classList.contains('show')) {
    clearTimeout(popHideTimer);                      // back from its own popover
    return;
  }
  popShowTimer = setTimeout(() => { if (bar.isConnected) showPopoverFor(bar); }, POP_DELAY_MS);
});
document.addEventListener('mouseout', (e) => {
  const from = e.target.closest?.('.blm-pop') ?? e.target.closest?.('.blm-native-host');
  if (!from || from.contains(e.relatedTarget)) return;
  clearTimeout(popShowTimer);
  hidePopover();
});

// ─── Orchestration ──────────────────────────────────────────────────────────────
//
// Two independent passes so the fetch never gates layout:
//
//   Phase 1 — reserveSlots(): fires SYNCHRONOUSLY on every row change. Reserves the
//             fixed-width slot in every subject cell so the subject column is aligned
//             the instant rows appear. Idempotent, no network, cheap DOM writes only.
//             Also applies data to rows whose id is already in the cache (no re-fetch).
//
//   Phase 2 — refreshData(): runs in the background at idle time. Fetches child
//             stats for uncached ids, then patches the matching rows in place. Never
//             awaited from the observer path — layout is already done by phase 1.

function collectRows() {
  const byId = new Map();
  for (const row of wpRows()) {
    const id = rowWpId(row);
    if (id) byId.set(id, row);
  }
  return byId;
}

/** Phase 1 — synchronous, no network. Re-applies cached stats on every row-change tick. */
function reserveSlots() {
  for (const [id, row] of collectRows()) {
    if (rowType(row) === 'task') continue;              // tasks have no children
    const cached = childStatsCache.get(id);
    if (cached) paintNativeProgress(row, cached);
  }
}

/** Kicks off a background refresh of any uncached ids in the current view. */
let refreshQueued = false;
function refreshData() {
  if (refreshQueued) return;
  refreshQueued = true;

  const run = async () => {
    refreshQueued = false;
    const byId = collectRows();
    const need = [];
    for (const [id, row] of byId) {
      if (childStatsCache.has(id)) continue;               // known (or in-flight)
      if (rowType(row) === 'task') continue;               // tasks have no children
      need.push(id);
    }
    if (!need.length) return;

    if (Date.now() - statsFailAt < STATS_RETRY_MS) return;
    need.forEach(id => childStatsCache.set(id, null));     // mark in-flight
    let fetched;
    try {
      fetched = await fetchChildStats(need);
    } catch {
      need.forEach(id => childStatsCache.delete(id));      // allow retry later
      statsFailAt = Date.now();
      return;
    }

    // Store results and patch any rows still on-screen for these ids.
    for (const id of need) {
      const stats = fetched.get(id) ?? { total: 0, done: 0, inProgress: 0, other: 0, children: [] };
      childStatsCache.set(id, stats);
      const row = collectRows().get(id);
      if (row) paintNativeProgress(row, stats);
    }
  };

  // Yield to the browser so the fetch is truly out of the critical path.
  (window.requestIdleCallback || setTimeout)(run, { timeout: 500 });
}

/** Public entry point: cheap sync pass now, background refresh in idle time. */
function decorateRows() {
  if (!subtaskBarEnabled) return;      // user has turned the feature off
  reserveSlots();
  refreshData();
  scheduleDetail();
}

// Re-decorate as the Angular table mutates (virtual scroll, grouping, query switch).
// We scope the observer as tightly as possible and only react when rows actually
// appear/disappear — arbitrary tooltip/menu mutations elsewhere on the page must not
// cause a full re-decorate pass.
// rAF-coalesced: multiple mutation bursts within one frame collapse to a single
// pass. Phase 1 is cheap and must feel instant; the fetch inside phase 2 is
// separately deferred to requestIdleCallback so it can't block anything.
let decorateFrame = 0;
function scheduleDecorate() {
  if (decorateFrame) return;
  decorateFrame = requestAnimationFrame(() => {
    decorateFrame = 0;
    decorateRows();
  });
}

const ROW_SEL     = 'tr[data-work-package-id], tr[id^="wp-row-"], tr.wp-table--row';
const CELL_SEL    = '.wp-table--cell-container';   // subject / any cell container
let tableObserver = null;

// Clicking a row opens the details sidebar, same as OpenProject's "i" icon. Anything
// interactive inside the row keeps its own behaviour.
const ROW_CLICK_SKIP = 'a, button, input, select, textarea, label, [contenteditable], ' +
  '.inline-edit--active-field, .ng-select, .ng-dropdown-panel, .wp-table-context-menu-icon, ' +
  '.wp-table--details-column, .wp-table--checkbox-column, .wp-table--hierarchy-indicator';
document.addEventListener('click', (e) => {
  if (e.button !== 0 || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const t = e.target;
  if (!t.closest || t.closest(ROW_CLICK_SKIP)) return;
  const row = t.closest('.work-package-table tbody tr.wp-table--row');
  if (!row || window.getSelection()?.toString()) return;
  row.querySelector('.wp-table--details-link')?.click();
});

let ensureFrame = 0;
function ensureRowObserver() {
  // Prefer the table body; fall back to the table element or the closest generic
  // work-packages container. If none of these exist yet (Angular still booting),
  // retry on the next frame.
  const target =
    document.querySelector('.work-package-table tbody, .wp-table tbody, table.generic-table tbody') ||
    document.querySelector('.work-package-table, .wp-table, table.generic-table');
  if (!target) {
    if (!ensureFrame) ensureFrame = requestAnimationFrame(() => { ensureFrame = 0; ensureRowObserver(); });
    return;
  }

  // If we're already observing this exact node, don't rebind.
  if (tableObserver && tableObserver._target === target) return;
  tableObserver?.disconnect();

  // Schedule a decorate when:
  //  a) an entire row is added or removed (virtual scroll, group expand, query switch)
  //  b) a row's subject cell-container is added — OpenProject re-renders it when the
  //     work package is opened in the right split-view, which wipes our injected slot.
  //     reserveSlots is idempotent, so firing more often is cheap.
  const matches = (n, sel) =>
    n.nodeType === 1 && (n.matches?.(sel) || n.querySelector?.(sel));

  tableObserver = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (matches(n, ROW_SEL) || matches(n, CELL_SEL)) return scheduleDecorate();
      }
      for (const n of r.removedNodes) {
        if (matches(n, ROW_SEL)) return scheduleDecorate();
      }
    }
  });
  tableObserver._target = target;
  tableObserver.observe(target, { childList: true, subtree: true });

  // Rows may already be populated at the moment we bind (fast initial load, or
  // Angular replacing the tbody wholesale on query switch — the new node arrives
  // with its rows already in it, so no `addedNodes` mutation ever fires). Force a
  // pass now so those rows get decorated.
  scheduleDecorate();
}

// The table itself is inside an Angular component that gets replaced on query
// switch, so re-locate its tbody when it's swapped.
let bodyFrame = 0;
new MutationObserver(() => {
  if (bodyFrame) return;
  bodyFrame = requestAnimationFrame(() => { bodyFrame = 0; ensureRowObserver(); scheduleDetail(); ensureBurndownButton(); });
}).observe(document.body, { childList: true, subtree: true });
ensureRowObserver();

// ─── Bootstrap ───────────────────────────────────────────────────────────────

maybeSync();
scheduleDecorate();
