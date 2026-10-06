// timelog.js — Member × Day spent-time grid for a project + sprint date range.
//
// Reads time entries live from the OpenProject API (session cookies, no key).
// Member groups live in chrome.storage.sync so they follow the Chrome profile;
// they are project-agnostic lists of user ids.

import {
  fetchActiveProjects, fetchTimeEntries,
  fetchProjectMembers, fetchUserName, fetchUserAvatar, sprintCalendar, fetchMyUserId,
} from '../shared/api.js';

import { requireHost } from '../shared/config.js';
const BACKLOG_URL   = await requireHost();
const GROUPS_KEY    = '__blm_timelog_groups';   // sync:  [{ id, name, userIds:[] }]
const LAST_KEY      = '__blm_timelog_last';     // local: { projectIds, sprintKey, groupId }
const DEFAULT_PROJECT = 'creditutility';        // compared with spaces stripped, lower-cased
const DAILY_TARGET  = 8;
const OVER_TARGET   = 9;
const EPS           = 0.005;

const $ = id => document.getElementById(id);

const state = {
  projects:  [],
  projectIds: [],         // selected project ids (strings)
  sprints:   [],          // [{ key:'start|end', name, startDate, endDate }]
  members:   new Map(),   // projectId → Map(userId → name)
  userNames: new Map(),   // userId → name, from any source
  groups:    [],
  last:      {},
  entries:   [],
  sort:      { key: 'name', dir: 'ascending' },
  loadSeq:   0,
  meId:      null,        // signed-in user, highlighted in the grid
  editingId: null,        // group being edited in the drawer, null = new
};

// ─── Utils ────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function datesInRange(from, to) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d <= end && out.length < 370) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function dayOfWeek(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }
function isWeekend(dateStr) { const w = dayOfWeek(dateStr); return w === 0 || w === 6; }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function mmdd(dateStr)    { const [, m, d] = dateStr.split('-'); return `${m}/${d}`; }
function mmddyyyy(dateStr){ const [y, m, d] = dateStr.split('-'); return `${m}/${d}/${y}`; }
const fmtH = h => h.toFixed(2);

function nameFor(userId) { return state.userNames.get(userId) || `User #${userId}`; }

// ─── Avatars ──────────────────────────────────────────────────────────────────
// Rendered as an initials disc first, then swapped for the real image once it
// arrives. One fetch per user per page load; failures keep the initials.

const avatarCache = new Map();   // userId → Promise<string|null> (object URL)

