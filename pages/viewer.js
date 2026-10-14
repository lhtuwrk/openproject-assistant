// viewer.js — Backlog Monitor
import { fetchActiveProjects, fetchAllVersions, fetchMyProjectNames, fetchAssignedProjectNames } from '../shared/api.js';
import { requireHost } from '../shared/config.js';

const BACKLOG_URL = await requireHost();

'use strict';

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}__.+$/;
const DEFAULT_DONE     = new Set(['resolved', 'closed', 'done', 'rejected']);

// ─── Data helpers ─────────────────────────────────────────────────────────────

async function loadSnapshots(all) {
  all = all ?? await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => DATE_KEY_PATTERN.test(key))
    .map(([key, snap]) => ({ date: key.slice(0, key.indexOf('__')), ...snap }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.backlogVersion.localeCompare(b.backlogVersion));
}

const FLOW_PREFIX_KEY = '__blm_flow__';

/** Map<version, Map<date, {completedPts, completedCount, reopenedCount}>> from detail keys. */
function groupThroughput(all, donePrefixedKey) {
  const result = new Map();
  for (const [key, val] of Object.entries(all)) {
    if (!key.startsWith(donePrefixedKey) || !Array.isArray(val)) continue;
    const rest    = key.slice(donePrefixedKey.length);          // "<date>__<version>"
    const sep     = rest.indexOf('__');
    if (sep < 0) continue;
    const date    = rest.slice(0, sep);
    const version = rest.slice(sep + 2);
    if (!result.has(version)) result.set(version, new Map());
    let completedPts = 0, completedCount = 0, reopenedCount = 0;
    for (const sc of val) {
      const to   = (sc.toStatus   ?? '').toLowerCase();
      const from = (sc.fromStatus ?? '').toLowerCase();
      const toDone = DEFAULT_DONE.has(to), fromDone = DEFAULT_DONE.has(from);
      if (toDone && !fromDone) { completedPts += (sc.points ?? 0); completedCount++; }
      if (to === 'reopened' || (fromDone && !toDone)) reopenedCount++;
    }
    result.get(version).set(date, { completedPts, completedCount, reopenedCount });
  }
  return result;
}

/** Map<version, {asOf, stories[]}> from flow keys. */
function groupFlow(all) {
  const result = new Map();
  for (const [key, val] of Object.entries(all)) {
    if (key.startsWith(FLOW_PREFIX_KEY) && val && Array.isArray(val.stories))
      result.set(key.slice(FLOW_PREFIX_KEY.length), val);
  }
  return result;
}

/** Map<version, Map<date, statusChanges[]>> from detail keys. */
function groupDetail(all, prefix) {
  const result = new Map();
  for (const [key, val] of Object.entries(all)) {
    if (!key.startsWith(prefix) || !Array.isArray(val)) continue;
    const rest = key.slice(prefix.length);            // "<date>__<version>"
    const sep  = rest.indexOf('__');
    if (sep < 0) continue;
    const date = rest.slice(0, sep), version = rest.slice(sep + 2);
    if (!result.has(version)) result.set(version, new Map());
    result.get(version).set(date, val);
  }
  return result;
}

/**
 * Net burned (completed) vs reopened story points over a set of days, from statusChanges.
 * Counts ONLY real status transitions into/out of a done status — NOT scope that arrives
 * already-done (e.g. a story moved in already Resolved), which the aggregate Done-delta
 * would wrongly count as "burned".  Nets per story (first fromStatus → last toStatus).
 * hasDetail=false when any day lacks a detail key (caller falls back to the Done-delta).
 */
function netBurnedOverGap(detailMap, gapDays, done) {
  const doneL = new Set([...done].map(s => String(s).toLowerCase()));
  const recs = new Map();
  let hasDetail = true;
  for (const d of gapDays) {
    const changes = detailMap.get(d);
    if (changes === undefined) { hasDetail = false; continue; }
    for (const sc of changes) {
      const r = recs.get(sc.id);
      if (!r) recs.set(sc.id, { from: sc.fromStatus, to: sc.toStatus, points: sc.points ?? 0 });
      else { r.to = sc.toStatus; r.points = sc.points ?? r.points; }
    }
  }
  let burnedPts = 0, reopenedPts = 0;
  for (const r of recs.values()) {
    if (!r.from || !r.to || r.from === r.to) continue;
    const fromDone = doneL.has(r.from.toLowerCase());
    const toDone   = doneL.has(r.to.toLowerCase());
    if (!fromDone && toDone)      burnedPts   += (r.points ?? 0);
    else if (fromDone && !toDone) reopenedPts += (r.points ?? 0);
  }
  return { burnedPts, reopenedPts, hasDetail };
}

function groupByVersion(snapshots) {
  const result = new Map();
  for (const { date, backlogVersion, statuses } of snapshots) {
    if (!result.has(backlogVersion)) result.set(backlogVersion, new Map());
    result.get(backlogVersion).set(date, statuses);
  }
  return result;
}

/** Returns Map<version, Map<date, source>> where source is 'csv' or 'auto'. */
function groupSources(snapshots) {
  const result = new Map();
  for (const { date, backlogVersion, source } of snapshots) {
    if (!result.has(backlogVersion)) result.set(backlogVersion, new Map());
    result.get(backlogVersion).set(date, source || 'auto');
  }
  return result;
}

/** Returns Map<version, Map<date, { movedOut, movedIn }>> for dates that have move metadata. */
function groupMoves(snapshots) {
  const result = new Map();
  for (const { date, backlogVersion, movedOut, movedIn } of snapshots) {
    if (!movedOut?.length && !movedIn?.length) continue;
    if (!result.has(backlogVersion)) result.set(backlogVersion, new Map());
    result.get(backlogVersion).set(date, { movedOut: movedOut ?? [], movedIn: movedIn ?? [] });
  }
  return result;
}

function collectStatuses(dateMap) {
  const seen = new Set(), order = [];
  for (const statuses of dateMap.values())
    for (const { status } of statuses)
      if (!seen.has(status)) { seen.add(status); order.push(status); }
  return order;
}

// ─── Calendar helpers ─────────────────────────────────────────────────────────

function isWeekend(d) {
  const day = new Date(d + 'T12:00:00Z').getUTCDay();
  return day === 0 || day === 6; // 0 = Sunday, 6 = Saturday
}

function calendarRange(start, end) {
  const out = [];
  const cur  = new Date(start + 'T12:00:00Z');
  const last = new Date(end   + 'T12:00:00Z');
  while (cur <= last) { out.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return out;
}

function addDays(d, n) {
  const dt = new Date(d + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Today in ICT (UTC+7): the background locks each ICT day at its end, so the viewer counts days the same way. */
function todayStr() {
  return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
}

// ─── Change detection ─────────────────────────────────────────────────────────

/**
 * Compares two snapshots and returns a change descriptor.
 * @param {Array|null} prev  statuses array from previous snapshot, or null (baseline)
 * @param {Array}      curr  statuses array from current snapshot
 * @returns {{ type: string, label: string }}
 */
function computeChange(prev, curr) {
  if (!prev) return { type: 'baseline', label: 'Baseline' };

  const totalPts = arr => arr.reduce((s, x) => s + (parseFloat(x.point) || 0), 0);
  const toSig    = arr => arr.map(x => `${x.status}:${x.numOfStory}:${x.point}`).sort().join('|');

  if (toSig(prev) === toSig(curr)) return { type: 'no-change', label: 'No progress' };

  const diff = totalPts(curr) - totalPts(prev);
  const fmt  = v => Number.isInteger(v) ? String(v) : v.toFixed(1);

  if (diff >  0.001) return { type: 'scope-up',   label: `Scope +${fmt(diff)}pts` };
  if (diff < -0.001) return { type: 'scope-down',  label: `Scope −${fmt(-diff)}pts` };

  // Total scope unchanged but distribution shifted → items moved between statuses
  return { type: 'progress', label: 'Progress' };
}

// ─── Snapshot table ───────────────────────────────────────────────────────────

function buildTable(dateMap, start, end, onDeleteDate, sourcesMap = new Map(), movesMap = new Map()) {
  const dates       = [...dateMap.keys()].filter(d => d >= start && d <= end);
  const statusNames = collectStatuses(dateMap);
  const wrap        = document.createElement('div');

  if (!dates.length) {
    const msg = document.createElement('p');
    msg.style.cssText = 'color:var(--muted);font-size:13px;padding:12px 0';
    msg.textContent = 'No snapshots in the selected date range.';
    wrap.appendChild(msg); return wrap;
  }

  const lookup = new Map();
  for (const [date, statuses] of dateMap)
    for (const { status, numOfStory, point } of statuses) {
      if (!lookup.has(status)) lookup.set(status, new Map());
      lookup.get(status).set(date, { numOfStory, point });
    }

  const table = document.createElement('table');
  table.className = 'snapshot-table';

  // All sorted snapshot dates (full range, not just filtered) for prev-lookup
  const allDates = [...dateMap.keys()].sort();

  const thead = table.createTHead();

  // Row 1 — date labels + delete buttons
  const hrow = thead.insertRow();
  for (const lbl of ['Status', 'Metric']) {
    const th = document.createElement('th'); th.textContent = lbl; hrow.appendChild(th);
  }
  for (const d of dates) {
    const th = document.createElement('th');
    th.appendChild(document.createTextNode(d));
    if (sourcesMap.get(d) === 'csv') {
      const badge = document.createElement('span');
      badge.className = 'csv-badge'; badge.textContent = 'CSV';
      th.appendChild(badge);
    }
    const moves = movesMap.get(d);
    if (moves?.movedOut?.length) {
      const badge = document.createElement('span');
      badge.className = 'move-badge move-out';
      badge.textContent = `↗${moves.movedOut.length}`;
      badge.title = 'Moved out:\n' + moves.movedOut
        .map(m => `${m.subject}${m.points ? ` (${m.points}pt)` : ''}${m.toVersion ? ` → ${m.toVersion}` : ''}`)
        .join('\n');
      th.appendChild(badge);
    }
    if (moves?.movedIn?.length) {
      const badge = document.createElement('span');
      badge.className = 'move-badge move-in';
      badge.textContent = `↙${moves.movedIn.length}`;
      badge.title = 'Moved in:\n' + moves.movedIn
        .map(m => `${m.subject}${m.points ? ` (${m.points}pt)` : ''}${m.fromVersion ? ` ← ${m.fromVersion}` : ''}`)
        .join('\n');
      th.appendChild(badge);
    }
    const del = document.createElement('button');
    del.className = 'btn-delete-date'; del.textContent = '×'; del.title = `Delete snapshot for ${d}`;
    del.addEventListener('click', () => onDeleteDate(d));
    th.appendChild(del); hrow.appendChild(th);
  }

  // Row 2 — change indicators
  const crow = thead.insertRow(); crow.className = 'change-row';
  const thS = document.createElement('th'); crow.appendChild(thS);
  const thM = document.createElement('th'); crow.appendChild(thM);
  for (const d of dates) {
    const idx  = allDates.indexOf(d);
    const prev = idx > 0 ? dateMap.get(allDates[idx - 1]) : null;
    const { type, label } = computeChange(prev, dateMap.get(d));
    const th    = document.createElement('th');
    const badge = document.createElement('span');
    badge.className = `change-badge ${type}`; badge.textContent = label;
    th.appendChild(badge); crow.appendChild(th);
  }

  const tbody = table.createTBody();
  for (const name of statusNames) {
    const dl = lookup.get(name) ?? new Map();

    const sRow = tbody.insertRow(); sRow.className = 'row-stories';
    const tdN = document.createElement('td'); tdN.className = 'status-name'; tdN.textContent = name; tdN.rowSpan = 2;
    sRow.appendChild(tdN);
    const tdSL = document.createElement('td'); tdSL.className = 'metric-label'; tdSL.textContent = 'Stories';
    sRow.appendChild(tdSL);
    for (const d of dates) {
      const td = document.createElement('td'); td.className = 'value-cell';
      const v = dl.get(d)?.numOfStory ?? ''; td.textContent = v; if (!v) td.classList.add('empty');
      sRow.appendChild(td);
    }

    const pRow = tbody.insertRow(); pRow.className = 'row-points';
    const tdPL = document.createElement('td'); tdPL.className = 'metric-label'; tdPL.textContent = 'Points';
    pRow.appendChild(tdPL);
    for (const d of dates) {
      const td = document.createElement('td'); td.className = 'value-cell';
      const v = dl.get(d)?.point ?? ''; td.textContent = v; if (!v) td.classList.add('empty');
      pRow.appendChild(td);
    }
  }

  wrap.appendChild(table); return wrap;
}

// ─── Burndown chart ───────────────────────────────────────────────────────────

/** Returns a "nice" Y-axis step (1/2/5 × power-of-10) targeting ~6 grid lines. */
function niceStep(maxVal, ticks = 6) {
  if (maxVal <= 0) return 5;
  const raw  = maxVal / ticks;
  const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * mag;
}

// ─── Copy chart as image ──────────────────────────────────────────────────────

function legendItems(showDone) {
  const items = [
    { color: '#4c7dff', dash: false, dot: true,  label: 'Remaining' },
    { color: '#f38ba8', dash: true,  dot: false, label: 'Ideal'     },
  ];
  if (showDone) items.splice(1, 0, { color: '#a6e3a1', dash: false, dot: true, label: 'Done' });
  return items;
}

function drawLegendH(ctx, cx, cy, items) {
  ctx.save();
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  for (const { color, dash, dot, label } of items) {
    ctx.strokeStyle = color; ctx.lineWidth = dash ? 1.5 : 2;
    ctx.setLineDash(dash ? [5, 4] : []);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 22, cy); ctx.stroke();
    ctx.setLineDash([]);
    if (dot) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx + 11, cy, 3.5, 0, Math.PI * 2); ctx.fill(); }
    cx += 27;
    ctx.fillStyle = '#e6e7ea'; ctx.textAlign = 'left';
    ctx.fillText(label, cx, cy);
    cx += ctx.measureText(label).width + 18;
  }
  ctx.restore();
}

function legendWidth(ctx, items) {
  ctx.font = '11px -apple-system, sans-serif';
  return items.reduce((a, { label }) => a + 27 + ctx.measureText(label).width + 18, 0);
}

function buildCompositeCanvas(sections) {
  const dpr   = window.devicePixelRatio || 1;
  const pad   = 20;
  const topH  = 48;  // global header (legend + title)
  const secH  = 36;  // per-section title bar
  const gap   = 20;
  const footH = 28;

  const cw   = parseInt(sections[0].canvas.style.width)  || sections[0].canvas.width  / dpr;
  const ch   = parseInt(sections[0].canvas.style.height) || sections[0].canvas.height / dpr;
  const outW = cw + pad * 2;
  const outH = 3 + topH + (secH + ch + gap) * sections.length - gap + footH;

  const out = document.createElement('canvas');
  out.width  = outW * dpr;
  out.height = outH * dpr;
  const ctx  = out.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#111214'; ctx.fillRect(0, 0, outW, outH);
  ctx.fillStyle = '#4c7dff'; ctx.fillRect(0, 0, outW, 3);

  // Global header: title left, legend right (based on first section's Done state)
  const showDone = sections.some(s => s.showDone);
  const items    = legendItems(showDone);

  ctx.font = 'bold 13px -apple-system, sans-serif';
  ctx.fillStyle = '#e6e7ea'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText('Burndown Chart', pad, 3 + topH / 2);

  const lw = legendWidth(ctx, items);
  drawLegendH(ctx, outW - pad - lw, 3 + topH / 2, items);

  // Divider under global header
  ctx.strokeStyle = '#2a2c31'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, 3 + topH - 4); ctx.lineTo(outW - pad, 3 + topH - 4); ctx.stroke();

  let y = 3 + topH;
  for (const { version, canvas } of sections) {
    // Section version name
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = '#a0a3ab'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(version, pad, y + secH / 2);

    // Divider
    ctx.strokeStyle = '#26282d'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, y + secH - 2); ctx.lineTo(outW - pad, y + secH - 2); ctx.stroke();

    ctx.drawImage(canvas, pad, y + secH, cw, ch);
    y += secH + ch + gap;
  }

  const now = new Date();
  const stamp = now.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
    + ' ' + now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  ctx.font = '10px -apple-system, sans-serif'; ctx.fillStyle = '#5c6069';
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('Generated ' + stamp, pad, outH - 8);
  ctx.textAlign = 'right';
  ctx.fillText('Backlog Monitor', outW - pad, outH - 8);

  return out;
}

async function copyToClipboard(canvas) {
  const dataUrl = canvas.toDataURL('image/png');
  return new Promise((resolve, reject) => {
    canvas.toBlob(async blob => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        resolve(dataUrl);
      } catch (e) { reject(e); }
    }, 'image/png');
  });
}

async function copyChartImage(chartCanvas, version, showDone) {
  const out = buildCompositeCanvas([{ version, canvas: chartCanvas, showDone }]);
  return copyToClipboard(out);
}

async function copyAllChartsImage() {
  const sections = sectionCanvasGetters
    .map(({ version, getCanvas, isDoneShown }) => ({ version, canvas: getCanvas(), showDone: isDoneShown() }))
    .filter(({ canvas }) => canvas && canvas.style.display !== 'none');
  if (!sections.length) return null;
  const out = buildCompositeCanvas(sections);
  return copyToClipboard(out);
}

function getChartColors() {
  const light = document.documentElement.dataset.theme === 'light';
  return {
    bg:          light ? '#ffffff' : '#18191c',
    grid:        light ? '#e8e9ec' : '#26282d',
    axis:        light ? '#8a8e96' : '#5c6069',
    axes:        light ? '#c9cbd1' : '#3a3d44',
    label:       light ? '#16171a' : '#e6e7ea',
    muted:       light ? '#6e727b' : '#7a7e87',
    ideal:       light ? '#c0254a' : '#f38ba8',
    done:        light ? '#2a7a40' : '#a6e3a1',
    remain:      light ? '#2f5fe0' : '#4c7dff',
    todayBg:     light ? '#fffbeb' : '#2a2316',
    todayBorder: light ? '#ca8a04' : '#f9e2af',
    todayText:   light ? '#92400e' : '#f9e2af',
    // Day bands and the day strip (tokens.css --accent-bg, --surface2, --border)
    band:        light ? '#e8eefc' : '#18233f',
    bandHover:   light ? '#f2f5fd' : '#141b2c',
    cell:        light ? '#f0f1f3' : '#202226',
    cellBorder:  light ? '#e3e4e8' : '#26282d',
    burned:      light ? '#1f8a4c' : '#5ad08a',
    reopened:    light ? '#c0283f' : '#f2828f',
    // Status pill colors — darker/richer in light mode for contrast against pale canvas
    pillScopeUp:   light ? '#b01840' : '#f38ba8',
    pillScopeDown: light ? '#006888' : '#89dceb',
    pillNoProg:    light ? '#8a4800' : '#fab387',
    pillProgress:  light ? '#2a7a40' : '#a6e3a1',
    pillFillAlpha: light ? 0.14      : 0.22,
  };
}

