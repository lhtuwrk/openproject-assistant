// package.js — the release pipeline as a tracked "Package" instance: start one from
// a template (a free-form node/edge graph drawn on pkg-canvas), step through it, and
// turn a QA-flagged repackage into tasks. Phase 1 is local-only (chrome.storage.local,
// no OpenProject work packages): see the plan this page was built from for later phases.

import { PACKAGE_TEMPLATES, SEED } from './package-templates.js';
import { renderCanvas } from './package-canvas.js';
import { cachedMe } from '../shared/me.js';
import { sprintCalendar } from '../shared/api.js';
import { readFirstSheet } from './xlsx-read.js';

const DEPS_URL_KEY = '__blm_package_deps_url';
const DEPS_KEY = '__blm_package_deps';
const PACKAGES_KEY = '__blm_packages';
const TEMPLATES_KEY = '__blm_package_templates';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// ─── Template store ────────────────────────────────────────────────────────────
// Editable, persisted templates. Seeded from PACKAGE_TEMPLATES, so edits made in
// the template editor never touch the seed file — same "session key vs.
// definitions key" split as planning.js (SESSION_KEY vs LEVELS_KEY). Re-seeded
// when the seed graph changes (SEED), which replaces a seeded template that was
// edited; packages already running keep their own copy of the graph.

let templates = [];
const templateById = id => templates.find(t => t.id === id) ?? templates[0] ?? null;
const saveTemplates = () => chrome.storage.local.set({ [TEMPLATES_KEY]: { v: 1, seed: SEED, items: templates } });

// ─── Graph traversal ────────────────────────────────────────────────────────────

const nodeDef = (snapshot, id) => snapshot.nodes.find(n => n.id === id) ?? null;
const outgoing = (snapshot, id) => snapshot.edges.filter(e => e.from === id);

function nextNodeId(snapshot, id, decision) {
  const edges = outgoing(snapshot, id);
  const node = nodeDef(snapshot, id);
  if (node?.kind === 'decision') return edges.find(e => e.label === decision)?.to ?? null;
  return edges[0]?.to ?? null; // a task node is expected to have exactly one outgoing edge
}

/** The graph's start node: the one no edge points to. */
const startNodeId = snapshot => snapshot.nodes.find(n => !snapshot.edges.some(e => e.to === n.id))?.id ?? snapshot.nodes[0]?.id ?? null;

// ─── Packages store ─────────────────────────────────────────────────────────────

function freshStore(prev) {
  return { v: 1, items: Array.isArray(prev?.items) ? prev.items : [] };
}

let store = freshStore(null);
let me = null;
let openId = null;            // package shown in detail view
let showTemplates = false;    // template picker shown instead of the package list
let editingTemplateId = null; // template open in the canvas editor

const save = () => chrome.storage.local.set({ [PACKAGES_KEY]: store });
const packageById = id => store.items.find(p => p.id === id) ?? null;

/** The fields the delivery email and the Records row are written from. */
const FIELDS = [
  { key: 'sprint', label: 'Sprint' },
  { key: 'pgVersion', label: 'Postgres version', placeholder: '2.48.5', hint: 'odd' },
  { key: 'oraVersion', label: 'Oracle version', placeholder: '2.48.6', hint: 'even' },
  { key: 'mockVersion', label: 'ch-mock-app version', placeholder: '2.48.5' },
  { key: 'processes', label: 'Number of processes', placeholder: '12' },
];

/** The last number of a version, or null when there isn't one. */
const versionTail = v => {
  const m = String(v ?? '').trim().match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
};

/** The process wants odd versions for Postgres and even ones for Oracle. */
function versionParityWarning(pkg) {
  const bad = [];
  const pg = versionTail(pkg.fields?.pgVersion);
  const ora = versionTail(pkg.fields?.oraVersion);
  if (pg !== null && pg % 2 === 0) bad.push(`the Postgres version ${pkg.fields.pgVersion} is even`);
  if (ora !== null && ora % 2 === 1) bad.push(`the Oracle version ${pkg.fields.oraVersion} is odd`);
  return bad.length ? `${bad.join(' and ')} — Postgres takes odd versions, Oracle even ones.` : '';
}

function freshPackage(tpl, name, fields) {
  const snapshot = structuredClone({ nodes: tpl.nodes, edges: tpl.edges });
  const steps = Object.fromEntries(snapshot.nodes.map(n => [n.id, {
    status: 'todo', startedAt: null, endedAt: null, decision: null, tasks: [], checked: [],
  }]));
  return {
    id: uid(), templateId: tpl.id, name, fields,
    holder: me ? { id: me.id, name: me.name } : null,
    startedAt: nowIso(), endedAt: null,
    templateSnapshot: snapshot,
    currentNodeId: startNodeId(snapshot),
    steps,
  };
}

/**
 * Finishes a node (and, at a decision, records the answer), moving the package on.
 * @returns {boolean} false when the graph has nowhere to go from here, which leaves
 *   the package where it was rather than calling it delivered.
 */
function completeStep(pkg, id, decision = null) {
  const snapshot = pkg.templateSnapshot;
  const st = pkg.steps[id];
  const next = nextNodeId(snapshot, id, decision ?? st.decision);
  if (!next && outgoing(snapshot, id).length) return false;
  st.status = 'done';
  st.endedAt = nowIso();
  if (decision) st.decision = decision;
  pkg.currentNodeId = next;
  if (!next) pkg.endedAt = nowIso();
  return true;
}