function initials(name) {
  const parts = name.replace(/^User #/, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0], last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function avatarHue(userId) {
  let h = 0;
  for (const c of String(userId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Math.round((h * 137.508) % 360);   // golden-angle spread: neighbouring ids get distant hues
}

function avatarHtml(userId, name) {
  return `<span class="avatar" data-uid="${esc(userId)}" style="--hue:${avatarHue(userId)}" aria-hidden="true">${esc(initials(name))}</span>`;
}

function avatarUrl(userId) {
  if (!avatarCache.has(userId)) {
    avatarCache.set(userId, fetchUserAvatar(userId).then(b => {
      if (b === undefined) avatarCache.delete(userId);   // transient failure: try again next render
      return b ? URL.createObjectURL(b) : null;
    }));
  }
  return avatarCache.get(userId);
}

function hydrateAvatars(root) {
  root.querySelectorAll('.avatar[data-uid]:not(.has-img)').forEach(async el => {
    const url = await avatarUrl(el.dataset.uid);
    if (!url || !el.isConnected) return;
    el.style.backgroundImage = `url("${url}")`;
    el.classList.add('has-img');
  });
}

async function saveLast(patch) {
  state.last = { ...state.last, ...patch };
  await chrome.storage.local.set({ [LAST_KEY]: state.last });
}

// ─── Banner / toast ───────────────────────────────────────────────────────────

function showBanner(msg, actionLabel, onAction) {
  $('banner-msg').textContent = msg;
  const btn = $('banner-action');
  btn.textContent = actionLabel;
  btn.onclick = onAction;
  $('banner').classList.add('show');
}
function hideBanner() { $('banner').classList.remove('show'); }

function handleError(err, retry) {
  if (err?.code === 'NOT_AUTHENTICATED') {
    showBanner(`Session expired — sign in at ${new URL(BACKLOG_URL).host}, then Refresh.`, 'Open backlog',
      () => chrome.tabs.create({ url: BACKLOG_URL }));
  } else {
    showBanner(`Could not load data: ${err?.message ?? err}`, 'Retry', retry);
  }
}

let toastTimer = null;
function showToast(msg, actionLabel, onAction) {
  $('toast-msg').textContent = msg;
  const btn = $('toast-action');
  btn.textContent = actionLabel ?? '';
  btn.style.display = actionLabel ? '' : 'none';
  btn.onclick = () => { hideToast(); onAction?.(); };
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}
function hideToast() { $('toast').classList.remove('show'); }

// ─── Selectors ────────────────────────────────────────────────────────────────

function renderGroupSelect() {
  const sel = $('sel-group');
  const current = sel.value || state.last.groupId || '';
  sel.innerHTML = '<option value="">Everyone who logged</option>' +
    state.groups.map(g => `<option value="${esc(g.id)}">${esc(g.name)} (${g.userIds.length})</option>`).join('');
  sel.value = state.groups.some(g => g.id === current) ? current : '';
}

const projectName = id => state.projects.find(p => String(p.id) === id)?.name ?? `#${id}`;
const selectedProjectNames = () => state.projectIds.map(projectName);

function renderProjectButton() {
  const names = selectedProjectNames();
  const btn = $('btn-projects');
  btn.textContent = names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] ?? 'No project');
  btn.title = names.join(', ');
}

function renderProjectList() {
  const selected = new Set(state.projectIds);
  $('project-list').innerHTML = state.projects.map(p => `<label data-name="${esc(p.name.toLowerCase())}">
      <input type="checkbox" value="${p.id}" ${selected.has(String(p.id)) ? 'checked' : ''} /><span>${esc(p.name)}</span>
    </label>`).join('');
}

async function loadProjects() {
  state.projects = (await fetchActiveProjects()).sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set(state.projects.map(p => String(p.id)));
  const saved = (state.last.projectIds ?? []).map(String).filter(id => known.has(id));
  const fallback = state.projects.find(p => p.name.replace(/\s+/g, '').toLowerCase() === DEFAULT_PROJECT)
                ?? state.projects[0];
  state.projectIds = saved.length ? saved : (fallback ? [String(fallback.id)] : []);
  renderProjectButton();
  $('btn-projects').disabled = !state.projects.length;
}

function loadSprints() {
  const sel = $('sel-sprint');
  const today = localDateStr();
  state.sprints = sprintCalendar(today);

  const isCurrent = p => p.startDate <= today && today <= p.endDate;
  sel.innerHTML = '<option value="">Custom range</option>' +
    state.sprints.map(p => `<option value="${p.key}" class="${isCurrent(p) ? 'current' : ''}">${esc(p.name)} · ${mmdd(p.startDate)} – ${mmdd(p.endDate)}</option>`).join('');

  const pick = state.sprints.find(p => p.key === state.last.sprintKey)
            ?? state.sprints.find(isCurrent)
            ?? state.sprints[0];
  if (pick) {
    sel.value = pick.key;
    $('inp-from').value = pick.startDate;
    $('inp-to').value   = pick.endDate;
  } else if (!$('inp-from').value) {
    $('inp-from').value = today;
    $('inp-to').value   = today;
  }
  sel.disabled = false;
}

async function projectMembers(projectId) {
  if (!state.members.has(projectId)) {
    const list = await fetchProjectMembers(projectId);
    state.members.set(projectId, new Map(list.map(m => [m.id, m.name])));
    list.forEach(m => m.name && state.userNames.set(m.id, m.name));
  }
  return state.members.get(projectId);
}

/** Union of members across the selected projects: Map(userId → name). */
async function selectedMembers() {
  const maps = await Promise.all(state.projectIds.map(projectMembers));
  return new Map(maps.flatMap(m => [...m]));
}

function cachedSelectedMembers() {
  return new Map(state.projectIds.flatMap(id => [...(state.members.get(id) ?? [])]));
}

// ─── Load + render grid ───────────────────────────────────────────────────────

function renderSkeleton() {
  const wrap = $('grid-wrap');
  if (wrap.querySelector('table.ledger:not(.skel-table)')) { wrap.classList.add('loading'); return; }
  const cols = 10;
  const row = `<tr class="skel">${'<td></td>'.repeat(cols)}</tr>`;
  wrap.innerHTML = `<table class="ledger skel-table"><tbody>${row.repeat(6)}</tbody></table>`;
}

// Names of group members nobody has seen yet (not in project, no entries). Ids that
// could not be resolved (hidden/deleted users) are remembered so they are asked once.
const unresolvedNames = new Set();
async function resolveGroupNames() {
  const group = state.groups.find(g => g.id === $('sel-group').value);
  const unknown = (group?.userIds ?? []).filter(id => !state.userNames.has(id) && !unresolvedNames.has(id));
  if (!unknown.length) return;
  const names = await Promise.all(unknown.map(fetchUserName));
  unknown.forEach((id, i) => {
    if (names[i]) state.userNames.set(id, names[i]); else unresolvedNames.add(id);
  });
}

// A group only filters rows already loaded, so switching groups re-renders instead of refetching.
async function showGroup() {
  await resolveGroupNames();
  renderGrid();
}

async function load() {
  const seq = ++state.loadSeq;
  const from = $('inp-from').value, to = $('inp-to').value;
  if (!state.projectIds.length || !from || !to) return;
  if (from > to) { $('summary').textContent = 'The From date is after the To date.'; $('grid-wrap').innerHTML = ''; return; }

  hideBanner();
  renderSkeleton();
  $('btn-refresh').disabled = true;

  try {
    const [entries] = await Promise.all([
      fetchTimeEntries(state.projectIds, from, to),
      selectedMembers().catch(() => {}),   // member list is optional (403 when memberships are hidden)
    ]);
    if (seq !== state.loadSeq) return;
    entries.forEach(e => e.userName && state.userNames.set(e.userId, e.userName));
    state.entries = entries;

    await resolveGroupNames();
    if (seq !== state.loadSeq) return;
    renderGrid();
  } catch (err) {
    if (seq !== state.loadSeq) return;
    $('grid-wrap').innerHTML = '';
    $('summary').textContent = '';
    handleError(err, load);
  } finally {
    if (seq === state.loadSeq) {
      $('grid-wrap').classList.remove('loading');
      $('btn-refresh').disabled = false;
    }
  }
}

function renderGrid() {
  const from = $('inp-from').value, to = $('inp-to').value;
  const today = localDateStr();
  const group = state.groups.find(g => g.id === $('sel-group').value);
  const projectLabel = selectedProjectNames().join(', ');

  // hours[userId][date]
  const hours = new Map();
  for (const e of state.entries) {
    if (!hours.has(e.userId)) hours.set(e.userId, new Map());
    const m = hours.get(e.userId);
    m.set(e.spentOn, (m.get(e.spentOn) ?? 0) + e.hours);
  }

  const userIds = group ? [...new Set(group.userIds)] : [...hours.keys()];
  const hoursOf = (uid, d) => hours.get(uid)?.get(d) ?? 0;

  const days = datesInRange(from, to)
    .filter(d => !isWeekend(d) || userIds.some(uid => hoursOf(uid, d) > 0));
  const elapsedWeekdays = days.filter(d => !isWeekend(d) && d <= today).length;
  const expected = elapsedWeekdays * DAILY_TARGET;

  const rows = userIds.map(uid => {
    const total   = days.reduce((s, d) => s + hoursOf(uid, d), 0);
    const toDate  = days.filter(d => d <= today).reduce((s, d) => s + hoursOf(uid, d), 0);
    return { uid, name: nameFor(uid), total, toDate };
  });
  const { key, dir } = state.sort;
  const sign = dir === 'ascending' ? 1 : -1;
  rows.sort((a, b) => sign * (key === 'total' ? a.total - b.total : a.name.localeCompare(b.name)));

  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  const grandToDate = rows.reduce((s, r) => s + r.toDate, 0);
  const grandExpected = expected * rows.length;
  const workingDays = days.filter(d => !isWeekend(d)).length;

  $('summary').innerHTML = rows.length
    ? `<strong>${rows.length}</strong> member${rows.length === 1 ? '' : 's'} · ` +
      `<strong>${workingDays}</strong> working day${workingDays === 1 ? '' : 's'} · ` +
      `<strong>${fmtH(grandToDate)} h</strong> logged of <strong>${fmtH(grandExpected)} h</strong> expected to date`
    : '';

  const wrap = $('grid-wrap');
  wrap.classList.remove('loading');
  if (!rows.length) {
    wrap.innerHTML = `<div class="state-msg">${group
      ? `Group “${esc(group.name)}” has no members.`
      : `No time logged in ${esc(projectLabel)} between ${mmdd(from)} and ${mmdd(to)}.`}</div>`;
    return;
  }

  const ariaSort = k => state.sort.key === k ? state.sort.dir : 'none';
  const head = `<tr>
      <th class="name sortable" data-sort="name" tabindex="0" aria-sort="${ariaSort('name')}">Member</th>
      ${days.map((d, i) => `<th data-col="${i}" class="${isWeekend(d) ? 'wk' : ''} ${d === today ? 'today' : ''}" title="${mmddyyyy(d)}">
        <span class="dow">${DOW[dayOfWeek(d)]}</span>${mmdd(d)}</th>`).join('')}
      <th class="total sortable" data-sort="total" tabindex="0" aria-sort="${ariaSort('total')}">Total</th>
    </tr>`;

  const body = rows.map(r => `<tr class="${r.uid === state.meId ? 'me' : ''}">
      <th class="name" scope="row"><span class="who">${avatarHtml(r.uid, r.name)}${esc(r.name)}${r.uid === state.meId ? '<span class="you">You</span>' : ''}</span></th>
      ${days.map((d, i) => {
        const h = hoursOf(r.uid, d);
        const wk = isWeekend(d);
        let cls = wk ? 'wk' : '', txt = '';
        if (h > 0) {
          txt = fmtH(h);
          if (h >= OVER_TARGET - EPS)       cls += ' over';
          else if (h >= DAILY_TARGET - EPS) cls += ' met';
          else if (!wk)                     cls += ' under';
        } else if (!wk && d <= today) {
          cls += ' miss'; txt = '—';
        } else if (d > today) {
          cls += ' future';
        }
        return h > 0
          ? `<td data-col="${i}" data-uid="${esc(r.uid)}" data-day="${d}" class="${cls} has-log">${txt}</td>`
          : `<td data-col="${i}" class="${cls}" title="${esc(r.name)} · ${DOW[dayOfWeek(d)]} ${mmdd(d)} · 0.00 h">${txt}</td>`;
      }).join('')}
      <td class="total">${fmtH(r.total)}</td>
    </tr>`).join('');

  const foot = `<tr>
      <th class="name" scope="row">Total</th>
      ${days.map((d, i) => {
        const s = rows.reduce((acc, r) => acc + hoursOf(r.uid, d), 0);
        return `<td data-col="${i}" class="${isWeekend(d) ? 'wk' : ''}">${s > 0 ? fmtH(s) : ''}</td>`;
      }).join('')}
      <td class="total">${fmtH(grandTotal)}</td>
    </tr>`;

  clearTimeout(popShowT); pop.hidden = true; popKey = null;
  wrap.innerHTML = `<table class="ledger"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
  hydrateAvatars(wrap);
}

// Column crosshair + sorting (delegated; the table is re-rendered on every load).
$('grid-wrap').addEventListener('mouseover', e => {
  const cell = e.target.closest('td[data-col], th[data-col]');
  const col = cell?.dataset.col;
  $('grid-wrap').querySelectorAll('.col-hover').forEach(c => c.classList.remove('col-hover'));
  if (col != null) $('grid-wrap').querySelectorAll(`tbody td[data-col="${col}"]`).forEach(c => c.classList.add('col-hover'));
});
$('grid-wrap').addEventListener('mouseleave', () => {
  $('grid-wrap').querySelectorAll('.col-hover').forEach(c => c.classList.remove('col-hover'));
  schedulePopHide();
});

// ─── Cell detail popover: which stories the hours went to ─────────────────────
// Built from the time entries already loaded — no extra API calls. Opens after a
// short hover delay, stays open while the pointer is over it (links clickable).

const WP_URL = `${BACKLOG_URL}/work_packages/`;
const pop = $('cell-pop');
let popShowT = null, popHideT = null, popKey = null;

function showPop(cell) {
  if (!cell.isConnected) return;
  const { uid, day } = cell.dataset;
  const byWp = new Map();
  for (const e of state.entries) {
    if (e.userId !== uid || e.spentOn !== day) continue;
    const k = e.wpId || '—';
    if (!byWp.has(k)) byWp.set(k, { id: e.wpId, title: e.wpTitle, hours: 0, notes: [] });
    const w = byWp.get(k);
    w.hours += e.hours;
    const note = [e.activity, e.comment].filter(Boolean).join(' · ');
    if (note) w.notes.push(note);
  }
  const items = [...byWp.values()].sort((a, b) => b.hours - a.hours);
  const total = items.reduce((s, w) => s + w.hours, 0);

  pop.innerHTML = `
    <div class="pop-head"><span>${esc(nameFor(uid))} · ${DOW[dayOfWeek(day)]} ${mmdd(day)}</span><b>${fmtH(total)} h</b></div>
    ${items.map(w => `<div class="pop-row">
        <div class="pop-wp">${w.id ? `<a href="${WP_URL}${esc(w.id)}" target="_blank" rel="noopener">#${esc(w.id)}</a> ` : ''}${esc(w.title || 'No work package')}</div>
        <b>${fmtH(w.hours)}</b>
        ${w.notes.length ? `<div class="pop-note">${esc([...new Set(w.notes)].join(' / '))}</div>` : ''}
      </div>`).join('')}`;

  pop.hidden = false;
  popKey = `${uid}|${day}`;
  const r = cell.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), innerWidth - pw - 8);
  const below = r.bottom + 6 + ph <= innerHeight - 8;
  pop.style.left = `${left}px`;
  pop.style.top  = `${below ? r.bottom + 6 : Math.max(8, r.top - ph - 6)}px`;
}

function schedulePopShow(cell) {
  clearTimeout(popHideT);
  if (`${cell.dataset.uid}|${cell.dataset.day}` === popKey) return;
  clearTimeout(popShowT);
  popShowT = setTimeout(() => showPop(cell), 500);
}

function schedulePopHide() {
  clearTimeout(popShowT);
  clearTimeout(popHideT);
  popHideT = setTimeout(() => { pop.hidden = true; popKey = null; }, 200);
}

$('grid-wrap').addEventListener('mouseover', e => {
  const cell = e.target.closest('td.has-log');
  if (cell) schedulePopShow(cell); else schedulePopHide();
});
pop.addEventListener('mouseenter', () => clearTimeout(popHideT));
pop.addEventListener('mouseleave', schedulePopHide);
$('grid-wrap').addEventListener('scroll', () => { pop.hidden = true; popKey = null; });

function toggleSort(key) {
  const flip = { ascending: 'descending', descending: 'ascending' };
  const dir = state.sort.key === key ? flip[state.sort.dir] : (key === 'total' ? 'descending' : 'ascending');
  state.sort = { key, dir };
  renderGrid();
}
$('grid-wrap').addEventListener('click', e => {
  const th = e.target.closest('th[data-sort]');
  if (th) toggleSort(th.dataset.sort);
});
$('grid-wrap').addEventListener('keydown', e => {
  const th = e.target.closest('th[data-sort]');
  if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleSort(th.dataset.sort); }
});

