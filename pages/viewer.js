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

function todayStr() {
  const n = new Date();
  return [n.getFullYear(), String(n.getMonth()+1).padStart(2,'0'), String(n.getDate()).padStart(2,'0')].join('-');
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
function niceStep(maxVal) {
  if (maxVal <= 0) return 5;
  const raw  = maxVal / 6;
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

/**
 * actual[]:     { dayIndex, value, status?, statusText? }  — remaining (blue)
 * doneActual[]: { dayIndex, value }                        — done pts  (green)
 * status values: 'no-progress' | 'scope-up' | 'scope-down' | null
 */
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
    burnedBg:    light ? '#fff0c8' : '#f9e2af',
    burnedFg:    light ? '#78350f' : '#111214',
    todayBg:     light ? '#fffbeb' : '#2a2316',
    todayBorder: light ? '#ca8a04' : '#f9e2af',
    todayText:   light ? '#92400e' : '#f9e2af',
    // Status pill colors — darker/richer in light mode for contrast against pale canvas
    pillScopeUp:   light ? '#b01840' : '#f38ba8',
    pillScopeDown: light ? '#006888' : '#89dceb',
    pillNoProg:    light ? '#8a4800' : '#fab387',
    pillProgress:  light ? '#2a7a40' : '#a6e3a1',
    pillFillAlpha: light ? 0.14      : 0.22,
  };
}

function drawBurndownChart(canvas, { xDates, actual, doneActual, ideal, maxY, notSyncedToday = false }) {
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

  const n   = xDates.length;
  const xAt = i => PAD.left + (n < 2 ? CW/2 : CW*i/(n-1));
  const yAt = v => PAD.top  + CH*(1 - Math.max(0,v)/top);

  ctx.fillStyle = C.bg; ctx.fillRect(0,0,W,H);

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
  const hitAreas = [];

  if (actual.length >= 1) {
    const STATUS_COLOR = { 'no-progress': C.pillNoProg, 'scope-up': C.pillScopeUp, 'scope-down': C.pillScopeDown, 'progress': C.pillProgress };

    // Phase 1: compute pill rects for all points, then resolve horizontal overlaps
    const pillRects = actual.map(p => {
      if (!p.status || !p.statusText) return null;
      const color = STATUS_COLOR[p.status] ?? C.muted;
      ctx.font = 'bold 9px -apple-system,sans-serif';
      const tw = ctx.measureText(p.statusText).width;
      const ph = 15, pw = tw + 12;
      const x = xAt(p.dayIndex), y = yAt(p.value);
      const nearTop = p.value > top * 0.82;
      const dir  = nearTop ? 1 : -1;
      const base = nearTop ? 'top' : 'bottom';
      const vOff = nearTop ? y + 9 : y - 9;
      const pillCenter = vOff + dir * 27;
      const rectY = base === 'bottom' ? pillCenter - ph : pillCenter;
      return { rx: x - pw / 2, rectY, pw, ph, color, text: p.statusText, dir };
    });

    // Shift pills that overlap the previous pill further from the dot
    for (let i = 1; i < pillRects.length; i++) {
      const a = pillRects[i - 1], b = pillRects[i];
      if (!a || !b) continue;
      if (a.rx + a.pw + 3 > b.rx) b.rectY += b.dir * 17;
    }

    // Draw the line
    ctx.strokeStyle=C.remain; ctx.lineWidth=2.5; ctx.lineJoin='round';
    ctx.beginPath(); actual.forEach((p,i) => i===0 ? ctx.moveTo(xAt(p.dayIndex),yAt(p.value)) : ctx.lineTo(xAt(p.dayIndex),yAt(p.value)));
    ctx.stroke();

    actual.forEach((p, pi) => {
      const x = xAt(p.dayIndex), y = yAt(p.value);

      ctx.fillStyle=C.remain; ctx.beginPath(); ctx.arc(x,y,4.5,0,Math.PI*2); ctx.fill();

      const nearTop = p.value > top * 0.82;
      const dir  = nearTop ? 1 : -1;
      const base = nearTop ? 'top' : 'bottom';
      const vOff = nearTop ? y+9 : y-9;

      // Value + burned badge (clickable)
      ctx.font = 'bold 11px -apple-system,sans-serif';
      const valStr = fmt(p.value);
      let burnHit = null;
      if (p.burnedText) {
        const valW=ctx.measureText(valStr).width;
        const badgePad=4, gap=5, badgeH=13;
        ctx.font='bold 9px -apple-system,sans-serif';
        const badgeTextW=ctx.measureText(p.burnedText).width;
        const badgeW=badgeTextW+badgePad*2, totalW=valW+gap+badgeW;
        const startX=x-totalW/2, badgeX=startX+valW+gap;
        const badgeY=base==='bottom' ? vOff-badgeH : vOff;
        ctx.font='bold 11px -apple-system,sans-serif';
        ctx.fillStyle=C.label; ctx.textAlign='left'; ctx.textBaseline=base;
        ctx.fillText(valStr, startX, vOff);
        ctx.fillStyle=C.burnedBg; ctx.beginPath(); ctx.roundRect(badgeX,badgeY,badgeW,badgeH,3); ctx.fill();
        ctx.font='bold 9px -apple-system,sans-serif';
        ctx.fillStyle=C.burnedFg; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(p.burnedText, badgeX+badgeW/2, badgeY+badgeH/2);
        burnHit = { x: badgeX, y: badgeY, w: badgeW, h: badgeH };
      } else {
        ctx.fillStyle=C.label; ctx.textAlign='center'; ctx.textBaseline=base;
        ctx.fillText(valStr, x, vOff);
      }

      // Total scope
      if (p.total !== undefined) {
        ctx.fillStyle=C.muted; ctx.font='9px -apple-system,sans-serif';
        ctx.textAlign='center'; ctx.textBaseline=base;
        ctx.fillText(`/ ${fmt(p.total)}`, x, vOff+dir*14);
      }

      // Status pill — from pre-computed, collision-resolved rects
      let pillHit = null;
      const pr = pillRects[pi];
      if (pr) {
        const { rx, rectY, pw, ph, color, text } = pr;
        ctx.globalAlpha = C.pillFillAlpha; ctx.fillStyle = color;
        ctx.beginPath(); ctx.roundRect(rx, rectY, pw, ph, 4); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.roundRect(rx, rectY, pw, ph, 4); ctx.stroke();
        ctx.fillStyle = color; ctx.font = 'bold 9px -apple-system,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, rx + pw / 2, rectY + ph / 2);
        pillHit = { x: rx, y: rectY, w: pw, h: ph };
      }

      hitAreas.push({ x, y, date: p.date, prevDate: p.prevDate, status: p.status, statusText: p.statusText, burnedText: p.burnedText, pillHit, burnHit });
    });
  }

  return hitAreas;
}

