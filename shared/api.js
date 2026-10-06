// api.js — OpenProject REST API client for Backlog Monitor
//
// Fetches projects, open sprint versions, and work packages using the
// browser's existing session cookies (credentials: 'include') — no API
// key required, same mechanism used by the backlog-summary-report extension.
//
// All exports are pure async functions; no side-effects at module load time.

'use strict';

import { getHost } from './config.js';

/** The configured backlog origin; throws NO_HOST before setup. */
async function base() {
  const host = await getHost();
  if (host) return host;
  const err = new Error('No backlog host set — open the extension setup page.');
  err.code = 'NO_HOST';
  throw err;
}

// ─── Core fetch ─────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const BASE = await base();
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { Accept: 'application/hal+json' },
  });

  if (res.status === 401 || res.status === 403) {
    const err = new Error('Not authenticated — please log in to the backlog.');
    err.code = 'NOT_AUTHENTICATED';
    throw err;
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

// ─── Projects ────────────────────────────────────────────────────────────────

/**
 * Returns all active projects the current user can access.
 * @returns {Promise<Array>}
 */
export async function fetchActiveProjects() {
  const filter = encodeURIComponent(
    JSON.stringify([{ active: { operator: '=', values: ['t'] } }])
  );
  const data = await apiFetch(`/api/v3/projects?pageSize=200&filters=${filter}`);
  return data._embedded?.elements ?? [];
}

// ─── Versions ────────────────────────────────────────────────────────────────

/**
 * Returns versions with status "open" for the given project.
 * @param {number|string} projectId
 * @returns {Promise<Array>}
 */
export async function fetchOpenVersions(projectId) {
  const data = await apiFetch(`/api/v3/projects/${projectId}/versions`);
  const all = data._embedded?.elements ?? [];
  return all.filter(v => v.status === 'open');
}

/**
 * Returns ALL versions for the given project regardless of status
 * (open, locked, closed).
 * @param {number|string} projectId
 * @returns {Promise<Array>}
 */
export async function fetchAllVersions(projectId) {
  const data = await apiFetch(`/api/v3/projects/${projectId}/versions`);
  return data._embedded?.elements ?? [];
}

// ─── Work packages ───────────────────────────────────────────────────────────

/**
 * Fetches all work packages belonging to the given version, paginating
 * automatically (OpenProject returns max 200 per page).
 * @param {number|string} projectId
 * @param {number|string} versionId
 * @returns {Promise<Array>}
 */
export async function fetchWorkPackagesByVersion(projectId, versionId) {
  return fetchProjectWorkPackages(projectId,
    [{ version_id: { operator: '=', values: [String(versionId)] } }]);
}

/**
 * Fetches every work package of a project matching OpenProject filters,
 * paginating automatically (OpenProject returns max 200 per page).
 * @param {number|string} projectId
 * @param {Array<Object>} filters  OpenProject filter objects
 * @returns {Promise<Array>}
 */
export async function fetchProjectWorkPackages(projectId, filters) {
  const filter = encodeURIComponent(JSON.stringify(filters));

  const items = [];
  let offset = 1;

  while (true) {
    const data = await apiFetch(
      `/api/v3/projects/${projectId}/work_packages?filters=${filter}&pageSize=200&offset=${offset}`
    );
    const elements = data._embedded?.elements ?? [];
    items.push(...elements);

    // Stop when we have everything or the page was short (last page).
    // OpenProject's `offset` is a 1-based page number, not an item index.
    if (items.length >= (data.total ?? 0) || elements.length < (data.pageSize ?? 200)) break;
    offset++;
  }

  return items;
}

/**
 * Fetches a single work package by id (regardless of which version it currently
 * belongs to).  Used to re-fetch stories that have LEFT a tracked version so their
 * activity can still be replayed.  Throws HTTP 404 if the WP was deleted.
 * @param {number|string} wpId
 * @returns {Promise<Object>}
 */
export async function fetchWorkPackage(wpId) {
  return apiFetch(`/api/v3/work_packages/${wpId}`);
}

// ─── Activities ──────────────────────────────────────────────────────────────

/**
 * Fetches the full activity feed for a single work package.
 * Activities arrive in ascending (oldest-first) order.
 * @param {number|string} wpId
 * @returns {Promise<Array>}
 */
export async function fetchWorkPackageActivities(wpId) {
  const data = await apiFetch(`/api/v3/work_packages/${wpId}/activities`);
  return data._embedded?.elements ?? [];
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/**
 * Changes a work package, re-reading lockVersion first so a stale copy can't
 * overwrite someone else's edit. OpenProject needs X-Requested-With for
 * session-cookie writes. Throws with OpenProject's own message when it refuses.
 * @param {number|string} wpId
 * @param {Object} changes  e.g. { _links: { version: { href }, assignee: { href: null } } }
 * @returns {Promise<Object>}  the saved work package
 */
export async function patchWorkPackage(wpId, changes) {
  const { lockVersion } = await apiFetch(`/api/v3/work_packages/${wpId}`);
  return apiWrite('PATCH', `/api/v3/work_packages/${wpId}`, { lockVersion, ...changes });
}

/** A JSON write with the session cookie; throws with OpenProject's own message when it refuses. */
async function apiWrite(method, path, body) {
  const BASE = await base();
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/hal+json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message ?? `HTTP ${res.status}`);
    if (res.status === 401) err.code = 'NOT_AUTHENTICATED';
    throw err;
  }
  return data;
}