/**
 * actual[]: { dayIndex, value, total, status, statusText, burned, live } — remaining (cobalt); dayIndex may be
 *           fractional for today's live point.  doneActual[]: { dayIndex, value } — done points (green).
 * cells[]:  { a, b, k, label, burned, scope, live, empty } — the day strip under the axis; cell k is the segment
 *           that ends at actual[k], so it spans the days of work between two points.
 * hover / selected: the k of the highlighted day.
 * Returns the hit regions in CSS pixels.
 */
function drawBurndownChart(canvas, { xDates, actual, doneActual, ideal, maxY, notSyncedToday = false, cells = [], hover = -1, selected = -1 }) {
  const C = getChartColors();
  const PLOT_H = 520, STRIP_H = cells.length ? 48 : 0;
  const W = Math.max(Math.min(canvas.parentElement.clientWidth || 800, 1400), 320), H = PLOT_H + STRIP_H, dpr = window.devicePixelRatio || 1;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  canvas.width = W*dpr; canvas.height = H*dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  const PAD = { top:28, right:24, bottom:48, left:56 };
  const CW = W-PAD.left-PAD.right, CH = PLOT_H-PAD.top-PAD.bottom;

  const rawMax = maxY > 0 ? maxY : 1;
  // A grid row about every 40px, so a change of a few points shows as a visible turn of the line.
  const step   = niceStep(rawMax, Math.max(6, Math.round(CH / 40)));
  const top    = Math.ceil(rawMax / step) * step || step;

  const n   = xDates.length;
  const xAt = i => PAD.left + (n < 2 ? CW/2 : CW*i/(n-1));
  const yAt = v => PAD.top  + CH*(1 - Math.max(0,v)/top);

  ctx.fillStyle = C.bg; ctx.fillRect(0,0,W,H);

  // ── Day bands: the hovered and the selected day's segment ──────────────────
  const band = (k, fill) => {
    const c = cells.find(c => c.k === k);
    if (c) { ctx.fillStyle = fill; ctx.fillRect(xAt(c.a), PAD.top, xAt(c.b) - xAt(c.a), CH); }
  };
  if (hover >= 0 && hover !== selected) band(hover, C.bandHover);
  if (selected >= 0) band(selected, C.band);

  // ── Y grid + labels ──────────────────────────────────────────────────────────
  for (let v = 0; v <= top + 0.001; v += step) {
    const y = yAt(v);
    ctx.strokeStyle=C.grid; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+CW,y); ctx.stroke();
    ctx.fillStyle=C.axis; ctx.font='11px -apple-system,sans-serif';
    ctx.textAlign='right'; ctx.textBaseline='middle';
    ctx.fillText(Number.isInteger(v) ? v : v.toFixed(1), PAD.left-8, y);
  }

  // ── X axis labels + ticks ────────────────────────────────────────────────────
  const xStep = Math.ceil(38 / (n>1 ? CW/(n-1) : CW));
  for (let i = 0; i < n; i++) {
    if (i % xStep !== 0 && i !== n-1) continue;
    ctx.fillStyle=C.axis; ctx.font='11px -apple-system,sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.fillText(xDates[i].slice(5), xAt(i), PAD.top+CH+10);
    ctx.strokeStyle=C.axes; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(xAt(i),PAD.top+CH); ctx.lineTo(xAt(i),PAD.top+CH+5); ctx.stroke();
  }
  ctx.strokeStyle=C.axes; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(PAD.left,PAD.top); ctx.lineTo(PAD.left,PAD.top+CH); ctx.lineTo(PAD.left+CW,PAD.top+CH); ctx.stroke();

  // ── Today marker ─────────────────────────────────────────────────────────────
  const todayIdx = xDates.indexOf(todayStr());
  if (todayIdx >= 0) {
    const tx = xAt(todayIdx);
    ctx.setLineDash([4,4]); ctx.strokeStyle=C.muted; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(tx, PAD.top); ctx.lineTo(tx, PAD.top+CH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle=C.muted; ctx.font='10px -apple-system,sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.fillText('Today', tx, PAD.top+CH+28);
    if (notSyncedToday) {
      const label = '⚠ Not synced today';
      ctx.font = 'bold 11px -apple-system,sans-serif';
      const tw = ctx.measureText(label).width;
      const bpad=7, bh=20, bw=tw+bpad*2;
      const bx=Math.min(tx-bw/2, W-bw-4), by=PAD.top+6;
      ctx.fillStyle=C.todayBg; ctx.beginPath(); ctx.roundRect(bx,by,bw,bh,4); ctx.fill();
      ctx.strokeStyle=C.todayBorder+'66'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.roundRect(bx,by,bw,bh,4); ctx.stroke();
      ctx.fillStyle=C.todayText; ctx.textAlign='left'; ctx.textBaseline='middle';
      ctx.fillText(label, bx+bpad, by+bh/2);
    }
  }

  // ── Ideal line ───────────────────────────────────────────────────────────────
  if (ideal.length >= 2) {
    ctx.setLineDash([7,5]); ctx.strokeStyle=C.ideal; ctx.lineWidth=1.8;
    ctx.beginPath(); ideal.forEach((v,i) => i===0 ? ctx.moveTo(xAt(i),yAt(v)) : ctx.lineTo(xAt(i),yAt(v)));
    ctx.stroke(); ctx.setLineDash([]);
  }

  const fmt = v => Number.isInteger(v) ? String(v) : v.toFixed(1);

  // ── Done line ─────────────────────────────────────────────────────────────────
  if (doneActual && doneActual.length >= 1) {
    ctx.strokeStyle=C.done; ctx.lineWidth=2; ctx.lineJoin='round';
    ctx.beginPath();
    doneActual.forEach((p,i) => i===0 ? ctx.moveTo(xAt(p.dayIndex),yAt(p.value)) : ctx.lineTo(xAt(p.dayIndex),yAt(p.value)));
    ctx.stroke();
    doneActual.forEach(p => {
      const x=xAt(p.dayIndex), y=yAt(p.value);
      ctx.fillStyle=C.done; ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill();
      ctx.fillStyle=C.done; ctx.font='bold 10px -apple-system,sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='top';
      ctx.fillText(fmt(p.value), x, y+7);
    });
  }

  // ── Remaining line ───────────────────────────────────────────────────────────
  const pills = [];
  if (actual.length >= 1) {
    const STATUS_COLOR = { 'scope-up': C.pillScopeUp, 'scope-down': C.pillScopeDown, 'progress': C.pillProgress };

    // Scope and ⇄ pills describe the segment that ends at a point, so they sit below that segment's
    // midpoint; burned points live in the day strip.
    ctx.font = 'bold 9px -apple-system,sans-serif';
    const pillRects = actual.map((p, k) => {
      if (k === 0 || !STATUS_COLOR[p.status] || !p.statusText) return null;
      const a = actual[k - 1];
      const mx = (xAt(a.dayIndex) + xAt(p.dayIndex)) / 2, my = (yAt(a.value) + yAt(p.value)) / 2;
      const pw = ctx.measureText(p.statusText).width + 12, ph = 15;
      return { rx: mx - pw / 2, rectY: my + 10, pw, ph, color: STATUS_COLOR[p.status], text: p.statusText, k };
    });
    for (let i = 1; i < pillRects.length; i++) {
      const a = pillRects[i - 1], b = pillRects[i];
      if (a && b && a.rx + a.pw + 3 > b.rx) b.rectY = Math.max(b.rectY, a.rectY + a.ph + 3);
    }

    // Solid through finished days, dashed into today's live point
    ctx.strokeStyle=C.remain; ctx.lineWidth=2.5; ctx.lineJoin='round';
    const locked = actual.filter(p => !p.live);
    ctx.beginPath(); locked.forEach((p,i) => i===0 ? ctx.moveTo(xAt(p.dayIndex),yAt(p.value)) : ctx.lineTo(xAt(p.dayIndex),yAt(p.value)));
    ctx.stroke();
    const live = actual[actual.length - 1];
    if (live?.live && locked.length) {
      const from = locked[locked.length - 1];
      ctx.setLineDash([5,4]);
      ctx.beginPath(); ctx.moveTo(xAt(from.dayIndex), yAt(from.value)); ctx.lineTo(xAt(live.dayIndex), yAt(live.value)); ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const p of actual) {
      const x = xAt(p.dayIndex), y = yAt(p.value);
      if (p.live) {
        ctx.fillStyle=C.bg; ctx.strokeStyle=C.remain; ctx.lineWidth=2;
        ctx.beginPath(); ctx.arc(x,y,4.5,0,Math.PI*2); ctx.fill(); ctx.stroke();
      } else {
        ctx.fillStyle=C.remain; ctx.beginPath(); ctx.arc(x,y,4.5,0,Math.PI*2); ctx.fill();
      }
      if (p.live) {
        // Right of the dot: it sits close to today's locked point, whose labels are centred
        ctx.font='bold 11px -apple-system,sans-serif';
        ctx.fillStyle=C.label; ctx.textAlign='left'; ctx.textBaseline='middle';
        ctx.fillText(fmt(p.value), x + 9, y);
        const vw = ctx.measureText(fmt(p.value)).width;
        ctx.fillStyle=C.muted; ctx.font='9px -apple-system,sans-serif';
        ctx.fillText('now', x + 13 + vw, y);
        continue;
      }
      const nearTop = p.value > top * 0.82;
      const dir  = nearTop ? 1 : -1;
      const base = nearTop ? 'top' : 'bottom';
      const vOff = nearTop ? y+9 : y-9;
      ctx.font='bold 11px -apple-system,sans-serif';
      ctx.fillStyle=C.label; ctx.textAlign='center'; ctx.textBaseline=base;
      ctx.fillText(fmt(p.value), x, vOff);
      ctx.fillStyle=C.muted; ctx.font='9px -apple-system,sans-serif';
      ctx.fillText(`/ ${fmt(p.total)}`, x, vOff+dir*14);
    }

    for (const pr of pillRects) {
      if (!pr) continue;
      const { rx, rectY, pw, ph, color, text } = pr;
      ctx.globalAlpha = C.pillFillAlpha; ctx.fillStyle = color;
      ctx.beginPath(); ctx.roundRect(rx, rectY, pw, ph, 4); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.roundRect(rx, rectY, pw, ph, 4); ctx.stroke();
      ctx.fillStyle = color; ctx.font = 'bold 9px -apple-system,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, rx + pw / 2, rectY + ph / 2);
      pills.push({ x0: rx, x1: rx + pw, y0: rectY, y1: rectY + ph, k: pr.k });
    }
  }

  // ── Day strip: one cell per day of work, under its segment ───────────────────
  const strip = [];
  if (STRIP_H) {
    const y0 = PLOT_H + 2, h = 38;
    for (const c of cells) {
      const x0 = xAt(c.a) + 2, w = Math.max(xAt(c.b) - xAt(c.a) - 4, 6);
      const sel = c.k === selected, hov = c.k === hover;
      ctx.beginPath(); ctx.roundRect(x0, y0, w, h, 4);
      if (c.empty) {
        ctx.setLineDash([3,3]); ctx.strokeStyle = C.axes; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      } else {
        ctx.fillStyle = sel ? C.band : hov ? C.bandHover : C.cell; ctx.fill();
        ctx.strokeStyle = sel ? C.remain : C.cellBorder; ctx.lineWidth = sel ? 1.5 : 1; ctx.stroke();
      }
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
      ctx.font = '10px -apple-system,sans-serif'; ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(c.label, x0 + 6, y0 + 5);
      if (!c.empty) {
        ctx.font = 'bold 11px ui-monospace, Consolas, monospace'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
        const b = c.burned ?? 0;
        if (Math.abs(b) > 0.001) { ctx.fillStyle = b > 0 ? C.burned : C.reopened; ctx.fillText(`${b > 0 ? '−' : '+'}${fmt(Math.abs(b))}`, x0 + 6, y0 + h - 5); }
        else { ctx.fillStyle = C.muted; ctx.fillText('—', x0 + 6, y0 + h - 5); }
        if (c.scope) {
          ctx.fillStyle = c.scope > 0 ? C.pillScopeUp : C.pillScopeDown; ctx.textAlign = 'right';
          ctx.fillText(`${c.scope > 0 ? '+' : '−'}${fmt(Math.abs(c.scope))}`, x0 + w - 6, y0 + h - 5);
        }
        strip.push({ x0, x1: x0 + w, y0, y1: y0 + h, k: c.k });
      }
      ctx.restore();
    }
  }

  return {
    plot:  { x0: PAD.left, x1: PAD.left + CW, y0: PAD.top, y1: PAD.top + CH },
    bands: cells.filter(c => !c.empty).map(c => ({ x0: xAt(c.a), x1: xAt(c.b), k: c.k })),
    strip, pills,
  };
}

// ─── Burndown section ─────────────────────────────────────────────────────────

/** Weekdays (Mon–Fri) from a to b inclusive. */
function weekdaysBetween(a, b) {
  return a > b ? 0 : calendarRange(a, b).filter(d => !isWeekend(d)).length;
}

/** Strip label for the days a segment covers: "Tue 13" or "Fri–Sun". */
function cellLabel(days) {
  const wd = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' });
  return days.length > 1 ? `${wd(days[0])}–${wd(days[days.length - 1])}` : `${wd(days[0])} ${days[0].slice(8)}`;
}

/** Closes any open chart menu when the click lands outside it (one listener for every section). */
document.addEventListener('click', e => {
  for (const m of document.querySelectorAll('details.chart-menu[open]')) if (!m.contains(e.target)) m.removeAttribute('open');
});

const HIDE_FIRST_DAY_KEY = '__blm_hide_first_day';

/** The open day and tab per version, so a re-render (new data for today) keeps the detail open. */
const daySelection = new Map();