// ─── Filter events ────────────────────────────────────────────────────────────

// Project picker: selection is applied when the popover closes, so ticking
// three projects triggers one reload, not three.
function openProjectPop() {
  renderProjectList();
  $('inp-project-search').value = '';
  $('project-pop').hidden = false;
  $('btn-projects').setAttribute('aria-expanded', 'true');
  $('inp-project-search').focus();
}

async function closeProjectPop() {
  if ($('project-pop').hidden) return;
  $('project-pop').hidden = true;
  $('btn-projects').setAttribute('aria-expanded', 'false');

  const picked = [...$('project-list').querySelectorAll('input:checked')].map(i => i.value);
  const next = picked.length ? picked : state.projectIds;   // never allow an empty selection
  if (next.join() === state.projectIds.join()) return;
  state.projectIds = next;
  renderProjectButton();
  await applyProjects();
}

// Sprints are a fixed calendar, so switching projects keeps the chosen range.
async function applyProjects() {
  await saveLast({ projectIds: state.projectIds });
  load();
}

$('btn-projects').addEventListener('click', () => {
  if ($('project-pop').hidden) openProjectPop(); else closeProjectPop();
});
$('inp-project-search').addEventListener('input', () => {
  const q = $('inp-project-search').value.trim().toLowerCase();
  $('project-list').querySelectorAll('label').forEach(l => { l.style.display = l.dataset.name.includes(q) ? '' : 'none'; });
});
document.addEventListener('click', e => {
  if (!e.target.closest('#project-picker')) closeProjectPop();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('project-pop').hidden) { closeProjectPop(); $('btn-projects').focus(); }
});

