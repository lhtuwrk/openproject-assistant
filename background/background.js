// background.js — Backlog Monitor service worker
//
// Two independent jobs:
//
//  1. syncTracked()           — fires hourly and on startup.
//                               Fetches today's work-package state for every
//                               version the user has selected to track.
//
//  2. reconstructMissingDays() — fires just after midnight ICT and on startup.
//                               Walks each tracked version's activity feeds to
//                               lock every finished day at its end-of-day state
//                               (23:59:59 ICT) and to refresh today's live
//                               snapshot together with its burn detail.
//
// A day's progress runs from the start of the day to the end of the day in ICT,
// whatever the machine's timezone, so every install computes the same numbers.
//
// Tracked versions are stored in chrome.storage.local under __blm_tracked as
//   [{ projectId, versionId, versionName, projectName, startDate, endDate }]
//
// Sync status is written to __blm_sync_meta so the popup can show live state.

import {
  fetchWorkPackagesByVersion,
  fetchWorkPackageActivities,
  fetchWorkPackage,
  fetchVersion,
  aggregateWorkPackages,
} from '../shared/api.js';
import { setupReminder } from './reminder.js';
import { getHost, HOST_KEY, SETUP_URL } from '../shared/config.js';

'use strict';

const ALARM_SYNC        = 'blm-hourly-sync';
const ALARM_RECONSTRUCT = 'blm-midnight-reconstruct';
const META_KEY          = '__blm_sync_meta';
const TRACKED_KEY       = '__blm_tracked';
const MEMBERS_PREFIX    = '__blm_members__';
const FLOW_PREFIX       = '__blm_flow__';

// Master toggle for the burndown pipeline (popup "Sync burndown chart"). Defaults
// to OFF: on a fresh install we don't hit OpenProject or accumulate snapshots until
// the user explicitly opts in. Read at every job entry so live toggles take effect.
const CFG_SYNC_BURNDOWN = '__blm_sync_burndown';
async function burndownEnabled() {
  const s = await chrome.storage.local.get(CFG_SYNC_BURNDOWN);
  return s[CFG_SYNC_BURNDOWN] ?? true;
}

// ─── Date helpers ────────────────────────────────────────────────────────────