function buildBurndownSection(version, dateMap, detailRecord = new Map(), hideFirstDay = false, versionStart = null) {
  const snapDates = [...dateMap.keys()].sort();
  const allStats  = collectStatuses(dateMap);
  const wrap = document.createElement('div'); wrap.className = 'burndown-section';

  // ── Pace strip ─────────────────────────────────────────────────────────────
  const pace = document.createElement('div'); pace.className = 'pace';
  wrap.appendChild(pace);

  // ── Toolbar: Done and Weekends menus, pace pill, legend ─────────────────────
  const toolbar = document.createElement('div'); toolbar.className = 'chart-toolbar';
  const menu = (label) => {
    const d = document.createElement('details'); d.className = 'chart-menu';
    const s = document.createElement('summary');
    const k = document.createElement('span'); k.className = 'menu-k'; k.textContent = label;
    const v = document.createElement('span'); v.className = 'menu-v';
    s.append(k, v, document.createTextNode(' ▾'));
    const pop = document.createElement('div'); pop.className = 'menu-pop';
    d.append(s, pop);
    return { el: d, value: v, pop };
  };
  const doneMenu = menu('Done');
  const doneBox  = doneMenu.pop;
  allStats.forEach(s => {
    const lbl=document.createElement('label'); lbl.className='done-label';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.value=s; cb.checked=DEFAULT_DONE.has(s.toLowerCase());
    lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' '+s)); doneBox.appendChild(lbl);
  });
  // Days menu: hide the range's first day (the planning day, whose scope jump dwarfs the
  // rest of the chart), then the weekend days to show
  const weekendMenu    = menu('Days');
  const weekendDaysBox = weekendMenu.pop;
  let hideFirst = hideFirstDay;
  const weekendSelected = new Set();   // the user's per-date choices, kept across redraws

  const spacer   = document.createElement('span'); spacer.className = 'spacer';
  const legend   = document.createElement('div'); legend.className = 'chart-legend';
  legend.innerHTML = `
    <span class="legend-chip"><i class="sw-remain"></i>Remaining</span>
    <button type="button" class="legend-chip legend-toggle" aria-pressed="false" title="Show the Done line"><i class="sw-done"></i>Done</button>
    <span class="legend-chip"><i class="sw-ideal"></i>Ideal</span>`;
  const doneToggle = legend.querySelector('.legend-toggle');
  let showDone = false;
  toolbar.append(doneMenu.el, weekendMenu.el, spacer, legend);
  wrap.appendChild(toolbar);

  // ── Chart ──────────────────────────────────────────────────────────────────
  const chartRow = document.createElement('div'); chartRow.className='chart-row';
  const canvas = document.createElement('canvas'); canvas.className='burndown-canvas';
  const noMsg  = document.createElement('p'); noMsg.className='chart-no-data'; noMsg.style.display='none';
  chartRow.append(canvas, noMsg);
  wrap.appendChild(chartRow);

  // ── Day detail, under the chart ────────────────────────────────────────────
  const detail = document.createElement('div'); detail.className = 'day-detail';
  wrap.appendChild(detail);

  let curStart = snapDates[0], curEnd = addDays(snapDates[0], 9);
  let model = null;          // what compute() derived; paint() and the detail read it
  let hover = -1;            // k of the hovered day
  let selDate = daySelection.get(version)?.date ?? null;   // the selected day, by the snapshot date its segment ends at
  let selTab  = daySelection.get(version)?.tab ?? null;    // 'burned' | 'scope' | 'progress'
  let hits = { plot: null, bands: [], strip: [], pills: [] };

  const selectedK = () => model && selDate ? model.actual.findIndex((p, k) => k > 0 && p.date === selDate) : -1;

  function compute() {
    const s=curStart, e=curEnd;
    model = null;
    if (!s||!e||s>e) { canvas.style.display='none'; noMsg.textContent='Invalid date range.'; noMsg.style.display='block'; renderPace(); renderDetail(); return; }
    const done = new Set([...doneBox.querySelectorAll('input:checked')].map(c=>c.value));
    doneMenu.value.textContent = [...done].join(', ') || 'none';

    // Rebuild weekend checkboxes for the current range, keeping existing selections.
    // The range is the days of work, last one included; the axis adds a closing tick on the
    // day after, whose point is the end of that last day.
    const allInRange  = calendarRange(s, e);
    const closing     = addDays(e, 1);
    const weekendDays = allInRange.filter(isWeekend);
    weekendDaysBox.innerHTML = '';
    const dayName = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' });
    // "First day" is the version's own first day (its planning day), not the first day of the
    // range on screen: a drawer plan or a custom range can start later, and then nothing is hidden.
    const firstDay = versionStart && versionStart >= s && versionStart <= e ? versionStart : null;
    if (firstDay) {
      const firstLbl = document.createElement('label'); firstLbl.className = 'done-label';
      const firstCb  = document.createElement('input'); firstCb.type = 'checkbox'; firstCb.checked = hideFirst;
      firstCb.addEventListener('change', () => {
        hideFirst = firstCb.checked;
        chrome.storage.local.set({ [HIDE_FIRST_DAY_KEY]: hideFirst });
        compute();
      });
      firstLbl.append(firstCb, document.createTextNode(` Hide first day (${dayName(firstDay)} ${firstDay.slice(5)})`));
      weekendDaysBox.appendChild(firstLbl);
    }
    if (weekendDays.length) {
      const head = document.createElement('div'); head.className = 'menu-sub'; head.textContent = 'Show weekend days';
      weekendDaysBox.appendChild(head);
    }
    weekendDays.forEach(d => {
      const lbl = document.createElement('label'); lbl.className='done-label';
      const cb  = document.createElement('input'); cb.type='checkbox'; cb.checked=weekendSelected.has(d);
      cb.addEventListener('change', () => {
        if (cb.checked) weekendSelected.add(d); else weekendSelected.delete(d);
        compute();
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(` ${d.slice(5)} (${dayName(d)})`));
      weekendDaysBox.appendChild(lbl);
    });
    const shownWeekends = weekendDays.filter(d => weekendSelected.has(d));
    const xDates = [...allInRange.filter(d => !(hideFirst && d === firstDay) && (!isWeekend(d) || weekendSelected.has(d))), closing];
    weekendMenu.value.textContent = [hideFirst && firstDay ? `from ${xDates[0].slice(5)}` : 'all',
      ...(shownWeekends.length ? [`+ ${shownWeekends.map(d => d.slice(5)).join(', ')}`] : [])].join(' ');
    const n = xDates.length;
    const today = todayStr();

    // Each x tick is the START of its day: the point on day D is the state locked at the end
    // of the day before, so the segment from D to the next tick is the progress made on D
    // (Monday's work is the segment Monday → Tuesday).  Ticks after today have no point;
    // today's own snapshot is live and drawn between today's tick and the next one.
    const snapBefore = (d, after) => {
      let found = null;
      for (const x of snapDates) { if (x >= d) break; if (x > after) found = x; }
      return found;
    };
    const pts = [];   // { idx, snap, live }
    let lastSnap = null;
    xDates.forEach((d, i) => {
      if (d > today) return;
      const snap = snapBefore(d, lastSnap ?? addDays(d, -4));
      if (snap) { pts.push({ idx: i, snap }); lastSnap = snap; }
    });
    const dayFrac = ((Date.now() + 7 * 3600000) % 86400000) / 86400000;   // of today, in ICT
    if (today >= s && today <= e && dateMap.has(today) && (!lastSnap || today > lastSnap)) {
      const i = xDates.findLastIndex(d => d <= today);
      if (i >= 0) {
        const span = dayDiff(xDates[i], xDates[i + 1] ?? addDays(xDates[i], 1));
        pts.push({ idx: Math.min(i + Math.min((dayDiff(xDates[i], today) + dayFrac) / span, 1), n - 1), snap: today, live: true });
      }
    }
    if (!pts.length) { canvas.style.display='none'; noMsg.textContent='No snapshots in range.'; noMsg.style.display='block'; renderPace(); renderDetail(); return; }
    noMsg.style.display='none'; canvas.style.display='block';

    const sumPts  = arr => arr.reduce((a,x)=>a+(parseFloat(x.point)||0),0);
    const remaining = d => sumPts((dateMap.get(d)??[]).filter(x=>!done.has(x.status)));

    const fmtPts = v => { const a = Math.abs(v); return (Number.isInteger(a) ? a : a.toFixed(1)) + 'pts'; };

    // date / prevDate are snapshot days: the segment ending at a point covers (prevDate, date]
    const actual = pts.map(({ idx, snap: d, live }, i) => {
      const value = remaining(d);
      let status = null, statusText = null, burned = 0, scope = 0;
      const prev = i > 0 ? pts[i-1].snap : null;
      if (prev) {
        const scopeNow = sumPts(dateMap.get(d)??[]);
        const scopePrv = sumPts(dateMap.get(prev)??[]);
        scope = Math.round((scopeNow - scopePrv) * 10) / 10;
        if      (scope >  0.001) { status = 'scope-up';   statusText = `+${fmtPts(scope)}`; }
        else if (scope < -0.001) { status = 'scope-down'; statusText = `−${fmtPts(scope)}`; }
        else if (Math.abs(value - remaining(prev)) < 0.001) {
          // Scope flat AND remaining flat: tell a genuine internal status reshuffle
          // (e.g. Specified → In progress) apart from "truly nothing changed".
          const sig = arr => (arr ?? []).map(x => `${x.status}:${x.numOfStory}:${x.point}`).sort().join('|');
          if (sig(dateMap.get(d)) !== sig(dateMap.get(prev))) { status = 'progress'; statusText = '⇄'; }
          else { status = 'no-progress'; statusText = '—'; }
        }

        // "Burned" = work actually completed (status transitions into a done status, net
        // of reopens) over the segment's days.  The aggregate Done-delta would also count
        // scope that arrives already-done (e.g. a story moved in already Resolved), which
        // isn't a completion.  Fall back to the Done-delta only when a day has no detail.
        const gap = calendarRange(addDays(prev, 1), d);
        const bi  = netBurnedOverGap(detailRecord, gap, done);
        if (bi.hasDetail) {
          burned = Math.round((bi.burnedPts - bi.reopenedPts) * 10) / 10;
        } else {
          const donePrev = sumPts(dateMap.get(prev)??[]) - remaining(prev);
          const doneNow  = sumPts(dateMap.get(d)??[])    - remaining(d);
          burned = Math.round((doneNow - donePrev) * 10) / 10;
        }
      }
      const burnedText = Math.abs(burned) > 0.001 ? String(Math.abs(burned)).replace(/^(\d+\.\d).*$/, '$1') : null;
      const total = sumPts(dateMap.get(d) ?? []);
      return { dayIndex: idx, date: d, prevDate: prev, value, total, status, statusText, burned, scope,
               burnedText: burnedText && (burned < 0 ? `-${burnedText}` : burnedText), live: !!live };
    });

    // Ideal line: from what was left when the sprint's work started, straight down to 0 at the
    // closing tick.  That start is the first point, or, when the planning day is shown and its
    // point is the state before planning, the point after it.
    const planningShown = !hideFirst && firstDay && xDates[0] === firstDay && actual[0].dayIndex === 0 && actual.length > 1 && !actual[1].live;
    const idealStart = (planningShown ? actual[1] : actual[0]).value;
    const ideal = xDates.map((_, i) => idealStart * (1 - i / Math.max(n - 1, 1)));

    // Day strip cells: the segments with data, then dashed cells for the days still to come
    const cells = [];
    if (actual[0].dayIndex > 0) cells.push({ a: 0, b: actual[0].dayIndex, k: -1, label: '', empty: true });
    actual.forEach((p, k) => {
      if (k === 0) return;
      const a = actual[k - 1].dayIndex;
      const b = p.live ? Math.min(Math.floor(a) + 1, n - 1) : p.dayIndex;
      if (b <= a) return;
      cells.push({ a, b, k, label: p.live ? 'Today' : cellLabel(calendarRange(addDays(p.prevDate, 1), p.date)), burned: p.burned, scope: p.scope, live: p.live });
    });
    const last = actual[actual.length - 1];
    const futureFrom = last.live ? Math.min(Math.floor(actual.length > 1 ? actual[actual.length - 2].dayIndex : last.dayIndex) + 1, n - 1) : last.dayIndex;
    for (let i = futureFrom; i < n - 1; i++) cells.push({ a: i, b: i + 1, k: -1, label: cellLabel([xDates[i]]), empty: true });

    const doneActual = showDone
      ? pts.map(({ idx, snap }) => ({ dayIndex: idx, value: Math.round((sumPts(dateMap.get(snap)??[]) - remaining(snap)) * 10) / 10 }))
      : null;
    const maxScope = Math.max(...pts.map(({ snap }) => sumPts(dateMap.get(snap)??[])));
    const notSyncedToday = xDates.includes(today) && !dateMap.has(today);

    // Pace strip: what is left and the working days left (today counts for the part not yet gone)
    const daysLeft = today > e ? 0
      : today < s ? weekdaysBetween(s, e)
      : (isWeekend(today) ? 0 : 1 - dayFrac) + weekdaysBetween(addDays(today, 1), e);
    model = { done, xDates, actual, doneActual, ideal, maxY: Math.max(maxScope, 1), notSyncedToday, cells,
              pace: { remaining: last.value, total: last.total, live: last.live ? last : null, daysLeft } };
    renderPace();
    paint();
    renderDetail();
  }

  function paint() {
    if (!model) return;
    hits = drawBurndownChart(canvas, { ...model, hover, selected: selectedK() }) ?? hits;
  }

  // ── Pace strip ─────────────────────────────────────────────────────────────
  function renderPace() {
    if (!model) { pace.innerHTML = ''; return; }
    const p = model.pace;
    const f = v => v == null ? '—' : (Math.round(v * 10) / 10).toString();
    const stat = (k, v, sub) => `<div class="pace-stat"><span class="pace-k">${k}</span><span class="pace-v num">${v}</span><span class="pace-sub">${sub}</span></div>`;
    pace.innerHTML =
      stat('Remaining', f(p.remaining), `of ${f(p.total)} pts`) +
      stat('Burned today', p.live ? f(p.live.burned) : '—', p.live ? 'live · since 00:00 ICT' : 'no live data for today') +
      stat('Days left', f(p.daysLeft), `until ${curEnd.slice(5)}`);
  }

  // ── Day detail ─────────────────────────────────────────────────────────────
  function renderDetail() {
    const k = selectedK();
    if (!model || k < 1) {
      selDate = null;
      daySelection.delete(version);
      detail.className = 'day-detail is-empty';
      detail.textContent = model ? 'Click a day under the chart to see its stories.' : '';
      return;
    }
    const p = model.actual[k];
    const days = calendarRange(addDays(p.prevDate, 1), p.date);
    const scopeEvent = p.status === 'scope-up' || p.status === 'scope-down';
    if (!selTab) selTab = p.burnedText ? 'burned' : scopeEvent ? 'scope' : 'progress';
    daySelection.set(version, { date: selDate, tab: selTab });
    const hit = { date: p.date, prevDate: p.prevDate, status: p.status, statusText: p.statusText, burnedText: p.burnedText };

    detail.className = 'day-detail';
    detail.innerHTML = '';
    const head = document.createElement('div'); head.className = 'dd-head';
    const title = document.createElement('strong'); title.textContent = dayLabel(days) + (p.live ? ' · live' : '');
    const tabs = document.createElement('div'); tabs.className = 'dd-tabs'; tabs.setAttribute('role', 'tablist');
    const tab = (id, label) => {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(selTab === id)); b.textContent = label;
      b.addEventListener('click', () => { selTab = id; renderDetail(); });
      tabs.appendChild(b);
    };
    tab('burned',   `Burned ${p.burnedText ?? 0}`);
    tab('scope',    `Scope ${scopeEvent ? p.statusText.replace('pts', '') : '0'}`);
    tab('progress', 'Status moves');
    const sp = document.createElement('span'); sp.className = 'spacer';
    const btn = (label, title, fn) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'dd-btn'; b.textContent = label; b.title = title;
      b.addEventListener('click', fn); return b;
    };
    const prevBtn = btn('‹', 'Previous day', () => step(-1)); prevBtn.disabled = k <= 1;
    const nextBtn = btn('›', 'Next day', () => step(1));      nextBtn.disabled = k >= model.actual.length - 1;
    const refresh = btn('↻ Refresh', 'Rebuild the snapshot(s) behind this day', async () => {
      const keys = days.flatMap(d => [`${d}__${version}`, `${DETAIL_PREFIX}${d}__${version}`]);
      await chrome.storage.local.remove(keys);
      triggerSync();
    });
    const collapse = btn('Collapse ▴', 'Close the day detail', () => { selDate = null; selTab = null; renderDetail(); paint(); });
    head.append(title, tabs, sp, prevBtn, nextBtn, refresh, collapse);

    const body = document.createElement('div'); body.className = 'dd-body';
    detail.append(head, body);
    const done = model.done;
    if (selTab === 'burned')     showBurnedDetail(body, version, hit, done);
    else if (selTab === 'scope') showPointDetail(body, version, hit);
    else                         showProgressDetail(body, version, hit);
  }

  function select(k, tabId = null) {
    if (!model || k < 1) return;
    const date = model.actual[k].date;
    if (date === selDate && !tabId) { selDate = null; selTab = null; }
    else { selDate = date; selTab = tabId; }
    paint(); renderDetail();
  }
  function step(dir) {
    const k = selectedK() + dir;
    if (k >= 1 && model && k < model.actual.length) { selDate = model.actual[k].date; selTab = null; paint(); renderDetail(); }
  }

  doneBox.addEventListener('change', compute);
  doneToggle.addEventListener('click', () => {
    showDone = !showDone;
    doneToggle.setAttribute('aria-pressed', String(showDone));
    compute();
  });
  let rt; window.addEventListener('resize',()=>{ clearTimeout(rt); rt=setTimeout(paint,120); });

  // ── Pointer: hover lights a day, click selects it ─────────────────────────
  const kAt = (mx, my) => {
    const inside = r => mx >= r.x0 && mx <= r.x1 && my >= r.y0 && my <= r.y1;
    const pill = hits.pills.find(inside);
    if (pill) return { k: pill.k, tab: 'scope' };
    const cell = hits.strip.find(inside);
    if (cell) return { k: cell.k };
    if (hits.plot && my >= hits.plot.y0 && my <= hits.plot.y1) {
      const b = hits.bands.find(b => mx >= b.x0 && mx < b.x1);
      if (b) return { k: b.k };
    }
    return null;
  };
  const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  let raf = 0;
  canvas.addEventListener('mousemove', e => {
    const hit = kAt(...pos(e));
    const k = hit ? hit.k : -1;
    canvas.style.cursor = k >= 1 ? 'pointer' : 'default';
    if (k === hover) return;
    hover = k;
    cancelAnimationFrame(raf); raf = requestAnimationFrame(paint);
  });
  canvas.addEventListener('mouseleave', () => { if (hover !== -1) { hover = -1; paint(); } });
  canvas.addEventListener('click', e => { const hit = kAt(...pos(e)); if (hit) select(hit.k, hit.tab ?? null); });

  // ← / → walk the days while the chart has focus (Escape stays with the drawer)
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', `Burndown chart for ${version}. Use the left and right arrows to walk the days.`);
  canvas.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    if (selectedK() < 1 && model) select(model.actual.length - 1);
    else step(e.key === 'ArrowLeft' ? -1 : 1);
  });

  return {
    el: wrap,
    update(s, e) { curStart = s; curEnd = e; compute(); },
    redraw: paint,
    getCanvas() { return canvas; },
    isDoneShown() { return showDone; },
  };
}

// ─── Cumulative Flow Diagram + Flow metrics ───────────────────────────────────

const WP_BASE_URL = `${BACKLOG_URL}/work_packages`;
const CFD_PALETTE = ['#89b4fa','#a6e3a1','#f9e2af','#fab387','#f38ba8','#cba6f7','#94e2d5','#eba0ac','#74c7ec','#b4befe','#f2cdcd','#89dceb'];
const AGING_THRESHOLD_DAYS = 5;

/** "10-12 (Mon)" for one day, "10-09 → 10-11" for a segment spanning several. */
function dayLabel(days) {
  const one = d => `${d.slice(5)} (${new Date(d + 'T12:00:00Z').toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' })})`;
  return days.length > 1 ? `${days[0].slice(5)} → ${days[days.length - 1].slice(5)}` : one(days[0]);
}

function dayDiff(fromStr, toStr) {
  if (!fromStr || !toStr) return 0;
  return Math.round((new Date(toStr + 'T00:00:00Z') - new Date(fromStr + 'T00:00:00Z')) / 86400000);
}

/** Injects styles for the CFD/Flow panels once. */
function ensureFlowStyles() {
  if (document.getElementById('__blm-flow-style')) return;
  const s = document.createElement('style');
  s.id = '__blm-flow-style';
  s.textContent = `
    .flow-section { margin-top:14px; padding:14px 16px; background:var(--card,var(--surface)); border:1px solid var(--border); border-radius:10px; }
    [data-theme="light"] .flow-section { background:#f4f4fa; border-color:#dcdce8; }
    .flow-stats { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
    .flow-stat { flex:1; min-width:120px; padding:10px 12px; border-radius:8px; background:var(--bg); border:1px solid var(--border); }
    [data-theme="light"] .flow-stat { background:#fff; border-color:#e2e2ee; }
    .flow-stat .v { font-size:20px; font-weight:800; color:var(--text); line-height:1.1; }
    [data-theme="light"] .flow-stat .v { color:var(--bg); }
    .flow-stat .l { font-size:10px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); margin-top:3px; }
    .flow-stat.warn .v { color:#fb923c; }
    .flow-heading { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:4px 0 8px; }
    .aging-row { display:flex; align-items:center; gap:10px; padding:6px 8px; border-radius:6px; }
    .aging-row + .aging-row { border-top:1px solid #2a2a3e44; }
    .aging-age { font-size:12px; font-weight:800; min-width:54px; text-align:right; color:var(--text2); }
    .aging-age.hot { color:#fb923c; }
    .aging-status { font-size:10px; font-weight:700; padding:1px 7px; border-radius:4px; background:var(--border); color:var(--text2); white-space:nowrap; }
    .aging-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
    .aging-name a { color:var(--accent); text-decoration:none; }
    .aging-name a:hover { text-decoration:underline; }
    .flow-empty { font-size:12px; color:var(--muted); padding:6px 2px; }
  `;
  document.head.appendChild(s);
}

/** Stacked-area cumulative flow chart (story points per status over time). */
function drawCFD(canvas, { dates, series, maxY }) {
  const C = getChartColors();
  const W = Math.min(canvas.parentElement.clientWidth || 800, 800), H = 300, dpr = window.devicePixelRatio || 1;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  canvas.width = W*dpr; canvas.height = H*dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  const PAD = { top:28, right:24, bottom:48, left:56 };
  const CW = W-PAD.left-PAD.right, CH = H-PAD.top-PAD.bottom;
  const rawMax = maxY > 0 ? maxY : 1;
  const step   = niceStep(rawMax);
  const top    = Math.ceil(rawMax / step) * step || step;
  const n   = dates.length;
  const xAt = i => PAD.left + (n < 2 ? CW/2 : CW*i/(n-1));
  const yAt = v => PAD.top  + CH*(1 - Math.max(0,v)/top);

  ctx.fillStyle = C.bg; ctx.fillRect(0,0,W,H);

  for (let v = 0; v <= top + 0.001; v += step) {
    const y = yAt(v);
    ctx.strokeStyle=C.grid; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+CW,y); ctx.stroke();
    ctx.fillStyle=C.axis; ctx.font='11px -apple-system,sans-serif';
    ctx.textAlign='right'; ctx.textBaseline='middle';
    ctx.fillText(Number.isInteger(v) ? v : v.toFixed(1), PAD.left-8, y);
  }
  const xStep = Math.ceil(38 / (n>1 ? CW/(n-1) : CW));
  for (let i = 0; i < n; i++) {
    if (i % xStep !== 0 && i !== n-1) continue;
    ctx.fillStyle=C.axis; ctx.font='11px -apple-system,sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.fillText(dates[i].slice(5), xAt(i), PAD.top+CH+10);
    ctx.strokeStyle=C.axes; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(xAt(i),PAD.top+CH); ctx.lineTo(xAt(i),PAD.top+CH+5); ctx.stroke();
  }
  ctx.strokeStyle=C.axes; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(PAD.left,PAD.top); ctx.lineTo(PAD.left,PAD.top+CH); ctx.lineTo(PAD.left+CW,PAD.top+CH); ctx.stroke();

  // Stacked areas (done statuses first → drawn at the bottom)
  const cum = new Array(n).fill(0);
  for (const s of series) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xAt(i), y = yAt(cum[i]); i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y); }
    for (let i = n-1; i >= 0; i--) { const x = xAt(i), y = yAt(cum[i] + s.values[i]); ctx.lineTo(x,y); }
    ctx.closePath();
    ctx.globalAlpha = 0.82; ctx.fillStyle = s.color; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = s.color; ctx.lineWidth = 1; ctx.stroke();
    for (let i = 0; i < n; i++) cum[i] += s.values[i];
  }
  // Total-scope line (top of the stack)
  ctx.strokeStyle = C.label; ctx.lineWidth = 1.5; ctx.setLineDash([]);
  ctx.beginPath(); for (let i = 0; i < n; i++) { const x = xAt(i), y = yAt(cum[i]); i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y); } ctx.stroke();
}

