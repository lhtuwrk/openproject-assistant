// planning.js — "Planning Quest": the sprint planning session as a game, run by
// one facilitator on a shared screen. The open stories of the sprint being
// planned are dealt level by level in the team's priority order (label goal →
// pilot/chiron/VAB → Immediate → High → the rest), each story against its own
// clock. The story on the table shows everything needed to plan it — description,
// subtasks, relations, attachments — and its status, assignee and subtasks can be
// changed right there; those edits are written to OpenProject at once. Marking a
// story planned or deferred is the game's own bookkeeping and writes nothing.

import {
  fetchActiveProjects, fetchOpenVersions, fetchProjectWorkPackages, fetchWorkPackage,
  fetchAvailableAssignees, patchWorkPackage, createWorkPackage, fetchAllowedStatuses,
  fetchChildWorkPackages, fetchRelations, fetchAttachments, fetchProjectTypes,
  fetchBacklogBlob, sprintCalendar,
} from '../shared/api.js';
import { cachedMe, refreshMe, initials, avatarHue, todayStr } from '../shared/me.js';

const SESSION_KEY = '__blm_planning_session';
const LABEL_FIELD = 'customField6';   // the backlog's "Label" list custom field
import { requireHost } from '../shared/config.js';
const BACKLOG_URL = await requireHost();
const START_AT    = '14:30';
const END_AT      = '18:00';
const LOOT_MIN    = 15;

// Minutes a story gets by its priority; a level's timebox is the sum over its
// stories, scaled down together when the whole sprint doesn't fit the session.
const BUCKETS = [
  { key: 'immediate', label: 'Immediate', min: 6 },
  { key: 'high',      label: 'High',      min: 5 },
  { key: 'normal',    label: 'Normal',    min: 3 },
  { key: 'low',       label: 'Low',       min: 2 },
];

const ICON = {
  goal:  '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  big3:  '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2"/><path d="M9 15l-3-3c1-4 4-8 12-9-1 8-5 11-9 12z"/><circle cx="14.5" cy="9.5" r="1.5"/>',
  break: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3v3M12 3v3"/>',
  fire:  '<path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .3 2 1.3 3 2.5 3 0-3-1-5 0-8z"/>',
  high:  '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  rest:  '<path d="M4 6h16M4 12h16M4 18h10"/>',
  grip:  '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  lock:  '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  loot:  '<path d="M3 10h18v10H3z"/><path d="M3 10l2-5h14l2 5"/><path d="M10 14h4"/>',
  file:  '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
};

const hasLabel = (card, re) => card.labels.some(l => re.test(l));
const isImmediate = card => /immediate/i.test(card.priority);

// The team's priority rules, in precedence order: a card belongs to the first
// level it matches, whatever order the levels are played in.
const LEVEL_DEFS = [
  { key: 'goal',  name: 'Boss: the sprint goal', short: 'Goal',         sub: 'Label goal',
    min: 55, match: c => hasLabel(c, /\bgoal\b/i) },
  { key: 'big3',  name: 'The big three',         short: 'Big three',    sub: 'Pilot · Chiron · VAB',
    min: 45, match: c => hasLabel(c, /\b(pilot|chiron|vab)\b/i) },
  { key: 'break', name: 'Coffee respawn',        short: 'Coffee',       sub: 'Ten minutes, no tickets',
    min: 10, isBreak: true },
  { key: 'fire',  name: 'Fire drill',            short: 'Fire drill',   sub: 'Immediate priority',
    min: 40, match: isImmediate },
  { key: 'high',  name: 'High voltage',          short: 'High voltage', sub: 'High priority',
    min: 30, match: c => /\bhigh\b/i.test(c.priority) && !isImmediate(c) },
  { key: 'rest',  name: 'Side quests',           short: 'Side quests',  sub: 'Every other story, by priority',
    min: 15, match: () => true },
];
const DEFAULT_ORDER = LEVEL_DEFS.map(l => l.key);
const DEF = Object.fromEntries(LEVEL_DEFS.map(l => [l.key, l]));

/** Known keys in the saved order, then any level the saved order doesn't know yet. */
function normalizeOrder(order) {
  const known = (Array.isArray(order) ? order : []).filter((k, i, a) => DEF[k] && a.indexOf(k) === i);
  return [...known, ...DEFAULT_ORDER.filter(k => !known.includes(k))];
}

// The play order, set from the session by applyOrder().
let LEVELS = LEVEL_DEFS;
let PLAY_LEVELS = LEVELS.filter(l => !l.isBreak);
function applyOrder() {
  s.levelOrder = normalizeOrder(s.levelOrder);
  LEVELS = s.levelOrder.map(k => DEF[k]);
  PLAY_LEVELS = LEVELS.filter(l => !l.isBreak);
}

// Relation types as OpenProject names them, read from the story's side.
const RELATION_LABEL = {
  relates: 'Relates to', duplicates: 'Duplicates', duplicated: 'Duplicated by',
  blocks: 'Blocks', blocked: 'Blocked by', precedes: 'Precedes', follows: 'Follows',
  includes: 'Includes', partof: 'Part of', requires: 'Requires', required: 'Required by',
};

// ─── Utils ────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
const pts = n => (Math.round(n * 10) / 10).toString();
const idOf = href => /\/(\d+)$/.exec(href ?? '')?.[1] ?? null;

function clock(ms) {
  const s = Math.floor(Math.abs(ms) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
const signedClock = ms => `${ms < 0 ? '−' : '+'}${clock(ms)}`;

function addMinutes(hhmm, min) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + min;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function avatar(id, name) {
  if (!name) return '<span class="avatar none" aria-hidden="true">–</span>';
  return `<span class="avatar" style="--hue:${avatarHue(id ?? name)}" aria-hidden="true">${esc(initials(name))}</span>`;
}

function fileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const shortDate = iso => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

/** Labels from the Label custom field, whether it's a list (links) or text. */
function wpLabels(wp) {
  const out = [];
  const link = wp._links?.[LABEL_FIELD];
  if (Array.isArray(link)) out.push(...link.map(l => l?.title ?? ''));
  else if (link?.title) out.push(link.title);
  const val = wp[LABEL_FIELD];
  if (typeof val === 'string') out.push(...val.split(/[,;\n]/));
  else if (Array.isArray(val)) out.push(...val.map(String));
  else if (val?.raw) out.push(...val.raw.split(/[,;\n]/));
  return out.map(s => s.trim()).filter(Boolean);
}

function toCard(wp) {
  return {
    id:           String(wp.id),
    subject:      wp.subject ?? '',
    type:         wp._links?.type?.title ?? '',
    points:       typeof wp.storyPoints === 'number' ? wp.storyPoints : null,
    priority:     wp._links?.priority?.title ?? '',
    labels:       wpLabels(wp),
    status:       wp._links?.status?.title ?? '',
    statusHref:   wp._links?.status?.href ?? null,
    assigneeHref: wp._links?.assignee?.href ?? null,
    assigneeName: wp._links?.assignee?.title ?? '',
  };
}

const levelOf = card => LEVEL_DEFS.find(l => l.match?.(card))?.key ?? null;
const PRIORITY_RANK = p => isImmediate({ priority: p }) ? 0 : /\bhigh\b/i.test(p) ? 1 : /normal|medium/i.test(p) ? 2 : 3;

/**
 * OpenProject's rendered description, made safe for an extension page: no
 * scripts, frames or handlers, links open in a new tab on the backlog, and
 * images wait for a cookie-carrying fetch (hydrateImages) instead of hot-linking.
 */
/** A link resolved against the backlog, kept only for web and mail schemes. */
function safeUrl(href) {
  if (!href) return null;
  try {
    const u = new URL(href, `${BACKLOG_URL}/`);
    return ['https:', 'http:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

function safeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html ?? ''}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  root.querySelectorAll('script, style, iframe, frame, frameset, object, embed, form, input, button, select, textarea, link, meta, base, svg, math, noscript, noembed, noframes, template, title, xmp, plaintext')
    .forEach(n => n.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'srcset' || n === 'style' || n === 'id' || n === 'name') el.removeAttribute(a.name);
    }
    if (el.tagName === 'A' || el.tagName === 'AREA') {
      const url = safeUrl(el.getAttribute('href'));
      if (url) el.setAttribute('href', url); else el.removeAttribute('href');
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      el.removeAttribute('src');
      if (src.startsWith('/') || src.startsWith(`${BACKLOG_URL}/`)) el.dataset.blob = src;
      el.setAttribute('alt', el.getAttribute('alt') ?? '');
    }
  }
  return root.innerHTML;
}

// ─── State ────────────────────────────────────────────────────────────────────

function freshSession(prev) {
  return {
    v: 1,
    phase: 'lobby',            // lobby · play · loot
    projectId:   prev?.projectId ?? null,
    projectName: prev?.projectName ?? '',
    versionId:   prev?.versionId ?? null,
    versionName: prev?.versionName ?? '',
    versionHref: prev?.versionHref ?? null,
    budgets:     { ...Object.fromEntries(LEVEL_DEFS.map(l => [l.key, l.min])), ...prev?.budgets },   // minutes; play levels are set at Start
    perStory:    { ...Object.fromEntries(BUCKETS.map(b => [b.key, b.min])), ...prev?.perStory },
    scale: 1,                  // per-story minutes × scale = what each story got, fixed at Start
    cardSpent: {},             // wpId -> ms discussed
    levelOrder:  normalizeOrder(prev?.levelOrder),
    level: 0,
    intro: true,               // the level's title card shows until the facilitator starts it
    elapsed: {},               // levelKey -> ms played
    runningSince: null,
    overtimeOk: {},            // levelKey -> true once "Keep playing" was chosen
    order: {},                 // levelKey -> [wpId] in play order
    decisions: {},             // wpId -> { d: 'plan' | 'defer', level, at, card, reason }
    cursor: {},                // levelKey -> wpId on the table (Next / Previous move it)
    history: [],               // wpIds, newest last, for Undo
  };
}

let s = freshSession();
const rt = {
  projects: [], versions: [],
  cards: new Map(),            // wpId -> card: the sprint's open stories (subtasks of those excluded)
  people: null, me: null, types: null,
  loading: false, error: null,
  ui: { mode: null },          // mode: 'defer' while the reason field is open
  timeUp: false,
  view: null,                  // 'all' while the story overview is open
  allFilter: 'all',            // all · open · done
  selected: null,              // wpId shown in the overview's detail
  tab: 'desc',                 // desc · sub · rel · files
  saving: new Set(),           // `${wpId}:${field}` writes in flight
  writeErr: new Map(),         // `${wpId}:${field}` -> message
  sub: { draft: '', typeHref: null, assigneeHref: undefined, busy: false, err: '' },
};
const details = new Map();     // wpId -> { wp, statuses, kids, kidStatuses, relations, files, err, loading }
const blobs = new Map();       // backlog path -> object URL | 'loading' | 'failed'

const save = () => chrome.storage.local.set({ [SESSION_KEY]: s });
const curLevel = () => LEVELS[s.level];
const budgetMs = key => (Number(s.budgets[key]) || 0) * 60000;
const mins = key => Math.round(Number(s.budgets[key]) || 0);

function bucketOf(priority) {
  if (isImmediate({ priority })) return 'immediate';
  if (/\bhigh\b/i.test(priority)) return 'high';
  if (/low|minor|trivial/i.test(priority)) return 'low';
  return 'normal';
}
const storyMin = card => Number(s.perStory[bucketOf(card.priority)]) || 0;
const cardBudgetMs = card => storyMin(card) * s.scale * 60000;

const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Each play level's minutes from its stories, scaled to fit the session if needed. */
function timePlan() {
  const raw = Object.fromEntries(PLAY_LEVELS.map(l => [l.key,
    levelIds(l.key).filter(id => rt.cards.has(id)).reduce((t, id) => t + storyMin(rt.cards.get(id)), 0)]));
  const sum = Object.values(raw).reduce((t, m) => t + m, 0);
  const avail = Math.max(0, toMin(END_AT) - toMin(START_AT) - LOOT_MIN - (Number(s.budgets.break) || 0));
  const scale = sum > avail && sum > 0 ? avail / sum : 1;
  return { raw, sum, avail, scale, minutes: key => raw[key] * scale };
}

function elapsedMs(key) {
  const base = s.elapsed[key] ?? 0;
  return s.runningSince && curLevel()?.key === key ? base + Date.now() - s.runningSince : base;
}
const remainingMs = key => budgetMs(key) - elapsedMs(key);

/** Time saved (or overspent) on the levels already behind you; an empty level you skip banks its whole budget. */
function bankMs() {
  const done = s.phase === 'loot' ? s.level + 1 : s.level;
  return LEVELS.slice(0, done).reduce((t, l) => t + remainingMs(l.key), 0);
}

function pause() {
  if (!s.runningSince) return;
  const k = curLevel().key;
  s.elapsed[k] = elapsedMs(k);
  s.runningSince = null;
}
function resume() { if (!s.runningSince) s.runningSince = Date.now(); }

/** The live card, or a decided card's snapshot. */
const cardById = id => rt.cards.get(id) ?? s.decisions[id]?.card ?? null;

/** Keeps a level's play order: known cards keep their place, new ones join at the end. */
function syncOrder(key) {
  const fresh = [...rt.cards.values()]
    .filter(c => levelOf(c) === key)
    .sort((a, b) => PRIORITY_RANK(a.priority) - PRIORITY_RANK(b.priority) || Number(a.id) - Number(b.id))
    .map(c => c.id);
  const kept = (s.order[key] ?? []).filter(id => rt.cards.has(id) || s.decisions[id]);
  s.order[key] = [...kept, ...fresh.filter(id => !kept.includes(id))];
}

const levelIds = key => s.order[key] ?? [];
const undecided = key => levelIds(key).filter(id => !s.decisions[id] && cardById(id));
/** The story on the table: where Next / Previous left the cursor, else the level's first unplanned one. */
function currentId() {
  const lv = curLevel();
  if (s.phase !== 'play' || !lv || lv.isBreak) return null;
  const at = s.cursor?.[lv.key];
  if (at && levelIds(lv.key).includes(at) && cardById(at)) return at;
  return undecided(lv.key)[0] ?? null;
}
const currentCard = () => { const id = currentId(); return id ? cardById(id) : null; };

/** The first unplanned story after `id` in the level, wrapping round; null when none is left. */
function nextUndecidedAfter(key, id) {
  const ids = levelIds(key).filter(x => cardById(x));
  const i = ids.indexOf(id);
  const rotated = [...ids.slice(i + 1), ...ids.slice(0, Math.max(0, i))];
  return rotated.find(x => !s.decisions[x]) ?? null;
}
const levelKeyOf = id => PLAY_LEVELS.find(l => levelIds(l.key).includes(id))?.key ?? null;

// ─── Data ─────────────────────────────────────────────────────────────────────

async function loadProjects() {
  rt.projects = (await fetchActiveProjects()).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadVersions() {
  rt.versions = s.projectId ? (await fetchOpenVersions(s.projectId)).sort((a, b) => a.name.localeCompare(b.name)) : [];
}

/** The sprint being planned: the one starting today if planning is on its first day, else the next one. */
function plannedSprintName() {
  const today = todayStr();
  const [next, current] = sprintCalendar(today, { past: 0, future: 1 });
  return current.startDate === today ? current.name : next.name;
}

function guessVersion() {
  if (rt.versions.some(v => String(v.id) === String(s.versionId))) return;
  const name = plannedSprintName();
  const v = rt.versions.find(x => x.name.includes(name)) ?? null;
  setVersion(v);
}

function setVersion(v) {
  s.versionId   = v ? String(v.id) : null;
  s.versionName = v?.name ?? '';
  s.versionHref = v?._links?.self?.href ?? (v ? `/api/v3/versions/${v.id}` : null);
}

async function loadCards() {
  rt.cards = new Map();
  if (!s.projectId || !s.versionId) return;
  const wps = await fetchProjectWorkPackages(s.projectId, [
    { status:     { operator: 'o', values: [] } },
    { version_id: { operator: '=', values: [s.versionId] } },
  ]);
  // A subtask of a story in the same sprint is planned with its story, not dealt on its own.
  const ids = new Set(wps.map(wp => String(wp.id)));
  const stories = wps.filter(wp => !ids.has(idOf(wp._links?.parent?.href)));
  rt.cards = new Map(stories.map(toCard).map(c => [c.id, c]));
  for (const l of PLAY_LEVELS) syncOrder(l.key);
}

async function loadPeople() {
  if (rt.people) return;
  const [people, me] = await Promise.all([fetchAvailableAssignees(s.projectId), cachedMe()]);
  rt.people = people;
  rt.me = me ? people.find(p => p.id === String(me.id)) ?? null : null;
}

// Several detail requests finish within moments of each other; they share one
// repaint instead of rebuilding the page once each.
let renderFrame = 0;
function requestRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = 0; render(); });
}

