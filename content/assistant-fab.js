// assistant-fab.js — a floating button that opens the Claude assistant as a small chat popup,
// not a full-page drawer: the user stays able to see and use the backlog page behind it (so that
// if the assistant ever edits something directly, that edit is visible as it happens).
//
// Runs on: <backlog host>/projects/*/work_packages* (registered by background.js, same route as
// content.js), so it shows on the backlog list and on a story's own detail view. Shown only while
// Settings → Experimental → "Claude on Planning" is on. The popup is an iframe of its own
// (pages/assistant.html) inside a closed shadow root, anchored above the button; this script owns
// that iframe directly, so it can postMessage context updates into it without going through
// quick-settings-host.js's shared drawer.

'use strict';

const AI_KEY = '__blm_claude_ai';
let enabled = false;
let fabHost = null;    // the button's shadow host, always present while enabled
let fabRoot = null;    // its closed shadow root's live handle — attachShadow's return value is the
                        // only way to reach back into a closed root later, so it's kept here
let panel = null;      // { host, frame } while the popup is open, else null

// The AI mark, as in shared/claude-icon.js (OpenProject's one-line o·p + the Claude spark in its
// top-left corner) — duplicated because a content script can't import an ES module; keep the two in
// step (see also getChartColors() in viewer.js and reminder-banner.js, which duplicate token values
// for the same reason). Here it is white on the orange button, with an orange bead on the line.
const MARK_LINE = 'M13.92 17.62V15.8M13.92 11.93V5.82A2.4 2.4 0 0 1 16.32 3.42H18.43A2.4 2.4 0 0 1 20.83 5.82V9.53A2.4 2.4 0 0 1 18.43 11.93H5.52A2.4 2.4 0 0 0 3.12 14.33V18.15A2.4 2.4 0 0 0 5.52 20.55H7.53A2.4 2.4 0 0 0 9.93 18.15V15.8';
const MARK_SPARK = 'M6.4 2.9C6.76 5.11 7.49 5.84 9.7 6.2C7.49 6.56 6.76 7.29 6.4 9.5C6.04 7.29 5.31 6.56 3.1 6.2C5.31 5.84 6.04 5.11 6.4 2.9Z';

/** The work package shown in the detail view, from /work_packages/(details/)<id> — same regex content.js uses. */
function detailWpId() {
  const m = /\/work_packages\/(?:details\/)?(\d+)/.exec(location.pathname);
  return m ? m[1] : null;
}