/**
 * Creates a work package (e.g. a subtask: pass `_links.parent`).
 * @param {Object} body  { subject, _links: { project, type, parent?, assignee? } }
 * @returns {Promise<Object>}  the new work package
 */
export function createWorkPackage(body) {
  return apiWrite('POST', '/api/v3/work_packages', body);
}

/**
 * The statuses a work package may move to next (its workflow), read from its
 * edit form. A form POST validates only; it saves nothing.
 * @param {number|string} wpId
 * @returns {Promise<Array<{href:string, name:string}>>}
 */
export async function fetchAllowedStatuses(wpId) {
  const { lockVersion } = await apiFetch(`/api/v3/work_packages/${wpId}`);
  const form = await apiWrite('POST', `/api/v3/work_packages/${wpId}/form`, { lockVersion });
  const allowed = form?._embedded?.schema?.status?._embedded?.allowedValues
    ?? form?._embedded?.schema?.status?._links?.allowedValues ?? [];
  return allowed.map(v => ({ href: v._links?.self?.href ?? v.href, name: v.name ?? v.title ?? '' })).filter(v => v.href);
}

/**
 * The direct children (subtasks) of a work package, oldest first.
 * @param {number|string} wpId
 * @returns {Promise<Array>}  raw work packages
 */
export async function fetchChildWorkPackages(wpId) {
  const filters = encodeURIComponent(JSON.stringify([{ parent: { operator: '=', values: [String(wpId)] } }]));
  const sort = encodeURIComponent('[["id","asc"]]');
  const items = [];
  for (let offset = 1; ; offset++) {
    const data = await apiFetch(`/api/v3/work_packages?filters=${filters}&sortBy=${sort}&pageSize=200&offset=${offset}`);
    const page = data._embedded?.elements ?? [];
    items.push(...page);
    if (page.length < 200) break;
  }
  return items;
}

/**
 * A work package's relations (relates, blocks, precedes, duplicates…).
 * @param {number|string} wpId
 * @returns {Promise<Array>}  raw relation objects
 */
export async function fetchRelations(wpId) {
  const data = await apiFetch(`/api/v3/work_packages/${wpId}/relations?pageSize=200`);
  return data._embedded?.elements ?? [];
}

/**
 * A work package's attachments.
 * @param {number|string} wpId
 * @returns {Promise<Array<{id:string, name:string, size:number, type:string, created:string, author:string, href:string}>>}
 */