/** Cumulative-flow section (collapsible). Returns { el, update(s,e), show(v) }. */
function buildCFDSection(version, dateMap) {
  const wrap = document.createElement('div'); wrap.className = 'burndown-section cfd-section'; wrap.style.display = 'none';
  const heading = document.createElement('div'); heading.className = 'burndown-heading';
  heading.textContent = 'Cumulative Flow — story points by status';
  wrap.appendChild(heading);

  const chartRow = document.createElement('div'); chartRow.className = 'chart-row';
  const canvas = document.createElement('canvas'); canvas.className = 'burndown-canvas';
  const legend = document.createElement('div'); legend.className = 'chart-legend';
  const noMsg  = document.createElement('p'); noMsg.className = 'chart-no-data'; noMsg.style.display = 'none';
  chartRow.appendChild(canvas); chartRow.appendChild(noMsg); chartRow.appendChild(legend);
  wrap.appendChild(chartRow);

  const allStatuses = collectStatuses(dateMap);
  function redraw(s, e) {
    const dates = [...dateMap.keys()].filter(d => d >= s && d <= e).sort();
    if (!dates.length) { canvas.style.display='none'; legend.innerHTML=''; noMsg.textContent='No snapshots in range.'; noMsg.style.display='block'; return; }
    canvas.style.display='block'; noMsg.style.display='none';
    const sumPts = arr => arr.reduce((a,x)=>a+(parseFloat(x.point)||0),0);
    // Done statuses first so they stack at the bottom of the chart.
    const ordered = [...allStatuses].sort((a,b) =>
      (DEFAULT_DONE.has(a.toLowerCase())?0:1) - (DEFAULT_DONE.has(b.toLowerCase())?0:1));
    const series = ordered.map((st, idx) => ({
      status: st, color: CFD_PALETTE[idx % CFD_PALETTE.length],
      values: dates.map(d => { const row = (dateMap.get(d)||[]).find(x => x.status === st); return row ? (parseFloat(row.point)||0) : 0; }),
    })).filter(s => s.values.some(v => v > 0));   // drop statuses with no points in range
    const maxY = Math.max(...dates.map(d => sumPts(dateMap.get(d)||[])), 1);
    drawCFD(canvas, { dates, series, maxY });
    legend.innerHTML = series.map(s =>
      `<div class="legend-item"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${s.color}"></span><span class="legend-label">${s.status}</span></div>`
    ).join('');
  }
  return { el: wrap, update: redraw, show(v) { wrap.style.display = v ? '' : 'none'; } };
}

/** Flow-metrics panel: throughput, rework, and Aging WIP. Returns { el, update(s,e), show(v) }. */
function buildFlowPanel(version, throughputMap, flowRecord) {
  ensureFlowStyles();
  const wrap = document.createElement('div'); wrap.className = 'flow-section'; wrap.style.display = 'none';

  function redraw(s, e) {
    let pts = 0, count = 0, reopened = 0;
    if (throughputMap) for (const [d, t] of throughputMap) {
      if (d >= s && d <= e) { pts += t.completedPts; count += t.completedCount; reopened += t.reopenedCount; }
    }

    const asOf = flowRecord?.asOf ?? todayStr();
    const wip = (flowRecord?.stories ?? [])
      .filter(st => !DEFAULT_DONE.has((st.status ?? '').toLowerCase()))
      .map(st => ({ ...st, age: dayDiff(st.enteredStatusAt || asOf, asOf) }))
      .sort((a, b) => b.age - a.age);
    const wipPts = wip.reduce((a, x) => a + (x.points || 0), 0);
    const aging  = wip.filter(x => x.age >= AGING_THRESHOLD_DAYS);

    const stat = (v, l, warn) => `<div class="flow-stat${warn ? ' warn' : ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    let html = `<div class="flow-stats">
      ${stat(`${count}`, `Completed (${pts} pts)`)}
      ${stat(`${reopened}`, 'Reopened', reopened > 0)}
      ${stat(`${wip.length}`, `WIP (${wipPts} pts)`)}
      ${stat(`${aging.length}`, `Stuck > ${AGING_THRESHOLD_DAYS}d`, aging.length > 0)}
    </div>`;

    if (!flowRecord) {
      html += `<p class="flow-empty">No flow data yet — click Sync Now (reconstruction must run over this version to compute it).</p>`;
    } else if (!wip.length) {
      html += `<p class="flow-empty">No work in progress in this version.</p>`;
    } else {
      html += `<div class="flow-heading">Aging WIP — in-progress stories, oldest first</div>`;
      for (const st of wip) {
        const hot = st.age >= AGING_THRESHOLD_DAYS ? ' hot' : '';
        html += `<div class="aging-row">
          <span class="aging-age${hot}">${st.age}d</span>
          <span class="aging-status">${st.status}</span>
          <span class="aging-name"><a href="${WP_BASE_URL}/${st.id}" target="_blank">#${st.id} ${st.subject ?? ''}</a></span>
        </div>`;
      }
    }
    wrap.innerHTML = html;
  }
  return { el: wrap, update: redraw, show(v) { wrap.style.display = v ? '' : 'none'; } };
}

// ─── Point detail panel ───────────────────────────────────────────────────────

async function showPointDetail(panel, version, hit) {
  const STATUS_CLS = { 'scope-up': 'scope-up', 'scope-down': 'scope-down', 'no-progress': 'no-progress' };
  const fmtPts = p => { const v = p ?? 0; return `${Number.isInteger(v) ? v : v.toFixed(1)}pts`; };

  const WP_BASE = WP_BASE_URL;
  const TYPE_CLS = { 'bug': 'wt-bug', 'user story': 'wt-story', 'feature': 'wt-feature', 'epic': 'wt-epic', 'task': 'wt-task' };
  const wpLink = (wp) => {
    const typeCls = TYPE_CLS[(wp.type ?? '').toLowerCase()] ?? 'wt-default';
    const typeBadge = wp.type ? `<span class="wp-type ${typeCls}">${wp.type.toUpperCase()}</span>` : '';
    return `${typeBadge}<a class="dp-wp-link" href="${WP_BASE}/${wp.id}" target="_blank">#${wp.id} ${wp.subject ?? ''}</a>`;
  };

  // The chart hides weekends, so a scope pill on a visible day represents the *net*
  // change since the previous VISIBLE day — a span that can include hidden weekend
  // days.  Reconstruction stores detail per calendar day, so we aggregate every day
  // in (prevDate, date] to match the pill.  Reading only the clicked day would miss
  // changes that landed on a hidden weekend, leaving the panel permanently "stale".
  const gapDays    = hit.prevDate ? calendarRange(addDays(hit.prevDate, 1), hit.date) : [hit.date];
  const coreKeys   = gapDays.map(d => `${d}__${version}`);
  const detailKeys = gapDays.map(d => `${DETAIL_PREFIX}${d}__${version}`);
  const store      = await chrome.storage.local.get([...coreKeys, ...detailKeys]);

  // Net each work package across the window: a story may move in on Sat, gain points
  // on Sun, etc.  We replay every day's events in order, then classify the net result
  // so the panel shows one clean entry per WP (no double-counting intermediate states).
  const recs   = new Map();
  const ensure = (id) => {
    if (!recs.has(id)) recs.set(id, { id, subject: '', type: '', started: false,
      startPresent: false, startPoints: 0, startFromVersion: '',
      present: false, points: 0, lastToVersion: '' });
    return recs.get(id);
  };

  let anyReconstructed = false;   // a reconstructed day exists in the window…
  let anyMissingDetail = false;   // …and at least one predates detail tracking (refresh can fix it)

  for (const d of gapDays) {
    const snap = store[`${d}__${version}`];
    if (!snap) continue;
    if (snap.source === 'reconstructed') {
      anyReconstructed = true;
      if (store[`${DETAIL_PREFIX}${d}__${version}`] === undefined) anyMissingDetail = true;
    }
    const merge = (wp, kind) => {
      const r = ensure(wp.id);
      if (wp.subject) r.subject = wp.subject;
      if (wp.type)    r.type    = wp.type;
      if (!r.started) {
        r.started = true;
        if (kind === 'in')      { r.startPresent = false; r.startPoints = 0;            r.startFromVersion = wp.fromVersion || ''; }
        if (kind === 'out')     { r.startPresent = true;  r.startPoints = wp.points ?? 0; }
        if (kind === 'changed') { r.startPresent = true;  r.startPoints = wp.from ?? 0; }
      }
      if (kind === 'in')      { r.present = true;  r.points = wp.points ?? 0; }
      if (kind === 'out')     { r.present = false; r.lastToVersion = wp.toVersion || ''; }
      if (kind === 'changed') { r.present = true;  r.points = wp.to ?? 0; }
    };
    (snap.movedIn       ?? []).forEach(wp => merge(wp, 'in'));
    (snap.movedOut      ?? []).forEach(wp => merge(wp, 'out'));
    (snap.pointsChanged ?? []).forEach(wp => merge(wp, 'changed'));
  }

  const movedIn = [], movedOut = [], pointsChanged = [];
  for (const r of recs.values()) {
    if (!r.startPresent && r.present)
      movedIn.push({ id: r.id, subject: r.subject, points: r.points, fromVersion: r.startFromVersion, type: r.type });
    else if (r.startPresent && !r.present)
      movedOut.push({ id: r.id, subject: r.subject, points: r.startPoints, toVersion: r.lastToVersion, type: r.type });
    else if (r.startPresent && r.present && Math.abs(r.points - r.startPoints) > 0.001)
      pointsChanged.push({ id: r.id, subject: r.subject, from: r.startPoints, to: r.points, type: r.type });
  }

  // Stale only when a reconstructed day in the window predates detail tracking: then a
  // refresh genuinely rebuilds missing detail.  If tracking ran on every day but the net
  // is still empty, the change can't be attributed — that's "no detail", not "stale".
  const hasDetail  = movedIn.length || movedOut.length || pointsChanged.length;
  const scopeEvent = hit.status === 'scope-up' || hit.status === 'scope-down';
  const isStale    = scopeEvent && !hasDetail && anyReconstructed && anyMissingDetail;

  let html = `<div class="dp-header">
    <span class="dp-date">${dayLabel(gapDays)}</span>
    ${hit.status ? `<span class="dp-badge ${STATUS_CLS[hit.status] ?? ''}">${hit.statusText ?? ''}</span>` : ''}
    <div class="dp-header-actions">
      <button class="dp-refresh" title="Re-reconstruct the snapshot(s) behind this point">↻ Refresh</button>
      <button class="dp-close"   title="Close">✕</button>
    </div>
  </div>`;

  if (movedIn.length) {
    // Split into "moved in from another version" vs "newly created in this version"
    const created   = movedIn.filter(w => !w.fromVersion);
    const movedFrom = movedIn.filter(w =>  w.fromVersion);
    if (created.length) {
      html += `<div class="dp-section"><div class="dp-section-label">Newly created</div><div class="dp-list">`;
      for (const wp of created)
        html += `<div class="dp-item"><span class="dp-pts">+${fmtPts(wp.points)}</span><span class="dp-name">${wpLink(wp)}</span></div>`;
      html += `</div></div>`;
    }
    if (movedFrom.length) {
      html += `<div class="dp-section"><div class="dp-section-label">Moved into version</div><div class="dp-list">`;
      for (const wp of movedFrom)
        html += `<div class="dp-item"><span class="dp-pts">+${fmtPts(wp.points)}</span><span class="dp-name">${wpLink(wp)}</span><span class="dp-from">from ${wp.fromVersion}</span></div>`;
      html += `</div></div>`;
    }
  }

  if (movedOut.length) {
    html += `<div class="dp-section"><div class="dp-section-label">Removed from version</div><div class="dp-list">`;
    for (const wp of movedOut)
      html += `<div class="dp-item"><span class="dp-pts dp-pts-out">−${fmtPts(wp.points)}</span><span class="dp-name">${wpLink(wp)}</span>${wp.toVersion ? `<span class="dp-from">to ${wp.toVersion}</span>` : ''}</div>`;
    html += `</div></div>`;
  }

  if (pointsChanged.length) {
    html += `<div class="dp-section"><div class="dp-section-label">Story points changed</div><div class="dp-list">`;
    for (const wp of pointsChanged) {
      const diff = wp.to - wp.from;
      html += `<div class="dp-item"><span class="dp-pts ${diff > 0 ? '' : 'dp-pts-out'}">${diff > 0 ? '+' : '−'}${fmtPts(Math.abs(diff))}</span><span class="dp-name">${wpLink(wp)}</span><span class="dp-from">${fmtPts(wp.from)} → ${fmtPts(wp.to)}</span></div>`;
    }
    html += `</div></div>`;
  }

  if (!hasDetail) {
    html += `<p class="dp-empty">${
      hit.status === 'no-progress' ? 'No items completed this day.' :
      isStale ? '⚠ Snapshot predates detail tracking — click ↻ Refresh to re-reconstruct.' :
      'No scope change detail available for this date.'
    }</p>`;
  }

  panel.innerHTML = html;
  panel.classList.add('visible');
  panel.querySelector('.dp-close')?.addEventListener('click', () => panel.classList.remove('visible'));

  // Refresh: delete every snapshot behind this point (the clicked day plus any hidden
  // weekend days the pill rolls up) and re-sync, so reconstruction rebuilds them all with
  // full detail.  Removing only the clicked day would leave weekend detail unrebuilt.
  panel.querySelector('.dp-refresh')?.addEventListener('click', async () => {
    await chrome.storage.local.remove([...coreKeys, ...detailKeys]);
    panel.classList.remove('visible');
    triggerSync();
  });
}

// ─── Progress (internal status reshuffle) panel ───────────────────────────────

// Shown when the burndown is flat (scope + remaining unchanged) but stories moved
// between statuses, e.g. Specified → In progress.  Lists the net status moves over
// the same window the pill represents (prevVisibleDay, clickedDay].
async function showProgressDetail(panel, version, hit) {
  const fmtPts  = p => { const v = p ?? 0; return `${Number.isInteger(v) ? v : v.toFixed(1)}pts`; };
  const WP_BASE = WP_BASE_URL;
  const TYPE_CLS = { 'bug': 'wt-bug', 'user story': 'wt-story', 'feature': 'wt-feature', 'epic': 'wt-epic', 'task': 'wt-task' };
  const wpLink = (wp) => {
    const typeCls = TYPE_CLS[(wp.type ?? '').toLowerCase()] ?? 'wt-default';
    const typeBadge = wp.type ? `<span class="wp-type ${typeCls}">${wp.type.toUpperCase()}</span>` : '';
    return `${typeBadge}<a class="dp-wp-link" href="${WP_BASE}/${wp.id}" target="_blank">#${wp.id} ${wp.subject ?? ''}</a>`;
  };

  const gapDays    = hit.prevDate ? calendarRange(addDays(hit.prevDate, 1), hit.date) : [hit.date];
  const coreKeys   = gapDays.map(d => `${d}__${version}`);
  const detailKeys = gapDays.map(d => `${DETAIL_PREFIX}${d}__${version}`);
  const store      = await chrome.storage.local.get([...coreKeys, ...detailKeys]);

  // Net each story across the window: first fromStatus → last toStatus.
  const recs = new Map();
  let anyStale = false;
  for (const d of gapDays) {
    const snap    = store[`${d}__${version}`];
    const changes = store[`${DETAIL_PREFIX}${d}__${version}`];
    if (snap?.source === 'reconstructed' && changes === undefined) anyStale = true;
    for (const sc of (changes ?? [])) {
      const r = recs.get(sc.id);
      if (!r) recs.set(sc.id, { id: sc.id, subject: sc.subject ?? '', type: sc.type ?? '', from: sc.fromStatus, to: sc.toStatus, points: sc.points ?? 0 });
      else { r.to = sc.toStatus; r.points = sc.points ?? r.points; if (sc.subject) r.subject = sc.subject; if (sc.type) r.type = sc.type; }
    }
  }
  const moves = [...recs.values()].filter(r => r.from !== r.to);

  let html = `<div class="dp-header">
    <span class="dp-date">${dayLabel(gapDays)}</span>
    <span class="dp-badge" style="color:var(--green-soft);border-color:var(--green-soft)">⇄ Progress</span>
    <div class="dp-header-actions">
      <button class="dp-refresh" title="Re-reconstruct the snapshot(s) behind this point">↻ Refresh</button>
      <button class="dp-close"   title="Close">✕</button>
    </div>
  </div>`;

  if (moves.length) {
    html += `<div class="dp-section"><div class="dp-section-label">Status changed (scope unchanged)</div><div class="dp-list">`;
    for (const r of moves)
      html += `<div class="dp-item"><span class="dp-pts">${fmtPts(r.points)}</span><span class="dp-name">${wpLink(r)}</span><span class="dp-from">${r.from} → ${r.to}</span></div>`;
    html += `</div></div>`;
  } else {
    html += `<p class="dp-empty">${anyStale ? '⚠ Snapshot predates detail tracking — click ↻ Refresh to re-reconstruct.' : 'No status changes recorded for this date.'}</p>`;
  }

  panel.innerHTML = html;
  panel.classList.add('visible');
  panel.querySelector('.dp-close')?.addEventListener('click', () => panel.classList.remove('visible'));
  panel.querySelector('.dp-refresh')?.addEventListener('click', async () => {
    await chrome.storage.local.remove([...coreKeys, ...detailKeys]);
    panel.classList.remove('visible');
    triggerSync();
  });
}

// ─── Burned-detail panel ──────────────────────────────────────────────────────

const DETAIL_PREFIX = '__blm_sc__';

