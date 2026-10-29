// Sprint math (2-week sprints; anchor start: 2026-04-10 = "26.04.B")
//
// A sprint starts on its planning Friday and ends on the Thursday 13 days later, as the
// OpenProject versions do; the next Friday is the next sprint's planning day.  The name
// still comes from the month of that next Friday.
// Example: 26.04.B = 2026-04-10 (Fri) → 2026-04-23 (Thu)
//          26.05.A = 2026-04-24 (Fri) → 2026-05-07 (Thu)

const SPRINT_DAY_MS       = 86400000;
const SPRINT_LEN_DAYS     = 14;
const SPRINT_ANCHOR_START = Date.UTC(2026, 3, 10); // 2026-04-10

export function sprintIndexForDate(dateStr) {
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

export function sprintInfo(idx) {
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