async function withLoading(fn) {
  rt.loading = true; rt.error = null; render();
  try { await fn(); }
  catch (err) { rt.error = err; }
  finally { rt.loading = false; render(); }
}

// ─── Story details ────────────────────────────────────────────────────────────

/** The story whose details are on screen: the overview's pick, else the card on the table. */
function detailId() {
  if (rt.view === 'all') return rt.selected;
  return currentCard()?.id ?? null;
}

async function loadDetail(id) {
  const d = { loading: true };
  details.set(id, d);
  const [wp, kids, relations, files] = await Promise.allSettled([
    fetchWorkPackage(id), fetchChildWorkPackages(id), fetchRelations(id), fetchAttachments(id),
  ]);
  d.loading = false;
  if (wp.status === 'rejected') { d.err = wp.reason; requestRender(); return; }
  d.wp = wp.value;
  d.kids = kids.status === 'fulfilled' ? kids.value : null;
  d.relations = relations.status === 'fulfilled' ? relations.value : null;
  d.files = files.status === 'fulfilled' ? files.value : null;
  d.partialErr = [kids, relations, files].find(r => r.status === 'rejected')?.reason?.message ?? '';
  d.kidStatuses = new Map();
  requestRender();
  loadStatuses(id);
  if (rt.tab === 'sub' && detailId() === id) loadKidStatuses(id);
}

async function loadStatuses(id) {
  const d = details.get(id);
  if (!d?.wp) return;
  try { d.statuses = await fetchAllowedStatuses(id); }
  catch { d.statuses = null; }
  requestRender();
}

/** Every subtask's allowed statuses at once, so the selects open with their options. */
async function loadKidStatuses(id) {
  const d = details.get(id);
  if (!d?.kids?.length || d.kidStatusesLoading) return;
  d.kidStatusesLoading = true;
  const todo = d.kids.filter(k => !d.kidStatuses.has(String(k.id)) && !d.kidStatusFailed?.has(String(k.id)));
  if (!todo.length) { d.kidStatusesLoading = false; return; }
  await Promise.all(todo.map(async k => {
    try { d.kidStatuses.set(String(k.id), await fetchAllowedStatuses(k.id)); }
    catch { (d.kidStatusFailed ??= new Set()).add(String(k.id)); /* the select keeps the current status only */ }
  }));
  d.kidStatusesLoading = false;
  requestRender();
  if (details.get(id) === d && d.kids.some(k => !d.kidStatuses.has(String(k.id)))) loadKidStatuses(id);
}

/** Loads whatever the visible story needs and hasn't been fetched yet. */
function ensureDetail() {
  const id = detailId();
  if (!id) return;
  if (!details.has(id)) loadDetail(id);
  else if (details.get(id).wp) prefetchAround(id);
  if (!rt.people && !rt.peopleLoading && s.projectId) {
    rt.peopleLoading = true;
    loadPeople().catch(() => { /* the selects keep the current assignee */ }).finally(() => { rt.peopleLoading = false; requestRender(); });
  }
  if (!rt.types && !rt.typesLoading && s.projectId) {
    rt.typesLoading = true;
    fetchProjectTypes(s.projectId).then(t => { rt.types = t; }).catch(() => { rt.types = []; })
      .finally(() => { rt.typesLoading = false; requestRender(); });
  }
}

/** Loads the stories Next and Prev would show, once the current one is in, so they open at once. */
function prefetchAround(id) {
  const key = levelKeyOf(id);
  if (!key || rt.view === 'all') return;
  const ids = levelIds(key).filter(x => cardById(x));
  const i = ids.indexOf(id);
  for (const near of [ids[i + 1], ids[i - 1], nextUndecidedAfter(key, id)]) {
    if (near && !details.has(near)) loadDetail(near);
  }
}

// View all: start loading a story as the pointer reaches its row.
document.addEventListener('pointerover', e => {
  const row = e.target.closest?.('.all-row[data-id]');
  if (row && !details.has(row.dataset.id)) loadDetail(row.dataset.id);
});

const blobUrl = path => { const u = blobs.get(path); return u && u !== 'loading' && u !== 'failed' ? u : null; };

/** Puts already-fetched pictures straight into the markup, so a repaint doesn't blank them. */
function withBlobSrc(html) {
  return html.replace(/data-blob="([^"]*)"/g, (m, attr) => {
    const url = blobUrl(attr.replace(/&amp;/g, '&'));
    return url ? `${m} src="${url}"` : m;
  });
}

/** Fills images that need the session cookie (description images, attachment thumbnails). */
function hydrateImages() {
  for (const img of document.querySelectorAll('#view img[data-blob]:not([src])')) {
    const path = img.dataset.blob;
    const url = blobs.get(path);
    if (url && url !== 'loading' && url !== 'failed') { img.src = url; continue; }
    if (url) continue;
    blobs.set(path, 'loading');
    fetchBacklogBlob(path)
      .then(b => { blobs.set(path, URL.createObjectURL(b)); hydrateImages(); })
      .catch(() => { blobs.set(path, 'failed'); });
  }
}

const writeChains = new Map();   // wpId -> the last write's promise
function queueWrite(wpId, fn) {
  const run = (writeChains.get(wpId) ?? Promise.resolve()).catch(() => {}).then(fn);
  writeChains.set(wpId, run);
  return run;
}