async function showBurnedDetail(panel, version, hit, done, _autoTriggered = false) {
  // Aggregate over the window the chart badge represents: (prevVisibleDay, clickedDay].
  // hit.prevDate already reflects the weekend toggles (redraw recomputes it), so a hidden
  // weekend rolls its burns into the next visible day, while a shown weekend stays its own.
  const gapDays    = hit.prevDate ? calendarRange(addDays(hit.prevDate, 1), hit.date) : [hit.date];
  const coreKeys   = gapDays.map(d => `${d}__${version}`);
  const detailKeys = gapDays.map(d => `${DETAIL_PREFIX}${d}__${version}`);
  const store      = await chrome.storage.local.get([...coreKeys, ...detailKeys]);

  const isToday = hit.date === todayStr();
  // Stale = a reconstructed day in the window has no detail key yet (refresh can rebuild it),
  // or today's own detail hasn't been computed.
  let anyMissingDetail = false;
  for (const d of gapDays) {
    const s = store[`${d}__${version}`];
    if (s?.source === 'reconstructed' && store[`${DETAIL_PREFIX}${d}__${version}`] === undefined) anyMissingDetail = true;
  }
  const isStale = anyMissingDetail || (isToday && store[`${DETAIL_PREFIX}${hit.date}__${version}`] === undefined);

  // For today's burned badge: if detail data hasn't been computed yet, auto-trigger
  // reconstruction so we can show which stories completed from yesterday's locked
  // snapshot (6AM) to today's locked snapshot (6AM).
  if (isStale && isToday && !_autoTriggered) {
    panel.innerHTML = `<div class="dp-header">
      <span class="dp-date">${dayLabel(gapDays)}</span>
      <span class="dp-badge scope-down">Computing…</span>
      <div class="dp-header-actions">
        <button class="dp-close" title="Close">✕</button>
      </div>
    </div>
    <p class="dp-empty">Fetching today's burn detail from locked snapshots…</p>`;
    panel.classList.add('visible');
    panel.querySelector('.dp-close')?.addEventListener('click', () => panel.classList.remove('visible'));

    // Kick off reconstruction in the background (same as "Sync Now")
    try { chrome.runtime.sendMessage({ type: 'sync-now' }); } catch { /* sw may be inactive */ }

    // Poll __blm_sync_meta until the background job completes, then re-render.
    // Guard with seenSyncing so we don't accidentally stop on a stale 'ok' from
    // a previous sync that finished before our trigger message was processed.
    let polls = 0, seenSyncing = false;
    const waitTimer = setInterval(async () => {
      polls++;
      const meta = (await chrome.storage.local.get('__blm_sync_meta'))['__blm_sync_meta'];
      if (meta?.status === 'syncing') seenSyncing = true;
      if ((seenSyncing && (meta?.status === 'ok' || meta?.status === 'error')) || polls >= 120) {
        clearInterval(waitTimer);
        await showBurnedDetail(panel, version, hit, done, true);
      }
    }, 500);
    return;
  }

  const fmtPts = p => { const v = p ?? 0; return `${Number.isInteger(v) ? v : v.toFixed(1)}pts`; };
  const WP_BASE = WP_BASE_URL;
  const TYPE_CLS = { 'bug': 'wt-bug', 'user story': 'wt-story', 'feature': 'wt-feature', 'epic': 'wt-epic', 'task': 'wt-task' };
  const wpLink = (wp) => {
    const typeCls = TYPE_CLS[(wp.type ?? '').toLowerCase()] ?? 'wt-default';
    const typeBadge = wp.type ? `<span class="wp-type ${typeCls}">${wp.type.toUpperCase()}</span>` : '';
    return `${typeBadge}<a class="dp-wp-link" href="${WP_BASE}/${wp.id}" target="_blank">#${wp.id} ${wp.subject ?? ''}</a>`;
  };

  // Net each story's status movement across the window (first fromStatus → last toStatus)
  // so weekend-day completions roll into the visible day, matching the chart badge.
  const recs = new Map();
  for (const d of gapDays)
    for (const sc of (store[`${DETAIL_PREFIX}${d}__${version}`] ?? [])) {
      const r = recs.get(sc.id);
      if (!r) recs.set(sc.id, { id: sc.id, subject: sc.subject ?? '', type: sc.type ?? '', fromStatus: sc.fromStatus, toStatus: sc.toStatus, points: sc.points ?? 0 });
      else { r.toStatus = sc.toStatus; r.points = sc.points ?? r.points; if (sc.subject) r.subject = sc.subject; if (sc.type) r.type = sc.type; }
    }

  // Filter net moves relative to the viewer's current done-status selection.
  const doneL    = new Set([...done].map(s => s.toLowerCase()));
  const allMoves = [...recs.values()].filter(c => c.fromStatus && c.toStatus && c.fromStatus !== c.toStatus);
  const burned   = allMoves.filter(c => !doneL.has(c.fromStatus.toLowerCase()) &&  doneL.has(c.toStatus.toLowerCase()));
  const reopened = allMoves.filter(c =>  doneL.has(c.fromStatus.toLowerCase()) && !doneL.has(c.toStatus.toLowerCase()));

  // Stories moved OUT of this version anywhere in the window (last record wins).
  const movedOutMap = new Map();
  for (const d of gapDays)
    for (const w of (store[`${d}__${version}`]?.movedOut ?? [])) movedOutMap.set(w.id, w);
  const movedOut    = [...movedOutMap.values()];
  const movedOutPts = movedOut.reduce((s, w) => s + (w.points ?? 0), 0);

  const burnedPts   = burned.reduce((s, c) => s + (c.points ?? 0), 0);
  const reopenedPts = reopened.reduce((s, c) => s + (c.points ?? 0), 0);
  const netPts      = burnedPts - reopenedPts;
  // When stale, fall back to the chart badge value (hit.burnedText) so the header
  // always reflects what the chart shows rather than displaying a misleading "0pts".
  const netLabel = !isStale
    ? (netPts > 0.001 ? `−${fmtPts(netPts)}` : netPts < -0.001 ? `+${fmtPts(-netPts)}` : '0pts')
    : (hit.burnedText ? `−${hit.burnedText}pts` : '?');

  let html = `<div class="dp-header">
    <span class="dp-date">${dayLabel(gapDays)}</span>
    <span class="dp-badge scope-down">Burned ${netLabel}</span>
    ${movedOut.length ? `<span class="dp-badge moved-out" title="Scope removed by moving stories to other sprints">−${fmtPts(movedOutPts)} moved out</span>` : ''}
    <div class="dp-header-actions">
      <button class="dp-refresh" title="Re-reconstruct this snapshot">↻ Refresh</button>
      <button class="dp-close" title="Close">✕</button>
    </div>
  </div>`;

  if (burned.length) {
    html += `<div class="dp-section"><div class="dp-section-label">Completed ${isToday ? 'today' : 'on this day'}</div><div class="dp-list">`;
    for (const wp of burned)
      html += `<div class="dp-item"><span class="dp-pts">−${fmtPts(wp.points)}</span><span class="dp-name">${wpLink(wp)}</span><span class="dp-from">${wp.fromStatus} → ${wp.toStatus}</span></div>`;
    html += `</div></div>`;
  }

  if (reopened.length) {
    html += `<div class="dp-section"><div class="dp-section-label">Reopened (un-burned)</div><div class="dp-list">`;
    for (const wp of reopened)
      html += `<div class="dp-item"><span class="dp-pts dp-pts-out">+${fmtPts(wp.points)}</span><span class="dp-name">${wpLink(wp)}</span><span class="dp-from">${wp.fromStatus} → ${wp.toStatus}</span></div>`;
    html += `</div></div>`;
  }

  if (movedOut.length) {
    html += `<div class="dp-section"><div class="dp-section-label">Moved to other sprint</div><div class="dp-list">`;
    for (const wp of movedOut)
      html += `<div class="dp-item"><span class="dp-pts dp-pts-moved">−${fmtPts(wp.points)}</span><span class="dp-name">${wpLink(wp)}</span><span class="dp-from">→ ${wp.toVersion || 'unversioned'}</span></div>`;
    html += `</div></div>`;
  }

  if (!burned.length && !reopened.length && !movedOut.length) {
    // isStale + isToday: today's detail couldn't be computed (sync failed or is off).
    html += `<p class="dp-empty">${
      isStale && isToday
        ? '⏳ Today is live until it ends (23:59 ICT) and its burn detail isn\'t computed yet — click ↻ Refresh.'
        : isStale
          ? '⚠ No burn detail available — click ↻ Refresh to re-reconstruct.'
          : 'No items burned or reopened this day.'
    }</p>`;
  }

  panel.innerHTML = html;
  panel.classList.add('visible');
  panel.querySelector('.dp-close')?.addEventListener('click', () => panel.classList.remove('visible'));
  panel.querySelector('.dp-refresh')?.addEventListener('click', async () => {
    await chrome.storage.local.remove([...coreKeys, ...detailKeys]);
    panel.classList.remove('visible');
    triggerSync();
  });
}

// ─── Backlog section ──────────────────────────────────────────────────────────

function buildBacklogSection(version, dateMap, sourcesMap = new Map(), movesMap = new Map(), throughputMap = new Map(), flowRecord = null, detailRecord = new Map(), syncMeta = null, hideFirstDay = false, versionStart = null) {
  const section = document.createElement('div'); section.className='backlog-section';

  // ── Version header: name, sync state, Copy chart, Delete all ──────────────
  const bar = document.createElement('div'); bar.className='backlog-title-bar';
  const title = document.createElement('h2'); title.className='backlog-title'; title.textContent=version;
  const chip = document.createElement('span');
  if (dateMap.has(todayStr())) {
    const at = syncMeta?.lastSync && new Date(syncMeta.lastSync);
    chip.className = 'sync-chip ok';
    chip.textContent = at && !isNaN(at) ? `synced ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'synced today';
  } else {
    chip.className = 'sync-chip warn';
    chip.textContent = 'not synced today';
    chip.title = 'No snapshot for today yet — click Sync Now';
  }
  const spacer = document.createElement('span'); spacer.className = 'spacer';
  const COPY_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`;
  const copyImgBtn = document.createElement('button'); copyImgBtn.type = 'button'; copyImgBtn.className='btn-copy-image';
  copyImgBtn.innerHTML = COPY_ICON + 'Copy chart';
  copyImgBtn.title = 'Copy chart as image to clipboard';
  const delVersionBtn = document.createElement('button'); delVersionBtn.type = 'button'; delVersionBtn.className='btn-delete-version'; delVersionBtn.textContent='Delete all';
  delVersionBtn.title = `Delete all snapshots for "${version}"`;
  bar.append(title, chip, spacer, copyImgBtn, delVersionBtn);
  section.appendChild(bar);

  // Delete a single date snapshot (core + detail)
  const onDeleteDate = async (date) => {
    if (!confirm(`Delete snapshot for "${version}" on ${date}?`)) return;
    const k = `${date}__${version}`;
    await chrome.storage.local.remove([k, DETAIL_PREFIX + k]);
    await renderAll();
  };

  // Delete all snapshots for this version (core + detail)
  delVersionBtn.addEventListener('click', async () => {
    const dates = [...dateMap.keys()];
    if (!confirm(`Delete all ${dates.length} snapshot${dates.length!==1?'s':''} for "${version}"? This cannot be undone.`)) return;
    const keys = dates.flatMap(d => { const k = `${d}__${version}`; return [k, DETAIL_PREFIX + k]; });
    await chrome.storage.local.remove(keys);
    await renderAll();
  });

  const chart = buildBurndownSection(version, dateMap, detailRecord, hideFirstDay, versionStart);
  section.appendChild(chart.el);

  // ── Table, CFD and Flow open as rows under the chart ──────────────────────
  const tableWrap = document.createElement('div'); tableWrap.className = 'sec-body';
  const flowPanel = buildFlowPanel(version, throughputMap, flowRecord);
  const cfd       = buildCFDSection(version, dateMap);
  let curS, curE;
  const row = (name, hint, body, onOpen) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'sec-row'; b.setAttribute('aria-expanded', 'false');
    b.innerHTML = `<strong>${name}</strong><span class="sec-hint">${hint}</span><span class="sec-chev" aria-hidden="true">▸</span>`;
    let open = false;
    const set = v => { open = v; b.setAttribute('aria-expanded', String(v)); onOpen(v); };
    b.addEventListener('click', () => set(!open));
    section.append(b, body);
    set(false);
    return { isOpen: () => open };
  };
  const tableRow = row('Snapshot table', 'status × day, CSV and moved-in/out badges, delete a day', tableWrap, v => {
    tableWrap.style.display = v ? '' : 'none';
    if (v) { tableWrap.innerHTML = ''; tableWrap.appendChild(buildTable(dateMap, curS, curE, onDeleteDate, sourcesMap, movesMap)); }
  });
  const cfdRow  = row('CFD', 'cumulative flow by status', cfd.el, v => { cfd.show(v); if (v) cfd.update(curS, curE); });
  const flowRow = row('Flow', 'throughput, rework and aging WIP', flowPanel.el, v => { flowPanel.show(v); if (v) flowPanel.update(curS, curE); });

  copyImgBtn.addEventListener('click', async () => {
    const canvas = chart.getCanvas();
    if (!canvas || canvas.style.display === 'none') return;
    try {
      const dataUrl = await copyChartImage(canvas, version, chart.isDoneShown());
      copyImgBtn.innerHTML = '✓ Copied';
      copyImgBtn.classList.add('copied');
      setTimeout(() => { copyImgBtn.innerHTML = COPY_ICON + 'Copy chart'; copyImgBtn.classList.remove('copied'); }, 2000);
      showCopyPreview(dataUrl);
    } catch(e) {
      console.error('[BacklogMonitor] Copy image failed:', e);
    }
  });

  return {
    el: section,
    getCanvas: chart.getCanvas,
    isDoneShown: chart.isDoneShown,
    isSyncedToday: () => dateMap.has(todayStr()),
    update(s,e) {
      curS = s; curE = e;
      if (tableRow.isOpen()) { tableWrap.innerHTML=''; tableWrap.appendChild(buildTable(dateMap,s,e,onDeleteDate,sourcesMap,movesMap)); }
      chart.update(s,e);
      if (cfdRow.isOpen())  cfd.update(s,e);
      if (flowRow.isOpen()) flowPanel.update(s,e);
    }
  };
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCSVRaw(text) {
  const rows=[]; let row=[], field='', inQ=false;
  for (let i=0; i<text.length; i++) {
    const ch=text[i], nx=text[i+1];
    if (inQ) {
      if (ch==='"'&&nx==='"') { field+='"'; i++; }
      else if (ch==='"')      { inQ=false; }
      else                    { field+=ch; }
    } else {
      if      (ch==='"')              { inQ=true; }
      else if (ch===',')              { row.push(field); field=''; }
      else if (ch==='\r'&&nx==='\n')  { row.push(field); rows.push(row); row=[]; field=''; i++; }
      else if (ch==='\n'||ch==='\r')  { row.push(field); rows.push(row); row=[]; field=''; }
      else                            { field+=ch; }
    }
  }
  row.push(field);
  if (row.some(f=>f!=='')) rows.push(row);
  return rows;
}

function parseCSV(text) {
  const rows = parseCSVRaw(text.trim());
  if (rows.length < 2) return { statuses:[], error:'File is empty or has no data rows.' };

  const headers   = rows[0].map(h=>h.trim());
  const statusIdx = headers.indexOf('Status');
  const ptsIdx    = headers.indexOf('Story Points');

  if (statusIdx===-1) return { statuses:[], error:'No "Status" column found. Is this an OpenProject CSV export?' };

  const map = new Map();
  for (const row of rows.slice(1)) {
    const s=(row[statusIdx]??'').trim(); if (!s) continue;
    if (!map.has(s)) map.set(s,{count:0,points:0});
    const e=map.get(s); e.count++;
    if (ptsIdx!==-1) { const p=parseFloat(row[ptsIdx]); if (!isNaN(p)) e.points+=p; }
  }
  if (!map.size) return { statuses:[], error:'No status groups found.' };

  return { statuses:[...map.entries()].map(([s,{count,points}])=>({ status:s, numOfStory:String(count), point:points>0?String(points):'0' })), error:null };
}

// ─── Import panel ─────────────────────────────────────────────────────────────

const importCards = new Map();
let   importSeq   = 0;
let   existingKeysCache = new Set();  // kept in sync after each import

function storageKey(date, name) { return `${date}__${name.trim()}`; }

function parseJsonExport(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return { entries: [], error: 'Invalid JSON.' }; }
  if (typeof raw !== 'object' || Array.isArray(raw) || !raw)
    return { entries: [], error: 'JSON must be a plain object (the format exported by this tool).' };
  const entries = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!DATE_KEY_PATTERN.test(k)) continue;
    const date = k.slice(0, 10);
    const { backlogVersion, statuses, source } = v ?? {};
    if (!backlogVersion || !Array.isArray(statuses))
      return { entries: [], error: `Entry "${k}" is missing backlogVersion or statuses.` };
    entries.push({ key: k, date, backlogVersion, statuses, source: source ?? 'json' });
  }
  if (!entries.length) return { entries: [], error: 'No valid snapshot entries found in this file.' };
  return { entries, error: null };
}


function sortFileList() {
  const list = document.getElementById('file-list');
  [...list.querySelectorAll('.file-row')]
    .sort((a, b) => a.querySelector('.file-row-name').textContent
      .localeCompare(b.querySelector('.file-row-name').textContent, undefined, { numeric: true, sensitivity: 'base' }))
    .forEach(r => list.appendChild(r));
}

/**
 * Generate `count` dates from `base`, skipping weekends unless the date is
 * in the `includedWeekends` Set.
 */
