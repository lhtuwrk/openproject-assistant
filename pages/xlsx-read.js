// xlsx-read.js — reads the first sheet of an .xlsx into rows of cell values, with
// what Chrome already ships (DecompressionStream, DOMParser): the repo has no bundler
// to pull a spreadsheet library through. Read-only, values only — no styles, so a
// struck-through row reads like any other.
// shortcut: no zip64 and no formula evaluation (cached values are used), fine for
// an ordinary Excel workbook; swap in a real library if either is ever needed.

const utf8 = new TextDecoder();

function zipEntries(buf) {
  const v = new DataView(buf);
  let p = buf.byteLength - 22;
  while (p >= 0 && v.getUint32(p, true) !== 0x06054b50) p--;
  if (p < 0) throw new Error('Not an .xlsx file');
  const count = v.getUint16(p + 10, true);
  let o = v.getUint32(p + 16, true);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const nameLen = v.getUint16(o + 28, true);
    out.set(utf8.decode(new Uint8Array(buf, o + 46, nameLen)), {
      method: v.getUint16(o + 10, true), size: v.getUint32(o + 20, true), local: v.getUint32(o + 42, true),
    });
    o += 46 + nameLen + v.getUint16(o + 30, true) + v.getUint16(o + 32, true);
  }
  return out;
}

async function entryXml(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  const v = new DataView(buf);
  const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
  const raw = new Uint8Array(buf, start, e.size);
  const text = e.method === 0
    ? utf8.decode(raw)
    : await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  return new DOMParser().parseFromString(text, 'application/xml');
}

const tags = (node, name) => [...node.getElementsByTagName(name)];
/** Text of a string item, skipping phonetic runs. */
const richText = node => tags(node, 't').filter(t => t.parentNode.nodeName !== 'rPh').map(t => t.textContent).join('');

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    if (ch < 'A') break;
    n = n * 26 + ch.charCodeAt(0) - 64;
  }
  return n - 1;
}

/** 'xl/worksheets/sheet1.xml' + '../drawings/vmlDrawing1.vml' → 'xl/drawings/vmlDrawing1.vml' */
function resolveRelative(fromDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromDir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/**
 * A tick-box grid like the team's dependency sheet is often drawn with Excel's
 * legacy Form Control checkboxes (Developer ▸ Insert ▸ Form Controls), which sit
 * over a cell rather than being its value — the cell itself stays blank unless the
 * checkbox has a "Cell link". Reads the sheet's VML drawing (the one thing that
 * records each checkbox's own state) and returns `{row, col, checked}` for every
 * one, 0-based like `colIndex`, so a blank cell under one can be filled in.
 * shortcut: Form Control checkboxes only, not ActiveX ones (a different, DrawingML
 * mechanism) — upgrade this if a sheet turns out to use those instead.
 */
async function readFormCheckboxes(buf, entries, sheetPath, sheetXml) {
  const rId = tags(sheetXml, 'legacyDrawing')[0]?.getAttribute('r:id');
  if (!rId) return [];
  const sheetDir = sheetPath.slice(0, sheetPath.lastIndexOf('/'));
  const sheetFile = sheetPath.slice(sheetDir.length + 1);
  const sheetRels = await entryXml(buf, entries, `${sheetDir}/_rels/${sheetFile}.rels`);
  const target = sheetRels && tags(sheetRels, 'Relationship').find(r => r.getAttribute('Id') === rId)?.getAttribute('Target');
  if (!target) return [];
  const vml = await entryXml(buf, entries, resolveRelative(sheetDir, target));
  if (!vml) return [];
  const out = [];
  for (const shape of tags(vml, 'v:shape')) {
    const data = tags(shape, 'x:ClientData')[0];
    if (!data || data.getAttribute('ObjectType') !== 'Checkbox') continue;
    const [col, , row] = (tags(data, 'x:Anchor')[0]?.textContent ?? '').split(',').map(Number);
    if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
    out.push({ col, row, checked: tags(data, 'x:Checked')[0]?.textContent.trim() === '1' });
  }
  return out;
}

function cellValue(c, shared) {
  const type = c.getAttribute('t');
  if (type === 'inlineStr') return richText(c);
  const raw = tags(c, 'v')[0]?.textContent ?? '';
  if (raw === '') return '';
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'b') return raw === '1';
  if (type === 'str' || type === 'e') return raw;
  return Number(raw);
}

/**
 * @param {string} [sheetName] Reads this sheet (by its exact tab name) instead of
 *   the first one — a workbook with several same-shaped tabs (this sprint's,
 *   last sprint's, a patch build's) only has one actually in use, and it isn't
 *   always the first; the caller finds out which from the `sheets` this returns.
 * @returns {Promise<{name: string, rows: Array<Array<string|number|boolean>>, sheets: string[], checkboxes: number}>}
 *   rows are dense, '' for an empty cell.
 */
export async function readFirstSheet(buf, sheetName) {
  const entries = zipEntries(buf);
  const workbook = await entryXml(buf, entries, 'xl/workbook.xml');
  const sheetEls = workbook ? tags(workbook, 'sheet') : [];
  if (!sheetEls.length) throw new Error('Not an .xlsx file');
  const sheets = sheetEls.map(s => s.getAttribute('name') ?? '');
  const sheet = (sheetName && sheetEls.find(s => s.getAttribute('name') === sheetName)) ?? sheetEls[0];
  const rels = await entryXml(buf, entries, 'xl/_rels/workbook.xml.rels');
  const target = tags(rels, 'Relationship').find(r => r.getAttribute('Id') === sheet.getAttribute('r:id'))?.getAttribute('Target') ?? '';
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const sheetXml = await entryXml(buf, entries, sheetPath);
  if (!sheetXml) throw new Error('That sheet could not be read');
  const sharedXml = await entryXml(buf, entries, 'xl/sharedStrings.xml');
  const shared = sharedXml ? tags(sharedXml, 'si').map(richText) : [];

  const rowEls = tags(sheetXml, 'row');
  const rowNumbers = rowEls.map(r => Number(r.getAttribute('r')) || 0);
  const rows = rowEls.map(row => {
    const cells = [];
    for (const c of tags(row, 'c')) cells[colIndex(c.getAttribute('r') ?? '')] = cellValue(c, shared);
    return Array.from(cells, v => v ?? '');
  });

  let checkboxes = 0;
  for (const cb of await readFormCheckboxes(buf, entries, sheetPath, sheetXml)) {
    const r = rows[rowNumbers.indexOf(cb.row + 1)];
    // A row's array only runs as far as its last real cell, so a checkbox sitting
    // past that (the common case — these columns otherwise hold no value at all)
    // reads back as undefined, not ''; either counts as "nothing here yet".
    if (r && (r[cb.col] ?? '') === '') { r[cb.col] = cb.checked; checkboxes++; }
  }
  return { name: sheet.getAttribute('name') ?? '', rows, checkboxes, sheets };
}