/** Puts a finished step back in play, so a mis-click or a redo isn't a dead end. */
function reopenStep(pkg, id) {
  const st = pkg.steps[id];
  st.status = 'in_progress';
  st.endedAt = null;
  st.decision = null;
  pkg.currentNodeId = id;
  pkg.endedAt = null;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function nodeState(pkg, id) {
  const st = pkg.steps[id];
  if (st.status === 'done') return 'done';
  if (pkg.currentNodeId === id) return 'now';
  return 'locked';
}

const statusWord = s => s === 'in_progress' ? 'In progress' : s === 'done' ? 'Done' : 'Not started';

function taskRowHtml(task) {
  const mine = me && task.assignee && String(task.assignee.id) === String(me.id);
  const statusCtl = mine
    ? `<select class="ctrl task-status" data-task="${esc(task.id)}" aria-label="Status of ${esc(task.title)}">
        ${['TODO', 'IN_PROGRESS', 'DONE'].map(v => `<option value="${v}"${v === task.status ? ' selected' : ''}>${v.replace('_', ' ')}</option>`).join('')}
      </select>`
    : `<span class="chip ${task.status.toLowerCase()}" title="Only ${esc(task.assignee?.name ?? 'the assignee')} can change this">${esc(task.status.replace('_', ' '))}</span>`;
  return `<li class="task-row">
    <span class="task-title">${esc(task.title)}</span>
    <span class="task-assignee muted">${esc(task.assignee?.name || 'Unassigned')}</span>
    ${statusCtl}
  </li>`;
}

function taskListHtml(step) {
  if (!step.tasks.length) return '<p class="muted">No tasks yet.</p>';
  return `<ul class="task-list">${step.tasks.map(taskRowHtml).join('')}</ul>`;
}

const addTaskRowHtml = () => `<div class="add-task">
  <input class="ctrl" type="text" data-role="task-title" placeholder="Task title" aria-label="New task title" />
  <input class="ctrl" type="text" data-role="task-assignee" placeholder="Assignee name" aria-label="Assignee name" />
  <label class="inline-chk"><input type="checkbox" data-role="task-me" ${me ? '' : 'disabled'} /> It's me</label>
  <button type="button" class="primary" data-act="add-task">Add task</button>
</div>`;

const nameList = names => `<ul class="gate-list">${names.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;

/**
 * What the dependency sheet says about this package, as the build gate reads it.
 * @returns {{html: string, blocked: boolean, unknown: boolean}}
 */
function depsPanel(pkg) {
  const c = depsCheck();
  const open = '<button type="button" class="linkish" data-act="goto-deps">Dependencies</button>';
  if (!c) return { blocked: false, unknown: true, html: `<p class="gate warn">No dependency sheet has been read yet, so "merged into ch-app" can't be checked. Open ${open} and load it.</p>` };
  if (c.unreadable) return { blocked: false, unknown: true, html: `<p class="gate warn">The sheet is loaded but its <b>Services</b> / <b>Has change</b> columns weren't found, so this can't be checked. Check it in ${open}.</p>` };
  const parts = [];
  let blocked = false;
  let unknown = false;
  if (c.notMerged === null) {
    unknown = true;
    parts.push('<p class="gate warn">The sheet has no <b>Merged to ch-app</b> column, so this can\'t be checked.</p>');
  } else if (c.notMerged.length) {
    blocked = true;
    parts.push(`<p class="gate bad">⛔ Not ready to build: ${c.notMerged.length} of ${c.changed.length} changed services are not merged into ch-app yet.</p>${nameList(c.notMerged)}`);
  } else {
    parts.push(`<p class="gate ok">✓ Ready to build — all ${c.changed.length} changed services are merged into ch-app.</p>`);
  }
  if (c.notReleased?.length) parts.push(`<p class="gate warn">Not released for Postgres yet: ${c.notReleased.length} of ${c.changed.length}.</p>${nameList(c.notReleased)}`);
  if (c.wrongParity.length) parts.push(`<p class="gate warn">Wrong version parity — Postgres takes odd versions, Oracle even ones:</p>${nameList(c.wrongParity)}`);
  const parity = versionParityWarning(pkg);
  if (parity) parts.push(`<p class="gate warn">The package's own versions: ${esc(parity)}</p>`);
  parts.push(`<p class="muted">Sheet read ${esc(new Date(c.loadedAt).toLocaleString())} · ${open}</p>`);
  return { blocked, unknown, html: parts.join('') };
}

const todoText = item => typeof item === 'string' ? item : item.text;

/** True/false when the dependency sheet confirms this checklist item, null when it can't say. */
function autoChecklistValue(kind, pkg) {
  const c = depsCheck();
  if (!c || c.unreadable) return null;
  if (kind === 'released') return c.notReleased !== null ? c.notReleased.length === 0 : null;
  if (kind === 'parity') return c.wrongParity.length === 0 && !versionParityWarning(pkg);
  return null;
}

/** Each checklist item's effective checked state: the user's own click once made, else the auto value. */
function checklistState(def, st, pkg) {
  return (def.todo ?? []).map((item, i) => {
    const manual = st.checked?.[i];
    if (manual !== undefined) return manual;
    return item?.auto ? autoChecklistValue(item.auto, pkg) ?? false : false;
  });
}

function todoHtml(def, st, pkg) {
  if (!def.todo?.length) return '';
  const state = checklistState(def, st, pkg);
  const done = state.filter(Boolean).length;
  return `<section class="step-todo">
    <h3>Checklist <span class="muted">${done}/${def.todo.length}</span></h3>
    <ul class="todo-list">${def.todo.map((item, i) => {
      const auto = item?.auto && st.checked?.[i] === undefined;
      return `<li><label class="inline-chk">
      <input type="checkbox" data-todo="${i}" ${state[i] ? 'checked' : ''} ${st.status === 'done' ? 'disabled' : ''} />
      <span>${esc(todoText(item))}${auto ? ` <span class="muted" title="Ticked automatically from the dependency sheet">· auto</span>` : ''}</span></label></li>`;
    }).join('')}</ul>
  </section>`;
}