function fillDates(base, count, includedWeekends) {
  const dates = [];
  const dt = new Date(base + 'T12:00:00Z');
  while (dates.length < count) {
    const d   = dt.toISOString().slice(0, 10);
    const day = dt.getUTCDay();
    if (!isWeekend(d) || includedWeekends.has(d)) dates.push(d);
    if (dates.length < count) dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return dates;
}

const importWeekendSelected = new Set();

function rebuildWeekendBoxes() {
  const base  = document.getElementById('import-base-date')?.value;
  const grp   = document.getElementById('import-weekend-grp');
  const box   = document.getElementById('import-weekend-boxes');
  if (!grp || !box) return;

  const rowCount = document.querySelectorAll('.file-row[data-type="csv"]:not(.row-error)').length;
  if (!base || rowCount === 0) { grp.style.display = 'none'; return; }

  // Scan enough calendar days to cover all rows even with no weekends included
  const scanEnd = addDays(base, rowCount + Math.ceil(rowCount / 5) * 2 + 6);
  const weekendDays = calendarRange(base, scanEnd).filter(isWeekend);

  box.innerHTML = '';
  if (!weekendDays.length) { grp.style.display = 'none'; return; }

  grp.style.display = '';
  weekendDays.forEach(d => {
    const dt      = new Date(d + 'T12:00:00Z');
    const dayName = dt.toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' });
    const lbl = document.createElement('label'); lbl.className = 'done-label';
    const cb  = document.createElement('input'); cb.type = 'checkbox';
    cb.checked = importWeekendSelected.has(d);
    cb.addEventListener('change', () => {
      if (cb.checked) importWeekendSelected.add(d); else importWeekendSelected.delete(d);
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(` ${d.slice(5)} (${dayName})`));
    box.appendChild(lbl);
  });
}

// ─── Row drag-to-reorder ──────────────────────────────────────────────────────

let dragSrc = null;

function initRowDrag(row) {
  const handle = row.querySelector('.row-handle');
  if (!handle) return;

  // Only start drag from the handle
  handle.addEventListener('mousedown', () => { row.setAttribute('draggable', 'true'); });
  handle.addEventListener('mouseup',   () => { row.setAttribute('draggable', 'false'); });

  row.addEventListener('dragstart', e => {
    dragSrc = row;
    e.dataTransfer.effectAllowed = 'move';
    // Defer so the drag image captures the un-faded element
    setTimeout(() => row.classList.add('dragging'), 0);
  });

  row.addEventListener('dragend', () => {
    dragSrc = null;
    row.classList.remove('dragging');
    document.querySelectorAll('.file-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    row.setAttribute('draggable', 'false');
  });

  row.addEventListener('dragover', e => {
    if (!dragSrc || dragSrc === row) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.file-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    row.classList.add('drag-over');
  });

  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));

  row.addEventListener('drop', e => {
    e.preventDefault();
    if (!dragSrc || dragSrc === row) return;
    row.classList.remove('drag-over');
    const list = document.getElementById('file-list');
    const rows = [...list.querySelectorAll('.file-row')];
    const srcIdx = rows.indexOf(dragSrc);
    const tgtIdx = rows.indexOf(row);
    list.insertBefore(dragSrc, srcIdx < tgtIdx ? row.nextSibling : row);
  });
}

// Show/hide the shared controls area based on whether CSV rows exist
function syncSharedPanel() {
  const hasCsv = [...document.querySelectorAll('.file-row[data-type="csv"]')].length > 0;
  document.getElementById('import-shared').classList.toggle('visible', hasCsv);
}

function sharedName() {
  return (document.getElementById('import-shared-name')?.value ?? '').trim();
}

function validateRow(row) {
  const date  = row.querySelector('.row-date').value;
  const name  = sharedName();
  const badge = row.querySelector('.row-badge');
  if (!date) { badge.textContent = 'Pick a date'; badge.className = 'row-badge empty'; return false; }
  if (!name) { badge.textContent = 'Enter name ↑'; badge.className = 'row-badge empty'; return false; }
  if (existingKeysCache.has(storageKey(date, name))) {
    badge.textContent = '✗ Already exists'; badge.className = 'row-badge taken'; return false;
  }
  badge.textContent = '✓'; badge.className = 'row-badge ok'; return true;
}

function refreshImportBtn() {
  const csvRows  = [...document.querySelectorAll('.file-row[data-type="csv"]')];
  const jsonRows = [...document.querySelectorAll('.file-row[data-type="json"]')];
  const allRows  = [...csvRows, ...jsonRows];
  if (!allRows.length) { document.getElementById('btn-import-all').disabled = true; return; }

  const csvOk  = csvRows.every(r => { const d = importCards.get(Number(r.dataset.id)); return d && !d.error && validateRow(r); });
  const jsonOk = jsonRows.every(r => { const d = importCards.get(Number(r.dataset.id)); return d && !d.error && d.entries.some(e => !existingKeysCache.has(e.key)); });
  document.getElementById('btn-import-all').disabled = !(csvOk && jsonOk);
}

// Re-validate all CSV rows (called when shared name changes)
function revalidateAll() {
  document.querySelectorAll('.file-row[data-type="csv"]').forEach(r => validateRow(r));
  refreshImportBtn();
}

async function addFileCard(file) {
  const id   = ++importSeq;
  const text = await file.text();
  const { statuses, error } = parseCSV(text);
  importCards.set(id, { type: 'csv', statuses, error });

  const row = document.createElement('div');
  row.className = 'file-row' + (error ? ' row-error' : '');
  row.dataset.id = id; row.dataset.type = 'csv';

  // Drag handle
  const handle = document.createElement('span'); handle.className = 'row-handle'; handle.textContent = '⠿'; handle.title = 'Drag to reorder';
  row.appendChild(handle);

  // Filename
  const nm = document.createElement('span'); nm.className = 'file-row-name'; nm.textContent = file.name;
  row.appendChild(nm);

  if (error) {
    const err = document.createElement('span'); err.className = 'parse-error'; err.textContent = 'Parse error: ' + error;
    row.appendChild(err);
  } else {
    // Date picker
    const di = document.createElement('input'); di.type = 'date'; di.className = 'field-date row-date'; di.value = todayStr();
    row.appendChild(di);

    // Status badge
    const badge = document.createElement('span'); badge.className = 'row-badge empty';
    row.appendChild(badge);

    // Status chips
    const chips = document.createElement('div'); chips.className = 'status-chips';
    statuses.forEach(({ status, numOfStory, point }) => {
      const c = document.createElement('span'); c.className = 'status-chip';
      c.innerHTML = `<span class="chip-name">${status}</span><span class="chip-count">${numOfStory}</span><span class="chip-pts">${point}pts</span>`;
      chips.appendChild(c);
    });
    row.appendChild(chips);

    di.addEventListener('change', () => { validateRow(row); refreshImportBtn(); });
  }

  // Remove button
  const rm = document.createElement('button'); rm.className = 'btn-remove'; rm.textContent = '×'; rm.title = 'Remove';
  rm.addEventListener('click', () => { importCards.delete(id); row.remove(); syncSharedPanel(); rebuildWeekendBoxes(); revalidateAll(); });
  row.appendChild(rm);

  document.getElementById('file-list').appendChild(row);
  initRowDrag(row);
  sortFileList();
  syncSharedPanel();
  rebuildWeekendBoxes();
  if (!error) validateRow(row);
  refreshImportBtn();
}

async function addJsonCard(file) {
  const id   = ++importSeq;
  const text = await file.text();
  const { entries, error } = parseJsonExport(text);
  importCards.set(id, { type: 'json', entries, error });

  const row = document.createElement('div');
  row.className = 'file-row' + (error ? ' row-error' : '');
  row.dataset.id = id; row.dataset.type = 'json';

  // Drag handle
  const handle = document.createElement('span'); handle.className = 'row-handle'; handle.textContent = '⠿'; handle.title = 'Drag to reorder';
  row.appendChild(handle);

  const nm = document.createElement('span'); nm.className = 'file-row-name'; nm.textContent = file.name;
  row.appendChild(nm);

  if (error) {
    const err = document.createElement('span'); err.className = 'parse-error'; err.textContent = 'Parse error: ' + error;
    row.appendChild(err);
  } else {
    const chips = document.createElement('div'); chips.className = 'status-chips';
    for (const e of entries) {
      const exists = existingKeysCache.has(e.key);
      const c = document.createElement('span');
      c.className = 'status-chip' + (exists ? ' chip-exists' : '');
      c.title = exists ? 'Already in store — will be skipped' : '';
      c.innerHTML = `<span class="chip-name">${e.date}</span><span class="chip-count">${e.backlogVersion}</span><span class="chip-pts">${e.statuses.length} statuses</span>${exists ? '<span class="chip-skip">exists</span>' : ''}`;
      chips.appendChild(c);
    }
    row.appendChild(chips);
  }

  const rm = document.createElement('button'); rm.className = 'btn-remove'; rm.textContent = '×'; rm.title = 'Remove';
  rm.addEventListener('click', () => { importCards.delete(id); row.remove(); refreshImportBtn(); });
  row.appendChild(rm);

  document.getElementById('file-list').appendChild(row);
  initRowDrag(row);
  sortFileList();
  refreshImportBtn();
}

async function importAll() {
  const btn = document.getElementById('btn-import-all');
  const res = document.getElementById('import-result');
  btn.disabled = true; res.textContent = ''; res.className = '';

  const name = sharedName();
  let saved = 0; const errors = [];

  for (const row of [...document.querySelectorAll('.file-row')]) {
    const id   = Number(row.dataset.id);
    const data = importCards.get(id);
    if (!data || data.error) continue;

    if (data.type === 'json') {
      for (const e of data.entries) {
        const fresh = await chrome.storage.local.get(e.key);
        if (fresh[e.key]) continue;
        try {
          await chrome.storage.local.set({ [e.key]: { backlogVersion: e.backlogVersion, statuses: e.statuses, source: e.source } });
          existingKeysCache.add(e.key); saved++;
        } catch(err) { errors.push(`Failed "${e.key}": ${err.message}`); }
      }
      row.style.opacity = '0.45'; row.style.pointerEvents = 'none';
    } else {
      const date = row.querySelector('.row-date').value;
      if (!name || !date) continue;
      const key = storageKey(date, name);
      const fresh = await chrome.storage.local.get(key);
      if (fresh[key]) { errors.push(`"${name}" on ${date} already exists.`); continue; }
      try {
        await chrome.storage.local.set({ [key]: structuredClone({ backlogVersion: name, statuses: data.statuses, source: 'csv' }) });
        existingKeysCache.add(key); saved++;
        row.style.opacity = '0.45'; row.style.pointerEvents = 'none';
        const b = row.querySelector('.row-badge'); b.textContent = '✓ Imported'; b.className = 'row-badge ok';
      } catch(e) { errors.push(`Failed "${name}": ${e.message}`); }
    }
  }

  if (errors.length) { res.textContent = errors.join(' · '); res.className = 'error'; }
  else               { res.textContent = `✓ ${saved} snapshot${saved !== 1 ? 's' : ''} imported.`; res.className = 'success'; }

  if (saved > 0) await renderAll();

  setTimeout(() => {
    document.querySelectorAll('.file-row').forEach(r => { if (r.style.opacity === '0.45') { importCards.delete(Number(r.dataset.id)); r.remove(); } });
    syncSharedPanel(); refreshImportBtn();
  }, 900);
}

function dispatchFile(f) {
  if      (f.name.endsWith('.json')) addJsonCard(f);
  else if (f.name.endsWith('.csv'))  addFileCard(f);
}

function initImportPanel() {
  const dropZone  = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { [...fileInput.files].forEach(dispatchFile); fileInput.value = ''; });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); [...e.dataTransfer.files].forEach(dispatchFile); });

  document.getElementById('import-shared-name').addEventListener('input', revalidateAll);

  // Sprint selector → set base date to sprint start
  document.getElementById('import-sprint-sel').addEventListener('change', (ev) => {
    const v = ev.target.value;
    if (!v) return;
    const [start] = v.split('|');
    document.getElementById('import-base-date').value = start;
    rebuildWeekendBoxes();
  });

  // Fill dates: assign base date + 0, 1, 2, … days to CSV rows in list order
  document.getElementById('import-base-date').addEventListener('change', rebuildWeekendBoxes);

  document.getElementById('btn-fill-dates').addEventListener('click', () => {
    const base = document.getElementById('import-base-date').value;
    if (!base) return;
    // Use current DOM order (user may have reordered via drag)
    const rows  = [...document.querySelectorAll('.file-row[data-type="csv"]:not(.row-error)')];
    const dates = fillDates(base, rows.length, importWeekendSelected);
    rows.forEach((r, i) => {
      r.querySelector('.row-date').value = dates[i];
      validateRow(r);
    });
    refreshImportBtn();
  });

  document.getElementById('btn-import-all').addEventListener('click', importAll);

  document.getElementById('btn-toggle-import').addEventListener('click', () => {
    const panel = document.getElementById('import-panel');
    panel.classList.toggle('open');
    document.getElementById('more-details')?.removeAttribute('open');
  });

  document.getElementById('btn-import-panel-close').addEventListener('click', () => {
    document.getElementById('import-panel').classList.remove('open');
  });
}

// ─── Sync progress bar ───────────────────────────────────────────────────────

let isSyncing = false;
let syncSavedCount = 0;

function showProgressBar() {
  isSyncing = true;
  syncSavedCount = 0;
  const bar  = document.getElementById('sync-progress-bar');
  const fill = document.querySelector('.sync-progress-fill');
  const txt  = document.getElementById('sync-progress-text');
  if (bar)  bar.classList.add('active');
  if (fill) { fill.style.width = '0%'; fill.classList.add('indeterminate'); }
  if (txt)  txt.textContent = 'Syncing…';
}

function setProgressFill(done, total, label) {
  const fill = document.querySelector('.sync-progress-fill');
  const txt  = document.getElementById('sync-progress-text');
  if (fill) {
    fill.classList.remove('indeterminate');
    fill.style.width = `${Math.round(done / total * 100)}%`;
  }
  if (txt) txt.textContent = label;
}

function updateProgressBar(versionName) {
  syncSavedCount++;
  const fill = document.querySelector('.sync-progress-fill');
  const txt  = document.getElementById('sync-progress-text');
  if (fill) fill.classList.add('indeterminate');
  if (txt)  txt.textContent = `${syncSavedCount} snapshot${syncSavedCount !== 1 ? 's' : ''} saved`;
}

function hideProgressBar() {
  isSyncing = false;
  const bar  = document.getElementById('sync-progress-bar');
  const fill = document.querySelector('.sync-progress-fill');
  if (bar)  bar.classList.remove('active');
  if (fill) { fill.classList.remove('indeterminate'); fill.style.width = '0%'; }
}


// ─── Page render ──────────────────────────────────────────────────────────────

// Preserved across re-renders so the user's date selections aren't lost
let startInput = null, endInput = null;
let sectionUpdaters = [];
let sectionCanvasGetters = []; // { version, getCanvas }
let dateListenersSet = false;

let autoTrackTried = false;

// Opened in the drawer next to OpenProject's Create button (quick-settings-host.js):
// current sprint only, no rail; × and Escape ask the drawer to close.
const EMBEDDED = new URLSearchParams(location.search).has('embedded');
if (EMBEDDED) {
  document.documentElement.classList.add('embedded');
  const closeDrawer = () => window.parent.postMessage({ type: 'blm-drawer-close' }, '*');
  const btn = document.getElementById('btn-close-embedded');
  btn.hidden = false;
  btn.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
}

// ── Drawer: the version of the list it was opened from ───────────────────────
// content.js passes what it can read off the work-package list (project identifier,
// the list's version filter, its title). The first time a version is opened the user
// gives the sprint's planned dates (prefilled from the version); the chart then runs
// from the planned start to the planned end. Plans live in their own key and the full
// page never reads them, so the old Burndown page is unaffected. When no version can
// be resolved the drawer falls back to the current sprint, as before.
const EMBED_PARAMS = new URLSearchParams(location.search);
const PLAN_KEY = '__blm_burndown_plan';   // { [versionId]: { start, end } }
let embeddedTarget = null;                // { project, version } once resolved
let embeddedPlan = null;
let embeddedResolved = false;