/** Sets a story's or subtask's status or assignee on OpenProject. */
async function writeField(wpId, field, href, parentId) {
  const key = `${wpId}:${field}`;
  if (rt.saving.has(key)) return;
  rt.saving.add(key); rt.writeErr.delete(key); render();
  try {
    const saved = await queueWrite(String(wpId), () => patchWorkPackage(wpId, { _links: { [field]: { href } } }));
    const d = details.get(parentId ?? wpId);
    if (d?.loading) {
      details.delete(parentId ?? wpId);   // a reload started before the save: load it again after
    } else if (parentId) {
      if (d?.kids) d.kids = d.kids.map(k => String(k.id) === String(wpId) ? saved : k);
      if (field === 'status') { d?.kidStatuses?.delete(String(wpId)); loadKidStatuses(parentId); }
    } else {
      if (d) d.wp = saved;
      const card = rt.cards.get(String(wpId));
      if (card) rt.cards.set(card.id, { ...toCard(saved), labels: card.labels });
      if (field === 'status') loadStatuses(wpId);
    }
    announce(`#${wpId} ${field} saved`);
  } catch (err) {
    rt.writeErr.set(key, err.code === 'NOT_AUTHENTICATED' ? "you're signed out of the backlog" : err.message);
  } finally {
    rt.saving.delete(key);
    render();
  }
}

async function createSubtask(parentId) {
  const sub = rt.sub;
  const subject = sub.draft.trim();
  if (!subject || sub.busy) return;
  const d = details.get(parentId);
  const parentAssignee = d?.wp?._links?.assignee?.href ?? null;
  const assigneeHref = sub.assigneeHref === undefined ? parentAssignee : sub.assigneeHref;
  const typeHref = sub.typeHref ?? defaultTypeHref();
  const links = {
    parent:  { href: `/api/v3/work_packages/${parentId}` },
    project: { href: `/api/v3/projects/${s.projectId}` },
  };
  if (typeHref) links.type = { href: typeHref };
  if (assigneeHref) links.assignee = { href: assigneeHref };
  if (s.versionHref) links.version = { href: s.versionHref };   // subtasks live in the sprint they're planned in
  sub.busy = true; sub.err = ''; render();
  try {
    const kid = await createWorkPackage({ subject, _links: links });
    sub.draft = '';
    const live = details.get(parentId);
    if (live?.kids) live.kids = [...live.kids, kid];
    if (live) loadKidStatuses(parentId);
    announce(`Subtask #${kid.id} created`);
  } catch (err) {
    sub.err = err.message;
  } finally {
    sub.busy = false;
    render();
    if (rt.subFor === parentId) document.querySelector('[data-role="sub-subject"]')?.focus();
  }
}

const defaultTypeHref = () => (rt.types?.find(t => /^task$/i.test(t.name)) ?? rt.types?.[0])?.href ?? null;

// ─── Actions ──────────────────────────────────────────────────────────────────

function startQuest() {
  if (!s.projectId || !s.versionId) return;
  s.phase = 'play'; s.level = 0; s.intro = true;
  s.elapsed = {}; s.runningSince = null; s.overtimeOk = {};
  s.decisions = {}; s.history = []; s.order = {}; s.cardSpent = {}; s.cursor = {};
  for (const l of PLAY_LEVELS) syncOrder(l.key);
  const plan = timePlan();
  s.scale = plan.scale;
  for (const l of PLAY_LEVELS) s.budgets[l.key] = plan.minutes(l.key);
  save(); render();
}

// ─── Level order (lobby only) ─────────────────────────────────────────────────

function setOrder(order) {
  if (s.phase !== 'lobby') return;
  s.levelOrder = order;
  applyOrder(); save(); render();
}

function moveLevel(key, by) {
  const order = [...s.levelOrder];
  const i = order.indexOf(key), j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  setOrder(order);
  document.querySelector(`[data-act="${by < 0 ? 'up' : 'down'}"][data-key="${key}"]:not(:disabled)`)?.focus();
  announce(`${DEF[key].short} is now level ${j + 1}`);
}

let dragKey = null;
// Only the grip starts a drag, so selecting text in a row's minutes field still works.
document.addEventListener('pointerdown', e => {
  const row = e.target.closest?.('.grip') && e.target.closest('[data-role="levels"] .lvl-row');
  if (row) row.draggable = true;
});
const dropRow = e => e.target.closest?.('[data-role="levels"] .lvl-row');

document.addEventListener('dragstart', e => {
  const row = dropRow(e);
  if (!row || s.phase !== 'lobby') return;
  dragKey = row.dataset.level;
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragKey);
});
document.addEventListener('dragover', e => {
  const row = dropRow(e);
  if (!dragKey || !row) return;
  e.preventDefault();
  const after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
  document.querySelectorAll('.lvl-row.drop-before, .lvl-row.drop-after').forEach(r => r.classList.remove('drop-before', 'drop-after'));
  if (row.dataset.level !== dragKey) row.classList.add(after ? 'drop-after' : 'drop-before');
});
document.addEventListener('drop', e => {
  const row = dropRow(e);
  if (!dragKey || !row) return;
  e.preventDefault();
  const target = row.dataset.level;
  const after = row.classList.contains('drop-after');
  if (target !== dragKey) {
    const order = s.levelOrder.filter(k => k !== dragKey);
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, dragKey);
    setOrder(order);
  }
  dragKey = null;
});
document.addEventListener('dragend', () => {
  dragKey = null;
  document.querySelectorAll('.lvl-row[draggable="true"]').forEach(r => { r.draggable = false; });
  document.querySelectorAll('.lvl-row.dragging, .lvl-row.drop-before, .lvl-row.drop-after')
    .forEach(r => r.classList.remove('dragging', 'drop-before', 'drop-after'));
});

function startLevel() {
  s.intro = false; resume(); save(); render();
  announce(`${curLevel().name} started, ${mins(curLevel().key)} minutes`);
}

function nextLevel() {
  pause();
  rt.ui = { mode: null };
  if (s.level >= LEVELS.length - 1) s.phase = 'loot';
  else { s.level++; s.intro = true; }
  save(); render();
}

function togglePause() {
  if (s.phase !== 'play' || s.intro) return;
  if (s.runningSince) pause(); else resume();
  save(); render();
}

/** Marks a story planned or deferred. Game bookkeeping only: nothing is written to OpenProject. */
function decide(card, d, extra = {}) {
  hideToast();
  const level = levelKeyOf(card.id) ?? curLevel().key;
  const wasOnTable = currentId() === card.id;
  s.decisions[card.id] = {
    d, level, at: Date.now(),
    card: { id: card.id, subject: card.subject, type: card.type, points: card.points, priority: card.priority,
            labels: card.labels, assigneeHref: card.assigneeHref, assigneeName: card.assigneeName },
    ...extra,
  };
  s.history.push(card.id);
  rt.ui = { mode: null };
  if (s.phase === 'play' && level === curLevel().key) {
    if (wasOnTable) {   // the table moves on to the next story still open
      const next = nextUndecidedAfter(level, card.id);
      if (next) s.cursor[level] = next; else delete s.cursor[level];
    }
    if (!undecided(level).length && !s.cursor[level]) pause();   // level cleared: the clock stops on the win
  }
  save(); render();
  announce(d === 'plan' ? `#${card.id} planned` : `#${card.id} deferred`);
  toast(`#${card.id} ${d === 'plan' ? 'planned' : 'deferred'}`, 'Undo', () => (s.history.at(-1) === card.id ? undo() : hideToast()));
}

/** Next: the following story in the level (this one stays unplanned if it was). Previous: the one before. */
function step(by) {
  const key = curLevel().key;
  const ids = levelIds(key).filter(x => cardById(x));
  const i = ids.indexOf(currentId());
  if (i < 0) return;
  let target = ids[i + by];
  if (!target && by > 0) target = nextUndecidedAfter(key, ids[i]);   // past the end: back to what's still open
  if (!target && by > 0 && !undecided(key).length) {   // nothing left open: the level is cleared
    delete s.cursor[key];
    pause();
    rt.ui = { mode: null };
    save(); render();
    return;
  }
  if (!target || target === ids[i]) return;
  s.cursor[key] = target;
  rt.ui = { mode: null };
  save(); render();
  announce(`#${target} on the table`);
}
const canStep = by => {
  const key = curLevel()?.key, ids = levelIds(key).filter(x => cardById(x)), i = ids.indexOf(currentId());
  if (i < 0) return false;
  return by < 0 ? i > 0 : (i < ids.length - 1 || !!nextUndecidedAfter(key, ids[i]) || !undecided(key).length);
};

/** Puts a decided story back in play, first in its level. */
function reopen(id) {
  const dec = s.decisions[id];
  if (!dec) return;
  delete s.decisions[id];
  const at = s.history.lastIndexOf(id);
  if (at >= 0) s.history.splice(at, 1);
  if (s.phase === 'play' && dec.level === curLevel()?.key) {
    s.cursor[dec.level] = id;
    if (!s.intro) resume();
  }
  hideToast();
  save(); render();
  announce(`#${id} is back in play`);
  return dec;
}

async function undo() {
  const id = s.history.at(-1);
  if (!id) return;
  const prior = s.decisions[id];
  if (!prior) { s.history.pop(); save(); render(); return; }   // stale entry: drop it
  if (prior.wrote && prior.prev) {   // an old-style Commit that wrote the assignee
    try { await queueWrite(id, () => patchWorkPackage(id, { _links: { assignee: { href: prior.prev.assigneeHref ?? null } } })); }
    catch (err) { toast(`Couldn't undo #${id}: ${err.message}`); return; }
  }
  const dec = reopen(id);
  if (dec && dec.level !== curLevel()?.key) toast(`#${id} is back in ${DEF[dec.level].short}, a level you've already played.`);
}

/** Brings a story of the current level to the table now. */
function playNow(id) {
  const key = curLevel()?.key;
  if (!levelIds(key).includes(id)) return;
  s.cursor[key] = id;
  rt.view = null;
  if (!s.intro) resume();
  save(); render();
}

function openDefer() {
  rt.ui = { mode: 'defer' };
  render();
  document.querySelector('[data-role="reason"]')?.focus();
}

function toggleAll() {
  if (s.phase === 'lobby') return;
  if (rt.view === 'all') { rt.view = null; render(); return; }
  rt.view = 'all';
  rt.selected = currentCard()?.id ?? rt.selected ?? PLAY_LEVELS.flatMap(l => levelIds(l.key)).find(id => cardById(id)) ?? null;
  render();
}

function endGame() {
  pause();
  hideToast();
  rt.confirmNew = false;
  s.phase = 'loot';
  rt.view = null;
  save(); render();
}

function newGame() {
  if (Object.keys(s.decisions).length && !rt.confirmNew) { rt.confirmNew = true; render(); return; }
  rt.confirmNew = false;
  s = freshSession(s);
  rt.view = null;
  applyOrder();
  save();
  withLoading(loadCards);
}

// ─── Render: frame ────────────────────────────────────────────────────────────

// ─── DOM patching ─────────────────────────────────────────────────────────────
//  Each render builds the page as a string, then patches the live DOM to match it
//  node by node instead of replacing it: images keep their decoded picture, open
//  selects and scroll positions survive, and nothing flashes when a background
//  request (statuses, people, a prefetched story) finishes. Event handlers are
//  all delegated on document, so patched nodes need no rebinding.

let lastHtml = null;

function morph(target, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  patchChildren(target, tpl.content);
}

// Elements that are a different thing when these differ are swapped, not patched.
const sameNode = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName
  && (a.nodeType !== 1 || (a.getAttribute('data-key') === b.getAttribute('data-key')
                        && a.getAttribute('data-id') === b.getAttribute('data-id')));