$('sel-sprint').addEventListener('change', async () => {
  const p = state.sprints.find(x => x.key === $('sel-sprint').value);
  if (p) { $('inp-from').value = p.startDate; $('inp-to').value = p.endDate; }
  await saveLast({ sprintKey: p ? p.key : null });
  load();
});

for (const id of ['inp-from', 'inp-to']) {
  $(id).addEventListener('change', () => {
    const p = state.sprints.find(x => x.key === $('sel-sprint').value);
    if (p && (p.startDate !== $('inp-from').value || p.endDate !== $('inp-to').value)) $('sel-sprint').value = '';
    load();
  });
}

$('sel-group').addEventListener('change', async () => {
  await saveLast({ groupId: $('sel-group').value || null });
  showGroup();
});

$('btn-refresh').addEventListener('click', () => {
  state.projectIds.forEach(id => state.members.delete(id));
  load();
});

// ─── Groups drawer ────────────────────────────────────────────────────────────

async function persistGroups(groups = state.groups) {
  await chrome.storage.sync.set({ [GROUPS_KEY]: groups });
}

function renderGroupList() {
  $('group-list').innerHTML =
    state.groups.map(g => `<button class="group-row" data-id="${esc(g.id)}" aria-current="${g.id === state.editingId}">
        <span>${esc(g.name)}</span><span class="cnt">${g.userIds.length}</span></button>`).join('') +
    `<button class="group-row new" data-id="" aria-current="${state.editingId === null}">+ New group</button>`;
}