async function fetchVersionById(id) {
  const res = await fetch(`${BACKLOG_URL}/api/v3/versions/${encodeURIComponent(id)}`,
    { credentials: 'include', headers: { Accept: 'application/hal+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function resolveEmbeddedTarget() {
  if (embeddedResolved) return embeddedTarget;
  embeddedResolved = true;
  const ident = EMBED_PARAMS.get('project');
  const title = (EMBED_PARAMS.get('title') ?? '').trim().toLowerCase();
  const ids   = (EMBED_PARAMS.get('versions') ?? '').split(',').filter(Boolean);
  if (!ident && !ids.length) return null;
  try {
    const projects = await fetchActiveProjects();
    let project = ident ? projects.find(p => p.identifier === ident) : null;
    if (!project && ids.length) {   // a cross-project list: the filtered version knows its project
      const owner = /(\d+)\s*$/.exec((await fetchVersionById(ids[0]))._links?.definingProject?.href ?? '')?.[1];
      project = projects.find(p => String(p.id) === owner);
    }
    if (!project) return null;
    const versions = await fetchAllVersions(project.id);
    const version = versions.find(v => ids.includes(String(v.id)))
      ?? versions.find(v => v.name.toLowerCase() === title)
      ?? versions.filter(v => title.includes(v.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
    if (!version) return null;
    embeddedTarget = { project, version };
    embeddedPlan = ((await chrome.storage.local.get(PLAN_KEY))[PLAN_KEY] ?? {})[version.id] ?? null;
    // Plans made by the old default started on the Monday after the version's planning Friday,
    // so the drawer showed other dates than the page.  Move those to the version's own start
    // (the planning day is then hidden by "Hide first day", as on the page); a hand-picked start stays.
    if (embeddedPlan && version.startDate && embeddedPlan.start !== version.startDate
        && embeddedPlan.start === addDays(version.startDate, (8 - new Date(version.startDate + 'T12:00:00Z').getUTCDay()) % 7 || 7)) {
      await saveEmbeddedPlan(version.startDate, embeddedPlan.end);
    }
  } catch { embeddedTarget = null; }
  return embeddedTarget;
}

async function saveEmbeddedPlan(start, end) {
  embeddedPlan = { start, end };
  const plans = (await chrome.storage.local.get(PLAN_KEY))[PLAN_KEY] ?? {};
  plans[embeddedTarget.version.id] = embeddedPlan;
  await chrome.storage.local.set({ [PLAN_KEY]: plans });
}

let embeddedSyncTried = false;
/** What the empty chart means while the shown version's history is still being fetched. */
async function emptyVersionNote(noData, name) {
  const syncOn = (await chrome.storage.local.get('__blm_sync_burndown')).__blm_sync_burndown ?? true;
  if (syncOn) {
    const spin = document.createElement('span'); spin.className = 'spinner'; spin.setAttribute('aria-hidden', 'true');
    noData.setAttribute('role', 'status');
    noData.replaceChildren(spin, document.createTextNode(`No data for ${name} yet — fetching it from OpenProject. The chart appears here when it's ready.`));
    return;
  }
  // The background fetches nothing while "Burndown sync" is off, so the chart can never fill
  const turnOn = document.createElement('button');
  turnOn.type = 'button';
  turnOn.textContent = 'Turn on Burndown sync';
  turnOn.addEventListener('click', async () => {
    turnOn.disabled = true;
    await chrome.storage.local.set({ __blm_sync_burndown: true });
    embeddedSyncTried = true;
    triggerSync();
    emptyVersionNote(noData, name);
  });
  noData.replaceChildren(`Burndown sync is switched off, so nothing is collected for ${name}.`, document.createElement('br'), turnOn);
}

/** First open of a version: ask for the planned dates instead of drawing a chart. */
function showPlanSetup(output, noData) {
  const { version } = embeddedTarget;
  const fallback = sprintInfo(sprintIndexForDate(todayStr()));
  noData.style.display = 'none';
  output.replaceChildren();
  const box = document.createElement('div');
  box.className = 'panel plan-setup';
  box.style.cssText = 'display:block;max-width:520px;margin:32px auto;padding:20px;';
  const title = document.createElement('div');
  title.className = 'panel-heading';
  title.textContent = `Plan ${version.name}`;
  const hint = document.createElement('p');
  hint.style.cssText = 'color:var(--muted);font-size:13px;margin:12px 0;';
  hint.textContent = 'Which days is this sprint planned for? The burndown runs from the first day to the last.';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;';
  const field = (label, id, value) => {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);';
    const input = document.createElement('input');
    input.type = 'date'; input.id = id; input.className = 'ctrl-date'; input.value = value;
    wrap.append(label, input);
    return [wrap, input];
  };
  const [startWrap, start] = field('Sprint start', 'plan-start', version.startDate ?? fallback.start);
  const [endWrap, end]     = field('Sprint end', 'plan-end', version.endDate ?? fallback.end);
  const go = document.createElement('button');
  go.type = 'button'; go.textContent = 'Show burndown';
  const msg = document.createElement('span');
  msg.style.cssText = 'font-size:12px;color:var(--muted);';
  go.addEventListener('click', async () => {
    if (!start.value || !end.value || start.value > end.value) { msg.textContent = 'Pick a start date on or before the end date.'; return; }
    go.disabled = true;
    await saveEmbeddedPlan(start.value, end.value);
    autoTrackTried = false;
    renderAll();
  });
  row.append(startWrap, endWrap, go);
  box.append(title, hint, row, msg);
  output.append(box);
}

/** Adds the current sprint's version of the user's project ("<project> <sprint>")
 *  to the tracked list when it's missing, so the chart opens on it. Returns the
 *  tracked list, unchanged when the project/version isn't found or the lookup fails. */
async function autoTrackCurrentVersion(tracked) {
  const name = currentMainViewVersion();
  if (!name) return tracked;
  const have = tracked.find(t => sameVersion(t.versionName, name));
  if (have) {
    // Tracked before the sprint dates were known: history is only rebuilt from a start date
    if (embeddedPlan && !have.startDate) {
      const next = tracked.map(t => t === have ? { ...t, startDate: embeddedPlan.start, endDate: t.endDate ?? embeddedPlan.end } : t);
      await chrome.storage.local.set({ [TRACKED_KEY]: next });
      return next;
    }
    return tracked;
  }
  try {
    const project = embeddedTarget?.project ?? (await fetchActiveProjects()).find(p => p.name === mainViewProject);
    if (!project) return tracked;
    const v = embeddedTarget?.version ?? (await fetchAllVersions(project.id)).find(v => sameVersion(v.name, name));
    if (!v) return tracked;
    // First in the list: the background syncs tracked versions in order, so the
    // sprint the user is waiting on gets its snapshots before the others.
    const next = [{
      projectId: project.id, projectName: project.name,
      versionId: v.id,      versionName: v.name,
      // History is rebuilt from the version's own start (the planning Friday), which is
      // also the baseline the chart measures the first visible day against
      startDate: v.startDate ?? embeddedPlan?.start ?? null, endDate: v.endDate ?? embeddedPlan?.end ?? null,
    }, ...tracked];
    await chrome.storage.local.set({ [TRACKED_KEY]: next });
    embeddedSyncTried = true;   // one sync for the new version, not a second from renderAll
    triggerSync();
    return next;
  } catch { return tracked; }
}

async function renderAll() {
  const output  = document.getElementById('output');
  const noData  = document.getElementById('no-data');

  if (EMBEDDED && await resolveEmbeddedTarget() && !embeddedPlan) { showPlanSetup(output, noData); return; }

  // ── No versions tracked ───────────────────────────────────────────────────
  let tracked = (await chrome.storage.local.get(TRACKED_KEY))[TRACKED_KEY] ?? [];
  // The current sprint's version is always tracked, so the chart always has it to show
  if (!autoTrackTried) {
    autoTrackTried = true;
    tracked = await autoTrackCurrentVersion(tracked);
  }
  if (!tracked.length) {
    output.innerHTML = '';
    noData.style.display = 'block';
    noData.innerHTML = `
      <div id="no-versions-msg">
        <div class="nv-icon">📋</div>
        <div class="nv-title">No versions selected</div>
        <div class="nv-body">Choose the sprint versions you want to monitor to start tracking.</div>
        <button id="btn-no-versions-cta">⚙ Configure Versions</button>
      </div>`;
    document.getElementById('btn-no-versions-cta')
      ?.addEventListener('click', () => toggleVersionPanel(true));
    return;
  }

  const all       = await chrome.storage.local.get(null);
  const snapshots = await loadSnapshots(all);

  // Update existing-keys cache and datalist (used by import panel)
  existingKeysCache = new Set(snapshots.map(s=>`${s.date}__${s.backlogVersion}`));
  const PERMANENT_NAMES = ['CreditUtility', 'MB'];
  const versions = [...new Set([...PERMANENT_NAMES, ...snapshots.map(s=>s.backlogVersion)])].sort();
  const dl = document.getElementById('blm-versions-list');
  dl.innerHTML = '';
  versions.forEach(v=>{ const o=document.createElement('option'); o.value=v; dl.appendChild(o); });
  // Also keep the import-specific datalist in sync
  const dl2 = document.getElementById('blm-name-list');
  if (dl2) {
    const extra = versions.filter(v => !PERMANENT_NAMES.includes(v));
    extra.forEach(v=>{ const o=document.createElement('option'); o.value=v; dl2.appendChild(o); });
  }

  // Set up global date inputs on first call only — default to current sprint range
  if (!startInput) {
    startInput = document.getElementById('global-start');
    endInput   = document.getElementById('global-end');
    const currentSprint = sprintInfo(sprintIndexForDate(todayStr()));
    startInput.value = currentSprint.start;
    endInput.value   = currentSprint.end;
  }
  if (embeddedPlan) { startInput.value = embeddedPlan.start; endInput.value = embeddedPlan.end; }

  if (!dateListenersSet && startInput) {
    const onChange = () => {
      // Manual date edit → the range is now a custom one
      const fs = document.getElementById('filter-sprint');
      if (fs) fs.value = 'custom';
      sectionUpdaters.forEach(u=>u(startInput.value, endInput.value));
      if (embeddedTarget && startInput.value && endInput.value) saveEmbeddedPlan(startInput.value, endInput.value);
    };
    startInput.addEventListener('change', onChange);
    endInput.addEventListener('change',   onChange);
    dateListenersSet = true;
  }

  // Rebuild data sections
  output.innerHTML = '';
  sectionUpdaters      = [];
  sectionCanvasGetters = [];

  // The current version is always shown (the drawer's version in the drawer). Nothing
  // stored for it yet: fetch its history now and say so, rather than showing other
  // versions in its place.
  const mainVer      = currentMainViewVersion();
  const showMainOnly = (EMBEDDED || mainViewOnly) && !!mainVer;
  if (showMainOnly && !snapshots.some(s => sameVersion(s.backlogVersion, mainVer))) {
    emptyVersionNote(noData, mainVer);
    noData.style.display = 'block';
    if (!embeddedSyncTried && (all.__blm_sync_burndown ?? true)) { embeddedSyncTried = true; triggerSync(); }
    return;
  }
  if (!snapshots.length) { noData.style.display='block'; return; }
  noData.style.display='none';

  const byVersion    = groupByVersion(snapshots);
  const bySources    = groupSources(snapshots);
  const byMoves      = groupMoves(snapshots);
  const byThroughput = groupThroughput(all, DETAIL_PREFIX);
  const byFlow       = groupFlow(all);
  const byDetail     = groupDetail(all, DETAIL_PREFIX);
  const frag = document.createDocumentFragment();

  // Main-view filter: when ON, render ONLY "<project> <CurrentSprint>". Without a known
  // project (signed out, no membership) every version is rendered instead.
  const applyMainOnly = showMainOnly;
  for (const [version, dateMap] of byVersion) {
    if (applyMainOnly && !sameVersion(version, mainVer)) continue;
    const sourcesMap    = bySources.get(version)    ?? new Map();
    const movesMap      = byMoves.get(version)      ?? new Map();
    const throughputMap = byThroughput.get(version) ?? new Map();
    const flowRecord    = byFlow.get(version)       ?? null;
    const detailRecord  = byDetail.get(version)     ?? new Map();
    const { el, update, getCanvas, isDoneShown, isSyncedToday } = buildBacklogSection(version, dateMap, sourcesMap, movesMap, throughputMap, flowRecord, detailRecord, all.__blm_sync_meta ?? null, all[HIDE_FIRST_DAY_KEY] !== false,
      tracked.find(t => sameVersion(t.versionName, version))?.startDate ?? null);
    sectionUpdaters.push(update);
    sectionCanvasGetters.push({ version, getCanvas, isDoneShown, isSyncedToday });
    frag.appendChild(el);
  }
  output.appendChild(frag);
  sectionUpdaters.forEach(u=>u(startInput.value, endInput.value));

  populateSprintSelector();
}

// ─── Main-view filter (auto-show only current sprint for one project) ────────

const MAIN_VIEW_STATE_KEY   = '__blm_main_view_only';
const MAIN_VIEW_PROJECT_KEY = '__blm_main_view_project';
let mainViewOnly = true;    // default ON; overwritten from storage on load
let mainViewProject = null; // one of the signed-in user's projects; null = unknown

/** The version name we auto-focus when Main-view is on: "<project> <sprint>"
 *  using the same sprint math as the sprint selector, e.g. "Credit Utility 26.07.C".
 *  Null until the user's project is known. */
/** Version names compare with runs of spaces collapsed: some OpenProject versions are named
 *  "Credit Utility  26.12.C" (two spaces) while the sprint math builds "Credit Utility 26.12.C". */
function sameVersion(a, b) {
  const norm = v => String(v ?? '').replace(/s+/g, ' ').trim();
  return !!a && !!b && norm(a) === norm(b);
}

function currentMainViewVersion() {
  if (embeddedTarget) return embeddedTarget.version.name;   // the drawer was opened for this version
  if (!mainViewProject) return null;
  const s = sprintInfo(sprintIndexForDate(todayStr()));
  return `${mainViewProject} ${s.name}`;
}

// ─── Sprint math (2-week sprints; anchor start: 2026-04-10 = "26.04.B") ───────
//
// A sprint starts on its planning Friday and ends on the Thursday 13 days later, as the
// OpenProject versions do; the next Friday is the next sprint's planning day.  The name
// still comes from the month of that next Friday.
// Example: 26.04.B = 2026-04-10 (Fri) → 2026-04-23 (Thu)
//          26.05.A = 2026-04-24 (Fri) → 2026-05-07 (Thu)

const SPRINT_DAY_MS       = 86400000;
const SPRINT_LEN_DAYS     = 14;
const SPRINT_ANCHOR_START = Date.UTC(2026, 3, 10); // 2026-04-10

function sprintIndexForDate(dateStr) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m-1, d);
  return Math.floor((t - SPRINT_ANCHOR_START) / (SPRINT_LEN_DAYS * SPRINT_DAY_MS));
}

function sprintEndMs(idx) {
  // End = start of the NEXT sprint (the shared planning Friday)
  return SPRINT_ANCHOR_START + (idx + 1) * SPRINT_LEN_DAYS * SPRINT_DAY_MS;
}

function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function sprintInfo(idx) {
  const startMs = SPRINT_ANCHOR_START + idx * SPRINT_LEN_DAYS * SPRINT_DAY_MS;
  const endMs   = sprintEndMs(idx);
  const end     = new Date(endMs);
  const endY = end.getUTCFullYear(), endM = end.getUTCMonth();

  // Walk back to find first sprint whose end is in the same month/year; letter = offset.
  let first = idx;
  while (true) {
    const prev = new Date(sprintEndMs(first - 1));
    if (prev.getUTCFullYear() === endY && prev.getUTCMonth() === endM) first--;
    else break;
  }
  const letter = String.fromCharCode(65 + (idx - first));
  const name = `${String(endY).slice(-2)}.${String(endM+1).padStart(2,'0')}.${letter}`;
  return { idx, name, start: fmtDate(startMs), end: fmtDate(endMs - SPRINT_DAY_MS) };
}

function populateSprintSelector() {
  const currentIdx = sprintIndexForDate(todayStr());
  // Current sprint + 9 previous = 10 total
  const sprints = Array.from({ length: 10 }, (_, i) => sprintInfo(currentIdx - i));
  const opts = sprints.map(s => `<option value="${s.start}|${s.end}|${s.name}">${s.name} (${s.start} → ${s.end})</option>`).join('');
  const stepOpts = sprints.map(s => `<option value="${s.start}|${s.end}|${s.name}">${s.name} · ${s.start.slice(5)} → ${s.end.slice(5)}</option>`).join('');

  const filterSel = document.getElementById('filter-sprint');
  if (filterSel) {
    const prev = filterSel.value;
    const currentSprint = sprintInfo(sprintIndexForDate(todayStr()));
    const currentVal = `${currentSprint.start}|${currentSprint.end}|${currentSprint.name}`;
    filterSel.innerHTML = stepOpts + '<option value="custom">Custom range…</option>';
    filterSel.value = prev || currentVal;
    if (!filterSel.value) filterSel.value = 'custom';   // the range matches no sprint in the list
    showCustomRange(filterSel.value === 'custom');
  }

  const exportSel = document.getElementById('export-sprint');
  if (exportSel) {
    exportSel.innerHTML = '<option value="">Export sprint…</option>' + opts;
  }

  // Import sprint selector — default to current sprint
  const importSel = document.getElementById('import-sprint-sel');
  if (importSel) {
    const prevImport = importSel.value;
    const currentSprint = sprintInfo(sprintIndexForDate(todayStr()));
    const currentVal = `${currentSprint.start}|${currentSprint.end}|${currentSprint.name}`;
    importSel.innerHTML = '<option value="">— Sprint —</option>' + opts;
    // Restore previous or default to current sprint
    importSel.value = prevImport || currentVal;
    // Set base date if not yet set
    const baseDateEl = document.getElementById('import-base-date');
    if (baseDateEl && !baseDateEl.value) {
      baseDateEl.value = currentSprint.start;
      rebuildWeekendBoxes();
    }
  }
}

// ─── Toolbar actions ──────────────────────────────────────────────────────────

function showUnsyncedConfirm(unsyncedVersions, onConfirm) {
  let modal = document.getElementById('unsynced-confirm-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'unsynced-confirm-modal';
    document.body.appendChild(modal);
  }

  const list = unsyncedVersions.map(v => `<li>${v}</li>`).join('');
  modal.innerHTML = `
    <div id="unsynced-backdrop"></div>
    <div id="unsynced-box">
      <div id="unsynced-icon">⚠</div>
      <div id="unsynced-title">Not synced today</div>
      <div id="unsynced-body">
        The following backlog${unsyncedVersions.length > 1 ? 's have' : ' has'} no snapshot for today:
        <ul id="unsynced-list">${list}</ul>
        The chart${unsyncedVersions.length > 1 ? 's' : ''} will show data up to the last available date. Continue?
      </div>
      <div id="unsynced-actions">
        <button id="unsynced-cancel">Cancel</button>
        <button id="unsynced-confirm">Generate anyway</button>
      </div>
    </div>
  `;
  modal.style.display = 'block';

  const close = () => { modal.style.display = 'none'; };
  modal.querySelector('#unsynced-backdrop').addEventListener('click', close);
  modal.querySelector('#unsynced-cancel').addEventListener('click', close);
  modal.querySelector('#unsynced-confirm').addEventListener('click', () => { close(); onConfirm(); });
}

function showCopySelectModal(preSelected = null) {
  const modal   = document.getElementById('copy-select-modal');
  const list    = document.getElementById('copy-select-list');
  const goBtn   = document.getElementById('btn-copy-select-go');
  const allBtn  = document.getElementById('btn-copy-select-all');

  list.innerHTML = '';
  const items = sectionCanvasGetters;
  if (!items.length) return;

  const selected = new Set(preSelected ?? items.map(s => s.version));

  function refresh() {
    const count = selected.size;
    goBtn.disabled    = count === 0;
    goBtn.textContent = count > 0 ? `Copy Charts (${count})` : 'Copy Charts';
    allBtn.textContent = selected.size === items.length ? 'Deselect all' : 'Select all';
  }

  for (const { version } of items) {
    const row = document.createElement('label');
    row.className = 'copy-select-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = selected.has(version);
    cb.addEventListener('change', () => {
      cb.checked ? selected.add(version) : selected.delete(version);
      refresh();
    });

    const name = document.createElement('span');
    name.className = 'row-name'; name.textContent = version;

    row.appendChild(cb); row.appendChild(name);
    list.appendChild(row);
  }

  refresh();
  modal.style.display = 'block';

  const close = () => { modal.style.display = 'none'; };
  document.getElementById('copy-select-close').onclick = close;
  document.getElementById('copy-select-backdrop').onclick = close;

  allBtn.onclick = () => {
    const selectAll = selected.size < items.length;
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = selectAll;
      selectAll ? selected.add(cb.closest('label').querySelector('.row-name').textContent)
                : selected.clear();
    });
    refresh();
  };

  async function doCopy() {
    close();
    const sections = sectionCanvasGetters
      .filter(s => selected.has(s.version))
      .map(({ version, getCanvas, isDoneShown }) => ({ version, canvas: getCanvas(), showDone: isDoneShown() }))
      .filter(({ canvas }) => canvas && canvas.style.display !== 'none');
    if (!sections.length) return;
    const composite = buildCompositeCanvas(sections);
    await copyToClipboard(composite);
    showCopyPreview(composite.toDataURL('image/png'));
  }

  goBtn.onclick = async () => {
    const unsynced = sectionCanvasGetters
      .filter(s => selected.has(s.version) && !s.isSyncedToday())
      .map(s => s.version);

    if (unsynced.length) {
      showUnsyncedConfirm(unsynced, doCopy);
    } else {
      await doCopy();
    }
  };
}

function showCopyPreview(dataUrl) {
  let modal = document.getElementById('copy-preview-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'copy-preview-modal';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div id="copy-preview-backdrop"></div>
    <div id="copy-preview-box">
      <div id="copy-preview-header">
        <span id="copy-preview-title">✓ Copied to clipboard</span>
        <button id="copy-preview-close">✕</button>
      </div>
      <div id="copy-preview-hint">Paste anywhere to share</div>
      <div id="copy-preview-img-wrap">
        <img id="copy-preview-img" src="${dataUrl}" alt="Chart preview" />
      </div>
    </div>
  `;
  modal.style.display = 'block';

  const close = () => { modal.style.display = 'none'; };
  modal.querySelector('#copy-preview-close').addEventListener('click', close);
  modal.querySelector('#copy-preview-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

function showToast(message, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.style.background  = type === 'sync' ? '#1a2535' : '#1e302a';
  t.style.borderColor = type === 'sync' ? 'var(--accent)' : 'var(--green-soft)';
  t.style.color       = type === 'sync' ? 'var(--accent)' : 'var(--green-soft)';
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

async function copyAll() {
  const all = await chrome.storage.local.get(null);
  const out = Object.fromEntries(Object.entries(all).filter(([k])=>DATE_KEY_PATTERN.test(k)));
  await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
  showToast('Copied!');
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function filterByRange(all, start, end) {
  return Object.fromEntries(Object.entries(all).filter(([k]) => {
    if (!DATE_KEY_PATTERN.test(k)) return false;
    const d = k.slice(0, 10);
    if (start && d < start) return false;
    if (end   && d > end)   return false;
    return true;
  }));
}

async function exportRange() {
  const all = await chrome.storage.local.get(null);
  const s = startInput?.value || '';
  const e = endInput?.value   || '';
  const out = filterByRange(all, s, e);
  const tag = (s || e) ? `${s || 'start'}_${e || 'end'}` : 'all';
  downloadJson(out, `backlog-${tag}.json`);
}

async function exportSprint(value) {
  if (!value) return;
  const [start, end, name] = value.split('|');
  const all = await chrome.storage.local.get(null);
  const out = filterByRange(all, start, end);
  downloadJson(out, `backlog-${name}.json`);
}

async function clearAll() {
  if (!confirm('Delete ALL stored snapshots? This cannot be undone.')) return;
  const all  = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(
    Object.keys(all).filter(k => DATE_KEY_PATTERN.test(k) || k.startsWith(DETAIL_PREFIX))
  );
  await renderAll();
}

// ─── Version selector panel ───────────────────────────────────────────────────

const TRACKED_KEY        = '__blm_tracked';
const PROJECT_FILTER_KEY = '__blm_project_filter';

/** Projects shown by default — matches "Credit Utility" or "Valiant" in name. */
function isDefaultProject(name) {
  return /credit.?utility/i.test(name) || /valiant/i.test(name);
}

function toggleVersionPanel(forceOpen) {
  const panel    = document.getElementById('version-panel');
  const willOpen = forceOpen !== undefined ? forceOpen : !panel.classList.contains('open');
  panel.classList.toggle('open', willOpen);
  if (willOpen) { loadVersionPanel(); loadPlanningSettings(); document.getElementById('vp-search')?.focus(); }
}

document.getElementById('version-scrim').addEventListener('click', () => toggleVersionPanel(false));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('version-panel').classList.contains('open')) toggleVersionPanel(false);
});

// ─── Work package filter settings ─────────────────────────────────────────────

const SETTINGS_KEY = '__blm_settings';

// ── Exclude-types tag UI ──────────────────────────────────────────────────────

let _excludeTypes = [];

function renderTypeTags() {
  const container = document.getElementById('exclude-types-tags');
  if (!container) return;
  container.innerHTML = '';
  for (const t of _excludeTypes) {
    const chip = document.createElement('span'); chip.className = 'type-tag';
    chip.innerHTML = `${t}<button title="Remove">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      _excludeTypes = _excludeTypes.filter(x => x !== t);
      renderTypeTags();
      saveExcludeTypes();
    });
    container.appendChild(chip);
  }
}