function stepDialogHtml(pkg, id) {
  const def = nodeDef(pkg.templateSnapshot, id);
  const st = pkg.steps[id];
  const current = pkg.currentNodeId === id;
  const gate = def.gate ? depsPanel(pkg) : null;
  const blocked = def.gate === 'merged' && gate.blocked;
  const actions = [];
  if (def.kind === 'decision') {
    if (current && !st.decision) {
      actions.push(`<div class="card-actions">
        <button type="button" class="primary" data-act="decide" data-answer="yes">Yes</button>
        <button type="button" data-act="decide" data-answer="no">No</button>
      </div>`);
    } else if (st.decision) {
      actions.push(`<p>Decision: <b>${esc(st.decision)}</b></p>`);
    }
  } else if (current && st.status === 'todo') {
    const label = def.gate === 'merged' && gate.unknown ? 'Start anyway' : 'Start';
    actions.push(`<div class="card-actions"><button type="button" class="primary" data-act="start" ${blocked ? 'disabled' : ''}>${label}</button></div>`);
  } else if (current && st.status === 'in_progress') {
    actions.push('<div class="card-actions"><button type="button" class="primary" data-act="mark-done">Mark done</button></div>');
  }
  if (st.status === 'done') actions.push('<div class="card-actions"><button type="button" data-act="reopen">Reopen this step</button></div>');
  const showTasks = def.kind === 'decision';
  return `<form class="step-form" method="dialog">
    <header class="cl-head"><span class="muted">${esc(def.label)}</span><button type="button" class="ghost" data-act="close" aria-label="Close">✕</button></header>
    <div class="step-body">
      ${def.when ? `<p class="step-when">⏱ ${esc(def.when)}</p>` : ''}
      <p class="muted">Status: ${esc(statusWord(st.status))}${st.startedAt ? ` · started ${new Date(st.startedAt).toLocaleString()}` : ''}${st.endedAt ? ` · done ${new Date(st.endedAt).toLocaleString()}` : ''}</p>
      ${gate ? `<section class="step-gate">${gate.html}</section>` : ''}
      ${todoHtml(def, st, pkg)}
      ${actions.join('')}
      ${showTasks ? `<section class="step-tasks"><h3>Tasks</h3>${taskListHtml(st)}${st.decision === 'yes' ? addTaskRowHtml() : ''}</section>` : ''}
    </div>
    <footer class="cl-foot"><span class="spacer"></span><button type="submit" class="ghost">Close</button></footer>
  </form>`;
}

/** Done steps over total, for a progress bar: {done, total, pct}. */
function packageProgress(pkg) {
  const total = pkg.templateSnapshot.nodes.length;
  const done = Object.values(pkg.steps).filter(s => s.status === 'done').length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

const progressBarHtml = (pct, tone = '') => `<span class="pkg-bar ${tone}"><span class="pkg-bar-fill" style="width:${pct}%"></span></span>`;

const EMPTY_ICON = `<svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M24 6 8 14v20l16 8 16-8V14z"/><path d="M8 14l16 8 16-8M24 22v20"/>
</svg>`;

function listHtml() {
  const rows = [...store.items].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).map(pkg => {
    const def = pkg.currentNodeId ? nodeDef(pkg.templateSnapshot, pkg.currentNodeId) : null;
    const status = pkg.endedAt ? 'Delivered' : def ? def.label : 'In progress';
    const { done, total, pct } = packageProgress(pkg);
    return `<li><button class="all-row" data-act="open-package" data-id="${esc(pkg.id)}">
      <span class="chip ${pkg.endedAt ? 'plan' : 'now'}">${pkg.endedAt ? 'Done' : 'Active'}</span>
      <span class="a-main">
        <span class="a-subject">${esc(pkg.name)}</span>
        <span class="a-meta">${pkg.fields?.sprint ? `${esc(pkg.fields.sprint)} · ` : ''}On: ${esc(status)}${pkg.holder ? ` · ${esc(pkg.holder.name)}` : ''}</span>
      </span>
      <span class="a-progress">${progressBarHtml(pct, pkg.endedAt ? 'done' : '')}<span class="muted num">${done}/${total}</span></span>
    </button></li>`;
  }).join('');
  return `<div class="pkg-list">
    <header class="list-head"><h2>Packages</h2>
      <button type="button" data-act="deps">Dependencies</button>
      <button type="button" data-act="manage-templates">Manage templates</button>
      <button type="button" class="primary" data-act="new-package">+ New package</button>
    </header>
    ${rows ? `<ul class="all-group">${rows}</ul>`
      : `<div class="empty-state">${EMPTY_ICON}<p>No packages yet.</p><p class="muted">Start one from the Release Pipeline template.</p></div>`}
  </div>`;
}

function templatesListHtml() {
  const rows = templates.map(tpl => `<li><button class="all-row" data-act="edit-template" data-id="${esc(tpl.id)}">
    <span class="chip plan">Template</span>
    <span class="a-subject">${esc(tpl.name)}</span>
    <span class="a-meta">${tpl.nodes.length} nodes</span>
  </button></li>`).join('');
  return `<div class="pkg-list">
    <header class="list-head"><button type="button" class="ghost" data-act="back">← Packages</button><h2>Templates</h2></header>
    <ul class="all-group">${rows}</ul>
  </div>`;
}