export async function fetchAttachments(wpId) {
  const data = await apiFetch(`/api/v3/work_packages/${wpId}/attachments`);
  return (data._embedded?.elements ?? []).map(a => ({
    id:      String(a.id),
    name:    a.fileName ?? `attachment ${a.id}`,
    size:    a.fileSize ?? 0,
    type:    a.contentType ?? '',
    created: a.createdAt ?? '',
    author:  a._links?.author?.title ?? '',
    href:    `/api/v3/attachments/${a.id}/content`,   // redirects to remote storage when attachments live there
  }));
}

/**
 * The work package types enabled in a project.
 * @param {number|string} projectId
 * @returns {Promise<Array<{href:string, name:string}>>}
 */
export async function fetchProjectTypes(projectId) {
  const data = await apiFetch(`/api/v3/projects/${projectId}/types`);
  return (data._embedded?.elements ?? [])
    .map(t => ({ href: t._links?.self?.href, name: t.name ?? '' }))
    .filter(t => t.href);
}

/**
 * Fetches a backlog file (attachment, inline image) as a Blob with the session
 * cookie, which an <img src> on an extension page wouldn't send.
 * @param {string} path  a backlog path such as /api/v3/attachments/1/content
 * @returns {Promise<Blob>}
 */
export async function fetchBacklogBlob(path) {
  const BASE = await base();
  const url = /^https?:\/\//.test(path) ? path : `${BASE}${path}`;
  if (!url.startsWith(`${BASE}/`)) throw new Error('not a backlog file');
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/**
 * Returns the users who can be assigned work packages in a project.
 * @param {number|string} projectId
 * @returns {Promise<Array<{href:string, id:string, name:string}>>}
 */
export async function fetchAvailableAssignees(projectId) {
  const data = await apiFetch(`/api/v3/projects/${projectId}/available_assignees?pageSize=500`);
  return (data._embedded?.elements ?? [])
    .map(u => ({ href: u._links?.self?.href, id: String(u.id ?? ''), name: u.name ?? '' }))
    .filter(u => u.href)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Groups work packages by status and sums story points per status.
 * Returns the same shape used by content.js and the CSV importer so
 * the viewer and storage layer need no changes.
 *
 * @param {Array} workPackages  Raw WP objects from the API
 * @returns {Array<{status:string, numOfStory:string, point:string}>}
 */
export function aggregateWorkPackages(workPackages) {
  /** @type {Map<string, {numOfStory:number, point:number}>} */
  const map = new Map();

  for (const wp of workPackages) {
    const status = wp._links?.status?.title ?? 'Unknown';
    const pts = typeof wp.storyPoints === 'number' ? wp.storyPoints : 0;

    if (!map.has(status)) map.set(status, { numOfStory: 0, point: 0 });
    const entry = map.get(status);
    entry.numOfStory += 1;
    entry.point += pts;
  }

  // Convert to array, stringify numbers to match the existing storage format
  return [...map.entries()].map(([status, { numOfStory, point }]) => ({
    status,
    numOfStory: String(numOfStory),
    point: String(point),
  }));
}

// ─── Time entries ────────────────────────────────────────────────────────────

/**
 * Parses an ISO-8601 duration ("PT7H30M", "P1DT2H") into decimal hours.
 * Days count as 24h, matching how OpenProject serialises long entries.
 * @param {string} iso
 * @returns {number}
 */
export function parseIsoHours(iso) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso ?? '');
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Number(d) * 24 + Number(h) + Number(min) / 60 + Number(s) / 3600;
}

/** Extracts the trailing numeric id from a HAL href ("/api/v3/users/42" → "42"). */
export function idFromHref(href) {
  return href?.split('/').pop() ?? '';
}

/**
 * Fetches every time entry logged between two dates (inclusive), paginating
 * automatically. An empty/null projectIds means "all projects".
 * @param {Array<number|string>|null} projectIds
 * @param {string} from  YYYY-MM-DD
 * @param {string} to    YYYY-MM-DD
 * @param {{user?: string}} [opts]  user id, or 'me' for the signed-in user
 * @returns {Promise<Array<{userId:string, userName:string, spentOn:string, hours:number}>>}
 */