function memberCandidates(group) {
  const projectMap = cachedSelectedMembers();
  const ids = new Set([...projectMap.keys(), ...state.entries.map(e => e.userId), ...(group?.userIds ?? [])]);
  return [...ids]
    .map(id => ({ id, name: nameFor(id), inProject: projectMap.has(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Refreshes the counter and the chip strip of selected members; the chips stay
 *  visible while the checklist is filtered, so the selection is never hidden. */
function updateMemberCount() {
  const checked = [...$('member-list').querySelectorAll('input:checked')];
  $('member-count').textContent = `${checked.length} selected`;
  $('member-chips').innerHTML = checked
    .map(i => ({ id: i.value, name: i.dataset.name }))
    .map(m => `<button type="button" class="chip" data-id="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">
        ${avatarHtml(m.id, m.name)}${esc(m.name)}<span class="x" aria-hidden="true">✕</span></button>`)
    .join('');
  hydrateAvatars($('member-chips'));
}

function openEditor(groupId) {
  state.editingId = groupId;
  const group = state.groups.find(g => g.id === groupId);
  const selected = new Set(group?.userIds ?? []);
  $('inp-group-name').value = group?.name ?? '';
  $('inp-member-search').value = '';
  $('editor-msg').textContent = '';
  $('btn-group-delete').disabled = !group;

  $('member-list').innerHTML = memberCandidates(group).map(m => `<label data-name="${esc(m.name.toLowerCase())}">
      <input type="checkbox" value="${esc(m.id)}" data-name="${esc(m.name)}" ${selected.has(m.id) ? 'checked' : ''} />
      ${avatarHtml(m.id, m.name)}<span>${esc(m.name)}</span>${m.inProject ? '' : '<span class="extra">not in project</span>'}
    </label>`).join('') || '<div class="state-msg">No members found for this project.</div>';

  updateMemberCount();
  hydrateAvatars($('member-list'));
  renderGroupList();
}

function openDrawer() {
  document.body.classList.add('drawer-open');
  const current = $('sel-group').value;
  openEditor(state.groups.some(g => g.id === current) ? current : null);
  $('inp-group-name').focus();
}
function closeDrawer() {
  document.body.classList.remove('drawer-open');
  $('btn-groups').focus();
}

$('btn-groups').addEventListener('click', async () => {
  try { await selectedMembers(); } catch { /* checklist falls back to entry users */ }
  openDrawer();
});
$('btn-drawer-close').addEventListener('click', closeDrawer);
$('drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) closeDrawer();
});

$('group-list').addEventListener('click', e => {
  const row = e.target.closest('.group-row');
  if (row) openEditor(row.dataset.id || null);
});

$('member-list').addEventListener('change', updateMemberCount);
$('member-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const box = [...$('member-list').querySelectorAll('input')].find(i => i.value === chip.dataset.id);
  if (box) box.checked = false;
  updateMemberCount();
});
$('inp-member-search').addEventListener('input', () => {
  const q = $('inp-member-search').value.trim().toLowerCase();
  $('member-list').querySelectorAll('label').forEach(l => { l.style.display = l.dataset.name.includes(q) ? '' : 'none'; });
});
$('btn-select-all').addEventListener('click', () => {
  $('member-list').querySelectorAll('label').forEach(l => { if (l.style.display !== 'none') l.querySelector('input').checked = true; });
  updateMemberCount();
});
$('btn-select-none').addEventListener('click', () => {
  $('member-list').querySelectorAll('label').forEach(l => { if (l.style.display !== 'none') l.querySelector('input').checked = false; });
  updateMemberCount();
});

$('btn-group-save').addEventListener('click', async () => {
  const name = $('inp-group-name').value.trim();
  const userIds = [...$('member-list').querySelectorAll('input:checked')].map(i => i.value);
  if (!name)           { $('editor-msg').textContent = 'Give the group a name.'; $('inp-group-name').focus(); return; }
  if (!userIds.length) { $('editor-msg').textContent = 'Select at least one member.'; return; }
  if (state.groups.some(g => g.id !== state.editingId && g.name.toLowerCase() === name.toLowerCase())) {
    $('editor-msg').textContent = 'A group with this name already exists.'; return;
  }

  const existing = state.groups.find(g => g.id === state.editingId);
  const group = existing ? { ...existing, name, userIds } : { id: crypto.randomUUID(), name, userIds };
  const next = existing ? state.groups.map(g => (g === existing ? group : g)) : [...state.groups, group];

  try { await persistGroups(next); }
  catch (err) { $('editor-msg').textContent = `Could not save: ${err.message}`; return; }
  state.groups = next;

  renderGroupSelect();
  $('sel-group').value = group.id;
  await saveLast({ groupId: group.id });
  closeDrawer();
  load();
});

$('btn-group-delete').addEventListener('click', async () => {
  const idx = state.groups.findIndex(g => g.id === state.editingId);
  if (idx < 0) return;
  const removed = state.groups[idx];
  const next = state.groups.filter((_, i) => i !== idx);
  try { await persistGroups(next); }
  catch (err) { showToast(`Could not delete: ${err.message}`); return; }
  state.groups = next;
  const wasSelected = $('sel-group').value === removed.id;
  renderGroupSelect();
  openEditor(null);
  if (wasSelected) { await saveLast({ groupId: null }); load(); }

  showToast(`Deleted “${removed.name}”`, 'Undo', async () => {
    const restored = [...state.groups];
    restored.splice(Math.min(idx, restored.length), 0, removed);
    try { await persistGroups(restored); }
    catch (err) { showToast(`Could not restore: ${err.message}`); return; }
    state.groups = restored;
    renderGroupSelect();
    if (document.body.classList.contains('drawer-open')) openEditor(removed.id);
    if (wasSelected) { $('sel-group').value = removed.id; await saveLast({ groupId: removed.id }); load(); }
  });
});

// Groups edited on another device/tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[GROUPS_KEY]) return;
  state.groups = changes[GROUPS_KEY].newValue ?? [];
  renderGroupSelect();
  if (document.body.classList.contains('drawer-open')) renderGroupList();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(GROUPS_KEY),
    chrome.storage.local.get(LAST_KEY),
  ]);
  state.groups = sync[GROUPS_KEY] ?? [];
  state.last   = local[LAST_KEY] ?? {};
  renderGroupSelect();
  loadSprints();
  fetchMyUserId().then(id => { state.meId = id; if (id && state.entries.length) renderGrid(); });

  try {
    await loadProjects();
  } catch (err) {
    handleError(err, init);
    return;
  }
  load();
}

init();