function templateEditShellHtml(tpl) {
  return `<div class="pkg-detail">
    <header class="list-head">
      <button type="button" class="ghost" data-act="back-templates">← Templates</button>
      <h2>${esc(tpl.name)}</h2>
    </header>
    <div id="pkg-canvas-root"></div>
  </div>`;
}

/** A compact "which services changed, and are they merged/released" panel beside the flow. */
function depsSideHtml() {
  if (sideCollapsed) {
    return `<aside class="pkg-side collapsed">
      <button type="button" class="ghost icon-btn" data-act="deps-collapse" title="Show the Dependencies panel" aria-label="Show the Dependencies panel">‹</button>
    </aside>`;
  }
  const openBtn = '<button type="button" class="ghost" data-act="deps">Dependencies →</button>';
  const dot = (v, label) => v === true ? `<span class="dep-dot ok" title="${label}: yes">✓</span>`
    : v === false ? `<span class="dep-dot bad" title="${label}: no">✕</span>`
    : `<span class="dep-dot unk" title="${label}: no such column">–</span>`;
  const c = depsCheck();
  let body;
  if (depsSyncing && !deps) body = '<p class="muted">Syncing…</p>';
  else if (!deps) body = '<p class="muted">No dependency sheet loaded yet.</p>';
  else if (!c || c.unreadable) body = '<p class="muted">The loaded sheet\'s columns weren\'t recognised.</p>';
  else if (!c.services.length) body = '<p class="muted">No service is marked as changed.</p>';
  else {
    const allGood = (c.notMerged?.length ?? 0) === 0 && (c.notReleased?.length ?? 0) === 0 && c.wrongParity.length === 0;
    body = `<p class="${allGood ? 'gate ok' : 'gate warn'}">${allGood ? '✓ All clear' : `${c.notMerged?.length || c.notReleased?.length || c.wrongParity.length} item(s) need attention`}</p>
      <ul class="dep-rows">${c.services.map(s => `<li class="dep-row">
        <span class="dep-name">${esc(s.name)}</span>
        ${dot(s.merged, 'Merged to ch-app')}${dot(s.released, 'Released Postgres')}
      </li>`).join('')}</ul>
      <p class="muted dep-legend">✓/✕ merged · ✓/✕ released</p>`;
  }
  const reloadTitle = depsUrl ? 'Sync the dependency sheet now' : 'Open Dependencies and load a sheet first';
  return `<aside class="pkg-side">
    <div class="pkg-side-handle" data-act="side-resize" aria-hidden="true"></div>
    <div class="pkg-side-head">
      <h3>Dependencies <span class="muted">${deps ? `· ${esc(sheetLabel(deps.name))} · ${c?.changed?.length ?? 0} changed` : ''}</span></h3>
      <span class="spacer"></span>
      <button type="button" class="ghost icon-btn ${depsSyncing ? 'spinning' : ''}" data-act="deps-reload" title="${esc(reloadTitle)}" aria-label="${esc(reloadTitle)}" ${!depsUrl || depsSyncing ? 'disabled' : ''}>⟳</button>
      <button type="button" class="ghost icon-btn" data-act="deps-collapse" title="Collapse" aria-label="Collapse the Dependencies panel">›</button>
    </div>
    ${depsStatus ? `<p class="gate warn">${esc(depsStatus)}</p>` : ''}
    ${body}
    ${deps?.loadedAt ? `<p class="muted dep-legend">Synced ${new Date(deps.loadedAt).toLocaleTimeString()} · ${deps.rows?.length ?? 0} row(s), ${deps.checkboxes ?? 0} checkbox control(s) read</p>` : ''}
    ${openBtn}
  </aside>`;
}

function detailShellHtml(pkg) {
  const facts = FIELDS.filter(f => pkg.fields?.[f.key]).map(f => `${esc(f.label)} ${esc(pkg.fields[f.key])}`);
  const parity = versionParityWarning(pkg);
  const { done, total, pct } = packageProgress(pkg);
  return `<div class="pkg-detail">
    <header class="list-head">
      <button type="button" class="ghost" data-act="back">← Packages</button>
      <h2>${esc(pkg.name)}</h2>
      <button type="button" data-act="edit-package">Edit</button>
      <button type="button" class="ghost" data-act="delete-package">Delete</button>
    </header>
    <div class="pkg-progress-row">
      ${progressBarHtml(pct, pkg.endedAt ? 'done' : '')}
      <span class="muted num">${pkg.endedAt ? 'Delivered' : `Step ${done + 1} of ${total}`}</span>
    </div>
    <p class="pkg-facts muted">${facts.join(' · ') || 'No package details yet.'}${pkg.holder ? ` · started by ${esc(pkg.holder.name)}` : ''}${pkg.endedAt ? ' · delivered' : ''}</p>
    ${parity ? `<p class="gate warn">${esc(parity)}</p>` : ''}
    <div class="pkg-detail-body${sideCollapsed ? ' side-collapsed' : ''}" style="--pkg-side-w:${sideWidth}px">
      <div id="pkg-canvas-root"></div>
      ${depsSideHtml()}
    </div>
  </div>`;
}

function mountDetailCanvas(pkg) {
  const root = $('pkg-canvas-root');
  renderCanvas(root, {
    nodes: pkg.templateSnapshot.nodes,
    edges: pkg.templateSnapshot.edges,
    mode: 'run',
    nodeStatus: node => nodeState(pkg, node.id),
    onNodeClick: node => openStepDialog(pkg, node.id),
  });
}