export async function fetchTimeEntries(projectIds, from, to, { user } = {}) {
  const filters = [{ spentOn: { operator: '<>d', values: [from, to] } }];
  if (projectIds?.length) filters.push({ project: { operator: '=', values: projectIds.map(String) } });
  if (user)               filters.push({ user:    { operator: '=', values: [String(user)] } });
  const filter = encodeURIComponent(JSON.stringify(filters));

  const pageUrl = (offset) => `/api/v3/time_entries?filters=${filter}&pageSize=500&offset=${offset}`;
  const first = await apiFetch(pageUrl(1));
  const items = [...(first._embedded?.elements ?? [])];
  const pageSize = first.pageSize ?? 500;
  const pages = Math.ceil((first.total ?? 0) / pageSize);
  if (pages > 1) {
    // the first response gives the total, so the remaining pages can load together
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => apiFetch(pageUrl(i + 2))));
    for (const d of rest) items.push(...(d._embedded?.elements ?? []));
  }

  return items.map(te => {
    const wp = te._links?.workPackage ?? te._links?.entity;   // newer OpenProject renamed it to `entity`
    return {
      userId:   idFromHref(te._links?.user?.href),
      userName: te._links?.user?.title ?? '',
      spentOn:  te.spentOn,
      hours:    parseIsoHours(te.hours),
      wpId:     wp?.href ? idFromHref(wp.href) : '',
      wpTitle:  wp?.title ?? '',
      activity: te._links?.activity?.title ?? '',
      comment:  te.comment?.raw ?? '',
    };
  });
}

/**
 * Returns the signed-in user's id, or null if it can't be read.
 * @returns {Promise<string|null>}
 */
export async function fetchMyUserId() {
  try {
    const me = await apiFetch('/api/v3/users/me');
    return me.id != null ? String(me.id) : null;
  } catch {
    return null;
  }
}

/**
 * Returns the signed-in user's profile. Throws NOT_AUTHENTICATED when signed out.
 * @returns {Promise<{id:string, name:string, login:string|null, email:string|null}>}
 */
export async function fetchMe() {
  const me = await apiFetch('/api/v3/users/me');
  if (me.id == null || me._type === 'AnonymousUser') {
    const err = new Error('Not authenticated — please log in to the backlog.');
    err.code = 'NOT_AUTHENTICATED';
    throw err;
  }
  return { id: String(me.id), name: me.name ?? '', login: me.login ?? null, email: me.email ?? null };
}

/**
 * Returns the names of the projects the signed-in user has open work packages
 * assigned in, most relevant first: projects with work assigned in a version whose
 * name ends with `sprintName` come first, then by number of assigned packages.
 * Empty when nothing is assigned.
 * @param {string} sprintName e.g. "26.07.C"
 * @returns {Promise<string[]>}
 */