// ─── Burndown section ─────────────────────────────────────────────────────────

function buildBurndownSection(version, dateMap, detailRecord = new Map()) {
  const snapDates = [...dateMap.keys()].sort();
  const allStats  = collectStatuses(dateMap);
  const wrap = document.createElement('div'); wrap.className = 'burndown-section';

  const heading = document.createElement('div'); heading.className='burndown-heading'; heading.textContent='Burndown Chart';
  wrap.appendChild(heading);

  const ctrl = document.createElement('div'); ctrl.className='chart-controls';
  const grp  = document.createElement('div'); grp.className='ctrl-group';
  grp.innerHTML='<label class="ctrl-label">Done statuses</label>';
  const doneBox = document.createElement('div'); doneBox.className='done-checkboxes';
  allStats.forEach(s => {
    const lbl=document.createElement('label'); lbl.className='done-label';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.value=s; cb.checked=DEFAULT_DONE.has(s.toLowerCase());
    lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' '+s)); doneBox.appendChild(lbl);
  });
  grp.appendChild(doneBox); ctrl.appendChild(grp);

  // Chart options: Show Done line
  const doneLineGrp = document.createElement('div'); doneLineGrp.className='ctrl-group';
  doneLineGrp.innerHTML='<label class="ctrl-label">Options</label>';

  const doneLineLbl = document.createElement('label'); doneLineLbl.className='done-label';
  const doneLineCb  = document.createElement('input'); doneLineCb.type='checkbox'; doneLineCb.checked=false;
  doneLineLbl.appendChild(doneLineCb); doneLineLbl.appendChild(document.createTextNode(' Show Done line'));
  doneLineGrp.appendChild(doneLineLbl);
  ctrl.appendChild(doneLineGrp);

  // Weekend day selector — rebuilt each time the date range changes
  const weekendGrp = document.createElement('div'); weekendGrp.className='ctrl-group';
  weekendGrp.innerHTML='<label class="ctrl-label">Weekends</label>';
  const weekendDaysBox = document.createElement('div'); weekendDaysBox.className='done-checkboxes';
  weekendGrp.appendChild(weekendDaysBox);
  ctrl.appendChild(weekendGrp);

  // Persists the user's per-date selections across redraws
  const weekendSelected = new Set();

  wrap.appendChild(ctrl);

  const chartRow = document.createElement('div'); chartRow.className='chart-row';
  const canvas = document.createElement('canvas'); canvas.className='burndown-canvas';
  const noMsg  = document.createElement('p'); noMsg.className='chart-no-data'; noMsg.style.display='none';

  const legend = document.createElement('div'); legend.className='chart-legend';
  legend.innerHTML = `
    <div class="legend-item">
      <svg width="26" height="14" viewBox="0 0 26 14">
        <line x1="0" y1="7" x2="26" y2="7" stroke="var(--accent)" stroke-width="2.5"/>
        <circle cx="13" cy="7" r="4" fill="var(--accent)"/>
      </svg>
      <span class="legend-label">Remaining</span>
    </div>
    <div class="legend-item">
      <svg width="26" height="14" viewBox="0 0 26 14">
        <line x1="0" y1="7" x2="26" y2="7" stroke="#a6e3a1" stroke-width="2"/>
        <circle cx="13" cy="7" r="4" fill="#a6e3a1"/>
      </svg>
      <span class="legend-label">Done</span>
    </div>
    <div class="legend-item">
      <svg width="26" height="14" viewBox="0 0 26 14">
        <line x1="0" y1="7" x2="26" y2="7" stroke="#f38ba8" stroke-width="1.8" stroke-dasharray="6,4"/>
      </svg>
      <span class="legend-label">Ideal</span>
    </div>
  `;

  chartRow.appendChild(canvas);
  chartRow.appendChild(noMsg);
  chartRow.appendChild(legend);
  wrap.appendChild(chartRow);

  let curStart = snapDates[0], curEnd = addDays(snapDates[0], 9);

  function redraw() {
    const s=curStart, e=curEnd;
    if (!s||!e||s>e) { canvas.style.display='none'; noMsg.textContent='Invalid date range.'; noMsg.style.display='block'; return; }
    const done = new Set([...doneBox.querySelectorAll('input:checked')].map(c=>c.value));

    // Rebuild weekend checkboxes for current range, preserving existing selections
    const allInRange  = calendarRange(s, e);
    const weekendDays = allInRange.filter(isWeekend);
    weekendDaysBox.innerHTML = '';
    if (weekendDays.length === 0) {
      weekendGrp.style.display = 'none';
    } else {
      weekendGrp.style.display = '';
      weekendDays.forEach(d => {
        const dt      = new Date(d + 'T12:00:00Z');
        const dayName = dt.toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' });
        const lbl = document.createElement('label'); lbl.className='done-label';
        const cb  = document.createElement('input'); cb.type='checkbox'; cb.checked=weekendSelected.has(d);
        cb.addEventListener('change', () => {
          if (cb.checked) weekendSelected.add(d); else weekendSelected.delete(d);
          redraw();
        });
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(` ${d.slice(5)} (${dayName})`));
        weekendDaysBox.appendChild(lbl);
      });
    }

    const xDates  = allInRange.filter(d => !isWeekend(d) || weekendSelected.has(d));
    const inRange = snapDates.filter(d => d>=s && d<=e && (!isWeekend(d) || weekendSelected.has(d)));
    if (!inRange.length) { canvas.style.display='none'; noMsg.textContent='No snapshots in range.'; noMsg.style.display='block'; return; }
    noMsg.style.display='none'; canvas.style.display='block';
    const n=xDates.length;
    const dIdx=new Map(xDates.map((d,i)=>[d,i]));

    const sumPts  = arr => arr.reduce((a,x)=>a+(parseFloat(x.point)||0),0);
    const remaining = d => sumPts((dateMap.get(d)??[]).filter(x=>!done.has(x.status)));

    // Ideal line: starts at the total scope of the most recent snapshot (matches the summary-report
    // approach of using the current sprint total), burns to 0 by the last x-axis day.
    const latestTotal = sumPts(dateMap.get(inRange[inRange.length - 1]) ?? []);
    const ideal = xDates.map((_, i) => latestTotal * (1 - i / Math.max(n - 1, 1)));

    const fmtPts = v => { const a = Math.abs(v); return (Number.isInteger(a) ? a : a.toFixed(1)) + 'pts'; };

    const actual = inRange.map((d,i) => {
      const value = remaining(d);
      let status = null, statusText = null, burnedText = null;
      const prev = i > 0 ? inRange[i-1] : null;
      if (prev) {
        const scopeNow = sumPts(dateMap.get(d)??[]);
        const scopePrv = sumPts(dateMap.get(prev)??[]);
        const diff     = scopeNow - scopePrv;
        if      (diff >  0.001) { status = 'scope-up';   statusText = `+${fmtPts(diff)}`; }
        else if (diff < -0.001) { status = 'scope-down'; statusText = `−${fmtPts(diff)}`; }
        else if (Math.abs(value - remaining(prev)) < 0.001) {
          // Scope flat AND remaining flat: tell a genuine internal status reshuffle
          // (e.g. Specified → In progress) apart from "truly nothing changed".
          const sig = arr => (arr ?? []).map(x => `${x.status}:${x.numOfStory}:${x.point}`).sort().join('|');
          if (sig(dateMap.get(d)) !== sig(dateMap.get(prev))) { status = 'progress'; statusText = '⇄'; }
          else { status = 'no-progress'; statusText = '—'; }
        }

        // "Burned" = work actually completed (status transitions into a done status, net
        // of reopens) over the window since the previous visible day.  The aggregate
        // Done-delta would also count scope that arrives already-done (e.g. a story moved
        // in already Resolved), which isn't a completion.  Fall back to the Done-delta
        // only for old snapshots that have no statusChanges detail.
        const gap = calendarRange(addDays(prev, 1), d);
        const bi  = netBurnedOverGap(detailRecord, gap, done);
        let burned;
        if (bi.hasDetail) {
          burned = Math.round((bi.burnedPts - bi.reopenedPts) * 10) / 10;
        } else {
          const donePrev = sumPts(dateMap.get(prev)??[]) - remaining(prev);
          const doneNow  = sumPts(dateMap.get(d)??[])    - remaining(d);
          burned = Math.round((doneNow - donePrev) * 10) / 10;
        }
        if (Math.abs(burned) > 0.001) {
          const n = Number.isInteger(Math.abs(burned)) ? String(Math.abs(burned)) : Math.abs(burned).toFixed(1);
          burnedText = burned < 0 ? `-${n}` : n;
        }
      }
      const total = sumPts(dateMap.get(d) ?? []);
      return { dayIndex: dIdx.get(d), date: d, prevDate: prev, value, total, status, statusText, burnedText };
    });

    const doneActual = doneLineCb.checked
      ? inRange.map(d => ({ dayIndex: dIdx.get(d), value: Math.round((sumPts(dateMap.get(d)??[]) - remaining(d)) * 10) / 10 }))
      : null;
    const maxScope = Math.max(...inRange.map(d => sumPts(dateMap.get(d)??[])));
    const today = todayStr();
    const notSyncedToday = xDates.includes(today) && !inRange.includes(today);
    hitAreas = drawBurndownChart(canvas,{ xDates, actual, doneActual, ideal, maxY: Math.max(maxScope, 1), notSyncedToday }) ?? [];
  }

  doneBox.addEventListener('change', redraw);
  doneLineCb.addEventListener('change', redraw);
  let rt; window.addEventListener('resize',()=>{ clearTimeout(rt); rt=setTimeout(redraw,120); });

  // ── Detail panel ──────────────────────────────────────────────────────────
  let hitAreas = [];
  const detailPanel = document.createElement('div');
  detailPanel.className = 'chart-detail-panel';
  wrap.appendChild(detailPanel);

  canvas.addEventListener('click', async (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let nearest = null, clickType = 'dot', minDist = 22;
    for (const h of hitAreas) {
      if (h.pillHit) {
        const { x: px, y: py, w: pw, h: ph } = h.pillHit;
        if (mx >= px && mx <= px+pw && my >= py && my <= py+ph) { nearest = h; clickType = 'pill'; break; }
      }
      if (h.burnHit) {
        const { x: bx, y: by, w: bw, h: bh } = h.burnHit;
        if (mx >= bx && mx <= bx+bw && my >= by && my <= by+bh) { nearest = h; clickType = 'burn'; break; }
      }
      const d = Math.hypot(h.x - mx, h.y - my);
      if (d < minDist) { minDist = d; nearest = h; clickType = 'dot'; }
    }
    if (!nearest) { detailPanel.classList.remove('visible'); return; }

    // Click semantics — each visual element has one clear action:
    //   Burned badge  → showBurnedDetail  (what was completed)
    //   scope-up/down pill → showPointDetail  (what changed scope)
    //   Dot           → showBurnedDetail if burned points exist, else dismiss
    //   "—" pill      → dismiss (no scope change, nothing to explain)
    const done = new Set([...doneBox.querySelectorAll('input:checked')].map(c => c.value));
    if (clickType === 'burn') {
      await showBurnedDetail(detailPanel, version, nearest, done);
    } else if (clickType === 'pill' && (nearest.status === 'scope-up' || nearest.status === 'scope-down')) {
      await showPointDetail(detailPanel, version, nearest);
    } else if (clickType === 'pill' && nearest.status === 'progress') {
      await showProgressDetail(detailPanel, version, nearest);
    } else if (clickType === 'dot' && nearest.burnedText) {
      // Dot on a day with burned points: show burned detail (same as clicking the badge)
      await showBurnedDetail(detailPanel, version, nearest, done);
    } else {
      // "—" pill, dot with no burns, or any other non-actionable click → dismiss
      detailPanel.classList.remove('visible');
    }
  });

  // Cursor: pointer only where a click actually does something.
  //   scope-up / scope-down pill  → pointer (opens scope detail)
  //   burned badge                → pointer (opens burned detail)
  //   dot with burned points      → pointer (opens burned detail)
  //   "—" pill / dot with no burns → default (no action)
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const over = hitAreas.some(h => {
      if (h.pillHit && (h.status === 'scope-up' || h.status === 'scope-down' || h.status === 'progress')) {
        const { x: px, y: py, w: pw, h: ph } = h.pillHit;
        if (mx >= px && mx <= px+pw && my >= py && my <= py+ph) return true;
      }
      if (h.burnHit) {
        const { x: bx, y: by, w: bw, h: bh } = h.burnHit;
        if (mx >= bx && mx <= bx+bw && my >= by && my <= by+bh) return true;
      }
      if (h.burnedText && Math.hypot(h.x - mx, h.y - my) < 18) return true;
      return false;
    });
    canvas.style.cursor = over ? 'pointer' : 'default';
  });

  return { el:wrap, update(s,e){ curStart=s; curEnd=e; redraw(); }, getCanvas(){ return canvas; }, isDoneShown(){ return doneLineCb.checked; } };
}