function patchChildren(from, to) {
  const olds = [...from.childNodes], news = [...to.childNodes];
  news.forEach((nb, i) => {
    const na = olds[i];
    if (!na) { from.appendChild(nb); return; }
    if (!sameNode(na, nb)) { from.replaceChild(nb, na); return; }
    if (na.nodeType !== 1) { if (na.nodeValue !== nb.nodeValue) na.nodeValue = nb.nodeValue; return; }
    patchAttrs(na, nb);
    patchChildren(na, nb);
    patchFormState(na, nb);
  });
  for (let i = olds.length - 1; i >= news.length; i--) olds[i].remove();
}

function patchAttrs(a, b) {
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  for (const { name } of [...a.attributes]) {
    if (b.hasAttribute(name)) continue;
    if (name === 'src' && a.tagName === 'IMG' && a.dataset.blob) continue;   // filled in by hydrateImages
    a.removeAttribute(name);
  }
}

/** Attributes don't move a control's live value; set it, unless someone is using that control. */
function patchFormState(a, b) {
  if (a === document.activeElement) return;
  if (a.tagName === 'SELECT') {
    const want = [...b.options].find(o => o.hasAttribute('selected'))?.value ?? b.options[0]?.value ?? '';
    if (a.value !== want) a.value = want;
  } else if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') {
    const want = b.getAttribute('value') ?? '';
    if (a.value !== want) a.value = want;
  }
}

// Re-rendering replaces the controls, so the focused one is found again by its data attribute.
const FOCUS_KEYS = ['field', 'set', 'budget', 'per', 'act', 'role'];
function focusKey() {
  const el = document.activeElement;
  const k = el && FOCUS_KEYS.find(x => el.dataset?.[x]);
  if (!k) return null;
  const extra = el.dataset.wp ? `[data-wp="${CSS.escape(el.dataset.wp)}"]` : el.dataset.id ? `[data-id="${CSS.escape(el.dataset.id)}"]` : el.dataset.tab ? `[data-tab="${CSS.escape(el.dataset.tab)}"]` : '';
  return { sel: `[data-${k}="${CSS.escape(el.dataset[k])}"]${extra}`, caret: el.selectionStart ?? null };
}

function render() {
  const focused = focusKey();
  const did = s.phase === 'lobby' ? null : detailId();
  if (rt.subFor !== did) {   // a new story: fresh subtask draft, back to its description
    rt.subFor = did;
    rt.sub = { draft: '', typeHref: rt.sub.typeHref, assigneeHref: undefined, busy: false, err: '' };
    rt.tab = 'desc';
  }
  const scrollTop = document.querySelector('[data-role="all-list"]')?.scrollTop ?? 0;
  const pane = document.querySelector('[data-role="all-detail"]');
  const paneTop = pane && pane.dataset.id === String(rt.selected) ? pane.scrollTop : 0;
  const tabBody = document.querySelector('.tab-body');
  const tabTop = tabBody && tabBody.dataset.key === `${detailId()}:${rt.tab}` ? tabBody.scrollTop : 0;
  renderBar();
  renderBanner();
  const view = $('view');
  const err = rt.error && !rt.loading ? errorHtml(rt.error) : '';
  const html = err + (s.phase === 'lobby' ? lobbyHtml() : rt.view === 'all' ? allHtml()
    : s.phase === 'loot' ? lootHtml() : arenaHtml());
  if (html !== lastHtml) { morph(view, html); lastHtml = html; }
  const list = document.querySelector('[data-role="all-list"]');
  if (list) list.scrollTop = scrollTop;
  const newPane = document.querySelector('[data-role="all-detail"]');
  if (newPane) newPane.scrollTop = paneTop;
  const newTab = document.querySelector('.tab-body');
  if (newTab) newTab.scrollTop = tabTop;
  if (focused && !document.activeElement?.matches('input, select, textarea, button')) {
    const el = document.querySelector(focused.sel) ?? document.querySelector('#view button.primary');
    el?.focus({ preventScroll: true });
    if (el && focused.caret != null && typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(focused.caret, focused.caret); } catch { /* not a text field */ }
    }
  }
  if (s.phase !== 'lobby') { ensureDetail(); hydrateImages(); }
}

/** Says a milestone to screen readers without re-reading the page. */
function announce(msg) { $('status').textContent = msg; }

function errorHtml(err) {
  if (err.code === 'NOT_AUTHENTICATED') {
    return `<div class="panel empty" role="alert" style="margin-bottom:var(--space-md)">You're signed out of the backlog. <a href="${BACKLOG_URL}" target="_blank" rel="noopener">Sign in ↗</a>, then <button data-act="retry">Try again</button></div>`;
  }
  return `<div class="panel empty" role="alert" style="margin-bottom:var(--space-md)">Couldn't load the backlog: ${esc(err.message)}. <button data-act="retry">Try again</button></div>`;
}

function renderBar() {
  const info = $('bar-info'), actions = $('bar-actions');
  if (s.phase === 'lobby') {
    info.innerHTML = `<span>Sprint planning, ${START_AT}–${END_AT}</span>`;
    actions.innerHTML = '';
    return;
  }
  const lv = curLevel();
  const playNo = PLAY_LEVELS.indexOf(lv) + 1;
  const all = PLAY_LEVELS.flatMap(l => levelIds(l.key)).filter(id => cardById(id));
  const done = all.filter(id => s.decisions[id]).length;
  info.innerHTML = `
    <span><b>${esc(s.projectName)}</b> → <b>${esc(s.versionName)}</b></span>
    ${s.phase === 'play' ? `<span>${lv.isBreak ? 'Break' : `Level ${playNo} of ${PLAY_LEVELS.length}`}</span>` : ''}
    <span>Planned <b class="num">${done} / ${all.length}</b></span>
    <span>Time bank <b class="num">${signedClock(bankMs())}</b></span>`;
  const allBtn = `<button data-act="all"${rt.view === 'all' ? ' aria-pressed="true"' : ''}>${rt.view === 'all' ? 'Close view all' : 'View all'} <kbd>V</kbd></button>`;
  actions.innerHTML = s.phase === 'play'
    ? `${allBtn}
       ${s.intro ? '' : `<button data-act="pause" title="Space">${s.runningSince ? 'Pause' : 'Resume'} <kbd>Space</kbd></button>`}
       <button data-act="refresh" title="Reload stories from OpenProject">↻ Refresh</button>
       <button class="ghost" data-act="end">End game</button>`
    : allBtn;
}

function renderBanner() {
  const lv = curLevel();
  const show = s.phase === 'play' && !s.intro && !lv.isBreak && !s.overtimeOk[lv.key]
    && remainingMs(lv.key) < 0 && !!currentCard();
  rt.timeUp = show;
  $('banner').hidden = !show;
  if (!show) return;
  const left = undecided(lv.key).length;
  $('banner-msg').textContent = `Time's up. ${left} stor${left === 1 ? 'y' : 'ies'} not planned yet.`;
  $('banner-actions').innerHTML = `
    <button data-act="keep">Keep playing${bankMs() > 0 ? ` (bank ${clock(bankMs())})` : ''}</button>
    <button data-act="next">Move on</button>`;
}

// ─── Render: lobby ────────────────────────────────────────────────────────────