const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Today's date in ICT (UTC+7) as YYYY-MM-DD. */
function todayStr() {
  return new Date(Date.now() + ICT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms of the last moment of dateStr in ICT: the state a finished day is locked at. */
function endOfDayMs(dateStr) {
  return new Date(`${dateStr}T23:59:59.999+07:00`).getTime();
}

/** The calendar day before dateStr. */
function dayBefore(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** All dates from startDate to endDate inclusive as YYYY-MM-DD strings. */
function datesInRange(startDate, endDate) {
  const dates = [];
  const cur = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate   + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/** Milliseconds until 00:05 ICT tomorrow, just after the previous day has ended. */
function msUntilNextIctDay() {
  return endOfDayMs(todayStr()) + 1 + 5 * 60 * 1000 - Date.now();
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

// Key prefix for per-snapshot status-change detail (stored separately to keep core snapshots lean).
const DETAIL_PREFIX = '__blm_sc__';

/**
 * Writes a snapshot. The core key holds lightweight chart/table data.
 * statusChanges (burn-detail) are stored under a separate DETAIL_PREFIX key.
 *
 * Overwrite rules:
 *  'api'          – overwrites an existing 'api' snapshot (today stays live until the day ends).
 *  'reconstructed'– upgrades an 'api' snapshot to the accurate historical version.
 *  Either source  – never overwrites 'reconstructed' or 'csv'.
 * Returns true when the core snapshot was written.
 */
async function saveSnapshot(storageKey, versionName, statuses, source = 'api', meta = {}) {
  const { statusChanges, ...coreMeta } = meta;

  const stored   = await chrome.storage.local.get(storageKey);
  const existing = stored[storageKey];
  if (existing?.backlogVersion) {
    const existSrc = existing.source ?? 'api';
    if (existSrc === 'csv' || existSrc === 'reconstructed') return false;
    if (source === 'api'          && existSrc !== 'api') return false;
    if (source === 'reconstructed' && existSrc !== 'api') return false;
  }

  // Core snapshot — always small, loaded on every chart render
  await chrome.storage.local.set({ [storageKey]: { backlogVersion: versionName, statuses, source, ...coreMeta } });

  // Burn-detail — only loaded when user clicks a burned-badge.
  // We write the detail key whenever statusChanges is defined (including [] for "tracking ran,
  // nothing burned"). undefined means this is a live api snapshot that doesn't compute
  // status-changes — in that case leave any existing detail key untouched.
  const detailKey = DETAIL_PREFIX + storageKey;
  if (statusChanges !== undefined) {
    await chrome.storage.local.set({ [detailKey]: statusChanges });
  }

  return true;
}

async function getTracked() {
  const d = await chrome.storage.local.get(TRACKED_KEY);
  return d[TRACKED_KEY] ?? [];
}

/**
 * Takes a tracked version's start and end dates from OpenProject.  Entries tracked from
 * the drawer used to store the Monday after the planning Friday, which left the first
 * days without history.  Updates v in place and in storage; keeps it as is on failure.
 */
async function refreshVersionDates(v) {
  try {
    const { startDate = null, endDate = null } = await fetchVersion(v.versionId);
    if ((!startDate || startDate === v.startDate) && (!endDate || endDate === v.endDate)) return;
    // The old first day was built with no day before it, so its burn detail is empty: rebuild it
    const oldFirst = v.startDate && `${v.startDate}__${v.versionName}`;
    if (oldFirst && startDate && startDate !== v.startDate) {
      const snap = (await chrome.storage.local.get(oldFirst))[oldFirst];
      if (snap?.source !== 'csv') await chrome.storage.local.remove([oldFirst, DETAIL_PREFIX + oldFirst]);
    }
    v.startDate = startDate ?? v.startDate;
    v.endDate   = endDate   ?? v.endDate;
    const tracked = await getTracked();   // re-read: the list may have changed meanwhile
    await chrome.storage.local.set({ [TRACKED_KEY]: tracked.map(t =>
      t.versionId === v.versionId ? { ...t, startDate: v.startDate, endDate: v.endDate } : t) });
  } catch { /* offline or no access: keep the stored dates */ }
}

// ─── Membership ledger ─────────────────────────────────────────────────────────

/**
 * Maintains a per-version ledger of every story that has ever been a member.
 *
 *   current:  { [id]: {points, subject, type} }            — last seen while in the version
 *   departed: { [id]: {points, subject, type, leftAt} }    — last-known state before it left
 *
 * fetchWorkPackagesByVersion only returns CURRENT members, so a story that moves
 * out is otherwise invisible: its scope drop disappears and it can never be named.
 * Diffing the current fetch against the ledger lets us catch departures the moment
 * they happen.  A departed id reappearing moves it back to `current`.
 *
 * Caller must pass a NON-EMPTY currentWps — an empty fetch (auth glitch, transient
 * error) must not be mistaken for "every story left".
 *
 * @returns {number[]} ids that have left the version (so they can be re-fetched).
 */
async function updateMemberLedger(versionName, currentWps, dateStr) {
  const lkey   = MEMBERS_PREFIX + versionName;
  const ledger = (await chrome.storage.local.get(lkey))[lkey] ?? { current: {}, departed: {} };

  const seen       = new Set();
  const nextCurrent = {};
  for (const wp of currentWps) {
    seen.add(String(wp.id));
    nextCurrent[wp.id] = {
      points:  typeof wp.storyPoints === 'number' ? wp.storyPoints : 0,
      subject: wp.subject ?? '',
      type:    wp._links?.type?.title ?? '',
    };
    delete ledger.departed[wp.id];           // re-entered the version
  }

  // Anything previously a member but absent now has departed.
  for (const id of Object.keys(ledger.current)) {
    if (!seen.has(id)) ledger.departed[id] = { ...ledger.current[id], leftAt: dateStr };
  }

  ledger.current = nextCurrent;
  await chrome.storage.local.set({ [lkey]: ledger });
  return Object.keys(ledger.departed).map(Number);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const s = await chrome.storage.local.get('__blm_settings');
  return { excludeTypes: ['Task'], ...(s.__blm_settings ?? {}) };
}

/** Same signature the viewer uses to tell "statuses changed" from "nothing changed". */
function statusesSig(statuses) {
  return (statuses ?? []).map(x => `${x.status}:${x.numOfStory}:${x.point}`).sort().join('|');
}

// ─── One-time switch from cutoff times to end-of-day snapshots ───────────────
//
// Snapshots used to be locked at configurable cutoff times (09:30, 21:00, Monday
// 12:00…).  Days are now locked at 23:59:59 ICT, so the old api/reconstructed
// snapshots of tracked versions are dropped once and rebuilt from activity.
// CSV/JSON imports are kept: they can't be rebuilt.  v2: history also starts the day
// before the version, so the first day gets its burn detail; rebuild once more.

const SNAPSHOT_MODE_KEY = '__blm_snapshot_mode';
const SNAPSHOT_MODE     = 'end-of-day-v2';

async function migrateToEndOfDay() {
  if ((await chrome.storage.local.get(SNAPSHOT_MODE_KEY))[SNAPSHOT_MODE_KEY] === SNAPSHOT_MODE) return;
  const tracked = new Set((await getTracked()).map(v => v.versionName));
  const all     = await chrome.storage.local.get(null);
  const drop    = [];
  for (const [key, snap] of Object.entries(all)) {
    if (!/^\d{4}-\d{2}-\d{2}__/.test(key) || !tracked.has(versionOfSnapshotKey(key))) continue;
    if (snap?.source === 'csv' || snap?.source === 'json') continue;
    drop.push(key, DETAIL_PREFIX + key);
  }
  if (drop.length) await chrome.storage.local.remove(drop);
  await chrome.storage.local.set({ [SNAPSHOT_MODE_KEY]: SNAPSHOT_MODE });
  const { __blm_settings: cfg } = await chrome.storage.local.get('__blm_settings');
  if (cfg) {
    const { dailyCutoff, planningCutoff, mondayEnabled, mondayCutoff, ...rest } = cfg;
    await chrome.storage.local.set({ __blm_settings: rest });
  }
}

// ─── Job 1: sync today's snapshot ────────────────────────────────────────────

async function syncTracked() {
  if (!(await burndownEnabled())) return;
  const tracked  = await getTracked();
  const settings = await loadSettings();
  if (!tracked.length) return;

  await chrome.storage.local.set({
    [META_KEY]: { status: 'syncing', startedAt: new Date().toISOString() },
  });

  const today = todayStr();

  let saved = 0, skipped = 0, errors = 0;

  try {
    for (const v of tracked) {
      // Today stays live until it ends: overwrite the previous api snapshot so the
      // chart stays fresh.  saveSnapshot() protects csv/reconstructed automatically.
      const key      = `${today}__${v.versionName}`;
      const existing = (await chrome.storage.local.get(key))[key];
      if (existing?.backlogVersion && existing.source !== 'api') { skipped++; continue; }

      try {
        const wps      = (await fetchWorkPackagesByVersion(v.projectId, v.versionId)).filter(w => wpIncluded(w, settings));
        if (!wps.length) continue;
        await updateMemberLedger(v.versionName, wps, today);   // record membership for move-out tracking
        const statuses = aggregateWorkPackages(wps);
        if (await saveSnapshot(key, v.versionName, statuses, 'api')) {
          saved++;
          // This light sync doesn't replay activity, so a burn detail computed for an
          // older state of today no longer matches it: drop it, the chart falls back.
          if (statusesSig(existing?.statuses) !== statusesSig(statuses))
            await chrome.storage.local.remove(DETAIL_PREFIX + key);
        }
      } catch { errors++; }
    }

    await chrome.storage.local.set({
      [META_KEY]: { status: 'ok', lastSync: new Date().toISOString(), saved, skipped, errors },
    });
  } catch (err) {
    await chrome.storage.local.set({
      [META_KEY]: {
        status: 'error',
        error: err.code === 'NOT_AUTHENTICATED' ? 'not-authenticated' : err.message,
        lastSync: new Date().toISOString(),
      },
    });
  }
}

// ─── Job 2: reconstruct missing days from activities ─────────────────────────

// Activity detail regex patterns (OpenProject HAL+JSON format, case-insensitive)
const RE_STATUS_CHANGED  = /^Status\s+changed\s+from\s+(.+?)\s+to\s+/i;
const RE_STATUS_SET      = /^Status\s+set\s+to\s+/i;
const RE_POINTS_CHANGED  = /^Story\s+[Pp]oints?\s+changed\s+from\s+([\d.]+)\s+to\s+/i;
const RE_POINTS_SET      = /^Story\s+[Pp]oints?\s+set\s+to\s+/i;
const RE_VERSION_CHANGED = /^Version\s+changed\s+from\s+(.+?)\s+to\s+/i;
const RE_VERSION_SET     = /^Version\s+set\s+to\s+/i;

/** Returns true if the work package should be included given the settings. */
function wpIncluded(wp, settings) {
  const type = (wp._links?.type?.title ?? '').toLowerCase();
  return !(settings.excludeTypes ?? []).some(t => t.trim().toLowerCase() === type);
}

function normalizeVer(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Rolls back a WP to its full state at the end of targetDateStr (ICT), or now for today.
 * Returns { status, points, version } or null if the WP didn't exist yet.
 */
function wpRawStateAtDate(wp, activities, targetDateStr) {
  const cutoff = Math.min(endOfDayMs(targetDateStr), Date.now());

  if (new Date(wp.createdAt).getTime() > cutoff) return null;

  let status  = wp._links?.status?.title ?? 'Unknown';
  let points  = typeof wp.storyPoints === 'number' ? wp.storyPoints : 0;
  let version = normalizeVer(wp._links?.version?.title);

  for (let i = activities.length - 1; i >= 0; i--) {
    const act = activities[i];
    if (new Date(act.createdAt).getTime() <= cutoff) continue;
    for (const d of act.details ?? []) {
      const raw = (d.raw ?? '').trim();
      let m;
      if      ((m = RE_STATUS_CHANGED.exec(raw)))  { status  = m[1].trim(); }
      else if (RE_STATUS_SET.exec(raw))             { status  = 'Unknown'; }
      else if ((m = RE_POINTS_CHANGED.exec(raw)))  { points  = parseFloat(m[1]); }
      else if (RE_POINTS_SET.exec(raw))             { points  = 0; }
      else if ((m = RE_VERSION_CHANGED.exec(raw))) { version = normalizeVer(m[1].trim()); }
      else if (RE_VERSION_SET.exec(raw))            { version = ''; }
    }
  }

  return { status, points, version };
}

/**
 * Date (YYYY-MM-DD) the WP entered its CURRENT status, derived from its activity
 * feed (activities arrive oldest-first).  Falls back to createdAt when no status
 * change is recorded.  Used for Aging-WIP / cycle-time views.
 */
function statusEnteredDate(wp, activities) {
  let entered = (wp.createdAt ?? '').slice(0, 10);
  for (const act of activities) {
    for (const d of act.details ?? []) {
      const raw = (d.raw ?? '').trim();
      if (RE_STATUS_CHANGED.test(raw) || RE_STATUS_SET.test(raw)) {
        entered = (act.createdAt ?? '').slice(0, 10) || entered;
      }
    }
  }
  return entered;
}

/** Aggregates reconstructed WP states for a single date into the storage shape. */
function buildSnapshotFromStates(states) {
  const map = new Map();
  for (const { status, points } of states) {
    if (!map.has(status)) map.set(status, { numOfStory: 0, point: 0 });
    const e = map.get(status);
    e.numOfStory++;
    e.point += points;
  }
  return [...map.entries()].map(([status, { numOfStory, point }]) => ({
    status,
    numOfStory: String(numOfStory),
    point: String(point),
  }));
}

/** Fetch activities in small parallel batches to avoid hammering the server. */
async function batchFetchActivities(wpIds, batchSize = 10, onProgress) {
  const results = [];
  for (let i = 0; i < wpIds.length; i += batchSize) {
    const batch = await Promise.all(
      wpIds.slice(i, i + batchSize).map(id =>
        fetchWorkPackageActivities(id).catch(() => [])
      )
    );
    results.push(...batch);
    onProgress?.(Math.min(results.length, wpIds.length), wpIds.length);
  }
  return results;
}

async function reconstructMissingDays() {
  if (!(await burndownEnabled())) return;
  const tracked  = await getTracked();
  const settings = await loadSettings();
  if (!tracked.length) return;

  await chrome.storage.local.set({
    [META_KEY]: { status: 'syncing', startedAt: new Date().toISOString() },
  });

  const today = todayStr();
  let reconstructed = 0;

  for (const v of tracked) {
    await refreshVersionDates(v);
    if (!v.startDate) continue;

    // From the day before the start: the chart's first point is the state at the start
    // of the first day, i.e. the end of the day before
    const rangeEnd  = (v.endDate && v.endDate < today) ? v.endDate : today;
    const allDates  = datesInRange(dayBefore(v.startDate), rangeEnd);

    // Dates to rebuild: every finished day with no snapshot or only a live 'api' one
    // (it is locked at its end-of-day state), plus today, which is refreshed as a
    // live 'api' snapshot together with its burn detail.
    const all       = await chrome.storage.local.get(null);
    const missing   = allDates.filter(d => {
      const existing = all[`${d}__${v.versionName}`];
      return existing?.source !== 'reconstructed' && existing?.source !== 'csv';
    });
    if (!missing.length) continue;

    try {
      const current    = (await fetchWorkPackagesByVersion(v.projectId, v.versionId)).filter(w => wpIncluded(w, settings));
      if (!current.length) continue;

      // Fold in stories that have LEFT the version.  The by-version fetch only sees
      // current members, so a moved-out story's scope drop would vanish and it could
      // never be named.  The ledger remembers every id ever seen; we re-fetch the
      // departed ones individually (skipping any since deleted) so their activity is
      // replayed too — which restores the dip AND fills in the movedOut detail.
      const departedIds = await updateMemberLedger(v.versionName, current, today);
      const departed    = (await Promise.all(
        departedIds.map(id => fetchWorkPackage(id).catch(() => null))
      )).filter(w => w && wpIncluded(w, settings));
      const wps = [...current, ...departed];

      const activities = await batchFetchActivities(wps.map(w => w.id), 10, (done, total) => {
        chrome.storage.local.set({
          __blm_fetch_progress: { done, total, version: v.versionName },
        });
      });
      const normTarget = normalizeVer(v.versionName);

      // Flow record — CURRENT members only: status + when each entered its current
      // status, for the dashboard's Aging-WIP / cycle-time views.  activities[i] lines
      // up with wps[i], and current members are the first current.length entries.
      const flowStories = current.map((wp, i) => ({
        id:              wp.id,
        subject:         wp.subject ?? `#${wp.id}`,
        type:            wp._links?.type?.title ?? '',
        status:          wp._links?.status?.title ?? 'Unknown',
        points:          typeof wp.storyPoints === 'number' ? wp.storyPoints : 0,
        enteredStatusAt: statusEnteredDate(wp, activities[i] ?? []),
        createdAt:       (wp.createdAt ?? '').slice(0, 10),
      }));
      await chrome.storage.local.set({ [FLOW_PREFIX + v.versionName]: { asOf: today, stories: flowStories } });

      for (const date of missing) {
        const dateIdx = allDates.indexOf(date);
        const prevDate = dateIdx > 0 ? allDates[dateIdx - 1] : null;

        const states        = [];
        const movedOut      = [];
        const movedIn       = [];
        const pointsChanged = [];
        const statusChanges = [];   // WPs that changed status while staying in the version

        for (let i = 0; i < wps.length; i++) {
          const wp   = wps[i];
          const acts = activities[i] ?? [];

          const curr  = wpRawStateAtDate(wp, acts, date);
          const inNow = curr?.version === normTarget;
          if (inNow) states.push({ status: curr.status, points: curr.points });

          if (prevDate) {
            const prev   = wpRawStateAtDate(wp, acts, prevDate);
            const inPrev = prev?.version === normTarget;
            const label  = wp.subject ?? `#${wp.id}`;
            const wpType = wp._links?.type?.title ?? '';
            if (inPrev && !inNow && curr)
              movedOut.push({ id: wp.id, subject: label, points: prev.points, toVersion: curr.version || '', type: wpType });
            else if (!inPrev && inNow)
              movedIn.push({ id: wp.id, subject: label, points: curr.points, fromVersion: prev?.version || '', type: wpType });
            else if (inPrev && inNow && prev && Math.abs(curr.points - prev.points) > 0.001)
              pointsChanged.push({ id: wp.id, subject: label, from: prev.points, to: curr.points, type: wpType });
            // Track all status changes for WPs staying in the version (enables burn-detail)
            if (inPrev && inNow && prev && curr && prev.status !== curr.status)
              statusChanges.push({ id: wp.id, subject: label, points: curr.points, fromStatus: prev.status, toStatus: curr.status, type: wpType });
          }
        }
        if (!states.length) continue;

        const statuses = buildSnapshotFromStates(states);
        const key      = `${date}__${v.versionName}`;
        const meta     = {};
        if (movedOut.length)      meta.movedOut      = movedOut;
        if (movedIn.length)       meta.movedIn       = movedIn;
        if (pointsChanged.length) meta.pointsChanged = pointsChanged;
        // Always include statusChanges (even []) so the detail key is written and
        // showBurnedDetail can distinguish "tracking ran, nothing burned" from "never tracked".
        meta.statusChanges = statusChanges;
        // Today hasn't ended: it stays a live 'api' snapshot that later syncs may refresh
        const source   = date === today ? 'api' : 'reconstructed';
        if (await saveSnapshot(key, v.versionName, statuses, source, meta)) reconstructed++;
      }

    } catch {
      // Skip this version silently; next alarm will retry
    }
  }

  chrome.storage.local.remove('__blm_fetch_progress');
  return reconstructed;
}

// ─── Job 3: purge sprints older than 1 week past their endDate ───────────────
//
// A sprint's data (day snapshots + burn detail + member ledger + flow record) stays
// live for one week after the sprint's endDate so retros and late reviews can still
// use it.  After that, everything for that version is wiped and the version is
// removed from __blm_tracked so it disappears from the dashboard entirely.

const CLEANUP_GRACE_DAYS = 7;

/** Extracts the versionName suffix from a "<date>__<versionName>" key. */
function versionOfSnapshotKey(key) {
  const sep = key.indexOf('__');
  return sep < 0 ? null : key.slice(sep + 2);
}

async function cleanupExpiredSprints() {
  const tracked = await getTracked();
  const now     = Date.now();

  const expired = tracked.filter(v => {
    if (!v.endDate) return false;                  // no known end → never auto-purge
    const cutoff = new Date(v.endDate + 'T23:59:59Z').getTime()
                 + CLEANUP_GRACE_DAYS * 24 * 60 * 60 * 1000;
    return now > cutoff;
  });
  if (!expired.length) return 0;

  const expiredNames = new Set(expired.map(v => v.versionName));
  const all          = await chrome.storage.local.get(null);
  const toRemove     = [];

  for (const key of Object.keys(all)) {
    // Day-level snapshots and their burn-detail siblings both end in "__<versionName>"
    if (/^\d{4}-\d{2}-\d{2}__/.test(key) || key.startsWith(DETAIL_PREFIX)) {
      const ver = versionOfSnapshotKey(key.startsWith(DETAIL_PREFIX) ? key.slice(DETAIL_PREFIX.length) : key);
      if (ver && expiredNames.has(ver)) toRemove.push(key);
    }
    // Per-version aggregates
    if (key.startsWith(MEMBERS_PREFIX) && expiredNames.has(key.slice(MEMBERS_PREFIX.length))) toRemove.push(key);
    if (key.startsWith(FLOW_PREFIX)    && expiredNames.has(key.slice(FLOW_PREFIX.length)))    toRemove.push(key);
  }

  if (toRemove.length) await chrome.storage.local.remove(toRemove);

  // Untrack the expired versions so the dashboard stops listing them.
  const remaining = tracked.filter(v => !expiredNames.has(v.versionName));
  await chrome.storage.local.set({ [TRACKED_KEY]: remaining });

  console.log(`[BacklogMonitor] Cleaned up ${expired.length} sprint(s):`,
              [...expiredNames], `— removed ${toRemove.length} keys.`);
  return expired.length;
}

// ─── Backlog host scripts ─────────────────────────────────────────────────────
//
// The backlog host is the user's choice (pages/setup.html), so the scripts that
// run on it can't be listed in manifest.json; they're registered here for the
// configured origin and re-registered whenever it changes.

const HOST_SCRIPT_PREFIX = 'blm-host-';

let registering = Promise.resolve();   // calls overlap (startup, permission and storage events); run one at a time
const registerHostScripts = () => (registering = registering.then(doRegisterHostScripts, doRegisterHostScripts));

async function doRegisterHostScripts() {
  const old = await chrome.scripting.getRegisteredContentScripts();
  const ids = old.map(s => s.id).filter(id => id.startsWith(HOST_SCRIPT_PREFIX));
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });

  const host = await getHost();
  if (!host) return;
  const all = `${host}/*`;
  if (!(await chrome.permissions.contains({ origins: [all] }))) return;

  await chrome.scripting.registerContentScripts([
    { id: `${HOST_SCRIPT_PREFIX}content`, matches: [`${host}/projects/*/work_packages*`],
      js: ['content/content.js'], runAt: 'document_idle' },
    { id: `${HOST_SCRIPT_PREFIX}skin`, matches: [all],
      js: ['content/quotes.js', 'shared/wp-chips.js', 'content/jira-skin.js'], runAt: 'document_start' },
    { id: `${HOST_SCRIPT_PREFIX}relay`, matches: [all],
      js: ['content/progress-hook-relay.js'], runAt: 'document_start' },
    { id: `${HOST_SCRIPT_PREFIX}hook`, matches: [all],
      js: ['content/progress-hook.js'], runAt: 'document_start', world: 'MAIN' },
    { id: `${HOST_SCRIPT_PREFIX}ui2`, matches: [`${host}/work_packages*`, `${host}/projects/*/work_packages*`],
      css: ['content/ui2/tokens.css', 'content/ui2/base.css', 'content/ui2/list.css', 'content/ui2/detail.css'], js: ['content/ui2/ui2.js'], runAt: 'document_start' },
  ]);
  console.log('[BacklogMonitor] Content scripts registered for', host);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (HOST_KEY in changes) registerHostScripts();
  // UI 2.0 and Jira style are mutually exclusive: the one just turned on wins.
  if (changes.__blm_ui2?.newValue === true) chrome.storage.local.set({ __blm_jira_skin: false });
  else if (changes.__blm_jira_skin?.newValue === true) chrome.storage.local.set({ __blm_ui2: false });
});
chrome.permissions.onAdded.addListener(() => registerHostScripts());
chrome.permissions.onRemoved.addListener(() => registerHostScripts());

// ─── Alarm setup ──────────────────────────────────────────────────────────────

function setupAlarms() {
  chrome.alarms.create(ALARM_SYNC, { periodInMinutes: 60 });
  chrome.alarms.create(ALARM_RECONSTRUCT, {
    when: Date.now() + msUntilNextIctDay(),
    periodInMinutes: 1440,
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  setupAlarms();
  await registerHostScripts();
  if (!(await getHost())) chrome.tabs.create({ url: SETUP_URL });   // first run: pick the backlog host
  await cleanupExpiredSprints();  // drop long-expired sprints before doing any work
  await migrateToEndOfDay();       // once: drop snapshots locked at the old cutoff times
  await reconstructMissingDays(); // lock historical snapshots first
  syncTracked();                  // then live-sync today (always runs, never locked)
});

chrome.runtime.onStartup.addListener(async () => {
  await registerHostScripts();
  await cleanupExpiredSprints();  // once per browser session
  await migrateToEndOfDay();
  await reconstructMissingDays(); // lock historical snapshots
  syncTracked();                  // live-sync today
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_SYNC)        syncTracked();
  if (alarm.name === ALARM_RECONSTRUCT) {
    await cleanupExpiredSprints();      // daily purge, just after midnight ICT
    reconstructMissingDays();
  }
});

setupReminder();

// ─── Popup messages ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'sync-now') {
    sendResponse({ started: true });
    // Reconstruction refreshes today with its burn detail; live sync then covers versions without a start date
    reconstructMissingDays().then(() => syncTracked());
  }
});