// ─── Cumulative Flow Diagram + Flow metrics ───────────────────────────────────

const WP_BASE_URL = `${BACKLOG_URL}/work_packages`;
const CFD_PALETTE = ['#89b4fa','#a6e3a1','#f9e2af','#fab387','#f38ba8','#cba6f7','#94e2d5','#eba0ac','#74c7ec','#b4befe','#f2cdcd','#89dceb'];
const AGING_THRESHOLD_DAYS = 5;

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
    .btn-toggle-table.active { background:var(--overlay); color:var(--text); }
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
    <span class="dp-date">${hit.date}</span>
    ${hit.status ? `<span class="dp-badge ${STATUS_CLS[hit.status] ?? ''}">${hit.statusText ?? ''}</span>` : ''}
    ${gapDays.length > 1 ? `<span class="dp-from">net change since ${hit.prevDate}</span>` : ''}
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
    <span class="dp-date">${hit.date}</span>
    <span class="dp-badge" style="color:var(--green-soft);border-color:var(--green-soft)">⇄ Progress</span>
    ${gapDays.length > 1 ? `<span class="dp-from">since ${hit.prevDate}</span>` : ''}
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
      <span class="dp-date">${hit.date}</span>
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
    <span class="dp-date">${hit.date}</span>
    <span class="dp-badge scope-down">Burned ${netLabel}</span>
    ${gapDays.length > 1 ? `<span class="dp-from">since ${hit.prevDate}</span>` : ''}
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
    // isStale + isToday means reconstruction ran but skipped today (daily cutoff
    // hasn't passed yet — only stories completed before 09:30 AM ICT count).
    let cutoffNote = '';
    if (isStale && isToday) {
      // Same rule as the background job: sprint start/end days lock at the planning cutoff, other days at the daily one.
      const kept = await chrome.storage.local.get([TRACKED_KEY, SETTINGS_KEY]);
      const cfg = kept[SETTINGS_KEY] ?? {};
      const planning = (kept[TRACKED_KEY] ?? []).some(t => t.startDate === hit.date || t.endDate === hit.date);
      cutoffNote = planning
        ? `Today is a sprint start/end day, so its burn detail locks at the planning cutoff (${cfg.planningCutoff ?? '21:00'} ICT)`
        : `Today's burn detail locks at the daily cutoff (${cfg.dailyCutoff ?? '09:30'} ICT)`;
    }
    html += `<p class="dp-empty">${
      isStale && isToday
        ? `⏳ ${cutoffNote}. The chart shows live numbers until then; stories completed after the cutoff count toward the next day.`
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

function buildBacklogSection(version, dateMap, sourcesMap = new Map(), movesMap = new Map(), throughputMap = new Map(), flowRecord = null, detailRecord = new Map()) {
  const section = document.createElement('div'); section.className='backlog-section';

  const bar = document.createElement('div'); bar.className='backlog-title-bar';
  const titleGroup = document.createElement('div'); titleGroup.style.cssText='display:flex;align-items:center;gap:10px;';
  const title = document.createElement('span'); title.className='backlog-title'; title.textContent=version;
  titleGroup.appendChild(title);

  if (!dateMap.has(todayStr())) {
    const warn = document.createElement('span');
    warn.className = 'sync-warning';
    warn.title = 'No snapshot for today — visit the backlog page to capture data';
    warn.textContent = '⚠ Not synced today';
    titleGroup.appendChild(warn);
  }

  const rightBtns = document.createElement('div'); rightBtns.style.cssText='display:flex;gap:8px;align-items:center;';
  const toggleBtn = document.createElement('button'); toggleBtn.className='btn-toggle-table'; toggleBtn.textContent='Hide Table';
  const COPY_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`;
  const copyImgBtn = document.createElement('button'); copyImgBtn.className='btn-copy-image';
  copyImgBtn.innerHTML = COPY_ICON + 'Copy Chart';
  copyImgBtn.title = 'Copy chart as image to clipboard';
  const cfdBtn  = document.createElement('button'); cfdBtn.className='btn-toggle-table';  cfdBtn.textContent='CFD';   cfdBtn.title='Cumulative Flow Diagram';
  const flowBtn = document.createElement('button'); flowBtn.className='btn-toggle-table'; flowBtn.textContent='Flow'; flowBtn.title='Throughput, rework & Aging WIP';
  const delVersionBtn = document.createElement('button'); delVersionBtn.className='btn-delete-version'; delVersionBtn.textContent='Delete All';
  delVersionBtn.title = `Delete all snapshots for "${version}"`;
  rightBtns.appendChild(toggleBtn); rightBtns.appendChild(cfdBtn); rightBtns.appendChild(flowBtn); rightBtns.appendChild(copyImgBtn); rightBtns.appendChild(delVersionBtn);
  bar.appendChild(titleGroup); bar.appendChild(rightBtns); section.appendChild(bar);

  const tableWrap = document.createElement('div'); tableWrap.style.display='none'; section.appendChild(tableWrap);
  let tableVisible = false;
  toggleBtn.textContent = 'Show Table';
  toggleBtn.addEventListener('click',()=>{ tableVisible=!tableVisible; tableWrap.style.display=tableVisible?'':'none'; toggleBtn.textContent=tableVisible?'Hide Table':'Show Table'; });

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

  const { el:chartEl, update:updateChart, getCanvas, isDoneShown } = buildBurndownSection(version, dateMap, detailRecord);
  section.appendChild(chartEl);

  // Flow metrics + Cumulative Flow Diagram (collapsible, off by default)
  const flowPanel = buildFlowPanel(version, throughputMap, flowRecord);
  const cfd       = buildCFDSection(version, dateMap);
  section.appendChild(flowPanel.el);
  section.appendChild(cfd.el);

  let curS, curE, cfdVisible = false, flowVisible = false;
  cfdBtn.addEventListener('click', () => {
    cfdVisible = !cfdVisible; cfd.show(cfdVisible); cfdBtn.classList.toggle('active', cfdVisible);
    if (cfdVisible) cfd.update(curS, curE);
  });
  flowBtn.addEventListener('click', () => {
    flowVisible = !flowVisible; flowPanel.show(flowVisible); flowBtn.classList.toggle('active', flowVisible);
    if (flowVisible) flowPanel.update(curS, curE);
  });

  copyImgBtn.addEventListener('click', async () => {
    const canvas = getCanvas();
    if (!canvas || canvas.style.display === 'none') return;
    try {
      const dataUrl = await copyChartImage(canvas, version, isDoneShown());
      copyImgBtn.innerHTML = '✓ Copied!';
      copyImgBtn.classList.add('copied');
      setTimeout(() => { copyImgBtn.innerHTML = COPY_ICON + 'Copy Chart'; copyImgBtn.classList.remove('copied'); }, 2000);
      showCopyPreview(dataUrl);
    } catch(e) {
      console.error('[BacklogMonitor] Copy image failed:', e);
    }
  });

  return {
    el: section,
    getCanvas,
    isDoneShown,
    isSyncedToday: () => dateMap.has(todayStr()),
    update(s,e) {
      curS = s; curE = e;
      tableWrap.innerHTML=''; tableWrap.appendChild(buildTable(dateMap,s,e,onDeleteDate,sourcesMap,movesMap));
      if (!tableVisible) tableWrap.style.display='none';
      updateChart(s,e);
      if (cfdVisible)  cfd.update(s,e);
      if (flowVisible) flowPanel.update(s,e);
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
  } catch { embeddedTarget = null; }
  return embeddedTarget;
}

