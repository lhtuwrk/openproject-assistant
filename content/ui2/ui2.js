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
const BL_CLASS   = 'blm-ui2-bl';

// The switch and theme are cached in the host page's localStorage so the first
// paint is already right; chrome.storage is async and lands after it.
const cached = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const cache  = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
let enabled = cached(CFG_UI2) === '1';
let theme = cached(CFG_THEME) === 'light' ? 'light' : 'dark';

const onWorkPackagePage = () => /\/work_packages(\/|$)/.test(location.pathname);
const onBacklogsPage    = () => /\/backlogs(\/|$)/.test(location.pathname);

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

// Priority names vary per instance: anything urgent-sounding is "urgent".
function prioTone(text) {
  if (/immediate|urgent|blocker|critical|highest/.test(text)) return 'urgent';
  if (/high/.test(text)) return 'high';
  if (/low/.test(text)) return 'low';
  return 'normal';
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
  // List: priority gets a tone (its text has no colour of its own), lone "-" cells
  // go quiet, and a group's "(6)" count becomes a bare number for its capsule.
  for (const f of document.querySelectorAll('td.priority .inline-edit--display-field')) {
    const tone = prioTone(f.textContent.trim().toLowerCase());
    if (f.dataset.blmPrio !== tone) f.dataset.blmPrio = tone;
  }
  for (const td of document.querySelectorAll('.work-package-table tr.wp-table--row > td')) {
    td.classList.toggle('blm-g-dash', /^[-–—]$/.test(td.textContent.trim()));
  }
  for (const c of document.querySelectorAll('.work-package-table tr[class*="group-header"] .count')) {
    const n = c.textContent.replace(/[()\s]/g, '');
    if (c.dataset.blmCount !== n) c.dataset.blmCount = n;
  }
  for (const cell of document.querySelectorAll('td.status')) {
    const leaf = textLeaf(cell);
    if (!leaf) continue;
    const tone = statusTone(leaf.textContent.trim().toLowerCase());
    if (leaf.dataset.blmTone !== tone) {
      leaf.classList.add('blm-g-chip');
      leaf.dataset.blmTone = tone;
    }
  }
  // Backlogs: the status text sits in .t, the stored id in a hidden .v
  for (const t of document.querySelectorAll('#rb li.story > .status_id > .t')) {
    const tone = statusTone(t.textContent.trim().toLowerCase());
    if (t.dataset.blmTone !== tone) {
      t.classList.add('blm-g-chip');
      t.dataset.blmTone = tone;
    }
  }
  for (const d of document.querySelectorAll('#rb .backlog > .header .date')) {
    d.classList.toggle('blm-g-empty', !d.textContent.trim());
  }
  // Story detail: fade empty values ("-") and groups with nothing filled in
  for (const g of document.querySelectorAll('.attributes-group')) {
    const values = g.querySelectorAll('.attributes-key-value--value-container');
    let filled = 0;
    for (const v of values) {
      const empty = /^[-–—]?$/.test(v.textContent.trim());
      v.classList.toggle('blm-g-empty', empty);
      if (!empty) filled++;
    }
    g.classList.toggle('blm-g-quiet', values.length > 0 && filled === 0);
  }
  document.querySelectorAll('.op-tab-row').forEach(row => placeInk(row, row.contains(hoverTab) ? hoverTab : null));
  const panel = document.querySelector('.work-packages--details');
  const storyId = location.pathname.match(/work_packages\/(?:details\/)?(\d+)/)?.[1] ?? null;
  // The new story is in: the dimmed panel brightens back (a transition from the
  // dim, never a reset to transparent after it was painted, which read as a jolt)
  if (storyId !== lastStoryId) {
    lastStoryId = storyId;
    document.querySelectorAll('.blm-g-opening').forEach(r => r.classList.remove('blm-g-opening'));
    if (panel?.classList.contains('blm-g-switching')) panel.classList.remove('blm-g-switching');
  }

  // Status button in the split view / full page (wp-status-button is an Angular element, not a class).
  for (const btn of document.querySelectorAll(
    'wp-status-button button, .wp-status-button button, button[class*="__hl_background_status"]'
  )) {
    if (btn.dataset.blmPending) continue;   // showing the status just picked (instant apply)
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
  document.querySelectorAll('.blm-g-empty, .blm-g-quiet, .blm-g-dash').forEach(el => el.classList.remove('blm-g-empty', 'blm-g-quiet', 'blm-g-dash'));
  document.querySelectorAll('[data-blm-prio], [data-blm-count]').forEach(el => { delete el.dataset.blmPrio; delete el.dataset.blmCount; });
  document.querySelectorAll('.blm-g-tab-ink').forEach(el => el.remove());
}

// ── Pointer-driven motion ───────────────────────────────────────────────────
// Segmented-control thumb: one element per tab row, slid under the hovered tab (or the selected one)
function placeInk(row, target) {
  let ink = row.querySelector(':scope > .blm-g-tab-ink');
  if (!ink) {
    ink = document.createElement('span');
    ink.className = 'blm-g-tab-ink blm-g-ink-new';
    ink.setAttribute('aria-hidden', 'true');
    row.prepend(ink);
    requestAnimationFrame(() => requestAnimationFrame(() => ink.classList.remove('blm-g-ink-new')));
  }
  const link = target || row.querySelector('.op-tab-row--link_selected');
  if (!link) { ink.style.opacity = '0'; return; }
  const r = row.getBoundingClientRect(), l = link.getBoundingClientRect();
  ink.style.opacity = '1';
  // transform only (GPU): a 100 px wide thumb moved and scaled to the tab
  const t = `translate(${l.left - r.left - row.clientLeft}px, ${l.top - r.top - row.clientTop}px) scaleX(${(l.width / 100).toFixed(4)})`;
  if (ink.style.height !== `${l.height}px`) ink.style.height = `${l.height}px`;
  if (ink.style.transform !== t) ink.style.transform = t;
}

let hoverTab = null;   // keeps the thumb on the hovered tab across re-tags
let lastStoryId = null; // the story shown, to undim the panel when the next one is in
document.addEventListener('pointerover', (e) => {
  if (!enabled) return;
  const link = e.target.closest?.('.op-tab-row--link');
  if (link) { hoverTab = link; placeInk(link.closest('.op-tab-row'), link); }
}, { passive: true });
document.addEventListener('pointerout', (e) => {
  if (!enabled) return;
  const row = e.target.closest?.('.op-tab-row');
  if (row && !row.contains(e.relatedTarget)) { hoverTab = null; placeInk(row); }
}, { passive: true });

// ── Apply on leave ──────────────────────────────────────────────────────────
// Long-text fields (the description, formattable custom fields) wait for a click
// on OpenProject's check button. With UI 2.0 they apply as soon as you leave
// them, through that same button so OpenProject's own state stays right:
//   · unchanged → the editor just closes (no request, no new version);
//   · changed   → the server copy of the field is checked first; if someone else
//                 changed it since you started, nothing is saved, your text
//                 stays in the editor and a note says why (no silent overwrite).
// Leaving into the editor's own toolbar popups, a file dialog or another window
// does not count as leaving. One-line fields already apply on Enter / blur.
// The activity comment box is the same kind of editor but is never posted on leave.
const EDIT_FIELD = '.inline-edit--active-field';
const STILL_EDITING = '.ck-body-wrapper, .ck-balloon-panel, .ck-dropdown__panel, .op-modal, .spot-modal, .ng-dropdown-panel';
const editSnap = new WeakMap();   // active field → { data, raw }

// The CKEditor instance lives in the page's JS world, invisible to this isolated script;
// the editable's DOM is shared, so changes are read from its HTML.
const editableOf = (f) => f.querySelector('.document-editor__editable, .ck-editor__editable');
const fieldName = (f) => [...f.classList].find(c => c !== 'inline-edit--active-field' && c !== 'inplace-edit' && !c.startsWith('-'));
const wpIdFromPath = () => location.pathname.match(/work_packages\/(?:details\/)?(\d+)/)?.[1];
async function serverRaw(name) {
  const id = wpIdFromPath();
  if (!id || !name) return undefined;
  const res = await fetch(`/api/v3/work_packages/${id}`, { credentials: 'include', headers: { Accept: 'application/hal+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json())[name]?.raw ?? '';
}

function showConflict(f) {
  if (f.querySelector('.blm-g-conflict')) return;
  const note = document.createElement('p');
  note.className = 'blm-g-conflict';
  note.setAttribute('role', 'status');
  note.textContent = 'Someone else changed this while you were editing, so it was not saved automatically. '
    + 'Your text is still here: copy what you need, then reload to see their version.';
  (f.querySelector('.inplace-edit--controls') || f).before(note);
}

async function commitOnLeave(f) {
  if (!enabled || !f.isConnected || f.dataset.blmSaving) return;
  const a = document.activeElement;
  if (!document.hasFocus() || f.contains(a) || a?.closest?.(STILL_EDITING)) return;
  const snap = editSnap.get(f);
  const ed = editableOf(f);
  if (!snap || !ed) return;
  if (ed.innerHTML === snap.data) {
    editSnap.delete(f);
    f.querySelector('.inplace-edit--control--cancel')?.click();
    return;
  }
  f.dataset.blmSaving = '1';
  try {
    if (snap.raw !== undefined && await serverRaw(fieldName(f)) !== snap.raw) { showConflict(f); return; }
    if (!f.isConnected) return;   // saved or cancelled by hand meanwhile
    editSnap.delete(f);
    f.querySelector('.inplace-edit--control--save')?.click();
  } catch {
    // network trouble: leave the editor open, the check button still saves by hand
  } finally {
    delete f.dataset.blmSaving;
  }
}

document.addEventListener('focusin', (e) => {
  if (!enabled) return;
  const f = e.target.closest?.(EDIT_FIELD);
  if (!f || editSnap.has(f) || !f.querySelector('.inplace-edit--control--save')) return;
  if (f.classList.contains('comment')) return;   // a comment is posted only by its own button, never on leave
  const ed = editableOf(f);
  if (!ed) return;
  const snap = { data: ed.innerHTML, raw: undefined };
  editSnap.set(f, snap);
  serverRaw(fieldName(f)).then(raw => { snap.raw = raw; }).catch(() => { /* no check possible: save as OpenProject would */ });
});
document.addEventListener('focusout', (e) => {
  if (!enabled) return;
  const f = e.target.closest?.(EDIT_FIELD);
  if (f && editSnap.has(f)) setTimeout(() => commitOnLeave(f), 300);   // let focus land first (toolbar popups)
});

// ── Instant apply ───────────────────────────────────────────────────────────
// OpenProject keeps an edited field in its editor until the server answers, so a
// pick or a typed value only "lands" a beat later. progress-hook.js (page world)
// announces each work-package save: 'wp-save-start', 'wp-updated', 'wp-save-failed'.
//   · the user's action itself (an option chosen, Enter, the check button) already
//              makes that editor drop its chrome and read as the applied value
//              (.blm-g-committing): OpenProject first round-trips its /form check,
//              so its PATCH, and the 'start' message, come a beat later;
//   · start  → any other open editor being saved gets the same; a status just picked
//              shows on the button (data-blm-pending) with its tone;
//   · saved  → OpenProject re-renders the field from the saved value; leftovers clear;
//   · failed → the editor comes back as it was, with a short shake, so nothing is lost.
const SAVE_MSG = 'blm-progress-hook';
let statusBtn = null;   // the status button whose menu is open

document.addEventListener('click', (e) => {
  if (!enabled) return;
  const btn = e.target.closest?.('.blm-g-status');
  if (btn) { statusBtn = btn; return; }
  const item = e.target.closest?.('.dropdown-menu .menu-item[class*="__hl_inline_status_"]');
  if (item && statusBtn?.isConnected) {
    const label = item.textContent.trim();
    statusBtn.dataset.blmPending = label;
    statusBtn.dataset.blmTone = statusTone(label.toLowerCase());
  }
}, true);

// Mark an editor as applied; if no save ever answers (validation kept it open,
// nothing changed), give it back after a while so it is never stuck read-only.
const savedSpots = new Set();   // .inline-edit--container of editors being saved
function markCommitting(f) {
  if (!f || f.classList.contains('blm-g-committing')) return;
  f.classList.add('blm-g-committing');
  const spot = f.closest('.inline-edit--container');
  if (spot) savedSpots.add(spot);
  setTimeout(() => {
    if (f.isConnected && f.classList.contains('blm-g-committing')) f.classList.remove('blm-g-committing');
  }, 10000);
}
const activeFieldOf = (el) => el?.closest?.(EDIT_FIELD);

// An option picked in a single-select editor (the panel is appended to <body>)
document.addEventListener('click', (e) => {
  if (!enabled) return;
  const opt = e.target.closest?.('.ng-dropdown-panel .ng-option:not(.ng-option-disabled)');
  if (opt) {
    const sel = document.querySelector(`${EDIT_FIELD} .ng-select-opened:not(.ng-select-multiple)`);
    markCommitting(activeFieldOf(sel));
    return;
  }
  if (e.target.closest?.('.inplace-edit--control--save')) markCommitting(activeFieldOf(e.target));
}, true);
// Enter in a one-line editor (title, numbers), or picking with the keyboard in a select
document.addEventListener('keydown', (e) => {
  if (!enabled || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  const f = activeFieldOf(e.target);
  if (!f || e.target.closest('.ck-editor__editable, .document-editor__editable, textarea, .ng-select-multiple')) return;
  markCommitting(f);
}, true);

function clearPending() {
  document.querySelectorAll('.blm-g-status[data-blm-pending]').forEach(b => { delete b.dataset.blmPending; });
  schedule();   // retag tones from what OpenProject now shows
}
function rollback() {
  savedSpots.clear();
  document.querySelectorAll('.blm-g-committing').forEach(f => {
    f.classList.remove('blm-g-committing');
    f.classList.add('blm-g-shake');
    setTimeout(() => f.classList.remove('blm-g-shake'), 450);
  });
  clearPending();
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== SAVE_MSG || !enabled) return;
  const { type } = e.data;
  if (type === 'wp-save-start') {
    document.querySelectorAll(EDIT_FIELD).forEach(f => {
      if (!f.contains(document.activeElement) || f.classList.contains('blm-g-committing')) markCommitting(f);
    });
  } else if (type === 'wp-updated') {
    // OpenProject swaps the editors for display fields; anything it kept open stays usable
    setTimeout(() => {
      document.querySelectorAll('.blm-g-committing').forEach(f => f.classList.remove('blm-g-committing'));
      clearPending();
      // the saved value glows once where it landed
      for (const spot of savedSpots) {
        const shown = spot.isConnected && spot.querySelector('.inline-edit--display-field');
        if (shown) {
          shown.classList.remove('blm-g-flash'); void shown.offsetWidth; shown.classList.add('blm-g-flash');
          setTimeout(() => shown.classList.remove('blm-g-flash'), 950);
        }
      }
      savedSpots.clear();
    }, 60);
  } else if (type === 'wp-save-failed') {
    rollback();
  }
});

// ── Open a story without the freeze ─────────────────────────────────────────
// Clicking a list row makes OpenProject build the whole story panel in one go
// (~0.5 s with nothing painted), so the screen seemed to stall. The click is held
// for one frame: the row shows as chosen and the open panel dims ("loading")
// first, then the same click goes on to OpenProject. When the new story lands,
// its content fades in. Plain clicks only: modified clicks, links, buttons,
// inline-editable cells and the context-menu cell pass straight through.
const replayed = new WeakSet();
document.addEventListener('click', (e) => {
  if (!enabled || replayed.has(e) || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (document.documentElement.classList.contains('blm-no-anim')) return;
  const row = e.target.closest?.('.work-package-table tr.wp-table--row');
  if (!row || e.target.closest('a, button, input, select, textarea, label, .inline-edit--display-field, .inline-edit--active-field, .wp-table--context-menu-td, .wp-table--cell-td.__internal-sorthandle')) return;
  if (row.classList.contains('-checked')) return;   // already open
  e.preventDefault();
  e.stopImmediatePropagation();
  row.classList.add('blm-g-opening');
  document.querySelector('.work-packages--details')?.classList.add('blm-g-switching');
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
    setTimeout(() => {
      row.classList.remove('blm-g-opening');
      document.querySelector('.work-packages--details.blm-g-switching')?.classList.remove('blm-g-switching');
    }, 3000);   // safety net; the story change below clears it sooner
  };
  requestAnimationFrame(() => requestAnimationFrame(go));   // after the feedback has been painted
  setTimeout(go, 100);   // never hold the click longer, even when no frames are drawn
}, true);

// Angular re-renders rows on scroll, grouping and query switch: re-tag once per frame.
let frame = 0;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    syncViewTransition();   // Settings → Animations lands after the first apply()
    if (enabled && (onWorkPackagePage() || onBacklogsPage())) {
      const t0 = performance.now();
      tagCells();
      try { performance.measure('blm-ui2 tag', { start: t0, end: performance.now() }); } catch { /* old browser */ }
    }
  });
}
function observe() {
  new MutationObserver(() => { if (enabled) schedule(); })
    .observe(document.body, { childList: true, subtree: true });
}
if (document.body) observe();
else document.addEventListener('DOMContentLoaded', observe, { once: true });

