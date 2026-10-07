// sidepanel.js — Quick settings in Chrome's side panel (opened from the popup).
//
// The switches come from the Settings page itself (dashboard.html: each
// .feature[data-key] with data-default), so a feature added there shows up here
// too. Changes save on click, like Settings, and both stay in step through
// chrome.storage.onChanged.

const groupsEl = document.getElementById('groups');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** [{ title, features: [{ key, def, name, desc }] }] read from the Settings page. */
async function readFeatures() {
  const html = await (await fetch(chrome.runtime.getURL('pages/dashboard.html'))).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('section.group')].map(g => ({
    title: g.querySelector('.group-title')?.textContent.trim() ?? '',
    features: [...g.querySelectorAll('.feature[data-key]')].map(f => ({
      key:  f.dataset.key,
      def:  f.dataset.default === 'true',
      name: f.querySelector('.name')?.textContent.trim() ?? f.dataset.key,
      desc: f.querySelector('.desc')?.textContent.trim() ?? '',
    })),
    hasTheme: !!g.querySelector('input[name="theme"]'),
  })).filter(g => g.features.length || g.hasTheme);
}

function themeRow() {
  const li = el('li', 'row');
  const label = el('span', 'name', 'Theme');
  label.id = 'sp-theme-label';
  const seg = el('div', 'segmented');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-labelledby', label.id);
  for (const [value, text] of [['dark', 'Dark'], ['light', 'Light']]) {
    const input = el('input');
    input.type = 'radio';
    input.name = 'sp-theme';
    input.id = `sp-t-${value}`;
    input.value = value;
    input.checked = window.blmTheme.get() === value;
    input.addEventListener('change', () => { if (input.checked) window.blmTheme.set(value); });
    const lab = el('label', null, text);
    lab.htmlFor = input.id;
    seg.append(input, lab);
  }
  document.addEventListener('blm-theme-change', e => {
    const r = seg.querySelector(`input[value="${e.detail}"]`);
    if (r) r.checked = true;
  });
  li.append(label, seg, el('p', 'desc', 'Applies to the popup, every dashboard page and the backlog skin.'));
  return li;
}

async function render() {
  let groups;
  try {
    groups = await readFeatures();
  } catch {
    groupsEl.replaceChildren(el('p', 'note', "Couldn't read the settings. Use All settings instead."));
    return;
  }
  const keys = groups.flatMap(g => g.features.map(f => f.key));
  const stored = await chrome.storage.local.get(keys);
  const inputs = new Map();   // key -> { input, row, def }

  groupsEl.replaceChildren(...groups.map((g, gi) => {
    const section = el('section');
    const title = el('h2', 'group-title', g.title);
    title.id = `sp-g-${gi}`;
    section.setAttribute('aria-labelledby', title.id);
    const rows = el('ul', 'rows');
    for (const f of g.features) {
      const li = el('li', 'row');
      const input = el('input');
      input.type = 'checkbox';
      input.className = 'switch';
      input.id = `sp-${f.key}`;
      input.checked = stored[f.key] ?? f.def;
      li.classList.toggle('off', !input.checked);
      input.addEventListener('change', () => {
        li.classList.toggle('off', !input.checked);
        chrome.storage.local.set({ [f.key]: input.checked });
      });
      const name = el('label', 'name', f.name);
      name.htmlFor = input.id;
      li.append(name, input);
      if (f.desc) {
        const desc = el('p', 'desc', f.desc);
        desc.title = f.desc;
        li.append(desc);
      }
      rows.append(li);
      inputs.set(f.key, { input, row: li, def: f.def });
    }
    if (g.hasTheme) rows.append(themeRow());
    section.append(title, rows);
    return section;
  }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { input, row, def }] of inputs) {
      if (!(key in changes)) continue;
      input.checked = changes[key].newValue ?? def;
      row.classList.toggle('off', !input.checked);
    }
  });
}

document.getElementById('all-settings').addEventListener('click', async e => {
  e.preventDefault();
  const url = chrome.runtime.getURL('pages/dashboard.html');
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// Shown in the right-hand drawer (quick-settings-host.js): × and Escape close it.
if (new URLSearchParams(location.search).has('embedded')) {
  const btn = document.getElementById('close-panel');
  btn.hidden = false;
  const closeDrawer = () => window.parent.postMessage({ type: 'blm-drawer-close' }, '*');
  btn.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
}

render();