async function saveEmbeddedPlan(start, end) {
  embeddedPlan = { start, end };
  const plans = (await chrome.storage.local.get(PLAN_KEY))[PLAN_KEY] ?? {};
  plans[embeddedTarget.version.id] = embeddedPlan;
  await chrome.storage.local.set({ [PLAN_KEY]: plans });
}

function mondayOnOrAfter(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

let embeddedSyncTried = false;
/** Drawer: what the empty chart means while the version's history is still being fetched. */
async function embeddedEmptyNote(noData) {
  const syncOn = (await chrome.storage.local.get('__blm_sync_burndown')).__blm_sync_burndown ?? true;
  if (syncOn) {
    noData.replaceChildren(document.createTextNode(`No data for ${embeddedTarget.version.name} yet — fetching it from OpenProject. The chart appears here when it's ready.`));
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
    embeddedEmptyNote(noData);
  });
  noData.replaceChildren(`Burndown sync is switched off, so nothing is collected for ${embeddedTarget.version.name}.`, document.createElement('br'), turnOn);
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
  // Sprints are planned on a Friday; the work (and the burndown) starts on the Monday after
  const [startWrap, start] = field('Sprint start', 'plan-start', mondayOnOrAfter(version.startDate ?? fallback.start));
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

// Snapshots are only taken while Burndown sync is on (background.js burndownEnabled),
// so with it off the drawer says why it is empty instead of asking for an import.
const CFG_SYNC_BURNDOWN = '__blm_sync_burndown';
const NO_DATA_HTML = document.getElementById('no-data').innerHTML;
function showEmbeddedEmpty(noData, all) {
  noData.style.display = 'block';
  if (all[CFG_SYNC_BURNDOWN] ?? true) { noData.innerHTML = NO_DATA_HTML; return; }
  noData.innerHTML = `<strong>Burndown sync is off.</strong><br>
    The chart is built from daily snapshots, which are only taken while sync is on.<br>
    <a href="#" id="btn-enable-sync">Turn it on in Settings</a>`;
  document.getElementById('btn-enable-sync').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/dashboard.html#feat-burndown') });
  });
}