async function saveExcludeTypes() {
  const prev = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? {};
  const prevTypes = (prev.excludeTypes ?? ['Task']).map(t => t.toLowerCase()).sort().join(',');
  const nextTypes = _excludeTypes.map(t => t.toLowerCase()).sort().join(',');
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...prev, excludeTypes: _excludeTypes } });
  if (prevTypes !== nextTypes) {
    await invalidateAllTrackedSnapshots();
    triggerSync();
  }
}

async function invalidateAllTrackedSnapshots() {
  const tracked = (await chrome.storage.local.get(TRACKED_KEY))[TRACKED_KEY] ?? [];
  const all     = await chrome.storage.local.get(null);
  const toDelete = Object.keys(all).filter(k => {
    const base = k.startsWith(DETAIL_PREFIX) ? k.slice(DETAIL_PREFIX.length) : k;
    return DATE_KEY_PATTERN.test(base) && tracked.some(v => base.endsWith(`__${v.versionName}`));
  });
  if (toDelete.length) await chrome.storage.local.remove(toDelete);
}

// ── Settings load ─────────────────────────────────────────────────────────────

async function loadPlanningSettings() {
  const cfg = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? {};
  _excludeTypes = cfg.excludeTypes ?? ['Task'];
  renderTypeTags();
}

document.getElementById('exclude-types-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ',') return;
  e.preventDefault();
  const val = e.target.value.trim();
  if (val && !_excludeTypes.some(t => t.toLowerCase() === val.toLowerCase())) {
    _excludeTypes = [..._excludeTypes, val];
    renderTypeTags();
    saveExcludeTypes();
  }
  e.target.value = '';
});

async function loadVersionPanel() {
  const trackingEl = document.getElementById('vp-tracking');
  const body       = document.getElementById('version-panel-body');
  const msg        = document.getElementById('version-panel-msg');
  const search     = document.getElementById('vp-search');

  body.innerHTML = '<div class="vp-empty">Loading versions…</div>';
  document.getElementById('version-panel-projects').innerHTML = '';
  msg.textContent  = '';
  msg.className    = 'version-panel-msg';

  const stored = await chrome.storage.local.get([TRACKED_KEY, PROJECT_FILTER_KEY]);
  let tracked  = stored[TRACKED_KEY] ?? [];
  const today  = todayStr();
  const current = currentMainViewVersion();

  // Changes save at once: every click writes __blm_tracked and redraws the lists
  const saveTracked = async (next) => {
    tracked = next;
    await chrome.storage.local.set({ [TRACKED_KEY]: next });
    renderTracking();
    renderAvailable();
  };

  const statusLine = (v) => {
    const range = v.startDate ? `${v.startDate.slice(5)} → ${(v.endDate ?? '?').slice(5)}` : 'no dates';
    if (sameVersion(v.versionName, current)) return `${range} · current sprint`;
    if (v.endDate && v.endDate < today) return `${range} · ended, kept until ${addDays(v.endDate, 7).slice(5)}`;
    return range;
  };

  function renderTracking() {
    document.getElementById('vp-tracking-label').textContent = `Tracking · ${tracked.length}`;
    trackingEl.innerHTML = '';
    if (!tracked.length) { trackingEl.innerHTML = '<div class="vp-empty">No versions tracked yet. Add one below.</div>'; return; }
    for (const v of tracked) {
      const row = document.createElement('div'); row.className = 'vp-row';
      const name = document.createElement('div'); name.className = 'vp-name';
      name.textContent = v.versionName;
      const sub = document.createElement('small'); sub.textContent = statusLine(v); name.appendChild(sub);
      row.appendChild(name);
      if (sameVersion(v.versionName, current)) {
        const lock = document.createElement('span'); lock.className = 'vp-lock'; lock.textContent = 'always shown';
        lock.title = 'The current sprint is tracked automatically';
        row.appendChild(lock);
      } else {
        const x = document.createElement('button'); x.type = 'button'; x.className = 'vp-icon'; x.textContent = '×';
        x.title = `Stop tracking ${v.versionName}`; x.setAttribute('aria-label', x.title);
        x.addEventListener('click', async () => { await saveTracked(tracked.filter(t => t.versionId !== v.versionId)); renderAll(); });
        row.appendChild(x);
      }
      trackingEl.appendChild(row);
    }
  }
  renderTracking();

  let projects;
  try {
    projects = await fetchActiveProjects();
  } catch (err) {
    body.innerHTML  = '';
    msg.textContent = err.code === 'NOT_AUTHENTICATED'
      ? '⚠ Not logged in — open the backlog page first.'
      : `⚠ ${err.message}`;
    msg.className   = 'version-panel-msg error';
    return;
  }

  const results = await Promise.all(
    projects.map(p =>
      fetchAllVersions(p.id)
        .then(versions => ({ project: p, versions }))
        .catch(() => ({ project: p, versions: [] }))
    )
  );
  const projectsWithVers = results.filter(r => r.versions.length);

  // Selected projects: saved filter OR default (Credit Utility + Valiant)
  const savedFilter = stored[PROJECT_FILTER_KEY];
  let selectedProjects = new Set(
    savedFilter ?? projectsWithVers.filter(r => isDefaultProject(r.project.name)).map(r => r.project.id)
  );
  let showClosed = false;

  renderProjectChips(projectsWithVers, selectedProjects, (newSet) => {
    selectedProjects = newSet;
    chrome.storage.local.set({ [PROJECT_FILTER_KEY]: [...newSet] });
    renderAvailable();
  }, () => { showClosed = !showClosed; renderAvailable(); });

  function renderAvailable() {
    const q = search.value.trim().toLowerCase();
    const trackedIds = new Set(tracked.map(t => t.versionId));
    body.innerHTML = '';
    for (const { project, versions } of projectsWithVers) {
      if (!selectedProjects.has(project.id)) continue;
      const list = versions.filter(v => !trackedIds.has(v.id)
        && (showClosed || v.status === 'open')
        && (!q || v.name.toLowerCase().includes(q)));
      if (!list.length) continue;
      const g = document.createElement('div'); g.className = 'vp-group';
      const label = document.createElement('div'); label.className = 'vp-project-label'; label.textContent = project.name;
      g.appendChild(label);
      for (const v of list) {
        const row = document.createElement('div'); row.className = 'vp-row' + (v.status === 'open' ? '' : ' vp-closed');
        const name = document.createElement('div'); name.className = 'vp-name'; name.textContent = v.name;
        const sub = document.createElement('small');
        sub.textContent = `${v.startDate ? `${v.startDate.slice(5)} → ${(v.endDate ?? '?').slice(5)}` : 'no dates'} · ${v.status}`;
        name.appendChild(sub);
        const add = document.createElement('button'); add.type = 'button'; add.className = 'vp-add'; add.textContent = '+ Track';
        add.addEventListener('click', async () => {
          add.disabled = true;
          await saveTracked([...tracked, {
            projectId: project.id, projectName: project.name,
            versionId: v.id,       versionName: v.name,
            startDate: v.startDate ?? null, endDate: v.endDate ?? null,
          }]);
          triggerSync();   // fetch the new version's history now; the chart re-renders when it lands
        });
        row.append(name, add);
        g.appendChild(row);
      }
      body.appendChild(g);
    }
    if (!body.children.length)
      body.innerHTML = `<div class="vp-empty">${q ? `No version matches "${q.replace(/[<&]/g, '')}".` : 'No more versions in the selected projects.'}</div>`;
  }
  search.oninput = renderAvailable;
  renderAvailable();
}

function renderProjectChips(projectsWithVers, selectedProjects, onToggle, onToggleClosed) {
  const container = document.getElementById('version-panel-projects');
  container.innerHTML = '';
  for (const { project } of projectsWithVers) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'vp-chip';
    chip.setAttribute('aria-pressed', String(selectedProjects.has(project.id)));
    chip.textContent = project.name;
    chip.addEventListener('click', () => {
      const newSet = new Set(selectedProjects);
      if (newSet.has(project.id)) newSet.delete(project.id); else newSet.add(project.id);
      selectedProjects = newSet;
      chip.setAttribute('aria-pressed', String(newSet.has(project.id)));
      onToggle(newSet);
    });
    container.appendChild(chip);
  }
  const closedChip = document.createElement('button');
  closedChip.type = 'button';
  closedChip.className = 'vp-chip vp-chip-closed';
  closedChip.setAttribute('aria-pressed', 'false');
  closedChip.textContent = 'Show closed';
  closedChip.addEventListener('click', () => {
    closedChip.setAttribute('aria-pressed', String(closedChip.getAttribute('aria-pressed') !== 'true'));
    onToggleClosed();
  });
  container.appendChild(closedChip);
}

document.getElementById('btn-configure-versions').addEventListener('click', () => {
  toggleVersionPanel();
  document.getElementById('more-details')?.removeAttribute('open');
});
document.getElementById('btn-version-panel-close').addEventListener('click',  () => toggleVersionPanel(false));

// Close the ⋯ dropdown when clicking outside it, or on any menu item inside it
document.addEventListener('click', e => {
  const el = document.getElementById('more-details');
  if (!el || !el.open) return;
  if (!el.contains(e.target)) { el.removeAttribute('open'); return; }
  if (e.target.closest('.more-menu button, .more-menu select')) el.removeAttribute('open');
});

// ─── Storage change listener (sync toast + live refresh) ──────────────────────

let liveRenderTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
    if (key === '__blm_fetch_progress' && isSyncing && newValue) {
      const { done, total, version } = newValue;
      setProgressFill(done, total, `${version}: fetching activities ${done} / ${total}`);
    }
    // Today's snapshot or burn detail changed (hourly sync, or the detail panel fetching today's
    // stories): redraw so the chart and the open detail show the same numbers.
    const base = key.startsWith(DETAIL_PREFIX) ? key.slice(DETAIL_PREFIX.length) : key;
    if (DATE_KEY_PATTERN.test(base) && base.startsWith(todayStr()) && oldValue !== undefined && !isSyncing) {
      clearTimeout(liveRenderTimer);
      liveRenderTimer = setTimeout(renderAll, 300);
      continue;
    }
    if (DATE_KEY_PATTERN.test(key) && !oldValue && newValue) {
      if (isSyncing) {
        updateProgressBar(newValue.backlogVersion);
        renderAll();
      } else {
        showToast(`✓ Synced: ${newValue.backlogVersion}`, 'sync');
        renderAll();
      }
      break;
    }
    if (key === '__blm_copy_req' && newValue) {
      chrome.storage.local.remove('__blm_copy_req');
      handleCopyRequest(newValue.versions);
    }
  }
});

function handleCopyRequest(versions) {
  showCopySelectModal(versions);
}

// ─── Shared sync trigger ──────────────────────────────────────────────────────

function triggerSync() {
  const btn = document.getElementById('btn-sync-now');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Syncing…'; }
  showProgressBar();

  try { chrome.runtime.sendMessage({ type: 'sync-now' }); } catch { /* sw may be asleep */ }

  let polls = 0;
  const timer = setInterval(async () => {
    polls++;
    const data = await chrome.storage.local.get('__blm_sync_meta');
    const meta = data['__blm_sync_meta'];
    if (meta?.status === 'ok' || meta?.status === 'error' || polls >= 120) {
      clearInterval(timer);
      if (btn) { btn.disabled = false; btn.textContent = '↻ Sync Now'; }
      const saved = syncSavedCount;
      hideProgressBar();
      if (meta?.status === 'ok') {
        showToast(saved ? `✓ Synced · ${saved} new snapshot${saved !== 1 ? 's' : ''}` : '✓ Already up to date');
        await renderAll();
      } else if (meta?.status === 'error') {
        showToast(meta.error === 'not-authenticated' ? '⚠ Not logged in to backlog' : `⚠ ${meta.error}`);
        await renderAll();
      }
    }
  }, 500);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.getElementById('btn-timelog')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/timelog.html') });
});

// ─── Theme toggle ─────────────────────────────────────────────────────────────

// Theme is chosen in the popup settings (theme.js applies it); charts are canvas,
// so redraw them with the new colours when it changes.
document.addEventListener('blm-theme-change', () => {
  sectionUpdaters.forEach(fn => fn(startInput?.value, endInput?.value));
});

document.getElementById('btn-sync-now').addEventListener('click', triggerSync);

document.getElementById('btn-copy').addEventListener('click', copyAll);
document.getElementById('btn-copy-charts').addEventListener('click', () => showCopySelectModal());

document.getElementById('btn-export').addEventListener('click', exportRange);
document.getElementById('export-sprint').addEventListener('change', (ev) => {
  const v = ev.target.value;
  exportSprint(v);
  ev.target.value = '';
});
/** Shows the two date inputs ("Custom range…" in the sprint menu, or always in the drawer). */
function showCustomRange(on) {
  document.getElementById('tb-range').classList.toggle('show', on);
}

function applySprint(v) {
  showCustomRange(v === 'custom');
  if (!v || v === 'custom') { if (v === 'custom') startInput?.focus(); return; }
  const [start, end] = v.split('|');
  startInput.value = start;
  endInput.value   = end;
  sectionUpdaters.forEach(u => u(start, end));
}
document.getElementById('filter-sprint').addEventListener('change', (ev) => applySprint(ev.target.value));

// ‹ older sprint · newer sprint ›  (the menu lists the current sprint first, then older ones)
function stepSprint(dir) {
  const sel  = document.getElementById('filter-sprint');
  const opts = [...sel.options].filter(o => o.value && o.value !== 'custom');
  const i    = opts.findIndex(o => o.value === sel.value);
  const next = opts[i < 0 ? 0 : i + dir];
  if (!next) return;
  sel.value = next.value;
  applySprint(next.value);
}
document.getElementById('btn-sprint-prev').addEventListener('click', () => stepSprint(1));
document.getElementById('btn-sprint-next').addEventListener('click', () => stepSprint(-1));
document.getElementById('btn-clear').addEventListener('click', clearAll);

// Main-view toggle: focus the dashboard on "<project> <CurrentSprint>" only. The
// project defaults to one of the signed-in user's projects (the saved choice, else
// the first with a snapshot for the current sprint) and can be switched.
// The chart renders at once with the saved or last-resolved project; the project
// lookups run after that and re-render only if they pick a different project.
const MAIN_VIEW_LAST_KEY = '__blm_main_view_project_last';
let markMainViewReady;
const mainViewReady = new Promise(r => { markMainViewReady = r; });
(async () => {
  const chk = document.getElementById('filter-main-view');
  const projSel = document.getElementById('filter-project');
  if (!chk) { markMainViewReady(); return; }
  const stored = await chrome.storage.local.get([MAIN_VIEW_STATE_KEY, MAIN_VIEW_PROJECT_KEY, MAIN_VIEW_LAST_KEY]);
  mainViewOnly = EMBEDDED || (stored[MAIN_VIEW_STATE_KEY] ?? true);  // default ON; drawer always
  chk.checked = mainViewOnly;
  const saved = stored[MAIN_VIEW_PROJECT_KEY];
  const guess = saved ?? stored[MAIN_VIEW_LAST_KEY] ?? null;
  if (guess) { mainViewProject = guess; markMainViewReady(); }

  // Projects the user is assigned work in come first (the default), then the rest
  // of their memberships for the dropdown.
  const s = sprintInfo(sprintIndexForDate(todayStr()));
  const [assignedRes, memberRes] = await Promise.allSettled([fetchAssignedProjectNames(s.name), fetchMyProjectNames()]);
  const assigned = assignedRes.value ?? [];                  // rejected: signed out / offline
  const projects = [...new Set([...assigned, ...(memberRes.value ?? [])])];
  const all = await chrome.storage.local.get(null);
  const versions = new Set(Object.keys(all).map(k => /^\d{4}-\d\d-\d\d__(.+)$/.exec(k)?.[1]).filter(Boolean));
  const picked = projects.includes(saved) ? saved
    : [...assigned, ...projects].find(p => [...versions].some(v => sameVersion(v, `${p} ${s.name}`))) ?? assigned[0] ?? projects[0] ?? guess;
  if (picked) chrome.storage.local.set({ [MAIN_VIEW_LAST_KEY]: picked });
  const changed = picked !== mainViewProject;
  mainViewProject = picked;
  if (guess && changed) { autoTrackTried = false; renderAll(); }   // track the right project's sprint
  markMainViewReady();

  const refreshTitle = () => { chk.title = mainViewProject ? `Show only ${currentMainViewVersion()}` : 'Show only the current sprint'; };
  refreshTitle();
  if (projSel && projects.length) {
    for (const p of projects) projSel.append(new Option(p, p));
    projSel.value = mainViewProject;
    projSel.style.display = projects.length < 2 ? 'none' : '';
    projSel.addEventListener('change', async () => {
      mainViewProject = projSel.value;
      refreshTitle();
      await chrome.storage.local.set({ [MAIN_VIEW_PROJECT_KEY]: mainViewProject });
      renderAll();
    });
  }
  chk.addEventListener('change', async () => {
    mainViewOnly = chk.checked;
    await chrome.storage.local.set({ [MAIN_VIEW_STATE_KEY]: mainViewOnly });
    renderAll();
  });
})();

initImportPanel();
mainViewReady.then(() => renderAll()).then(async () => {
  // Handle copy request set by popup before this tab existed (onChanged won't fire for pre-existing keys)
  const stored = await chrome.storage.local.get('__blm_copy_req');
  if (stored.__blm_copy_req) {
    chrome.storage.local.remove('__blm_copy_req');
    handleCopyRequest(stored.__blm_copy_req.versions);
  }
});