function lobbyHtml() {
  const counts = Object.fromEntries(PLAY_LEVELS.map(l => {
    const ids = levelIds(l.key).filter(id => rt.cards.has(id));
    return [l.key, { n: ids.length, p: ids.reduce((t, id) => t + (rt.cards.get(id).points ?? 0), 0) }];
  }));
  const plan = timePlan();
  const levelMin = l => l.isBreak ? Number(s.budgets.break) || 0 : plan.minutes(l.key);
  const total = Math.round(LEVELS.reduce((t, l) => t + levelMin(l), 0));
  const ends = addMinutes(START_AT, total + LOOT_MIN);
  const late = ends > END_AT;
  const dealt = PLAY_LEVELS.reduce((t, l) => t + counts[l.key].n, 0);
  const ready = s.projectId && s.versionId && !rt.loading && dealt > 0;
  const emptyNote = s.projectId && !rt.loading && !rt.error
    ? (!rt.versions.length ? 'This project has no open versions to plan into.'
      : !s.versionId ? ''
      : !dealt ? 'Nothing to deal: this sprint has no open work packages.' : '')
    : '';

  const projOpts = rt.projects.map(p => `<option value="${p.id}"${String(p.id) === String(s.projectId) ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  const verOpts  = rt.versions.map(v => `<option value="${v.id}"${String(v.id) === s.versionId ? ' selected' : ''}>${esc(v.name)}</option>`).join('');

  const rows = LEVELS.map((l, i) => `
    <div class="lvl-row lvl-${l.key}" data-level="${l.key}">
      <span class="grip" title="Drag to reorder" aria-hidden="true">${icon('grip')}</span>
      <span class="lvl-mark">${icon(l.key)}</span>
      <div><div class="name">${esc(l.name)}</div><div class="sub">${esc(l.sub)}</div></div>
      <span class="count num">${l.isBreak ? '' : rt.loading ? '…' : `${counts[l.key].n} stories · ${pts(counts[l.key].p)} pts`}</span>
      ${l.isBreak
        ? `<label class="mins"><input class="ctrl num" type="number" min="0" max="60" step="5" value="${esc(s.budgets.break)}" data-budget="break" aria-label="Break minutes" /> <span class="muted">min</span></label>`
        : `<span class="mins num" title="${counts[l.key].n} stories × minutes by priority${plan.scale < 1 ? ', scaled to fit' : ''}">${rt.loading ? '…' : Math.round(levelMin(l))} <span class="muted">min</span></span>`}
      <span class="moves">
        <button class="ghost icon" data-act="up" data-key="${l.key}" aria-label="Play ${esc(l.short)} earlier"${i === 0 ? ' disabled' : ''}>↑</button>
        <button class="ghost icon" data-act="down" data-key="${l.key}" aria-label="Play ${esc(l.short)} later"${i === LEVELS.length - 1 ? ' disabled' : ''}>↓</button>
      </span>
    </div>`).join('');
  const custom = s.levelOrder.join() !== DEFAULT_ORDER.join();

  return `
    <div class="lobby">
      <section>
        <h2>The quest</h2>
        <p class="text2" style="margin-bottom:var(--space-sm)">The sprint's open stories are dealt in priority order, one level at a time. Each story opens with its description, subtasks, relations and attachments.</p>
        ${emptyNote ? `<p class="panel empty" style="margin-bottom:var(--space-sm)">${esc(emptyNote)}</p>` : ''}
        <div class="panel lvl-list" data-role="levels">${rows}</div>
        <p class="muted order-note">Drag a level (or use ↑ ↓) to change when it's played. A story still belongs to the first rule it matches: goal, then pilot / Chiron / VAB, Immediate, High, everything else.${custom ? ' <button class="ghost" data-act="order-reset">Default order</button>' : ''}</p>
        <div class="lvl-foot">
          <span class="text2">Starts ${START_AT} · <span class="num">${total}</span> min of levels + ${LOOT_MIN} min loot · ends <b class="num ${late ? 'warn-text' : ''}">${ends}</b>${late ? ` <span class="warn-text">(past ${END_AT})</span>` : ''}</span>
          ${plan.scale < 1 ? `<span class="warn-text">${Math.round(plan.sum)} min of stories don't fit ${plan.avail} min, so every story gets ${Math.round(plan.scale * 100)}% of its time</span>` : ''}
          <span class="spacer"></span>
          <button class="primary big" data-act="start"${ready ? '' : ' disabled'}>Start quest</button>
        </div>
      </section>
      <aside class="panel lobby-setup" aria-label="Setup">
        <label class="field"><span>Project</span>
          <select class="ctrl" data-set="project"><option value="">Choose a project</option>${projOpts}</select></label>
        <label class="field"><span>Sprint to plan</span>
          <select class="ctrl" data-set="version"${s.projectId ? '' : ' disabled'}><option value="">Choose a version</option>${verOpts}</select></label>
        <p class="muted" style="font-size:var(--text-xs)">Only the sprint's open stories are dealt (their subtasks come with them). Labels come from the Label field; priorities from Priority.</p>
        <fieldset class="per-story">
          <legend>Minutes per story</legend>
          ${BUCKETS.map(b => `<label class="per-row"><span>${esc(b.label)}</span>
            <input class="ctrl num" type="number" min="0" max="60" step="1" value="${esc(s.perStory[b.key])}" data-per="${b.key}" aria-label="Minutes per ${esc(b.label)} story" />
            <span class="muted">min</span></label>`).join('')}
          <p class="muted">A level gets the minutes of its stories. Each story's own clock shows on its card.</p>
        </fieldset>
      </aside>
    </div>`;
}

// ─── Render: story detail ─────────────────────────────────────────────────────

function savingCls(key) { return rt.saving.has(key) ? ' saving' : ''; }
function writeErrHtml(key, label) {
  const e = rt.writeErr.get(key);
  return e ? `<div class="card-error" role="alert">Couldn't change the ${label}: ${esc(e)}</div>` : '';
}

function statusSelect(wpId, currentHref, currentName, options, parentId) {
  const opts = [...(options ?? [])];
  if (currentHref && !opts.some(o => o.href === currentHref)) opts.unshift({ href: currentHref, name: currentName });
  const key = `${wpId}:status`;
  return `<select class="ctrl${savingCls(key)}" data-field="status" data-wp="${esc(wpId)}"${parentId ? ` data-parent="${esc(parentId)}"` : ''}
    data-orig="${esc(currentHref ?? '')}" aria-label="Status of #${esc(wpId)}"${rt.saving.has(key) ? ' aria-busy="true"' : ''}>
    ${opts.map(o => `<option value="${esc(o.href)}"${o.href === currentHref ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}
  </select>`;
}

function assigneeSelect(wpId, currentHref, currentName, parentId, { field = 'assignee', label } = {}) {
  const people = [...(rt.people ?? [])];
  if (currentHref && !people.some(p => p.href === currentHref)) people.unshift({ href: currentHref, name: currentName });
  const key = `${wpId}:${field}`;
  return `<select class="ctrl${savingCls(key)}" data-field="${field}" data-wp="${esc(wpId)}"${parentId ? ` data-parent="${esc(parentId)}"` : ''}
    data-orig="${esc(currentHref ?? '')}" aria-label="${esc(label ?? `Assignee of #${wpId}`)}"${rt.saving.has(key) ? ' aria-busy="true"' : ''}>
    <option value=""${currentHref ? '' : ' selected'}>Unassigned</option>
    ${rt.me ? `<option value="${esc(rt.me.href)}"${rt.me.href === currentHref ? ' selected' : ''}>Me (${esc(rt.me.name)})</option>` : ''}
    ${people.filter(p => p.href !== rt.me?.href).map(p => `<option value="${esc(p.href)}"${p.href === currentHref ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
  </select>`;
}

function fieldsHtml(id, d) {
  const wp = d.wp, L = wp._links ?? {};
  return `<div class="fields">
    <label class="fld"><span>Status</span>${statusSelect(id, L.status?.href, L.status?.title, d.statuses)}</label>
    <label class="fld"><span>Assignee</span>${assigneeSelect(id, L.assignee?.href, L.assignee?.title)}</label>
    <div class="fld"><span>Author</span><b>${esc(L.author?.title ?? '—')}</b></div>
    <div class="fld"><span>Updated</span><b>${esc(shortDate(wp.updatedAt))}</b></div>
    ${L.parent?.href ? `<div class="fld"><span>Parent</span><a href="${BACKLOG_URL}/work_packages/${esc(idOf(L.parent.href))}" target="_blank" rel="noopener">${esc(L.parent.title ?? `#${idOf(L.parent.href)}`)} ↗</a></div>` : ''}
  </div>
  ${writeErrHtml(`${id}:status`, 'status')}${writeErrHtml(`${id}:assignee`, 'assignee')}`;
}

function descHtml(d) {
  const html = d.wp.description?.html ?? '';
  if (!html.replace(/<[^>]*>/g, '').trim() && !/<img/i.test(html)) return '<p class="text2">No description.</p>';
  if (d.descFor !== html) { d.descFor = html; d.descSafe = safeHtml(html); }
  return `<div class="rich">${d.descSafe}</div>`;
}

function kidsHtml(id, d) {
  if (!d.kids) return `<p class="card-error">Couldn't load the subtasks.</p>`;
  const done = d.kids.filter(k => k._links?.status?.title && /closed|done|resolved|rejected/i.test(k._links.status.title)).length;
  const rows = d.kids.map(k => {
    const kid = String(k.id), L = k._links ?? {};
    return `<li class="kid-row">
      <a class="num" href="${BACKLOG_URL}/work_packages/${kid}" target="_blank" rel="noopener">#${kid}</a>
      <span class="kid-type">${esc(L.type?.title ?? '')}</span>
      <span class="kid-subject">${esc(k.subject ?? '')}</span>
      ${statusSelect(kid, L.status?.href, L.status?.title, d.kidStatuses?.get(kid), id)}
      ${assigneeSelect(kid, L.assignee?.href, L.assignee?.title, id)}
      ${writeErrHtml(`${kid}:status`, 'status')}${writeErrHtml(`${kid}:assignee`, 'assignee')}
    </li>`;
  }).join('');
  const types = rt.types ?? [];
  const typeHref = rt.sub.typeHref ?? defaultTypeHref();
  const parentAssignee = d.wp._links?.assignee;
  const subAssignee = rt.sub.assigneeHref === undefined ? parentAssignee?.href ?? null : rt.sub.assigneeHref;
  return `
    ${d.kids.length ? `<p class="text2 kid-sum">${done} of ${d.kids.length} done</p><ul class="kids">${rows}</ul>` : '<p class="text2">No subtasks yet.</p>'}
    <div class="create-row">
      <select class="ctrl" data-role="sub-type" aria-label="Type of the new subtask">
        ${types.map(t => `<option value="${esc(t.href)}"${t.href === typeHref ? ' selected' : ''}>${esc(t.name)}</option>`).join('') || '<option value="">Task</option>'}
      </select>
      <input class="ctrl" data-role="sub-subject" placeholder="New subtask, Enter creates it" aria-label="Subject of the new subtask" value="${esc(rt.sub.draft)}"${rt.sub.busy ? ' readonly aria-busy="true"' : ''} />
      ${assigneeSelect('new', subAssignee, parentAssignee?.title, null, { field: 'sub-assignee', label: 'Assignee of the new subtask' })}
      <button class="primary" data-act="sub-create" data-id="${esc(id)}"${rt.sub.busy ? ' aria-busy="true"' : ''}>${rt.sub.busy ? 'Creating…' : 'Create'}</button>
    </div>
    ${rt.sub.err ? `<div class="card-error" role="alert">Couldn't create the subtask: ${esc(rt.sub.err)}</div>` : ''}`;
}

function relationsHtml(id, d) {
  if (!d.relations) return `<p class="card-error">Couldn't load the relations.</p>`;
  if (!d.relations.length) return '<p class="text2">No relations.</p>';
  const groups = new Map();
  for (const r of d.relations) {
    const fromId = idOf(r._links?.from?.href);
    const mine = fromId === String(id);
    const other = mine ? r._links?.to : r._links?.from;
    const type = mine ? r.type : (r.reverseType ?? r.type);
    const label = RELATION_LABEL[type] ?? type ?? 'Related';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({ id: idOf(other?.href), title: other?.title ?? '', note: r.description ?? '' });
  }
  return [...groups.entries()].map(([label, items]) => `<div class="rel-group"><h4>${esc(label)}</h4><ul>
    ${items.map(x => `<li><a class="num" href="${BACKLOG_URL}/work_packages/${esc(x.id)}" target="_blank" rel="noopener">#${esc(x.id)}</a> ${esc(x.title)}${x.note ? ` <span class="muted">· ${esc(x.note)}</span>` : ''}</li>`).join('')}
  </ul></div>`).join('');
}

function filesHtml(d) {
  if (!d.files) return `<p class="card-error">Couldn't load the attachments.</p>`;
  if (!d.files.length) return '<p class="text2">No attachments.</p>';
  return `<ul class="files">${d.files.map(f => `<li><a class="file" href="${BACKLOG_URL}${esc(f.href)}" target="_blank" rel="noopener">
    <span class="thumb">${f.type.startsWith('image/') ? `<img data-blob="${esc(f.href)}" alt="" />` : icon('file', 22)}</span>
    <span class="f-name">${esc(f.name)}</span>
    <span class="f-meta">${esc([fileSize(f.size), f.author, shortDate(f.created)].filter(Boolean).join(' · '))}</span>
  </a></li>`).join('')}</ul>`;
}

function detailHtml(id) {
  if (!id) return '';
  const d = details.get(id);
  if (!d || (d.loading && !d.wp)) return '<section class="panel detail loading" aria-busy="true"><p class="text2">Loading the story…</p></section>';
  if (!d.wp) return `<section class="panel detail"><p class="card-error">Couldn't load #${esc(id)}: ${esc(d.err?.message ?? 'request failed')}</p>
    <button data-act="detail-retry" data-id="${esc(id)}">Try again</button></section>`;
  return withBlobSrc(`<section class="panel detail" aria-label="Story #${esc(id)}">
    ${fieldsHtml(id, d)}
    ${tabsHtml(id, d)}
  </section>`);
}

/** Description · Subtasks · Relations · Attachments for a loaded story. */
function tabsHtml(id, d) {
  const tabs = [
    ['desc', 'Description', ''],
    ['sub', 'Subtasks', d.kids?.length],
    ['rel', 'Relations', d.relations?.length],
    ['files', 'Attachments', d.files?.length],
  ];
  const body = rt.tab === 'sub' ? kidsHtml(id, d) : rt.tab === 'rel' ? relationsHtml(id, d)
    : rt.tab === 'files' ? filesHtml(d) : descHtml(d);
  return `<div class="tabs" role="tablist">${tabs.map(([k, label, n]) => `<button role="tab" class="tab" data-act="tab" data-tab="${k}" aria-selected="${rt.tab === k}">${label}${n ? ` <span class="num muted">${n}</span>` : ''}</button>`).join('')}</div>
    <div class="tab-body" role="tabpanel" data-key="${esc(id)}:${rt.tab}">${body}</div>
    ${d.partialErr ? `<p class="muted" style="font-size:var(--text-xs)">Some parts didn't load: ${esc(d.partialErr)}</p>` : ''}
    <div class="detail-foot"><button class="ghost" data-act="detail-retry" data-id="${esc(id)}">↻ Reload story</button></div>`;
}

// ─── Render: arena ────────────────────────────────────────────────────────────

const planned = () => Object.values(s.decisions).filter(d => d.d === 'plan' || d.d === 'commit');

function trackHtml() {
  return `<nav class="track" aria-label="Levels">${LEVELS.map((l, i) => {
    const st = i < s.level ? 'done' : i === s.level ? 'now' : 'locked';
    const left = l.isBreak ? '' : `${undecided(l.key).length} left · `;
    const meta = st === 'done'
      ? (l.isBreak ? 'Recharged' : `${levelIds(l.key).filter(id => s.decisions[id]?.d === 'plan').length} planned`)
      : `${left}${mins(l.key)} min`;
    return `<div class="track-item lvl-${l.key} ${st}"${st === 'now' ? ' aria-current="step"' : ''}>
      <span class="lvl-mark">${icon(st === 'done' ? 'check' : st === 'locked' ? 'lock' : l.key)}</span>
      <div><div class="t-name">${esc(l.short)}</div><div class="t-meta">${meta}</div></div></div>`;
  }).join('')}</nav>`;
}

function timerHtml(key) {
  const rem = remainingMs(key);
  const cls = !s.runningSince ? 'paused' : rem < 0 ? 'over' : rem < 5 * 60000 ? 'low' : '';
  const fill = Math.min(1, Math.max(0, elapsedMs(key) / (budgetMs(key) || 1)));
  return `<div class="clock lvl-${key}">
    <div class="clock-label">${esc(DEF[key].short)} ${s.runningSince ? 'left' : '· paused'}</div>
    <div class="timer ${cls}" data-role="timer">${rem < 0 ? '+' : ''}${clock(rem)}</div>
    <div class="meter" role="presentation"><i data-role="meter" style="--fill:${fill}"></i></div>
  </div>`;
}

/** Levels across the top with the level clock at the end. */
function playHeadHtml() {
  const lv = curLevel();
  return `<header class="play-head">${trackHtml()}${s.intro ? '' : timerHtml(lv.key)}</header>`;
}

function cardClockText(card) {
  const budget = cardBudgetMs(card), used = s.cardSpent[card.id] ?? 0;
  return { used, budget, over: used > budget, fill: Math.min(1, used / (budget || 1)) };
}
function cardClockHtml(card) {
  const c = cardClockText(card);
  return `<div class="story-clock${c.over ? ' over' : ''}" data-role="card-clock">
    <div class="sc-head"><span>This story</span><span class="sc-over" data-role="sc-over">${c.over ? `${clock(c.used - c.budget)} over` : ''}</span></div>
    <div class="sc-time"><b class="num" data-role="sc-used">${clock(c.used)}</b><span class="num">/ ${clock(c.budget)}</span></div>
    <div class="meter" role="presentation"><i data-role="sc-meter" style="--fill:${c.fill}"></i></div>
  </div>`;
}
/** Repaints the story clock in place (every tick). */
function paintCardClock(card) {
  const el = document.querySelector('[data-role="card-clock"]');
  if (!el) return;
  const c = cardClockText(card);
  el.classList.toggle('over', c.over);
  el.querySelector('[data-role="sc-used"]').textContent = clock(c.used);
  el.querySelector('[data-role="sc-over"]').textContent = c.over ? `${clock(c.used - c.budget)} over` : '';
  el.querySelector('[data-role="sc-meter"]').style.setProperty('--fill', c.fill);
}

function cardHeadHtml(card) {
  const labels = card.labels.map(l => `<span class="tag lbl">${esc(l)}</span>`).join('');
  return `<div class="card-meta">
      <a href="${BACKLOG_URL}/work_packages/${card.id}" target="_blank" rel="noopener">#${card.id} ↗</a>
      <span>${esc(card.type)}</span>
      <span class="num">${card.points == null ? 'no estimate' : `${pts(card.points)} pts`}</span>
      ${card.priority ? `<span class="tag">${esc(card.priority)}</span>` : ''}${labels}
    </div>
    <h2 class="card-title">${esc(card.subject)}</h2>`;
}

/** The story on the table: what it is and what it says, in the wide column. */
function storyMainHtml(card) {
  const lv = curLevel();
  const d = details.get(card.id);
  const dec = s.decisions[card.id];
  const decided = dec ? `<div class="decided ${dec.d === 'defer' ? 'defer' : 'plan'}">${dec.d === 'defer' ? `Deferred${dec.reason ? `: ${esc(dec.reason)}` : ''}` : `${icon('check', 14)} Planned`}</div>` : '';
  let body;
  if (!d || (d.loading && !d.wp)) body = '<p class="text2 story-wait" aria-busy="true">Loading the story…</p>';
  else if (!d.wp) body = `<p class="card-error">Couldn't load #${esc(card.id)}: ${esc(d.err?.message ?? 'request failed')}</p>
    <div><button data-act="detail-retry" data-id="${esc(card.id)}">Try again</button></div>`;
  else body = tabsHtml(card.id, d);
  return withBlobSrc(`<article class="panel story-main lvl-${lv.key}" aria-label="Story #${card.id}">
    ${cardHeadHtml(card)}
    ${decided}
    ${body}
  </article>`);
}

/** What to do with the story, how long it has, and its fields: the narrow column. */
function storySideHtml(card) {
  const lv = curLevel();
  const d = details.get(card.id);
  const dec = s.decisions[card.id];
  const ids = levelIds(lv.key).filter(x => cardById(x));
  const pos = ids.indexOf(card.id) + 1;
  const tray = rt.ui.mode === 'defer' ? `<div class="defer-row">
      <input class="ctrl" data-role="reason" placeholder="Why not this sprint? (optional)" aria-label="Reason to defer" />
      <button class="primary" data-act="defer-ok">Defer</button>
      <button class="ghost" data-act="cancel">Cancel</button></div>` : '';
  const actions = dec
    ? `<button class="big" data-act="reopen-cur">Mark not planned</button>
       ${dec.d === 'defer' ? '<button class="big" data-act="plan">Planned instead <kbd>P</kbd></button>' : '<button class="big" data-act="defer">Defer instead <kbd>D</kbd></button>'}`
    : `<button class="primary big" data-act="plan">Planned <kbd>P</kbd></button>
       <button class="big" data-act="defer">Defer <kbd>D</kbd></button>`;
  const rest = (() => { const i = ids.indexOf(card.id);
    return [...ids.slice(i + 1), ...ids.slice(0, i)].filter(x => !s.decisions[x]); })();
  return `<aside class="story-side" aria-label="Plan this story">
    <section class="panel side-box lvl-${lv.key}">
      ${cardClockHtml(card)}
      ${tray || `<div class="card-actions">${actions}</div>`}
      <nav class="card-nav" aria-label="Stories in this level">
        <button class="ghost" data-act="prev"${canStep(-1) ? '' : ' disabled'} aria-label="Previous story">← Prev</button>
        <span class="muted num card-pos">${pos} / ${ids.length}</span>
        <button class="ghost" data-act="skip"${canStep(1) ? '' : ' disabled'} aria-label="Next story">Next →</button>
      </nav>
    </section>
    ${d?.wp ? `<section class="panel side-box">${fieldsHtml(card.id, d)}</section>` : ''}
    ${sideHtml()}
    <div class="queue">${rest.length
      ? `Up next: ${rest.slice(0, 3).map(id => `<span class="num">#${id}</span>`).join(' · ')}${rest.length > 3 ? ` · +${rest.length - 3}` : ''}`
      : 'Last open story of this level.'}
      <button class="ghost" data-act="next">Move on to the next level</button></div>
  </aside>`;
}

function sideHtml() {
  const rows = new Map();   // name -> { id, n, p }
  const done = planned();
  for (const d of done) {
    const live = rt.cards.get(d.card.id) ?? d.card;
    const name = live.assigneeName || '';
    const r = rows.get(name) ?? { id: live.assigneeHref, n: 0, p: 0 };
    r.n++; r.p += d.card.points ?? 0; rows.set(name, r);
  }
  const total = [...rows.values()].reduce((t, r) => t + r.p, 0);
  const people = [...rows.entries()].sort((a, b) => b[1].p - a[1].p).map(([name, r]) => `
    <div class="who-row">${avatar(r.id, name)}<span class="nm">${name ? esc(name) : 'Unassigned'}</span><span class="num">${pts(r.p)}</span></div>`).join('');
  const recent = s.history.slice(-5).reverse().map(id => {
    const d = s.decisions[id];
    return d ? `<div>${d.d === 'defer' ? '→' : '✓'} #${id} ${esc(d.card.subject)}</div>` : '';
  }).join('');
  return `<aside class="panel side" aria-label="Planned">
    <h3><span>Planned</span><span class="num">${pts(total)} pts</span></h3>
    <div class="muted" style="font-size:var(--text-xs)">${done.length} stor${done.length === 1 ? 'y' : 'ies'}, by who has them now</div>
    ${people || '<div class="text2">Nothing planned yet.</div>'}
    ${recent ? `<div class="recent">${recent}</div>` : ''}
    ${s.history.length ? '<button class="ghost" data-act="undo">↶ Undo last <kbd>U</kbd></button>' : ''}
  </aside>`;
}

function stageHtml() {
  const lv = curLevel();
  if (s.intro) {
    const n = undecided(lv.key).length;
    const body = lv.isBreak
      ? `${mins(lv.key)} minutes. Stretch, refill${LEVELS[s.level + 1] ? `, come back for ${LEVELS[s.level + 1].short.toLowerCase()}` : ''}.`
      : `${n} stor${n === 1 ? 'y' : 'ies'} · ${mins(lv.key)} minutes${bankMs() ? ` · time bank ${signedClock(bankMs())}` : ''}`;
    return `<div class="panel moment lvl-${lv.key}">
      <span class="lvl-mark">${icon(lv.key, 22)}</span>
      <h2>${esc(lv.name)}</h2><p>${esc(lv.sub)} · ${body}</p>
      <button class="primary big" data-act="go">${lv.isBreak ? 'Start the break' : n ? 'Fight' : 'Nothing here, skip ahead'} <kbd>Enter</kbd></button></div>`;
  }
  const head = '';
  if (lv.isBreak) {
    const c = planned();
    return `<div class="panel moment lvl-break">
      <span class="lvl-mark">${icon('break', 22)}</span>
      <h2>${esc(lv.name)}</h2>
      <p>So far: <b class="num">${c.length}</b> stories and <b class="num">${pts(c.reduce((t, d) => t + (d.card.points ?? 0), 0))}</b> points planned.</p>
      <button class="primary big" data-act="next">Back to work <kbd>Enter</kbd></button></div>`;
  }
  const card = currentCard();
  if (!card) {
    const used = elapsedMs(lv.key), saved = budgetMs(lv.key) - used;
    return `${head}<div class="panel moment lvl-${lv.key}">
      <span class="lvl-mark">${icon('check', 22)}</span>
      <h2>${lv.key === 'goal' ? 'Boss defeated' : 'Level cleared'}</h2>
      <p>Done in <b class="num">${clock(used)}</b>${saved > 0 ? `, <b class="num">${clock(saved)}</b> goes to the time bank` : saved < 0 ? `, <b class="num">${clock(saved)}</b> over` : ''}.</p>
      <div class="card-actions" style="justify-content:center">
        ${levelIds(lv.key).some(x => cardById(x)) ? '<button class="big ghost" data-act="prev-last">← Back to the last story</button>' : ''}
        <button class="primary big" data-act="next">${s.level === LEVELS.length - 1 ? 'Open the loot' : 'Next level'} <kbd>Enter</kbd></button>
      </div></div>`;
  }
  return '';
}

function arenaHtml() {
  if (rt.loading && !rt.cards.size) return '<div class="panel empty">Dealing stories…</div>';
  const card = s.intro ? null : currentCard();
  const body = card
    ? `${storyMainHtml(card)}${storySideHtml(card)}`
    : `<section class="stage">${stageHtml()}</section><aside class="story-side">${sideHtml()}</aside>`;
  return `<div class="arena">${playHeadHtml()}<div class="story">${body}</div></div>`;
}

// ─── Render: view all ─────────────────────────────────────────────────────────

function stateOf(id) {
  const d = s.decisions[id];
  if (currentCard()?.id === id && !d) return { key: 'now', label: 'On the table' };
  if (d?.d === 'defer') return { key: 'defer', label: 'Deferred' };
  if (d) return { key: 'plan', label: 'Planned' };
  return { key: 'open', label: 'Not planned' };
}

function allHtml() {
  const f = rt.allFilter;
  const groups = PLAY_LEVELS.map(l => {
    const ids = levelIds(l.key).filter(id => cardById(id));
    const shown = ids.filter(id => f === 'all' || (f === 'done' ? s.decisions[id] : !s.decisions[id]));
    const done = ids.filter(id => s.decisions[id]).length;
    const rows = shown.map(id => {
      const c = rt.cards.get(id) ?? cardById(id), st = stateOf(id);
      return `<li><button class="all-row${rt.selected === id ? ' sel' : ''}" data-act="select" data-id="${esc(id)}"${rt.selected === id ? ' aria-current="true"' : ''}>
        <span class="chip ${st.key}">${st.key === 'plan' ? icon('check', 12) : ''}${esc(st.label)}</span>
        <span class="num muted">#${esc(id)}</span>
        <span class="a-subject">${esc(c.subject)}</span>
        <span class="a-meta">${c.priority ? `<span class="tag">${esc(c.priority)}</span>` : ''}<span class="num">${c.points == null ? '–' : pts(c.points)}</span>${avatar(c.assigneeHref, c.assigneeName)}</span>
      </button></li>`;
    }).join('');
    return `<section class="all-group lvl-${l.key}">
      <h3><span class="lvl-mark">${icon(l.key)}</span>${esc(l.short)} <span class="num muted">${done} / ${ids.length} planned</span></h3>
      ${rows ? `<ul>${rows}</ul>` : `<p class="muted all-empty">${ids.length ? 'Nothing in this filter.' : 'No stories.'}</p>`}
    </section>`;
  }).join('');
  const total = PLAY_LEVELS.flatMap(l => levelIds(l.key)).filter(id => cardById(id));
  const done = total.filter(id => s.decisions[id]).length;
  const sel = rt.selected && cardById(rt.selected);
  const st = sel && stateOf(rt.selected);
  const inPlay = sel && s.phase === 'play' && !s.intro && levelKeyOf(rt.selected) === curLevel()?.key && !s.decisions[rt.selected];
  const selHead = sel ? `<article class="card lvl-${levelKeyOf(rt.selected) ?? 'rest'}" aria-label="Story #${esc(rt.selected)}">
      ${cardHeadHtml(rt.cards.get(rt.selected) ?? sel)}
      <div class="text2">${esc(DEF[levelKeyOf(rt.selected)]?.short ?? '')} · ${esc(st.label)}${s.decisions[rt.selected]?.reason ? ` · ${esc(s.decisions[rt.selected].reason)}` : ''}</div>
      <div class="card-actions">
        ${s.decisions[rt.selected]
          ? '<button data-act="reopen">Mark not planned</button>'
          : `<button class="primary" data-act="plan-sel">Planned</button><button data-act="defer-sel">Defer</button>${inPlay && currentCard()?.id !== rt.selected ? '<button data-act="play-now">Put it on the table</button>' : ''}`}
      </div>
    </article>` : '';
  return `<div class="all">
    <section class="all-list-wrap">
      <div class="all-head">
        <h2>All stories <span class="num muted">${done} / ${total.length} planned</span></h2>
        <div class="seg" role="group" aria-label="Show">
          ${[['all', 'All'], ['open', 'Not planned'], ['done', 'Planned']].map(([k, label]) => `<button class="${f === k ? 'on' : ''}" data-act="filter" data-id="${k}" aria-pressed="${f === k}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="all-list" data-role="all-list">${groups}</div>
    </section>
    <section class="all-detail" data-role="all-detail" data-id="${esc(rt.selected ?? '')}">${sel ? selHead + detailHtml(rt.selected) : '<div class="panel empty">Pick a story to see it.</div>'}</section>
  </div>`;
}

// ─── Render: loot ─────────────────────────────────────────────────────────────

function lootData() {
  const levels = PLAY_LEVELS.map(l => {
    const ids = levelIds(l.key).filter(id => cardById(id));
    const planIds = ids.filter(id => s.decisions[id] && s.decisions[id].d !== 'defer');
    const defer = ids.filter(id => s.decisions[id]?.d === 'defer');
    return {
      l, total: ids.length, plan: planIds.length, defer: defer.length,
      open: ids.length - planIds.length - defer.length,
      pts: planIds.reduce((t, id) => t + (s.decisions[id].card.points ?? 0), 0),
      used: elapsedMs(l.key), budget: budgetMs(l.key),
    };
  });
  const people = new Map();
  for (const d of planned()) {
    const live = rt.cards.get(d.card.id) ?? d.card;
    const name = live.assigneeName || 'Unassigned';
    const r = people.get(name) ?? { id: live.assigneeHref, n: 0, p: 0 };
    r.n++; r.p += d.card.points ?? 0; people.set(name, r);
  }
  const badges = [];
  const played = levels.filter(x => x.used > 0);
  const fast = played.filter(x => x.total && x.open === 0 && x.budget - x.used >= 60000).sort((a, b) => (b.budget - b.used) - (a.budget - a.used))[0];
  if (fast) badges.push({ name: 'Speedrunner', note: `${fast.l.short} cleared with ${clock(fast.budget - fast.used)} to spare` });
  const goal = levels.find(x => x.l.key === 'goal');
  if (goal?.total && goal.plan === goal.total) badges.push({ name: 'Goal keeper', note: 'every goal story planned' });
  const slow = played.filter(x => x.total && x.used - x.budget >= 60000).sort((a, b) => (b.used - b.budget) - (a.used - a.budget))[0];
  if (slow) badges.push({ name: 'Overtime hero', note: `${slow.l.short} ran ${clock(slow.used - slow.budget)} over` });
  if (levels.every(x => x.open === 0) && levels.some(x => x.total)) badges.push({ name: 'Full clear', note: 'no story left unplanned' });
  return { levels, people, badges };
}

function lootHtml() {
  const { levels, people, badges } = lootData();
  const sum = k => levels.reduce((t, x) => t + x[k], 0);
  const total = sum('total'), plan = sum('plan'), defer = sum('defer'), open = sum('open');
  const decided = plan + defer;
  const used = levels.reduce((t, x) => t + x.used, 0) + elapsedMs('break');
  const pct = n => total ? `${(n / total) * 100}%` : '0%';
  const bar = (x, cls = '') => `<div class="split${cls}" role="img" aria-label="${x.plan} planned, ${x.defer} deferred, ${x.open} not planned">
      <i class="seg plan" style="width:${x.total ? (x.plan / x.total) * 100 : 0}%"></i><i class="seg defer" style="width:${x.total ? (x.defer / x.total) * 100 : 0}%"></i></div>`;

  const headline = !decided ? 'Nothing decided yet'
    : open ? `${esc(s.versionName)}: ${decided} of ${total} decided`
    : `${esc(s.versionName)} is planned`;
  const lead = !decided
    ? `All ${total} stories are still open. Go back to the arena to plan them, or start over with a fresh game.`
    : `${plan} planned (${pts(sum('pts'))} pts), ${defer} deferred${open ? `, ${open} still open` : ''}. ${clock(used)} at the table, time bank ${signedClock(bankMs())}.`;

  const levelRows = levels.filter(x => x.total).map(x => `<li class="wrap-row lvl-${x.l.key}">
      <span class="lvl-mark">${icon(x.l.key)}</span>
      <div class="wr-name"><b>${esc(x.l.short)}</b><span class="muted">${x.plan + x.defer} / ${x.total} decided${x.plan ? ` · ${pts(x.pts)} pts` : ''}</span></div>
      ${bar(x)}
      <span class="num muted wr-time" title="Time used of the level's timebox">${clock(x.used)} / ${clock(x.budget)}</span>
    </li>`).join('');

  const whoRows = [...people.entries()].sort((a, b) => b[1].p - a[1].p).map(([name, r]) => `<li class="who-row">
      ${avatar(r.id, name === 'Unassigned' ? '' : name)}<span class="nm">${esc(name)}</span><span class="num">${r.n} · ${pts(r.p)} pts</span></li>`).join('');

  const confirm = rt.confirmNew ? `<div class="new-confirm" role="group" aria-label="Start a new planning">
      <p>This clears the ${decided} decision${decided === 1 ? '' : 's'} made in this game. Nothing on OpenProject changes.</p>
      <div class="loot-actions"><button class="primary" data-act="new-go">Start new planning</button><button class="ghost" data-act="new-cancel">Keep this game</button></div>
    </div>` : '';

  return `<div class="wrap">
    <section class="wrap-main">
      <header class="wrap-head">
        <h2>${headline}</h2>
        <p class="text2">${lead}</p>
      </header>
      <div class="panel wrap-total">
        <div class="wt-legend">
          <span><i class="dot plan"></i>Planned <b class="num">${plan}</b></span>
          <span><i class="dot defer"></i>Deferred <b class="num">${defer}</b></span>
          <span><i class="dot open"></i>Not planned <b class="num">${open}</b></span>
          <span class="muted num wt-of">${total} stories</span>
        </div>
        ${bar({ plan, defer, open, total }, ' big')}
      </div>
      ${levelRows ? `<ul class="panel wrap-levels">${levelRows}</ul>` : ''}
      ${badges.length && decided ? `<div class="badges">${badges.map(b => `<span class="badge">${icon('loot', 14)} ${esc(b.name)} <small>${esc(b.note)}</small></span>`).join('')}</div>` : ''}
    </section>
    <aside class="wrap-side">
      <section class="panel side-box">
        <h3>Next</h3>
        ${decided
          ? `<button class="primary big" data-act="copy">Copy summary</button>
             <button class="big" data-act="all">Review all stories <kbd>V</kbd></button>
             ${open ? '<button class="big" data-act="back">Back to the arena</button>' : ''}`
          : `<button class="primary big" data-act="back">Back to the arena</button>
             <button class="big" data-act="all">Review all stories <kbd>V</kbd></button>`}
        <div class="new-planning">
          ${confirm || `<button class="big" data-act="new">↺ Start a new planning</button>
            <p class="muted">Clears this game's decisions and goes back to the lobby (same project and sprint). Nothing on OpenProject changes.</p>`}
        </div>
      </section>
      ${whoRows ? `<section class="panel side-box"><h3>Planned by person</h3><ul class="who-list">${whoRows}</ul></section>` : ''}
    </aside>
  </div>`;
}

function summaryMarkdown() {
  const { levels, people, badges } = lootData();
  const lines = [`## Sprint planning: ${s.versionName} (${s.projectName})`, ''];
  for (const x of levels) {
    lines.push(`### ${x.l.short}: ${x.plan} planned (${pts(x.pts)} pts), ${x.defer} deferred, ${x.open} not planned`);
    for (const id of levelIds(x.l.key)) {
      const d = s.decisions[id], c = rt.cards.get(id) ?? cardById(id);
      if (!c) continue;
      const tag = !d ? 'not planned' : d.d === 'defer' ? `deferred${d.reason ? `: ${d.reason}` : ''}` : `planned · ${c.assigneeName || 'unassigned'}`;
      lines.push(`- #${id} ${c.subject} (${c.points ?? '?'} pts) · ${tag}`);
    }
    lines.push('');
  }
  if (people.size) {
    lines.push('### By person');
    for (const [name, r] of [...people.entries()].sort((a, b) => b[1].p - a[1].p)) lines.push(`- ${name}: ${r.n} stories, ${pts(r.p)} pts`);
    lines.push('');
  }
  if (badges.length) lines.push(`Badges: ${badges.map(b => `${b.name} (${b.note})`).join(', ')}`);
  return lines.join('\n');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(msg, actionLabel, action) {
  $('toast-msg').textContent = msg;
  const btn = $('toast-action');
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel ?? '';
  btn.onclick = action ? () => action() : null;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}
function hideToast() { $('toast').classList.remove('show'); }

// ─── Events ───────────────────────────────────────────────────────────────────

async function onAction(act, el) {
  const card = currentCard();
  const sel = rt.selected ? cardById(rt.selected) : null;
  switch (act) {
    case 'start':    return startQuest();
    case 'up':       return moveLevel(el.dataset.key, -1);
    case 'down':     return moveLevel(el.dataset.key, +1);
    case 'order-reset': s.levelOrder = [...DEFAULT_ORDER]; applyOrder(); save(); return render();
    case 'go':       return startLevel();
    case 'next':     return nextLevel();
    case 'pause':    return togglePause();
    case 'keep':     s.overtimeOk[curLevel().key] = true; save(); return render();
    case 'plan':     return card && decide(card, 'plan');
    case 'defer':    return card && openDefer();
    case 'skip':     return card && step(+1);
    case 'prev':     return card && step(-1);
    case 'prev-last': { const ids = levelIds(curLevel().key).filter(x => cardById(x)); if (!ids.length) return;
      s.cursor[curLevel().key] = ids.at(-1); resume(); save(); return render(); }
    case 'reopen-cur': return card && reopen(card.id);
    case 'cancel':   rt.ui = { mode: null }; return render();
    case 'defer-ok': return card && decide(card, 'defer', { reason: document.querySelector('[data-role="reason"]')?.value.trim() ?? '' });
    case 'undo':     return undo();
    case 'all':      return toggleAll();
    case 'select':   if (rt.selected === el.dataset.id) return; rt.selected = el.dataset.id; return render();
    case 'filter':   rt.allFilter = el.dataset.id; return render();
    case 'plan-sel': return sel && decide(sel, 'plan');
    case 'defer-sel': return sel && decide(sel, 'defer');
    case 'reopen':   return rt.selected && reopen(rt.selected);
    case 'play-now': return rt.selected && playNow(rt.selected);
    case 'tab':
      rt.tab = el.dataset.tab;
      if (rt.tab === 'sub') { const id = detailId(); if (id) loadKidStatuses(id); }
      return render();
    case 'sub-create': return createSubtask(el.dataset.id);
    case 'detail-retry': details.delete(el.dataset.id); return render();
    case 'end':      return endGame();
    case 'back':     rt.view = null; s.phase = 'play'; s.level = Math.min(s.level, LEVELS.length - 1); save(); return render();
    case 'new':      return newGame();
    case 'new-go':   rt.confirmNew = true; return newGame();
    case 'new-cancel': rt.confirmNew = false; return render();
    case 'refresh':  return withLoading(async () => { rt.people = null; details.clear(); await loadCards(); save(); });
    case 'retry':    return withLoading(init);
    case 'copy':
      try { await navigator.clipboard.writeText(summaryMarkdown()); toast('Summary copied'); }
      catch { toast("Couldn't copy to the clipboard"); }
      return;
  }
}

document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (a && !a.disabled) onAction(a.dataset.act, a);
});

document.addEventListener('input', e => {
  if (e.target.dataset.role === 'sub-subject') rt.sub.draft = e.target.value;
});

// Arrow keys on a closed select change its value at once; writing on every
// change would move a story's status while someone only looks at the options.
const isWpSelect = t => t?.matches?.('select[data-field="status"], select[data-field="assignee"]');
function commitSelect(t) {
  if (!isWpSelect(t) || (t.value || '') === (t.dataset.orig || '')) return;
  const key = `${t.dataset.wp}:${t.dataset.field}`;
  if (rt.saving.has(key)) { t.value = t.dataset.orig; return; }
  t.dataset.orig = t.value;
  writeField(t.dataset.wp, t.dataset.field, t.value || null, t.dataset.parent || null);
}
let pickedWithPointer = null;
document.addEventListener('pointerdown', e => { pickedWithPointer = isWpSelect(e.target) ? e.target : null; });
document.addEventListener('focusout', e => { if (isWpSelect(e.target)) commitSelect(e.target); });

document.addEventListener('change', async e => {
  const t = e.target;
  if (isWpSelect(t)) {
    if (pickedWithPointer === t) commitSelect(t);
    return;   // keyboard: written on Enter or when focus leaves
  }
  if (t.dataset.field === 'sub-assignee') { rt.sub.assigneeHref = t.value || null; return; }
  if (t.dataset.role === 'sub-type') { rt.sub.typeHref = t.value || null; return; }
  if (t.dataset.budget) {
    s.budgets[t.dataset.budget] = Math.max(0, Math.min(60, Math.round(Number(t.value) || 0)));
    save(); render();
    return;
  }
  if (t.dataset.per) {
    s.perStory[t.dataset.per] = Math.max(0, Math.min(60, Math.round(Number(t.value) || 0)));
    save(); render();
    return;
  }
  if (t.dataset.set === 'project') {
    const p = rt.projects.find(x => String(x.id) === t.value);
    s.projectId = p ? String(p.id) : null;
    s.projectName = p?.name ?? '';
    s.order = {}; rt.people = null; rt.types = null; rt.cards = new Map(); details.clear();
    setVersion(null);
    save();
    await withLoading(async () => { await loadVersions(); guessVersion(); await loadCards(); save(); });
  } else if (t.dataset.set === 'version') {
    setVersion(rt.versions.find(v => String(v.id) === t.value) ?? null);
    s.order = {};
    save();
    await withLoading(async () => { await loadCards(); save(); });
  }
});

document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = e.target.matches('input, select, textarea');
  if (e.key === 'Escape' && rt.ui.mode) { e.preventDefault(); return onAction('cancel'); }
  if (e.key === 'Escape' && rt.view === 'all' && !typing) { e.preventDefault(); return toggleAll(); }
  if (typing) {
    if (e.key !== 'Enter') return;
    if (isWpSelect(e.target)) { e.preventDefault(); commitSelect(e.target); }
    else if (e.target.dataset.role === 'reason') { e.preventDefault(); onAction('defer-ok'); }
    else if (e.target.dataset.role === 'sub-subject') {
      e.preventDefault();
      const id = detailId();
      if (id) createSubtask(id);
    }
    return;
  }
  if (s.phase === 'lobby' || rt.sub.busy || rt.saving.size) return;
  const key = e.key.toLowerCase();
  if (key === 'v') { e.preventDefault(); return toggleAll(); }
  if (s.phase !== 'play' || rt.view === 'all') return;
  const lv = curLevel();
  if ((key === 'b' || e.key === 'ArrowLeft') && !s.intro && !lv.isBreak && !currentCard()) { e.preventDefault(); return onAction('prev-last'); }
  if (e.key === 'Enter' && !e.target.matches('button, a')) {
    if (s.intro) { e.preventDefault(); return startLevel(); }
    if (lv.isBreak || !currentCard()) { e.preventDefault(); return nextLevel(); }
  }
  if (e.key === ' ' && (!e.target.matches('button, a') || e.target.matches('[data-act="plan"], [data-act="defer"], [data-act="skip"], [data-act="prev"], [data-act="reopen-cur"]'))) {
    e.preventDefault(); return togglePause();
  }
  if (key === 'u') return undo();
  if (s.intro || lv.isBreak || rt.ui.mode || !currentCard()) return;
  if (key === 'p') { e.preventDefault(); onAction('plan'); }
  else if (key === 'd') { e.preventDefault(); onAction('defer'); }
  else if (key === 's' || key === 'n' || e.key === 'ArrowRight') { e.preventDefault(); onAction('skip'); }
  else if (key === 'b' || e.key === 'ArrowLeft') { e.preventDefault(); onAction('prev'); }
});

