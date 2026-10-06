// import.js — CSV import logic for Backlog Monitor
'use strict';

// ─── CSV parser ───────────────────────────────────────────────────────────────

/**
 * Parses a CSV string into a 2-D array of strings.
 * Handles quoted fields, embedded commas, newlines inside quotes, and "" escapes.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCSVRaw(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch   = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }   // escaped ""
      else if (ch === '"')            { inQuotes = false; }    // closing quote
      else                            { field += ch; }
    } else {
      if      (ch === '"')                         { inQuotes = true; }
      else if (ch === ',')                         { row.push(field); field = ''; }
      else if (ch === '\r' && next === '\n')       { row.push(field); rows.push(row); row = []; field = ''; i++; }
      else if (ch === '\n' || ch === '\r')         { row.push(field); rows.push(row); row = []; field = ''; }
      else                                         { field += ch; }
    }
  }
  // flush last field / row
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);

  return rows;
}

/**
 * Parses a CSV text and groups rows by Status.
 * Returns { backlogName, statuses } where backlogName is derived from the filename.
 *
 * Expected columns (OpenProject export):
 *   id, Subject, Assignee, Priority, Type, Status, Story Points, …
 *
 * @param {string} text        Raw CSV text
 * @param {string} filename    Used as default backlog name (without extension)
 * @returns {{ statuses: Array<{status, numOfStory, point}>, error: string|null }}
 */
function parseCSV(text, filename) {
  const rows = parseCSVRaw(text.trim());
  if (rows.length < 2) return { statuses: [], error: 'File is empty or has no data rows.' };

  const headers    = rows[0].map(h => h.trim());
  const statusIdx  = headers.indexOf('Status');
  const pointsIdx  = headers.indexOf('Story Points');

  if (statusIdx === -1) {
    return { statuses: [], error: 'No "Status" column found. Is this an OpenProject CSV export?' };
  }

  // Group data rows by Status
  const map = new Map();
  for (const row of rows.slice(1)) {
    const status = (row[statusIdx] ?? '').trim();
    if (!status) continue;
    if (!map.has(status)) map.set(status, { count: 0, points: 0 });
    const entry = map.get(status);
    entry.count++;
    if (pointsIdx !== -1) {
      const pts = parseFloat(row[pointsIdx]);
      if (!isNaN(pts)) entry.points += pts;
    }
  }

  if (map.size === 0) return { statuses: [], error: 'No status groups found in the data.' };

  const statuses = [...map.entries()].map(([status, { count, points }]) => ({
    status,
    numOfStory : String(count),
    point      : points > 0 ? String(points) : '0',
  }));

  return { statuses, error: null };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}__.+$/;

/** Returns a Set of all existing storage keys matching YYYY-MM-DD__version */
async function loadExistingKeys() {
  const all = await chrome.storage.local.get(null);
  return new Set(Object.keys(all).filter(k => DATE_KEY_PATTERN.test(k)));
}

/** Today's date as YYYY-MM-DD (local time) */
function todayString() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

// ─── State ────────────────────────────────────────────────────────────────────

// Map<cardId, { file, statuses, error }>
const fileCards = new Map();
let   cardSeq   = 0;
let   existingKeys = new Set();  // loaded once, updated after each import

// ─── UI helpers ──────────────────────────────────────────────────────────────

function getStorageKey(date, backlogName) {
  return `${date}__${backlogName.trim()}`;
}

/**
 * Checks the date + backlogName combo and updates the validation badge.
 * Returns true if the combination is valid and unused.
 */
function validateDate(card) {
  const date        = card.querySelector('.field-date').value;
  const backlogName = card.querySelector('.field-input').value.trim();
  const badge       = card.querySelector('.date-status');

  if (!date) {
    badge.textContent = 'Pick a date.';
    badge.className   = 'date-status empty';
    return false;
  }
  if (!backlogName) {
    badge.textContent = 'Enter a backlog name.';
    badge.className   = 'date-status empty';
    return false;
  }

  const key = getStorageKey(date, backlogName);
  if (existingKeys.has(key)) {
    badge.textContent = `✗ ${date} already has data for "${backlogName}".`;
    badge.className   = 'date-status taken';
    return false;
  }

  badge.textContent = `✓ Available`;
  badge.className   = 'date-status ok';
  return true;
}

/** Re-evaluates every card and enables/disables the Import All button. */
function refreshImportButton() {
  const cards   = [...document.querySelectorAll('.file-card')];
  const allOk   = cards.length > 0 && cards.every(c => {
    const cardId = c.dataset.cardId;
    const data   = fileCards.get(Number(cardId));
    return data && !data.error && validateDate(c);
  });
  document.getElementById('btn-import-all').disabled = !allOk;
}

/** Renders the status chips preview inside a card. */
function renderStatusPreview(container, statuses) {
  container.innerHTML = '';
  for (const { status, numOfStory, point } of statuses) {
    const chip = document.createElement('span');
    chip.className = 'status-chip';
    chip.innerHTML =
      `<span class="chip-name">${status}</span>` +
      `<span class="chip-count">${numOfStory}</span>` +
      `<span class="chip-points">${point}pts</span>`;
    container.appendChild(chip);
  }
}

// ─── Card builder ─────────────────────────────────────────────────────────────

/**
 * Creates and appends a file card for one uploaded file.
 * Reads the file, parses the CSV, and wires up all interactions.
 */