/** Adds the current sprint's version of the user's project ("<project> <sprint>")
 *  to the tracked list when it's missing, so the chart opens on it. Returns the
 *  tracked list, unchanged when the project/version isn't found or the lookup fails. */
async function autoTrackCurrentVersion(tracked) {
  const name = currentMainViewVersion();
  if (!name) return tracked;
  const have = tracked.find(t => t.versionName === name);
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
    const v = embeddedTarget?.version ?? (await fetchAllVersions(project.id)).find(v => v.name === name);
    if (!v) return tracked;
    // First in the list: the background syncs tracked versions in order, so the
    // sprint the user is waiting on gets its snapshots before the others.
    const next = [{
      projectId: project.id, projectName: project.name,
      versionId: v.id,      versionName: v.name,
      startDate: embeddedPlan?.start ?? v.startDate ?? null, endDate: embeddedPlan?.end ?? v.endDate ?? null,
    }, ...tracked];
    await chrome.storage.local.set({ [TRACKED_KEY]: next });
    try { chrome.runtime.sendMessage({ type: 'sync-now' }); } catch { /* sw may be asleep */ }
    return next;
  } catch { return tracked; }
}

async function renderAll() {
  const output  = document.getElementById('output');
  const noData  = document.getElementById('no-data');

  if (EMBEDDED && await resolveEmbeddedTarget() && !embeddedPlan) { showPlanSetup(output, noData); return; }

  // ── No versions tracked ───────────────────────────────────────────────────
  let tracked = (await chrome.storage.local.get(TRACKED_KEY))[TRACKED_KEY] ?? [];
  if ((!tracked.length || EMBEDDED) && !autoTrackTried) {
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
      // Manual date edit → clear the sprint selector so it doesn't show stale selection
      const fs = document.getElementById('filter-sprint');
      if (fs) fs.value = '';
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

  if (EMBEDDED && embeddedTarget) {
    // Nothing stored for this version yet: fetch its history now (rebuilt from the planned start)
    const hasData = snapshots.some(s => s.backlogVersion === embeddedTarget.version.name);
    if (!hasData) {
      embeddedEmptyNote(noData);
      const syncOn = (all.__blm_sync_burndown ?? true);
      if (!embeddedSyncTried && syncOn) { embeddedSyncTried = true; triggerSync(); }
    }
  }
  if (!snapshots.length) { noData.style.display='block'; return; }
  if (!snapshots.length) {
    if (EMBEDDED) showEmbeddedEmpty(noData, all);
    else noData.style.display='block';
    return;
  }
  noData.style.display='none';

  const byVersion    = groupByVersion(snapshots);
  const bySources    = groupSources(snapshots);
  const byMoves      = groupMoves(snapshots);
  const byThroughput = groupThroughput(all, DETAIL_PREFIX);
  const byFlow       = groupFlow(all);
  const byDetail     = groupDetail(all, DETAIL_PREFIX);
  const frag = document.createDocumentFragment();

  // Main-view filter: when ON, render ONLY "Credit Utility <CurrentSprint>" — if a
  // section for it exists among the current snapshots. If the user hasn't tracked
  // that version yet, we silently fall back to rendering everything so they aren't
  // left staring at a blank page.
  const mainVer      = currentMainViewVersion();
  if (EMBEDDED && !byVersion.has(mainVer)) {
    if (embeddedTarget) embeddedEmptyNote(noData);
    noData.style.display = 'block';
    return;
  }
  const applyMainOnly = mainViewOnly && byVersion.has(mainVer);
  for (const [version, dateMap] of byVersion) {
    if (applyMainOnly && version !== mainVer) continue;
    const sourcesMap    = bySources.get(version)    ?? new Map();
    const movesMap      = byMoves.get(version)      ?? new Map();
    const throughputMap = byThroughput.get(version) ?? new Map();
    const flowRecord    = byFlow.get(version)       ?? null;
    const detailRecord  = byDetail.get(version)     ?? new Map();
    const { el, update, getCanvas, isDoneShown, isSyncedToday } = buildBacklogSection(version, dateMap, sourcesMap, movesMap, throughputMap, flowRecord, detailRecord);
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
function currentMainViewVersion() {
  if (embeddedTarget) return embeddedTarget.version.name;   // the drawer was opened for this version
  if (!mainViewProject) return null;
  const s = sprintInfo(sprintIndexForDate(todayStr()));
  return `${mainViewProject} ${s.name}`;
}

// ─── Sprint math (2-week sprints; anchor start: 2026-04-10 = "26.04.B") ───────
//
// Each sprint runs from its planning Friday through the NEXT planning Friday
// (inclusive), so sprint N end == sprint N+1 start (the planning day overlap).
// Example: 26.04.B = 2026-04-10 (Fri) → 2026-04-24 (Fri)
//          26.05.A = 2026-04-24 (Fri) → 2026-05-08 (Fri)

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
  return { idx, name, start: fmtDate(startMs), end: fmtDate(endMs) };
}

function populateSprintSelector() {
  const currentIdx = sprintIndexForDate(todayStr());
  // Current sprint + 9 previous = 10 total
  const sprints = Array.from({ length: 10 }, (_, i) => sprintInfo(currentIdx - i));
  const opts = sprints.map(s => `<option value="${s.start}|${s.end}|${s.name}">${s.name} (${s.start} → ${s.end})</option>`).join('');

  const filterSel = document.getElementById('filter-sprint');
  if (filterSel) {
    const prev = filterSel.value;
    const currentSprint = sprintInfo(sprintIndexForDate(todayStr()));
    const currentVal = `${currentSprint.start}|${currentSprint.end}|${currentSprint.name}`;
    filterSel.innerHTML = '<option value="">— Sprint —</option>' + opts;
    filterSel.value = prev || currentVal;
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
  if (willOpen) { loadVersionPanel(); loadPlanningSettings(); }
}

// ─── Planning settings ────────────────────────────────────────────────────────

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

// ── Planning settings load/save ───────────────────────────────────────────────

async function loadPlanningSettings() {
  const s   = await chrome.storage.local.get(SETTINGS_KEY);
  const cfg = s[SETTINGS_KEY] ?? {};
  const dailyEl   = document.getElementById('planning-daily-cutoff');
  const cutoffEl  = document.getElementById('planning-cutoff');
  const monCbEl   = document.getElementById('planning-monday-enabled');
  const monTimeEl = document.getElementById('planning-monday-cutoff');
  if (dailyEl)   dailyEl.value    = cfg.dailyCutoff     ?? '09:30';
  if (cutoffEl)  cutoffEl.value   = cfg.planningCutoff  ?? '21:00';
  if (monCbEl)   monCbEl.checked  = cfg.mondayEnabled   ?? false;
  if (monTimeEl) { monTimeEl.value = cfg.mondayCutoff ?? '12:00'; monTimeEl.classList.toggle('visible', monCbEl?.checked ?? false); }
  _excludeTypes = cfg.excludeTypes ?? ['Task'];
  renderTypeTags();
}

async function savePlanningSettings() {
  const daily   = document.getElementById('planning-daily-cutoff')?.value   || '09:30';
  const cutoff  = document.getElementById('planning-cutoff')?.value          || '21:00';
  const monOn   = document.getElementById('planning-monday-enabled')?.checked ?? false;
  const monTime = document.getElementById('planning-monday-cutoff')?.value   || '12:00';

  const prev = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? {};
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { ...prev, dailyCutoff: daily, planningCutoff: cutoff, mondayEnabled: monOn, mondayCutoff: monTime, excludeTypes: _excludeTypes },
  });

  const dailyChanged     = daily  !== (prev.dailyCutoff    ?? '09:30');
  const sprintEndChanged = cutoff !== (prev.planningCutoff ?? '21:00');
  const mondayChanged    = monOn  !== (prev.mondayEnabled  ?? false)
                        || (monOn && monTime !== (prev.mondayCutoff ?? '12:00'));

  if (dailyChanged) {
    // Daily cutoff affects every regular day — invalidate all tracked snapshots
    await invalidateAllTrackedSnapshots();
    triggerSync();
  } else if (sprintEndChanged || mondayChanged) {
    await invalidatePlanningSnapshots(sprintEndChanged, mondayChanged);
    triggerSync();
  }
}

/** Removes stored snapshots for dates whose cutoff time just changed so reconstruction re-creates them. */
async function invalidatePlanningSnapshots(includeSprintEnd, includeMonday) {
  const tracked       = (await chrome.storage.local.get(TRACKED_KEY))[TRACKED_KEY] ?? [];
  const planningDates = [...new Set(
    tracked.flatMap(v => [v.startDate, v.endDate]).filter(Boolean)
  )];
  const toDelete = [];

  for (const d of planningDates) {
    const monDate = nextMonday(d);
    for (const v of tracked) {
      if (includeSprintEnd) toDelete.push(`${d}__${v.versionName}`);
      if (includeMonday)    toDelete.push(`${monDate}__${v.versionName}`);
    }
  }

  if (toDelete.length) await chrome.storage.local.remove(toDelete);
}

function nextMonday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const daysToAdd = (8 - d.getUTCDay()) % 7 || 7; // days until next Monday
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return d.toISOString().slice(0, 10);
}