export async function fetchAssignedProjectNames(sprintName) {
  const filters = encodeURIComponent(JSON.stringify([
    { assignee: { operator: '=', values: ['me'] } },
    { status: { operator: 'o', values: [] } },
  ]));
  const data = await apiFetch(`/api/v3/work_packages?pageSize=200&filters=${filters}`);
  const score = new Map();
  for (const wp of data._embedded?.elements ?? []) {
    const project = wp._links?.project?.title;
    if (!project) continue;
    const inSprint = (wp._links?.version?.title ?? '').endsWith(` ${sprintName}`);
    score.set(project, (score.get(project) ?? 0) + (inSprint ? 1000 : 1));
  }
  return [...score].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/**
 * Returns the names of the projects the signed-in user is a member of.
 * @returns {Promise<string[]>}
 */
export async function fetchMyProjectNames() {
  const filter = encodeURIComponent(
    JSON.stringify([{ principal: { operator: '=', values: ['me'] } }])
  );
  const data = await apiFetch(`/api/v3/memberships?filters=${filter}&pageSize=200`);
  const names = (data._embedded?.elements ?? []).map(m => m._links?.project?.title).filter(Boolean);
  return [...new Set(names)];
}

/**
 * Returns the users who are members of a project (groups/placeholders excluded).
 * @param {number|string} projectId
 * @returns {Promise<Array<{id:string, name:string}>>}
 */
export async function fetchProjectMembers(projectId) {
  const filter = encodeURIComponent(
    JSON.stringify([{ project: { operator: '=', values: [String(projectId)] } }])
  );
  const data = await apiFetch(`/api/v3/memberships?filters=${filter}&pageSize=500`);
  return (data._embedded?.elements ?? [])
    .map(m => m._links?.principal)
    .filter(p => p?.href?.includes('/users/'))
    .map(p => ({ id: idFromHref(p.href), name: p.title ?? '' }));
}

/**
 * Returns a user's display name, or null if the user is hidden/deleted.
 * @param {number|string} userId
 * @returns {Promise<string|null>}
 */
export async function fetchUserName(userId) {
  try {
    const u = await apiFetch(`/api/v3/users/${userId}`);
    return u.name ?? null;
  } catch {
    return null;   // 403/404 here means hidden or deleted user, not a lost session
  }
}

/**
 * Fetches a user's avatar image as a Blob, or null when the user has none
 * (OpenProject answers 404 or a non-image in that case), or undefined when the
 * request failed transiently. Fetched rather than hot-linked so the session
 * cookie is sent from the extension page.
 * @param {number|string} userId
 * @returns {Promise<Blob|null|undefined>}
 */
export async function fetchUserAvatar(userId) {
  try {
    const BASE = await base();
    const res = await fetch(`${BASE}/api/v3/users/${userId}/avatar`, { credentials: 'include' });
    if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429) return undefined;
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
    return await res.blob();
  } catch {
    return undefined;   // transient failure: unknown, not "no avatar"
  }
}

// ─── Sprint calendar ─────────────────────────────────────────────────────────

// Sprints are a fixed company-wide calendar, not OpenProject versions (projects
// name and date their versions inconsistently, and some have none). Every
// sprint is 14 days, Friday → Thursday, anchored at 26.04.B = 2026-04-10 (the
// same anchor viewer.js uses). The name is YY.MM.<letter> of the month the
// sprint ENDS in, lettered A, B, C… in order: 09/25–10/08 is 26.10.A.
const SPRINT_ANCHOR = Date.UTC(2026, 3, 10);
const SPRINT_MS     = 14 * 86400000;

function sprintAt(idx) {
  const startMs = SPRINT_ANCHOR + idx * SPRINT_MS;
  const endMs   = startMs + SPRINT_MS - 86400000;
  const end     = new Date(endMs);
  const sameMonth = ms => new Date(ms).getUTCFullYear() === end.getUTCFullYear()
                       && new Date(ms).getUTCMonth()    === end.getUTCMonth();
  let letter = 0;
  while (sameMonth(endMs - (letter + 1) * SPRINT_MS)) letter++;
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate   = end.toISOString().slice(0, 10);
  const name = `${String(end.getUTCFullYear()).slice(-2)}.${String(end.getUTCMonth() + 1).padStart(2, '0')}.${String.fromCharCode(65 + letter)}`;
  return { key: `${startDate}|${endDate}`, name, startDate, endDate };
}

/**
 * Sprints around a date, newest first.
 * @param {string} today  YYYY-MM-DD
 * @param {{past?: number, future?: number}} [range]
 * @returns {Array<{key:string, name:string, startDate:string, endDate:string}>}
 */
export function sprintCalendar(today, { past = 12, future = 2 } = {}) {
  const [y, m, d] = today.split('-').map(Number);
  const current = Math.floor((Date.UTC(y, m - 1, d) - SPRINT_ANCHOR) / SPRINT_MS);
  const out = [];
  for (let i = current + future; i >= current - past; i--) out.push(sprintAt(i));
  return out;
}