function projectSlug() {
  const m = /\/projects\/([^/]+)\/work_packages/.exec(location.pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

const context = () => ({ wp: detailWpId(), project: projectSlug(), query: new URLSearchParams(location.search).get('query_id') });

function assistantUrl() {
  const { wp, project, query } = context();
  const params = new URLSearchParams({ embedded: '1' });
  if (wp) params.set('wp', wp);
  if (project) params.set('project', project);
  if (query) params.set('query', query);
  return chrome.runtime.getURL('pages/assistant.html') + '?' + params.toString();
}

// ─── The button ───────────────────────────────────────────────────────────────

function createFab() {
  if (fabHost) return;
  fabHost = document.createElement('div');
  fabHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483646;';
  fabRoot = fabHost.attachShadow({ mode: 'closed' });
  fabRoot.innerHTML = `
    <style>
      button {
        all: initial; position: fixed; right: 20px; bottom: 20px; width: 48px; height: 48px;
        border-radius: 50%; background: #d97757; display: flex; align-items: center; justify-content: center;
        cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.3), 0 0 0 1px rgba(255,255,255,.08);
        transition: transform 140ms cubic-bezier(0.16,1,0.3,1);
      }
      button[data-offline] { background: #6b6f78; }
      button:hover { transform: translateY(-2px); }
      button:active { transform: translateY(0) scale(0.96); }
      svg { width: 26px; height: 26px; overflow: visible; display: block; pointer-events: none; }
      .line, .x { fill: none; stroke: #fff; stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; }
      .spark { fill: #fff; transform-box: fill-box; transform-origin: center; animation: twinkle 4.5s ease-in-out infinite; }
      .bead {
        fill: #d97757; stroke: #fff; stroke-width: 1.3; offset-path: path('${MARK_LINE}'); offset-rotate: 0deg;
        offset-anchor: 0 0; transform-box: view-box; transform-origin: 0 0; animation: ride 12s linear infinite;
      }
      .x { display: none; }
      button[aria-expanded="true"] .mark { display: none; }
      button[aria-expanded="true"] .x { display: inline; }
      button[data-offline] .spark, button[data-offline] .bead { animation: none; }
      button[data-offline] .bead { display: none; }
      @keyframes twinkle { 0%, 82%, 100% { transform: scale(1) rotate(0); } 88% { transform: scale(1.4) rotate(45deg); } 94% { transform: scale(.9) rotate(90deg); } }
      @keyframes ride { from { offset-distance: 0%; } to { offset-distance: 100%; } }
      @media (prefers-reduced-motion: reduce) { button { transition: none; } .spark, .bead { animation: none; } .bead { display: none; } }
    </style>
    <button type="button" aria-label="Ask Claude about this" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <g class="mark"><path class="line" d="${MARK_LINE}" /><circle class="bead" r="1.9" /><path class="spark" d="${MARK_SPARK}" /></g>
        <path class="x" d="M6.5 6.5L17.5 17.5M17.5 6.5L6.5 17.5" />
      </svg>
    </button>`;
  document.documentElement.append(fabHost);
  const btn = fabRoot.querySelector('button');
  // Read the page selection on pointerdown, before the click could move focus and clear it.
  btn.addEventListener('pointerdown', () => { pendingSelection = String(getSelection() ?? '').trim().slice(0, 2000); });
  btn.addEventListener('click', togglePanel);
  checkBridge();
}

// ─── Bridge status: a grey button with a tooltip while the local bridge is down ──

let pendingSelection = '';
let bridgeOffline = null;   // the bridge's last error message, or null while it answers

function paintFab() {
  const btn = fabRoot?.querySelector('button');
  if (!btn) return;
  const open = btn.getAttribute('aria-expanded') === 'true';
  btn.toggleAttribute('data-offline', !!bridgeOffline);
  btn.title = bridgeOffline ? `Claude bridge is offline: ${bridgeOffline}` : open ? 'Close the Claude assistant' : 'Ask Claude about this';
}

function checkBridge() {
  if (!fabRoot || !chrome.runtime?.id) return;
  chrome.runtime.sendMessage({ type: 'blm-bridge-health' })
    .then(r => { bridgeOffline = r?.ok ? null : (r?.error || 'not reachable'); paintFab(); })
    .catch(() => { /* the extension was reloaded; togglePanel reloads the tab */ });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkBridge(); });

function removeFab() {
  closePanel();
  fabHost?.remove();
  fabHost = null;
  fabRoot = null;
}

/** Swaps the button between the mark (closed) and an × (open); the CSS keys off aria-expanded. */
function setFabState(open) {
  const btn = fabRoot?.querySelector('button');
  if (!btn) return;
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', open ? 'Close the Claude assistant' : 'Ask Claude about this');
  paintFab();
}

// ─── The popup ────────────────────────────────────────────────────────────────

function openPanel() {
  if (panel) return;
  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483645;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .card {
        position: fixed; right: 20px; bottom: 80px;
        width: min(var(--w, 460px), calc(100vw - 40px)); height: min(var(--h, 640px), calc(100vh - 110px));
        border-radius: 16px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.08);
        transform-origin: bottom right; transform: scale(.94) translateY(8px); opacity: 0;
        transition: transform 160ms cubic-bezier(0.16,1,0.3,1), opacity 160ms cubic-bezier(0.16,1,0.3,1);
      }
      :host([data-open="true"]) .card { transform: none; opacity: 1; }
      iframe { border: 0; width: 100%; height: 100%; display: block; color-scheme: normal; }
      :host([data-resizing]) iframe { pointer-events: none; }   /* else the iframe swallows the drag */
      /* The popup is anchored bottom-right, so it grows from its top-left corner. */
      .grip {
        position: absolute; left: 0; top: 0; width: 18px; height: 18px; z-index: 1; cursor: nwse-resize;
        background: linear-gradient(135deg, rgba(128,128,128,.55) 0 2px, transparent 2px 5px, rgba(128,128,128,.55) 5px 7px, transparent 7px);
        border-top-left-radius: 16px; opacity: .6; transition: opacity 120ms;
      }
      .grip:hover, :host([data-resizing]) .grip { opacity: 1; }
      @media (prefers-reduced-motion: reduce) { .card { transition: none; } }
    </style>
    <div class="card" role="dialog" aria-label="Claude assistant">
      <div class="grip" title="Drag to resize · double-click to reset" aria-hidden="true"></div>
    </div>`;
  initResize(host, root.querySelector('.card'), root.querySelector('.grip'));
  const frame = document.createElement('iframe');
  frame.title = 'Claude assistant';
  frame.src = assistantUrl();
  root.querySelector('.card').append(frame);
  document.documentElement.append(host);
  requestAnimationFrame(() => requestAnimationFrame(() => { host.dataset.open = 'true'; }));
  const selection = pendingSelection;
  pendingSelection = '';
  frame.addEventListener('load', () => {
    frame.focus();
    if (selection) frame.contentWindow.postMessage({ type: 'blm-assistant-selection', text: selection }, '*');
  }, { once: true });
  panel = { host, frame };
  lastCtx = context();
  setFabState(true);
}

// ─── Resizing: drag the popup's top-left corner; the size is kept for next time ──

const SIZE_KEY = '__blm_assistant_size';   // local: { w, h } in px
const MIN_W = 340, MIN_H = 380;

function initResize(host, card, grip) {
  const apply = s => {
    if (s?.w) card.style.setProperty('--w', `${s.w}px`); else card.style.removeProperty('--w');
    if (s?.h) card.style.setProperty('--h', `${s.h}px`); else card.style.removeProperty('--h');
  };
  chrome.storage.local.get(SIZE_KEY).then(r => apply(r[SIZE_KEY])).catch(() => {});
  grip.addEventListener('dblclick', () => { apply(null); chrome.storage.local.remove(SIZE_KEY).catch(() => {}); });
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const r = card.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    let size = null;
    host.dataset.resizing = '';
    card.style.transition = 'none';
    const move = ev => {
      size = {
        w: Math.round(Math.min(innerWidth - 40, Math.max(MIN_W, r.width + x0 - ev.clientX))),
        h: Math.round(Math.min(innerHeight - 110, Math.max(MIN_H, r.height + y0 - ev.clientY))),
      };
      apply(size);
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      delete host.dataset.resizing;
      card.style.transition = '';
      if (size) chrome.storage.local.set({ [SIZE_KEY]: size }).catch(() => {});
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
}

function closePanel() {
  if (!panel) return;
  const { host } = panel;
  panel = null;
  host.dataset.open = 'false';
  setTimeout(() => host.remove(), 160);
  setFabState(false);
  checkBridge();
}

function togglePanel() {
  if (!chrome.runtime?.id) { location.reload(); return; }   // the extension was reloaded while this tab stayed open
  if (panel) closePanel(); else openPanel();
}

// Closing with Escape matches quick-settings-host.js's drawer; outside clicks do NOT close the
// popup, on purpose — the point of a popup over the drawer is that the page stays usable while it
// is open, so a stray click on the backlog must not dismiss it.
document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel) closePanel(); });

// Messages from the popup. Only its own iframe counts.
window.addEventListener('message', e => {
  if (!panel || e.source !== panel.frame.contentWindow) return;
  if (e.data?.type === 'blm-assistant-close') closePanel();
  if (e.data?.type === 'blm-assistant-applied') onApplied(e.data);
  if (e.data?.type === 'blm-assistant-working') setWorking(e.data);
});

// ─── After Apply: show the change in place, then light up where it landed ─────
// OpenProject's SPA doesn't notice writes made through the API, so background.js asks its own
// Angular app to re-read the work package (story, activity and list row update in place) and the
// changed text glows for a few seconds, with the popup still open. Only if that isn't possible
// does the page reload (the chat isn't kept, so the popup then stays closed).

const APPLIED_KEY = 'blm-ai-applied';   // sessionStorage of this tab: { wp, marks, at }

// wp '' is a change on a list (a new story): nothing to refresh by id, so that one reloads.
async function onApplied({ wp, marks, fields, reload }) {
  if (!Array.isArray(marks) || (wp !== '' && !/^\d+$/.test(String(wp)))) return;
  const clean = marks.filter(m => typeof m === 'string' && m.trim()).slice(0, 20).map(m => m.slice(0, 255));
  const names = (Array.isArray(fields) ? fields : []).filter(f => typeof f === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(f)).slice(0, 12);
  const r = wp !== '' && !reload ? await chrome.runtime.sendMessage({ type: 'blm-op-refresh', wp: String(wp) }).catch(() => null) : null;
  if (r?.ok) { highlightApplied({ marks: clean, fields: names }); return; }
  try { sessionStorage.setItem(APPLIED_KEY, JSON.stringify({ wp: String(wp), marks: clean, fields: names, at: Date.now() })); } catch { return; }
  setTimeout(() => location.reload(), 700);   // let "✓ Applied" show first
}

function takeApplied() {
  let v = null;
  try { v = JSON.parse(sessionStorage.getItem(APPLIED_KEY) ?? 'null'); sessionStorage.removeItem(APPLIED_KEY); } catch { /* no storage */ }
  return v && Date.now() - v.at < 30_000 && v.wp === (detailWpId() ?? '') ? v : null;
}

const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Up to three visible block elements on the page whose text contains the mark (our own UI is in shadow roots, so skipped). */
function findMarks(mark) {
  const needle = norm(mark).slice(0, 40);
  if (needle.length < 3) return [];
  const found = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode()) && found.size < 3;) {
    if (!norm(n.nodeValue).includes(needle)) continue;
    let el = n.parentElement;
    while (el && el !== document.body && getComputedStyle(el).display === 'inline') el = el.parentElement;
    if (el && el !== document.body && el.getClientRects().length && !el.closest('script, style, title')) found.add(el);
  }
  return [...found];
}

function injectGlowStyle() {
  if (document.getElementById('blm-ai-touched-style')) return;
  const style = document.createElement('style');
  style.id = 'blm-ai-touched-style';
  style.textContent = `
    @keyframes blm-ai-glow {
      0%   { box-shadow: 0 0 0 0 rgba(217,119,87,0); }
      25%  { box-shadow: 0 0 0 3px rgba(217,119,87,.6), 0 0 22px 6px rgba(217,119,87,.35); }
      100% { box-shadow: 0 0 0 0 rgba(217,119,87,0); }
    }
    @keyframes blm-ai-sweep { from { background-position: 180% 0; } to { background-position: -80% 0; } }
    @keyframes blm-ai-breathe {
      0%, 100% { box-shadow: 0 0 0 1px rgba(217,119,87,.35), 0 0 6px 0 rgba(217,119,87,.15); }
      50%      { box-shadow: 0 0 0 2px rgba(217,119,87,.75), 0 0 20px 4px rgba(217,119,87,.35); }
    }
    @keyframes blm-ai-shimmer { from { background-position: 200% 0; } to { background-position: -100% 0; } }
    @keyframes blm-ai-ghost-in { from { opacity: 0; transform: translateY(-4px); } }
    .blm-ai-ghost { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 6px; list-style: none;
      animation: blm-ai-ghost-in .25s ease-out, blm-ai-breathe 1.4s ease-in-out infinite; }
    .blm-ai-ghost > td { display: flex; align-items: center; gap: 10px; padding: 6px 8px; }
    .blm-ai-ghost-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .55; }
    .blm-ai-sk { display: inline-block; height: 10px; border-radius: 5px; flex: none;
      background: linear-gradient(100deg, rgba(128,128,128,.18) 30%, rgba(217,119,87,.45) 50%, rgba(128,128,128,.18) 70%) 200% 0 / 300% 100%;
      animation: blm-ai-shimmer 1.2s linear infinite; }
    @media (prefers-reduced-motion: reduce) { .blm-ai-ghost, .blm-ai-sk { animation: none; } }
    .blm-ai-working {
      border-radius: 6px;
      background-image: linear-gradient(100deg, transparent 25%, rgba(217,119,87,.22) 45%, rgba(255,214,170,.32) 50%, rgba(217,119,87,.22) 55%, transparent 75%) !important;
      background-size: 250% 100% !important; background-repeat: no-repeat !important;
      animation: blm-ai-breathe 1.4s ease-in-out infinite, blm-ai-sweep 1.6s ease-in-out infinite !important;
    }
    .blm-ai-touched {
      border-radius: 6px;
      background-image: linear-gradient(100deg, transparent 25%, rgba(217,119,87,.30) 45%, rgba(255,214,170,.40) 50%, rgba(217,119,87,.30) 55%, transparent 75%) !important;
      background-size: 250% 100% !important; background-repeat: no-repeat !important;
      animation: blm-ai-glow 1.4s cubic-bezier(0.16,1,0.3,1) 1, blm-ai-sweep 1.4s ease-in-out 1 !important;
    }
    @media (prefers-reduced-motion: reduce) {
      .blm-ai-touched, .blm-ai-working { animation: none !important; background-image: none !important; outline: 2px solid #d97757; outline-offset: 2px; }
    }`;
  document.head.append(style);
}

function glow(el, first) {
  injectGlowStyle();
  el.classList.add('blm-ai-touched');
  if (first) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  setTimeout(() => el.classList.remove('blm-ai-touched'), 1500);   // one flash; the glow while writing already told the story
}

let workingTimer = 0;

// New items: a skeleton row per title appears the moment Apply is pressed and shimmers until the real row arrives.
const GHOST = 'blm-ai-ghost';

function ghostRow(title, tag) {
  const row = document.createElement(tag);
  row.className = GHOST;
  row.setAttribute('aria-hidden', 'true');
  const mk = w => { const i = document.createElement('i'); i.className = 'blm-ai-sk'; i.style.width = w; return i; };
  const name = document.createElement('span');
  name.className = 'blm-ai-ghost-title';
  name.textContent = title;
  if (tag === 'tr') {
    const td = document.createElement('td');
    td.colSpan = 99;
    td.append(mk('40px'), name, mk('70px'), mk('56px'));
    row.append(td);
  } else row.append(mk('16px'), mk('40px'), name, mk('70px'), mk('56px'));
  return row;
}

/** Puts a skeleton row per new title at the end of the child list (story) or the top of the table (list), once. */
function showGhosts(titles, onList) {
  const host = onList ? document.querySelector('table.work-package-table tbody') : document.querySelector('.blm-jx-children ul');
  if (!host || host.querySelector('.' + GHOST)) return;
  host.dataset.blmRows = String(host.querySelectorAll(':scope > :not(.' + GHOST + ')').length);
  for (const t of titles) {
    const row = ghostRow(t, onList ? 'tr' : 'li');
    if (onList) host.prepend(row); else host.append(row);
  }
}

/** The write is over: the skeletons stay until the real rows show up (or 4 s), so the list never goes blank. */
function retireGhosts() {
  const t0 = Date.now();
  const timer = setInterval(() => {
    const ghosts = document.querySelectorAll('.' + GHOST);
    const host = ghosts[0]?.parentElement;
    const real = host ? host.querySelectorAll(':scope > :not(.' + GHOST + ')').length : 0;
    if (!ghosts.length || real > Number(host.dataset.blmRows ?? 0) || Date.now() - t0 > 4000) {
      ghosts.forEach(g => g.remove());
      clearInterval(timer);
    }
  }, 200);
}

/** While the popup writes, the places it writes to breathe; they stop when it's done and the "touched" flash takes over. */
function setWorking({ wp, on, fields, ghosts }) {
  clearInterval(workingTimer);
  document.querySelectorAll('.blm-ai-working').forEach(el => el.classList.remove('blm-ai-working'));
  if (!on) { retireGhosts(); return; }
  if ( (wp !== '' && !/^\d+$/.test(String(wp)))) return;
  const names = (Array.isArray(fields) ? fields : []).filter(f => typeof f === 'string' && /^(@children|[A-Za-z0-9_]{1,40})$/.test(f)).slice(0, 12);
  const titles = (Array.isArray(ghosts) ? ghosts : []).filter(t => typeof t === 'string' && t.trim()).slice(0, 12).map(t => t.slice(0, 255));
  if (!names.length && !titles.length) return;
  injectGlowStyle();
  let ticks = 0;
  const mark = () => {
    for (const n of names) (n === '@children' ? document.querySelector('.blm-jx-children, .wp-relations--children') : fieldRow(n))?.classList.add('blm-ai-working');
    if (titles.length) showGhosts(titles, wp === '');
    if (++ticks > 240) setWorking({ on: false });   // 2 min: never glow forever if the popup vanished mid-write
  };
  mark();
  workingTimer = setInterval(mark, 500);   // the page rebuilds these elements as it re-renders, so keep re-marking
}

/** The attribute row of a form field (its label and value together), once it is on screen. */
function fieldRow(name) {
  for (const el of document.querySelectorAll(`[data-field-name="${name}"]`)) {
    const row = el.closest('.attributes-key-value') ?? el;
    if (row.getClientRects().length) return row;
  }
  return null;
}

/** Waits (up to 15 s, as the SPA renders) for each changed field, then each text mark, to appear, and lights each up once. */
function highlightApplied({ marks, fields = [] }) {
  const left = new Set(marks), fieldsLeft = new Set(fields), lit = new Set();
  let first = true, tries = 0;
  const timer = setInterval(() => {
    for (const name of [...fieldsLeft]) {
      const row = fieldRow(name);
      if (!row) continue;
      fieldsLeft.delete(name);
      lit.add(row); glow(row, first); first = false;
    }
    for (const mark of [...left]) {
      const els = findMarks(mark);
      if (!els.length) continue;
      left.delete(mark);
      els.filter(el => ![...lit].some(l => l.contains(el) || el.contains(l))).forEach(el => { lit.add(el); glow(el, first); first = false; });
    }
    if ((!left.size && !fieldsLeft.size) || ++tries >= 30) clearInterval(timer);
  }, 500);
}

let appliedAfterReload = takeApplied();

function syncVisibility() {
  if (enabled) createFab(); else removeFab();
  if (enabled && appliedAfterReload) {
    const v = appliedAfterReload;
    appliedAfterReload = null;
    highlightApplied(v);
  }
}

chrome.storage.local.get(AI_KEY).then(s => { enabled = s[AI_KEY] === true; syncVisibility(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && AI_KEY in changes) { enabled = changes[AI_KEY].newValue === true; syncVisibility(); }
});

// ─── Keep the open popup's context in step with SPA navigation ───────────────
// OpenProject is an Angular SPA: opening/closing a story or switching the query changes the URL
// without a full reload, so this script is never re-injected — watch for it instead.

let lastCtx = null;

function pushContextIfOpen() {
  if (!panel) return;
  const c = context();
  if (lastCtx && lastCtx.wp === c.wp && lastCtx.project === c.project && lastCtx.query === c.query) return;
  lastCtx = c;
  panel.frame.contentWindow.postMessage({ type: 'blm-assistant-context', ...c }, '*');
}

let navDebounce = null;
function onNavigationDetected() {
  clearTimeout(navDebounce);
  navDebounce = setTimeout(pushContextIfOpen, 300);
}

if (typeof window.navigation !== 'undefined') {
  window.navigation.addEventListener('navigate', onNavigationDetected);
}
(function patchHistory() {
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = function (...args) { _push(...args); onNavigationDetected(); };
  history.replaceState = function (...args) { _replace(...args); onNavigationDetected(); };
})();