document.getElementById('planning-daily-cutoff').addEventListener('change', savePlanningSettings);
document.getElementById('planning-cutoff').addEventListener('change', savePlanningSettings);
document.getElementById('planning-monday-enabled').addEventListener('change', (e) => {
  document.getElementById('planning-monday-cutoff').classList.toggle('visible', e.target.checked);
  savePlanningSettings();
});
document.getElementById('planning-monday-cutoff').addEventListener('change', savePlanningSettings);

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
  const body    = document.getElementById('version-panel-body');
  const saveBtn = document.getElementById('btn-version-save');
  const msg     = document.getElementById('version-panel-msg');

  body.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading versions…</div>';
  document.getElementById('version-panel-projects').innerHTML = '';
  saveBtn.disabled = true;
  msg.textContent  = '';
  msg.className    = 'version-panel-msg';

  const stored      = await chrome.storage.local.get([TRACKED_KEY, PROJECT_FILTER_KEY]);
  const tracked     = stored[TRACKED_KEY] ?? [];
  const trackedIds  = new Set(tracked.map(v => v.versionId));
  const trackedById = new Map(tracked.map(v => [v.versionId, v]));

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
        .then(versions => ({
          project: p,
          versions,
          openVersions:   versions.filter(v => v.status === 'open'),
          closedVersions: versions.filter(v => v.status !== 'open'),
        }))
        .catch(() => ({ project: p, versions: [], openVersions: [], closedVersions: [] }))
    )
  );

  const projectsWithVers = results.filter(r => r.versions.length);

  // Resolve selected projects: saved filter OR default (Credit Utility + Valiant)
  const savedFilter = stored[PROJECT_FILTER_KEY];
  let selectedProjects = new Set(
    savedFilter
      ?? projectsWithVers.filter(r => isDefaultProject(r.project.name)).map(r => r.project.id)
  );

  // Count total untracked closed versions (for the "Show closed" chip label)
  const totalClosed = projectsWithVers.reduce(
    (n, { closedVersions }) => n + closedVersions.filter(v => !trackedIds.has(v.id)).length,
    0
  );

  // Track "show closed" state so chip toggle can reach it after body is built
  let showClosed = false;

  // Render project filter chips
  renderProjectChips(projectsWithVers, selectedProjects, totalClosed, (newSet) => {
    selectedProjects = newSet;
    chrome.storage.local.set({ [PROJECT_FILTER_KEY]: [...newSet] });
    // Show/hide project groups without re-rendering (preserves checkbox states)
    for (const { project } of projectsWithVers) {
      const g = body.querySelector(`.vp-group[data-project-id="${project.id}"]`);
      if (g) g.style.display = newSet.has(project.id) ? '' : 'none';
    }
  }, () => {
    showClosed = !showClosed;
    body.querySelectorAll('.vp-closed').forEach(el => {
      el.style.display = showClosed ? '' : 'none';
    });
  });

  // Build version list (all groups rendered; non-selected ones hidden)
  body.innerHTML = '';

  // ── Tracking section: currently tracked versions pinned at top ──
  if (tracked.length) {
    const g = makeVersionGroup('Tracking', null);
    for (const v of tracked)
      g.appendChild(makeVersionRow(v.versionId, v.versionName, v.startDate, v.endDate, true));
    body.appendChild(g);
  }

  // ── Per-project sections: untracked open + closed versions ──
  for (const { project, openVersions, closedVersions } of projectsWithVers) {
    const untrackedOpen   = openVersions.filter(v => !trackedIds.has(v.id));
    const untrackedClosed = closedVersions.filter(v => !trackedIds.has(v.id));
    if (!untrackedOpen.length && !untrackedClosed.length) continue;

    const g = makeVersionGroup(project.name, project.id);
    g.style.display = selectedProjects.has(project.id) ? '' : 'none';
    for (const v of untrackedOpen)
      g.appendChild(makeVersionRow(v.id, v.name, v.startDate, v.endDate, false, false));
    for (const v of untrackedClosed)
      g.appendChild(makeVersionRow(v.id, v.name, v.startDate, v.endDate, false, true));
    body.appendChild(g);
  }

  if (!body.children.length)
    body.innerHTML = '<div style="color:var(--muted);font-size:12px">No versions found.</div>';

  saveBtn.disabled = false;
  saveBtn.onclick  = async () => {
    const newTracked = [];
    for (const cb of body.querySelectorAll('input[type="checkbox"]:checked')) {
      const versionId = Number(cb.dataset.versionId);
      if (trackedById.has(versionId)) { newTracked.push(trackedById.get(versionId)); continue; }
      for (const { project, openVersions, closedVersions } of projectsWithVers) {
        const v = [...openVersions, ...closedVersions].find(v => v.id === versionId);
        if (v) {
          newTracked.push({
            projectId: project.id, projectName: project.name,
            versionId: v.id,       versionName: v.name,
            startDate: v.startDate ?? null, endDate: v.endDate ?? null,
          });
          break;
        }
      }
    }
    await chrome.storage.local.set({ [TRACKED_KEY]: newTracked });
    showToast(`Saved — tracking ${newTracked.length} version(s)`, 'sync');
    toggleVersionPanel(false);
  };
}