async function addFileCard(file) {
  const id          = ++cardSeq;
  const defaultName = file.name.replace(/\.csv$/i, '');

  // Read file text
  const text = await file.text();
  const { statuses, error } = parseCSV(text, file.name);

  // Store parsed data for this card
  fileCards.set(id, { file, statuses, error });

  // ── Build card DOM ────────────────────────────────────────────────────────
  const card = document.createElement('div');
  card.className    = 'file-card';
  card.dataset.cardId = id;

  // Header row: filename + remove button
  const header = document.createElement('div');
  header.className = 'file-card-header';

  const nameEl = document.createElement('span');
  nameEl.className   = 'file-name';
  nameEl.textContent = file.name;

  const removeBtn = document.createElement('button');
  removeBtn.className   = 'btn-remove';
  removeBtn.title       = 'Remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    fileCards.delete(id);
    card.remove();
    refreshImportButton();
    if (fileCards.size === 0) {
      document.getElementById('import-result').textContent = '';
    }
  });

  header.appendChild(nameEl);
  header.appendChild(removeBtn);
  card.appendChild(header);

  if (error) {
    // Show parse error — no fields needed
    const errEl = document.createElement('p');
    errEl.className   = 'parse-error';
    errEl.textContent = `Parse error: ${error}`;
    card.appendChild(errEl);
    document.getElementById('file-list').appendChild(card);
    refreshImportButton();
    return;
  }

  // ── Fields row ────────────────────────────────────────────────────────────
  const fields = document.createElement('div');
  fields.className = 'file-fields';

  // Backlog name input
  const nameGroup = document.createElement('div');
  nameGroup.className = 'field-group';
  nameGroup.innerHTML = '<label class="field-label">Backlog name</label>';
  const nameInput = document.createElement('input');
  nameInput.type        = 'text';
  nameInput.className   = 'field-input';
  nameInput.value       = defaultName;
  nameInput.placeholder = 'e.g. Credit Utility 26.04.B';
  nameGroup.appendChild(nameInput);
  fields.appendChild(nameGroup);

  // Date input
  const dateGroup = document.createElement('div');
  dateGroup.className = 'field-group';
  dateGroup.innerHTML = '<label class="field-label">Date</label>';
  const dateInput = document.createElement('input');
  dateInput.type      = 'date';
  dateInput.className = 'field-date';
  dateInput.value     = todayString();
  dateInput.setAttribute('data-role', 'date');

  // Validation badge sits below the date input
  const dateBadge = document.createElement('div');
  dateBadge.className = 'date-status empty';

  dateGroup.appendChild(dateInput);
  dateGroup.appendChild(dateBadge);
  fields.appendChild(dateGroup);

  card.appendChild(fields);

  // ── Status preview ────────────────────────────────────────────────────────
  const preview = document.createElement('div');
  preview.className = 'status-preview';
  renderStatusPreview(preview, statuses);
  card.appendChild(preview);

  // ── Wire up live validation ───────────────────────────────────────────────
  const revalidate = () => {
    validateDate(card);
    refreshImportButton();
  };
  nameInput.addEventListener('input',  revalidate);
  dateInput.addEventListener('change', revalidate);

  document.getElementById('file-list').appendChild(card);

  // Run initial validation after the card is in the DOM
  validateDate(card);
  refreshImportButton();
}

// ─── Import action ────────────────────────────────────────────────────────────

async function importAll() {
  const btn    = document.getElementById('btn-import-all');
  const result = document.getElementById('import-result');
  btn.disabled = true;
  result.textContent = '';
  result.className   = '';

  const cards = [...document.querySelectorAll('.file-card')];
  let   saved = 0;
  const errors = [];

  for (const card of cards) {
    const cardId      = Number(card.dataset.cardId);
    const data        = fileCards.get(cardId);
    if (!data || data.error) continue;

    const backlogName = card.querySelector('.field-input').value.trim();
    const date        = card.querySelector('.field-date').value;
    if (!backlogName || !date) continue;

    const storageKey = getStorageKey(date, backlogName);

    // Final guard: re-check in case storage changed since last validation
    const fresh = await loadExistingKeys();
    if (fresh.has(storageKey)) {
      errors.push(`"${backlogName}" on ${date} already exists — skipped.`);
      continue;
    }

    try {
      const snapshot = structuredClone({ backlogVersion: backlogName, statuses: data.statuses });
      await chrome.storage.local.set({ [storageKey]: snapshot });
      existingKeys.add(storageKey);  // update local cache so duplicates in same batch are caught
      saved++;

      // Mark card as imported
      card.style.opacity  = '0.5';
      card.style.pointerEvents = 'none';
      card.querySelector('.date-status').textContent = '✓ Imported';
      card.querySelector('.date-status').className   = 'date-status ok';
    } catch (err) {
      errors.push(`Failed to save "${backlogName}": ${err.message}`);
    }
  }

  if (errors.length) {
    result.textContent = errors.join(' | ');
    result.className   = 'error';
  } else {
    result.textContent = `✓ ${saved} snapshot${saved !== 1 ? 's' : ''} imported.`;
    result.className   = 'success';
  }

  // Remove imported cards after a short delay
  setTimeout(() => {
    document.querySelectorAll('.file-card').forEach(c => {
      if (c.style.opacity === '0.5') {
        fileCards.delete(Number(c.dataset.cardId));
        c.remove();
      }
    });
    refreshImportButton();
  }, 1200);
}

// ─── Drop zone ────────────────────────────────────────────────────────────────

function handleFiles(files) {
  document.getElementById('import-result').textContent = '';
  for (const file of files) {
    if (file.name.endsWith('.csv')) addFileCard(file);
  }
}

const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  handleFiles(fileInput.files);
  fileInput.value = ''; // reset so the same file can be re-added
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});

document.getElementById('btn-import-all').addEventListener('click', importAll);

// ─── Init ─────────────────────────────────────────────────────────────────────

// Pre-load existing keys so date validation works immediately
loadExistingKeys().then(keys => { existingKeys = keys; });
