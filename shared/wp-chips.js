// wp-chips.js — work package references as chips: a type icon, the id and the title.
//
// A classic script (no imports) so both the extension pages and the Jira-skin content
// script can use it: window.blmChips. It rewrites a DOM subtree in place: links to
// /work_packages/123 and plain "#123" in text become <a class="blm-chip">. The details
// (type, title, status) come from the caller's `info(id)`, which returns what it has
// cached, or undefined while it loads (and tells the caller to re-run when it arrives).

'use strict';

(() => {
  const GLYPH = {
    bug:   '<circle cx="12" cy="13" r="5"/><path d="M12 8V5M7 13H4M20 13h-3M8 9 6 7M16 9l2-2"/>',
    story: '<path d="M7 4h10v16l-5-4-5 4z"/>',
    task:  '<path d="m6 12 4 4 8-8"/>',
    other: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  };
  const kindOf = name => {
    const n = (name ?? '').toLowerCase();
    if (/bug|defect|incident/.test(n)) return 'bug';
    if (/story|feature|requirement/.test(n)) return 'story';
    if (/task|chore|support|investigation|sub/.test(n)) return 'task';
    return 'other';
  };
  const icon = kind => `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[kind]}</svg>`;

  const css = `
.blm-chip { display: inline-flex; align-items: center; gap: 6px; max-width: min(100%, 460px); height: 22px; padding: 0 8px 0 3px;
  vertical-align: middle; box-sizing: border-box; border-radius: 4px; text-decoration: none !important; white-space: nowrap;
  background: var(--blm-chip-bg, var(--overlay, #f1f2f4)); color: var(--blm-chip-fg, var(--text, #172b4d));
  border: 1px solid var(--blm-chip-border, var(--border2, #dcdfe4)); font: 500 13px/1 var(--font-body, system-ui, sans-serif); }
.blm-chip:hover { background: var(--blm-chip-hover, var(--surface2, #e4e6ea)); }
.blm-chip:focus-visible { outline: 2px solid var(--blm-chip-focus, var(--focus, #4c7dff)); outline-offset: 1px; }
.blm-chip-ic { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 16px; height: 16px; border-radius: 3px; background: var(--tc, #6b7280); color: #fff; }
.blm-chip[data-kind="bug"]   { --tc: var(--red, #d6293e); }
.blm-chip[data-kind="story"] { --tc: var(--green, #2f9e5b); }
.blm-chip[data-kind="task"]  { --tc: var(--accent, #3d6fe0); }
.blm-chip[data-kind="other"] { --tc: var(--warn, #b7791f); }
.blm-chip[data-kind="story"] .blm-chip-ic { color: var(--bg, #fff); }
.blm-chip-id { flex: none; font: 600 12px var(--font-mono, ui-monospace, monospace); color: var(--blm-chip-muted, var(--text2, #626f86)); }
.blm-chip-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.blm-chip[data-state="wait"] .blm-chip-t { opacity: .5; }
.blm-chip[data-state="plain"] { height: auto; padding: 0; border: 0; background: none; }
`;

  let styled = false;
  const installStyles = () => {
    if (styled || document.getElementById('blm-chips-css')) return;
    styled = true;
    const el = document.createElement('style');
    el.id = 'blm-chips-css';
    el.textContent = css;
    (document.head ?? document.documentElement).append(el);
  };

  const wpIdOf = href => /\/work_packages\/(\d+)(?:[/?#]|$)/.exec(href ?? '')?.[1] ?? null;
  // "#123" that stands alone: not part of a word, a URL fragment, an entity or a longer number.
  const REF = /(^|[^\w&/#])#(\d{3,8})(?![\w])/g;
  const SKIP = 'a, code, pre, button, textarea, input, select, script, style, .blm-chip';

  /** Gives a chip its content: placeholder first, then the loaded details. */
  function fill(el, id, info) {
    const sig = info ? `${info.type}|${info.subject}|${info.status}` : info === null ? 'failed' : 'wait';
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    if (info === null) {   // couldn't be read (no access, deleted): back to what the author wrote
      el.dataset.state = 'plain';
      el.textContent = el.dataset.orig || `#${id}`;
      return;
    }
    const kind = kindOf(info?.type);
    el.className = 'blm-chip';
    el.dataset.kind = kind;
    el.dataset.state = info ? 'ready' : 'wait';
    el.replaceChildren();
    const ic = document.createElement('i');
    ic.className = 'blm-chip-ic';
    ic.innerHTML = icon(kind);
    const num = document.createElement('span');
    num.className = 'blm-chip-id';
    num.textContent = `#${id}`;
    el.append(ic, num);
    if (info) {
      const t = document.createElement('span');
      t.className = 'blm-chip-t';
      t.textContent = info.subject;
      el.append(t);
      el.title = [info.type, `#${id}`, info.status && `· ${info.status}`, '—', info.subject].filter(Boolean).join(' ');
    }
  }

  /**
   * Rewrites `root` in place. opts: { origin, info(id), newTab } — origin builds the link of a plain "#123".
   */
  function transform(root, { origin = '', info, newTab = true } = {}) {
    // 1. Links to work packages ("#123", a bare URL, or OpenProject's own macro link) and chips made before.
    for (const a of root.querySelectorAll('a[href*="/work_packages/"], a.blm-chip')) {
      const id = a.dataset.wp ?? wpIdOf(a.getAttribute('href'));
      if (!id) continue;
      const text = a.textContent.trim();
      const ours = a.classList.contains('blm-chip');
      if (!ours && !a.classList.contains('work_package') && !/^#?\d+$/.test(text) && !/^[^:]{1,40}#\d+/.test(text) && !/\/work_packages\/\d+/.test(text)) continue;   // a link with its own words stays
      if (!ours) { a.dataset.orig = text; a.dataset.wp = id; a.classList.add('blm-chip'); }
      fill(a, id, info(id));
    }
    // 2. Plain "#123" in text.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes('#') && !n.parentElement?.closest(SKIP)) nodes.push(n);
    for (const node of nodes) {
      const text = node.nodeValue;
      REF.lastIndex = 0;
      let last = 0, m;
      const frag = document.createDocumentFragment();
      while ((m = REF.exec(text))) {
        const at = m.index + m[1].length;
        frag.append(text.slice(last, at));
        const a = document.createElement('a');
        a.className = 'blm-chip';
        a.dataset.wp = m[2];
        a.dataset.orig = `#${m[2]}`;
        a.href = `${origin}/work_packages/${m[2]}`;
        if (newTab) { a.target = '_blank'; a.rel = 'noopener'; }
        fill(a, m[2], info(m[2]));
        frag.append(a);
        last = at + 1 + m[2].length;
      }
      if (!last) continue;
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }

  window.blmChips = { transform, installStyles, css, wpIdOf };
})();