// Page-to-page crossfade (Backlogs ↔ work packages are full page loads). The
// @view-transition rule can't be scoped to a class, so it exists only while UI 2.0
// is on; the next page inserts it again at document_start from the cached switch.
// Off with Settings → Animations (blm-no-anim) and prefers-reduced-motion.
const VT_ID = 'blm-ui2-view-transition';
function syncViewTransition() {
  const want = enabled && !document.documentElement.classList.contains('blm-no-anim');
  let st = document.getElementById(VT_ID);
  if (want && !st) {
    st = document.createElement('style');
    st.id = VT_ID;
    st.textContent = '@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } '
      + '::view-transition-old(root), ::view-transition-new(root) { animation-duration: 180ms; } }';
    (document.head || document.documentElement).appendChild(st);
  } else if (!want && st) {
    st.remove();
  }
}

function apply() {
  const root = document.documentElement;
  syncViewTransition();
  root.classList.toggle(ROOT_CLASS, enabled);
  root.classList.toggle(WP_CLASS, enabled && onWorkPackagePage());
  root.classList.toggle(BL_CLASS, enabled && onBacklogsPage());
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
  cache(CFG_UI2, enabled ? '1' : '0');
  cache(CFG_THEME, theme);
  apply();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (CFG_UI2 in changes) {
    enabled = changes[CFG_UI2].newValue ?? false;
    cache(CFG_UI2, enabled ? '1' : '0');
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
