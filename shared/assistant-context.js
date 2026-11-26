// assistant-context.js — the extra context the floating Claude assistant reads beyond the story or
// list itself: the sprint's burndown history (only this extension has it: background.js keeps a
// daily snapshot per tracked sprint), and a story's parent, relations and attachments.
// Everything here is read-only and plain text for the system prompt.

import { fetchRelations, fetchAttachments, fetchBacklogBlob, fetchTimeEntries, idFromHref } from './api.js';

const TRACKED_KEY = '__blm_tracked';
const DEFAULT_DONE = new Set(['resolved', 'closed', 'done', 'rejected']);   // as pages/viewer.js
const MAX_DAYS = 31;

/** Today in ICT (UTC+7), as background.js dates its snapshots. */
const ictToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

function daysBetween(start, end) {
  const out = [];
  for (const d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`) && out.length < MAX_DAYS; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The sprint's day-by-day burndown from this extension's snapshots, or '' when the sprint isn't
 * tracked here. versionName: the sprint (version) title as OpenProject shows it.
 */
export async function sprintBrief(versionName) {
  if (!versionName) return '';
  const tracked = (await chrome.storage.local.get(TRACKED_KEY))[TRACKED_KEY] ?? [];
  const v = tracked.find(t => t.versionName === versionName);
  if (!v?.startDate) return '';
  const today = ictToday();
  const last = v.endDate && v.endDate < today ? v.endDate : today;
  if (v.startDate > last) return `Sprint "${versionName}" starts ${v.startDate}; no burndown yet.`;
  const days = daysBetween(v.startDate, last);
  const snaps = await chrome.storage.local.get(days.map(d => `${d}__${versionName}`));
  const pts = s => Number(s.point) || 0;
  const lines = [];
  let latest = null, total0 = null;
  for (const d of days) {
    const snap = snaps[`${d}__${versionName}`];
    if (!snap?.statuses) continue;
    const open = snap.statuses.filter(s => !DEFAULT_DONE.has(String(s.status).toLowerCase()));
    const total = snap.statuses.reduce((a, s) => a + pts(s), 0);
    const left = open.reduce((a, s) => a + pts(s), 0);
    const stories = open.reduce((a, s) => a + (Number(s.numOfStory) || 0), 0);
    total0 ??= total;
    lines.push(`- ${d}: ${left} of ${total} pts left, ${stories} open item(s)`);
    latest = snap;
  }
  if (!latest) return `Sprint "${versionName}" is tracked by this extension but has no snapshots yet.`;
  const byStatus = latest.statuses.map(s => `${s.status} ${s.numOfStory} (${pts(s)} pts)`).join(', ');
  let ideal = '';
  if (v.endDate && total0 != null) {
    const span = daysBetween(v.startDate, v.endDate).length - 1;
    const gone = days.length - 1;
    if (span > 0) ideal = `\nIdeal straight line today: ${Math.max(0, Math.round(total0 * (1 - gone / span) * 10) / 10)} pts left (calendar days, weekends included).`;
  }
  return `Sprint "${versionName}" (${v.startDate} → ${v.endDate ?? '?'}), from this extension's daily burndown snapshots (story points; done = Resolved, Closed, Done, Rejected):
${lines.join('\n')}
Latest by status: ${byStatus}.${ideal}`;
}

const TEXT_TYPE = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|sql|javascript))/;
const TEXT_EXT = /\.(txt|md|csv|json|xml|ya?ml|log|sql|feature|html?)$/i;
const TEXT_MAX_BYTES = 200_000, TEXT_MAX_CHARS = 6000, TEXT_MAX_FILES = 3;

/** A story's parent, relations and attachments, with the text of up to three small text attachments.
 *  files: false leaves the attachments out (a story read in passing doesn't need them). */
export async function linksBrief(wpId, w, { files: withFiles = true } = {}) {
  const parts = [];
  const parent = w._links?.parent;
  if (parent?.href) parts.push(`Parent: #${idFromHref(parent.href)} ${parent.title ?? ''}`.trim());

  const relations = await fetchRelations(wpId).catch(() => null);
  if (relations?.length) {
    const rows = relations.map(r => {
      const fromId = idFromHref(r._links?.from?.href);
      const mine = String(fromId) === String(wpId);
      const other = mine ? r._links?.to : r._links?.from;
      const kind = (mine ? r.type : r.reverseType ?? r.type) ?? 'relates';
      return `- ${kind.replace(/_/g, ' ')} #${idFromHref(other?.href)} ${other?.title ?? ''}`.trimEnd();
    });
    parts.push(`Relations:\n${rows.join('\n')}`);
  }

  const files = withFiles ? await fetchAttachments(wpId).catch(() => null) : null;
  if (files?.length) {
    const readable = files.filter(f => f.size <= TEXT_MAX_BYTES && (TEXT_TYPE.test(f.type) || TEXT_EXT.test(f.name))).slice(0, TEXT_MAX_FILES);
    const texts = await Promise.all(readable.map(async f => {
      try {
        const text = (await (await fetchBacklogBlob(f.href)).text()).trim();
        const cut = text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}\n…(cut, ${text.length} chars in all)` : text;
        return `--- ${f.name} ---\n${cut}`;
      } catch { return `--- ${f.name} --- (couldn't be read)`; }
    }));
    const list = files.map(f => `- ${f.name} (${f.type || 'unknown type'}, ${Math.max(1, Math.round(f.size / 1024))} KB)${readable.includes(f) ? '' : ' — content not read'}`);
    parts.push(`Attachments:\n${list.join('\n')}${texts.length ? `\n\nText of the readable attachments:\n${texts.join('\n\n')}` : ''}`);
  }
  return parts.join('\n\n');
}

/** Hours the team logged in a tracked sprint, per person. '' / a note when the sprint isn't tracked here. */
export async function sprintTimeBrief(versionName) {
  const tracked = (await chrome.storage.local.get(TRACKED_KEY))[TRACKED_KEY] ?? [];
  const v = tracked.find(t => t.versionName === versionName);
  if (!v?.startDate) return `Sprint "${versionName}" isn't tracked by this extension, so its dates are unknown.`;
  const today = ictToday();
  const entries = await fetchTimeEntries([v.projectId], v.startDate, v.endDate && v.endDate < today ? v.endDate : today);
  return hoursBrief(`Hours logged in "${versionName}" (${v.startDate} → ${v.endDate ?? 'today'})`, entries);
}

/** Hours per person from time entries ({ userName, hours }). */
export function hoursBrief(title, entries) {
  if (!entries.length) return `${title}: nothing logged.`;
  const by = new Map();
  for (const e of entries) by.set(e.userName || 'Someone', (by.get(e.userName || 'Someone') ?? 0) + (e.hours || 0));
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  const rows = [...by].sort((a, b) => b[1] - a[1]).map(([n, h]) => `- ${n}: ${Math.round(h * 10) / 10} h`);
  return `${title}: ${Math.round(total * 10) / 10} h in all.\n${rows.join('\n')}`;
}

/** Open and finished story points per assignee, from work packages (a list's rows or a sprint's). */
export function workloadBrief(items) {
  const by = new Map();
  for (const w of items) {
    const who = w._links?.assignee?.title ?? 'Unassigned';
    const done = DEFAULT_DONE.has(String(w._links?.status?.title ?? '').toLowerCase());
    const e = by.get(who) ?? { open: 0, openN: 0, done: 0 };
    const pts = typeof w.storyPoints === 'number' ? w.storyPoints : 0;
    if (done) e.done += pts; else { e.open += pts; e.openN++; }
    by.set(who, e);
  }
  if (!by.size) return 'No work packages to total.';
  const rows = [...by].sort((a, b) => b[1].open - a[1].open)
    .map(([who, e]) => `- ${who}: ${e.open} pts open in ${e.openN} item(s), ${e.done} pts done`);
  return `Workload by person (story points; done = Resolved, Closed, Done, Rejected):\n${rows.join('\n')}`;
}

/** The sprint most rows of a list belong to, by version title. */
export function mainVersion(items) {
  const n = new Map();
  for (const w of items) { const t = w._links?.version?.title; if (t) n.set(t, (n.get(t) ?? 0) + 1); }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