function mountTemplateCanvas(tpl) {
  const root = $('pkg-canvas-root');
  renderCanvas(root, {
    nodes: tpl.nodes,
    edges: tpl.edges,
    mode: 'edit',
    onGraphChange: saveTemplates,
    onDone: () => { editingTemplateId = null; showTemplates = true; render(); },
  });
}

// ─── Dependency sheet ──────────────────────────────────────────────────────────
// Read-only view of the first sheet of the team's dependency workbook, fetched from
// SharePoint with the browser's own session (or read from a downloaded copy).

const DEPS_SHEET_KEY = '__blm_package_deps_sheet';

let showDeps = false;
let depsUrl = '';
let deps = null;              // { name, rows, sheets, loadedAt } once a sheet is loaded
let depsOnlyChanged = true;
let depsStatus = '';
let depsSyncing = false;
let autoSyncedPkgId = null;   // which package's detail view already triggered its once-per-open auto-sync

// A workbook like this is usually several same-shaped tabs — last sprint's, this
// sprint's, a patch build's — and only one is actually in use; it isn't always
// the first, so the chosen tab's name is remembered, and the bytes last read are
// kept here so switching tabs re-reads them without another fetch.
let depsSheetName = null;
let depsLastBuf = null;

// The side panel beside the flow: collapsed/expanded and its width, same "set
// before next render, persist after" pattern as everything else on this page.
const SIDE_KEY = '__blm_package_side';
let sideCollapsed = false;
let sideWidth = 260;
const saveSidePrefs = () => chrome.storage.local.set({ [SIDE_KEY]: { collapsed: sideCollapsed, width: sideWidth } });

/**
 * Fetches a SharePoint "open in browser" link's own bytes, with the browser's
 * session cookie.
 * shortcut: a two-step REST lookup (resolve the id to its path, then read that
 * path) was tried here instead of `download.aspx`, to sidestep a rendition that
 * can lag the document library — dropped again after it 404'd on this tenant's
 * own path layout (one path-encoding bug fixed, then a second, unexplained
 * "file does not exist" from SharePoint itself). `download.aspx` is simpler and
 * is what every passing test here used; upgrade this only against a real tenant,
 * with someone able to check each step by hand.
 */
async function fetchSharePointBytes(link) {
  const u = new URL(link);
  if (u.protocol !== 'https:') throw new Error('The link must start with https://');
  const id = u.searchParams.get('sourcedoc')?.replace(/[{}]/g, '');
  let url = u;
  if (id) {
    const site = u.pathname.match(/\/(?:sites|teams)\/[^/]+/)?.[0] ?? '';
    url = new URL(`${u.origin}${site}/_layouts/15/download.aspx?UniqueId=${encodeURIComponent(id)}`);
  }
  // Every sync must see the sheet as it is right now: same URL every time (SharePoint
  // doesn't version it), so without this a "the file changed" sync can still come
  // back from the browser's own HTTP cache looking exactly like the last one.
  url.searchParams.set('_', Date.now());
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  return res.arrayBuffer();
}

const headLabel = v => String(v).replace(/\s+/g, ' ').trim();

/** Where the columns the package process cares about sit in this sheet. */
const DEPS_COLS = {
  name: /^services?$/i,
  change: /has change/i,
  merged: /merged to ch-app/i,
  releasedPg: /released postgres/i,
  releasedOra: /released oracle/i,
  pgVersion: /^postgres(ql)?$/i,
  oraVersion: /^oracle$/i,
};

function depsColumns(head) {
  const out = {};
  for (const [key, re] of Object.entries(DEPS_COLS)) {
    const i = head.findIndex(h => re.test(headLabel(h)));
    if (i >= 0) out[key] = i;
  }
  return out;
}

const depsBody = () => deps.rows.slice(1).filter(r => r.some(v => v !== ''));

/**
 * What the dependency sheet says about the services going into the package:
 * null before a sheet is loaded, `{ unreadable: true }` when its columns were
 * renamed beyond recognition.
 */
function depsCheck() {
  if (!deps) return null;
  const col = depsColumns(deps.rows[0] ?? []);
  if (col.name == null || col.change == null) return { unreadable: true };
  const rows = depsBody().filter(r => r[col.change] === true);
  const name = r => String(r[col.name] ?? '').trim();
  const unticked = key => col[key] == null ? null : rows.filter(r => r[col[key]] !== true).map(name);
  // The process wants odd versions for Postgres and even ones for Oracle.
  const wrongParity = rows.flatMap(r => [['pgVersion', 1, 'Postgres'], ['oraVersion', 0, 'Oracle']]
    .filter(([key, want]) => col[key] != null && versionTail(r[col[key]]) !== null && versionTail(r[col[key]]) % 2 !== want)
    .map(([key, , kind]) => `${name(r)} — ${kind} ${String(r[col[key]]).trim()}`));
  // One row per changed service, for the summary beside the pipeline.
  const services = rows.map(r => ({
    name: name(r),
    merged: col.merged == null ? null : r[col.merged] === true,
    released: col.releasedPg == null ? null : r[col.releasedPg] === true,
  }));
  return { loadedAt: deps.loadedAt, changed: rows.map(name), services, notMerged: unticked('merged'), notReleased: unticked('releasedPg'), wrongParity };
}