function renderProjectChips(projectsWithVers, selectedProjects, totalClosed, onToggle, onToggleClosed) {
  const container = document.getElementById('version-panel-projects');
  container.innerHTML = '<div class="vp-chips-label">Projects</div>';

  const wrap = document.createElement('div');
  wrap.className = 'vp-chips';

  for (const { project } of projectsWithVers) {
    const chip = document.createElement('button');
    chip.type      = 'button';
    chip.className = 'vp-chip' + (selectedProjects.has(project.id) ? ' active' : '');
    chip.textContent = project.name;
    chip.addEventListener('click', () => {
      const newSet = new Set(selectedProjects);
      if (newSet.has(project.id)) newSet.delete(project.id);
      else newSet.add(project.id);
      chip.classList.toggle('active', newSet.has(project.id));
      onToggle(newSet);
    });
    wrap.appendChild(chip);
  }

  if (totalClosed > 0) {
    const sep = document.createElement('span'); sep.className = 'vp-chip-sep';
    wrap.appendChild(sep);
    const closedChip = document.createElement('button');
    closedChip.type      = 'button';
    closedChip.className = 'vp-chip vp-chip-closed';
    closedChip.textContent = `Show closed (${totalClosed})`;
    closedChip.addEventListener('click', () => {
      closedChip.classList.toggle('active');
      onToggleClosed();
    });
    wrap.appendChild(closedChip);
  }

  container.appendChild(wrap);
}