// The clock only repaints the timers; the rest of the page re-renders when the
// time-up banner has to appear.
let lastTick = Date.now(), ticks = 0;
setInterval(() => {
  const now = Date.now(), delta = now - lastTick;
  lastTick = now;
  if (s.phase !== 'play' || s.intro || !s.runningSince) return;
  const key = curLevel().key;
  const card = rt.view === 'all' ? null : currentCard();   // a story's clock runs while it's on the table
  if (card) {
    s.cardSpent[card.id] = (s.cardSpent[card.id] ?? 0) + delta;
    paintCardClock(card);
    if (++ticks % 10 === 0) save();
  }
  const t = document.querySelector('[data-role="timer"]');
  if (t) {
    const rem = remainingMs(key);
    t.textContent = `${rem < 0 ? '+' : ''}${clock(rem)}`;
    t.className = `timer ${rem < 0 ? 'over' : rem < 5 * 60000 ? 'low' : ''}`;
    document.querySelector('[data-role="meter"]')?.style.setProperty('--fill', Math.min(1, elapsedMs(key) / (budgetMs(key) || 1)));
  }
  const shouldShow = !curLevel().isBreak && !s.overtimeOk[key] && remainingMs(key) < 0 && !!currentCard();
  if (shouldShow !== rt.timeUp) renderBanner();
}, 500);

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function init() {
  const stored = (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY];
  if (stored?.v === 1) {
    const base = freshSession(stored);
    s = { ...base, ...stored, budgets: base.budgets, perStory: base.perStory };
    for (const d of Object.values(s.decisions)) if (d.d === 'commit') d.d = 'plan';   // sessions from before "Planned"
  }
  applyOrder();
  refreshMe().catch(() => { /* the rail shows the signed-out state */ });
  await loadProjects();
  if (s.projectId) {
    await loadVersions();
    if (s.phase === 'lobby') guessVersion();
    await loadCards();
    save();
  }
}

withLoading(init);