function depsTableHtml() {
  const syncing = depsSyncing ? '<p class="muted" role="status">⏳ Syncing…</p>' : '';
  if (!deps) return syncing || (depsStatus ? `<p class="muted" role="status">${esc(depsStatus)}</p>` : '');
  const errNote = !depsSyncing && depsStatus ? `<p class="gate warn">${esc(depsStatus)}</p>` : '';
  const [head = []] = deps.rows;
  const cols = head.map((h, i) => i).filter(i => headLabel(head[i]));
  const changeCol = cols.find(i => DEPS_COLS.change.test(headLabel(head[i]))) ?? -1;
  const rows = depsBody();
  const changed = changeCol < 0 ? rows : rows.filter(r => r[changeCol] === true);
  const shown = depsOnlyChanged && changeCol >= 0 ? changed : rows;
  const cell = v => v === true ? '✓' : v === false ? '' : esc(v);
  const summary = changeCol < 0
    ? `${rows.length} rows · no "Has change" column found, showing everything`
    : `${changed.length} of ${rows.length} services have changes`;
  const cbNote = deps.checkboxes ? ` · ${deps.checkboxes} checkbox control(s) read` : '';
  return `${syncing}${errNote}<div class="deps-sum">
      <span><b>${esc(deps.name)}</b> · ${esc(summary)}${cbNote}${deps.loadedAt ? ` · read ${new Date(deps.loadedAt).toLocaleString()}` : ''}</span>
      ${changeCol >= 0 ? `<label class="inline-chk"><input type="checkbox" id="deps-only" ${depsOnlyChanged ? 'checked' : ''} /> Only services with changes</label>` : ''}
    </div>
    ${shown.length ? `<div class="deps-wrap"><table class="deps-table">
      <thead><tr>${cols.map(i => `<th scope="col">${esc(headLabel(head[i]))}</th>`).join('')}</tr></thead>
      <tbody>${shown.map(r => `<tr>${cols.map(i => `<td>${cell(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">No service is marked as changed.</p>'}`;
}

/** Collapses doubled-up whitespace for display only — tab names here run "ch-app ", "ch-app  2.48". */
const sheetLabel = s => s.replace(/\s+/g, ' ').trim() || '(unnamed)';

function depsHtml() {
  // A workbook like this is usually several same-shaped tabs (last sprint's, this
  // sprint's, a patch build's); shown whenever there's more than one, since the
  // one actually in use often isn't the first — that's the bug this picker fixes.
  const sheetPicker = deps?.sheets?.length > 1 ? `
    <label class="dlg-fld deps-sheet-fld"><span>Sheet</span>
      <select class="ctrl" id="deps-sheet">
        ${deps.sheets.map(s => `<option value="${esc(s)}" ${s === deps.name ? 'selected' : ''}>${esc(sheetLabel(s))}</option>`).join('')}
      </select>
    </label>` : '';
  return `<div class="pkg-list">
    <header class="list-head"><button type="button" class="ghost" data-act="back-deps">← Back</button><h2>Dependencies</h2></header>
    <div class="deps-bar">
      <input class="ctrl" id="deps-url" type="url" value="${esc(depsUrl)}" placeholder="SharePoint link to the dependency workbook" aria-label="SharePoint link to the dependency workbook" />
      <button type="button" class="primary" data-act="deps-load">Load</button>
      <label class="inline-chk">or a downloaded copy <input type="file" id="deps-file" accept=".xlsx" /></label>
      ${sheetPicker}
    </div>
    <div id="deps-out">${depsTableHtml()}</div>
  </div>`;
}

/**
 * Reads a workbook and replaces the loaded sheet. Keeps whatever was loaded
 * before on screen while it runs (and on failure) instead of blanking it —
 * a sync is a refresh, not a reset.
 */
async function loadDeps(readBuffer) {
  if (depsSyncing) return;
  depsSyncing = true;
  depsStatus = '';
  render();
  try {
    const buf = await readBuffer();
    deps = { ...await readFirstSheet(buf, depsSheetName), loadedAt: nowIso() };
    depsSheetName = deps.name; // locks in whichever tab was actually read (first run's default included)
    depsLastBuf = buf;
    chrome.storage.local.set({ [DEPS_KEY]: deps, [DEPS_SHEET_KEY]: depsSheetName });
  } catch (err) {
    depsStatus = `Couldn't read the workbook: ${err.message}. Open SharePoint in this browser and sign in, or choose a downloaded copy.`;
  }
  depsSyncing = false;
  render();
}

/** Re-reads a different tab of the same workbook without fetching it again. */
async function switchDepsSheet(name) {
  if (!depsLastBuf || depsSyncing || name === deps?.name) return;
  depsSyncing = true;
  depsStatus = '';
  render();
  try {
    deps = { ...await readFirstSheet(depsLastBuf, name), loadedAt: nowIso() };
    depsSheetName = deps.name;
    chrome.storage.local.set({ [DEPS_KEY]: deps, [DEPS_SHEET_KEY]: depsSheetName });
  } catch (err) {
    depsStatus = `Couldn't read that sheet: ${err.message}`;
  }
  depsSyncing = false;
  render();
}

/** Fetches the sheet at `link` with the browser's own SharePoint session. */
function syncDepsFromUrl(link) {
  let origin;
  try { origin = new URL(link).origin; } catch { depsStatus = 'That is not a link.'; return render(); }
  // Asked first, before anything is awaited: Chrome only shows the prompt inside the click;
  // once granted it resolves instantly and silently on every later call, so this is also
  // what a background auto-sync and the sidebar's reload button call directly.
  const granted = chrome.permissions.request({ origins: [`${origin}/*`] });
  loadDeps(async () => {
    if (!await granted) throw new Error(`access to ${new URL(link).host} was not allowed`);
    return fetchSharePointBytes(link);
  });
}

function loadDepsFromLink() {
  const link = $('deps-url').value.trim();
  depsUrl = link;
  chrome.storage.local.set({ [DEPS_URL_KEY]: link });
  syncDepsFromUrl(link);
}

function render() {
  if (showDeps) { $('view').innerHTML = depsHtml(); return; }
  if (editingTemplateId) {
    const tpl = templateById(editingTemplateId);
    if (!tpl) { editingTemplateId = null; return render(); }
    $('view').innerHTML = templateEditShellHtml(tpl);
    mountTemplateCanvas(tpl);
    return;
  }
  if (showTemplates) { $('view').innerHTML = templatesListHtml(); return; }
  const pkg = openId ? packageById(openId) : null;
  if (pkg) {
    $('view').innerHTML = detailShellHtml(pkg);
    mountDetailCanvas(pkg);
    wireSideResize();
    // Once per visit to this package, pick up anything changed on the sheet since.
    if (depsUrl && autoSyncedPkgId !== pkg.id && !depsSyncing) {
      autoSyncedPkgId = pkg.id;
      syncDepsFromUrl(depsUrl);
    }
    return;
  }
  $('view').innerHTML = listHtml();
}

// ─── New-package dialog ────────────────────────────────────────────────────────

function fieldsHtml(pkg) {
  const today = new Date().toISOString().slice(0, 10);
  const sprints = sprintCalendar(today, { past: 3, future: 1 });
  const selected = pkg?.fields?.sprint ?? sprintCalendar(today, { past: 0, future: 0 })[0]?.name;
  return FIELDS.map(f => f.key === 'sprint'
    ? `<label class="dlg-fld"><span>${esc(f.label)}</span><select class="ctrl" name="sprint">
        ${sprints.map(s => `<option${s.name === selected ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select></label>`
    : `<label class="dlg-fld"><span>${esc(f.label)}${f.hint ? ` <span class="muted">(${esc(f.hint)})</span>` : ''}</span>
        <input class="ctrl" name="${esc(f.key)}" value="${esc(pkg?.fields?.[f.key] ?? '')}" placeholder="${esc(f.placeholder ?? '')}" /></label>`).join('');
}

/** One dialog for both "+ New package" and the detail view's Edit. */
function openPackageDialog(pkg = null) {
  const dlg = document.createElement('dialog');
  dlg.className = 'step-dlg';
  dlg.innerHTML = `<form class="step-form" method="dialog">
    <header class="cl-head"><span class="muted">${pkg ? 'Package details' : 'New package'}</span><button type="button" class="ghost" data-act="close" aria-label="Close">✕</button></header>
    <div class="step-body">
      <label class="dlg-fld"><span>Name</span><input class="ctrl" name="name" required placeholder="e.g. ch-app 2.48.5" value="${esc(pkg?.name ?? '')}" /></label>
      ${pkg ? '' : `<label class="dlg-fld"><span>Template</span>
        <select class="ctrl" name="templateId">${templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>
      </label>`}
      ${fieldsHtml(pkg)}
    </div>
    <footer class="cl-foot"><span class="spacer"></span><button type="button" class="ghost" data-act="close">Cancel</button><button type="submit" class="primary">${pkg ? 'Save' : 'Create'}</button></footer>
  </form>`;
  document.body.append(dlg);
  dlg.addEventListener('cancel', e => { e.preventDefault(); dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', e => { if (e.target.closest('[data-act="close"]') || e.target === dlg) dlg.close(); });
  dlg.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get('name') ?? '').trim();
    if (!name) return;
    const fields = Object.fromEntries(FIELDS.map(fd => [fd.key, String(f.get(fd.key) ?? '').trim()]));
    if (pkg) {
      Object.assign(pkg, { name, fields });
    } else {
      const fresh = freshPackage(templateById(f.get('templateId')), name, fields);
      store.items.push(fresh);
      openId = fresh.id;
    }
    save();
    render();
    dlg.close();
  });
  dlg.showModal();
  dlg.querySelector('[name="name"]').focus();
}

// ─── Step dialog ────────────────────────────────────────────────────────────────

function openStepDialog(pkg, id) {
  const dlg = document.createElement('dialog');
  dlg.className = 'step-dlg';
  const paint = () => { dlg.innerHTML = stepDialogHtml(pkg, id); };
  paint();
  document.body.append(dlg);
  dlg.addEventListener('cancel', e => { e.preventDefault(); dlg.close(); });
  dlg.addEventListener('close', () => { dlg.remove(); render(); });
  dlg.addEventListener('click', e => {
    if (e.target.closest('[data-act="close"]') || e.target === dlg) return dlg.close();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'goto-deps') { showDeps = true; return dlg.close(); }
    const st = pkg.steps[id];
    const def = nodeDef(pkg.templateSnapshot, id);
    if (act === 'start') { st.status = 'in_progress'; st.startedAt ??= nowIso(); }
    else if (act === 'reopen') reopenStep(pkg, id);
    else if (act === 'mark-done') {
      const left = checklistState(def, st, pkg).filter(v => !v).length;
      if (left && !confirm(`${left} of ${def.todo.length} checklist items are still open. Mark this step done anyway?`)) return;
      if (!completeStep(pkg, id)) return alert('This step has no outgoing connection to follow. Add one under Manage templates.');
    } else if (act === 'decide') {
      const answer = e.target.closest('[data-act]').dataset.answer;
      if (!completeStep(pkg, id, answer)) return alert(`Nothing is connected to the "${answer}" branch of this decision. Connect it under Manage templates.`);
    } else if (act === 'add-task') {
      const title = dlg.querySelector('[data-role="task-title"]').value.trim();
      if (!title) return;
      const useMe = dlg.querySelector('[data-role="task-me"]').checked && me;
      const typed = dlg.querySelector('[data-role="task-assignee"]').value.trim();
      const assignee = useMe ? { id: me.id, name: me.name } : typed ? { id: typed.toLowerCase(), name: typed } : null;
      pkg.steps[id].tasks.push({ id: uid(), title, assignee, status: 'TODO' });
    } else return;
    save();
    paint();
  });
  dlg.addEventListener('change', e => {
    const todo = e.target.dataset.todo;
    if (todo !== undefined) {
      const st = pkg.steps[id];
      st.checked ??= [];
      st.checked[Number(todo)] = e.target.checked;
      save();
      return paint();
    }
    const taskId = e.target.closest('[data-task]')?.dataset.task;
    if (!taskId) return;
    const task = pkg.steps[id].tasks.find(t => t.id === taskId);
    if (task) { task.status = e.target.value; save(); }
  });
  dlg.showModal();
}

// ─── Events ──────────────────────────────────────────────────────────────────

$('view').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'new-package') return openPackageDialog();
  if (act === 'edit-package') return openPackageDialog(packageById(openId));
  if (act === 'delete-package') {
    const pkg = packageById(openId);
    if (!pkg || !confirm(`Delete "${pkg.name}"? Its progress is only stored in this browser and can't be recovered.`)) return;
    store.items = store.items.filter(p => p.id !== pkg.id);
    openId = null;
    save();
    return render();
  }
  if (act === 'manage-templates') { showTemplates = true; return render(); }
  if (act === 'back-templates') { editingTemplateId = null; showTemplates = true; return render(); }
  if (act === 'edit-template') { editingTemplateId = e.target.closest('[data-id]').dataset.id; showTemplates = false; return render(); }
  if (act === 'back') { openId = null; showTemplates = false; showDeps = false; autoSyncedPkgId = null; return render(); }
  if (act === 'open-package') { openId = e.target.closest('[data-id]').dataset.id; return render(); }
  if (act === 'deps') { showDeps = true; return render(); }
  if (act === 'back-deps') { showDeps = false; return render(); }
  if (act === 'deps-load') return loadDepsFromLink();
  if (act === 'deps-reload') return depsUrl && syncDepsFromUrl(depsUrl);
  if (act === 'deps-collapse') { sideCollapsed = !sideCollapsed; saveSidePrefs(); return render(); }
});

$('view').addEventListener('change', e => {
  if (e.target.id === 'deps-only') { depsOnlyChanged = e.target.checked; render(); }
  else if (e.target.id === 'deps-file' && e.target.files[0]) { const file = e.target.files[0]; loadDeps(() => file.arrayBuffer()); }
  else if (e.target.id === 'deps-sheet') switchDepsSheet(e.target.value);
});

/**
 * A package is only as good as its own templateSnapshot/steps — every read in this
 * file assumes both are complete, so a package saved by an older or interrupted
 * run (a dropped field, a stale module caught mid-edit) must be made whole again
 * here, once, rather than guarded at every call site.
 */
function repairPackage(pkg) {
  const hasGraph = Array.isArray(pkg?.templateSnapshot?.nodes) && pkg.templateSnapshot.nodes.length;
  if (!hasGraph) {
    const tpl = templateById(pkg?.templateId) ?? templates[0];
    pkg.templateSnapshot = structuredClone({ nodes: tpl.nodes, edges: tpl.edges });
  }
  pkg.steps ??= {};
  for (const n of pkg.templateSnapshot.nodes) {
    pkg.steps[n.id] ??= { status: 'todo', startedAt: null, endedAt: null, decision: null, tasks: [], checked: [] };
  }
  if (pkg.currentNodeId && !nodeDef(pkg.templateSnapshot, pkg.currentNodeId)) pkg.currentNodeId = null;
  if (!pkg.currentNodeId && !pkg.endedAt) pkg.currentNodeId = startNodeId(pkg.templateSnapshot);
  return pkg;
}

/** Drag-resize of the Dependencies side panel, from its left-edge handle. */
function wireSideResize() {
  const handle = $('view').querySelector('[data-act="side-resize"]');
  if (!handle) return;
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    const aside = handle.closest('.pkg-side');
    const startX = e.clientX, startW = sideWidth;
    const onMove = ev => {
      sideWidth = Math.min(420, Math.max(200, startW - (ev.clientX - startX)));
      aside.closest('.pkg-detail-body').style.setProperty('--pkg-side-w', `${sideWidth}px`);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      saveSidePrefs();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, { once: true });
  });
}

async function init() {
  const stored = await chrome.storage.local.get([PACKAGES_KEY, TEMPLATES_KEY, DEPS_URL_KEY, DEPS_KEY, DEPS_SHEET_KEY, SIDE_KEY]);
  store = freshStore(stored[PACKAGES_KEY]);
  depsUrl = stored[DEPS_URL_KEY] ?? '';
  deps = Array.isArray(stored[DEPS_KEY]?.rows) ? stored[DEPS_KEY] : null;
  depsSheetName = stored[DEPS_SHEET_KEY] ?? deps?.name ?? null;
  sideCollapsed = stored[SIDE_KEY]?.collapsed === true;
  sideWidth = Math.min(420, Math.max(200, Number(stored[SIDE_KEY]?.width) || 260));
  const tplStore = stored[TEMPLATES_KEY];
  const seeded = Array.isArray(tplStore?.items) && tplStore.items.length && tplStore.seed === SEED;
  templates = seeded ? tplStore.items : structuredClone(PACKAGE_TEMPLATES);
  if (!seeded) saveTemplates();
  const before = JSON.stringify(store.items);
  store.items = store.items.map(repairPackage);
  if (JSON.stringify(store.items) !== before) save();
  me = await cachedMe();
  render();
}

init();