function makeVersionGroup(title, projectId) {
  const g = document.createElement('div');
  g.className = 'vp-group';
  if (projectId != null) g.dataset.projectId = projectId;
  g.innerHTML = `<div class="vp-project-label">${title}</div>`;
  return g;
}

function makeVersionRow(versionId, name, startDate, endDate, checked, isClosed = false) {
  const label = document.createElement('label');
  label.className = 'vp-version-row' + (isClosed ? ' vp-closed' : '');
  if (isClosed) label.style.display = 'none';
  const fmt   = iso => iso ? iso.slice(5).replace('-', '/') : '';
  const dates = startDate ? `${fmt(startDate)} – ${fmt(endDate)}` : '';
  label.innerHTML =
    `<input type="checkbox" data-version-id="${versionId}" ${checked ? 'checked' : ''}>` +
    `<span class="vp-version-name">${name}</span>` +
    (dates ? `<span class="vp-version-dates">${dates}</span>` : '');
  return label;
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
    if (key === CFG_SYNC_BURNDOWN && EMBEDDED) {
      // switched on in Settings while the drawer is open: fetch now, not at the next hourly sync
      if (newValue ?? true) try { chrome.runtime.sendMessage({ type: 'sync-now' }); } catch { /* sw may be asleep */ }
      renderAll();
    }
    if (key === '__blm_fetch_progress' && isSyncing && newValue) {
      const { done, total, version } = newValue;
      setProgressFill(done, total, `${version}: fetching activities ${done} / ${total}`);
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
document.getElementById('filter-sprint').addEventListener('change', (ev) => {
  const v = ev.target.value;
  if (!v) return;
  const [start, end] = v.split('|');
  startInput.value = start;
  endInput.value   = end;
  sectionUpdaters.forEach(u => u(start, end));
});
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
    : [...assigned, ...projects].find(p => versions.has(`${p} ${s.name}`)) ?? assigned[0] ?? projects[0] ?? guess;
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
