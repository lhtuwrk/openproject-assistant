// package-canvas.js — free-form node/edge canvas shared by the template editor
// and the package detail (run) view. Plain DOM + SVG + pointer events only: MV3
// forbids remotely-hosted code, so no drag/flowchart library.
//
// renderCanvas(container, { nodes, edges, mode, nodeStatus, onNodeClick, onGraphChange, onDone })
//   nodes/edges are mutated in place (same array/object references the caller
//   holds); onGraphChange() is called after every mutation so the caller can
//   persist. mode: 'run' is read-only positions, click opens a step dialog.
//   mode: 'edit' adds drag-to-move, connect-by-handle, inline rename, delete,
//   and a small toolbar (+Task, +Decision, Done editing).

const NODE_W = 190;
const NODE_H = 80;
const DECISION_H = 100;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID();

// ─── Icons ───────────────────────────────────────────────────────────────────
// Tiny inline SVGs (currentColor), so a node reads its kind and status at a
// glance instead of only through its border colour.

const ICONS = {
  task: '<path d="M4 2h6l2 2v8H4z"/><path d="M8 2v2h2"/><path d="M5.5 7h5M5.5 9h5"/>',
  decision: '<path d="M7 2v3M7 9v3M2 7h3M9 7h3"/><circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none"/>',
  done: '<path d="M2.5 7.5l3 3 6-6.5" fill="none"/>',
  lock: '<rect x="3" y="6.5" width="8" height="6" rx="1"/><path d="M4.5 6.5V4.5a2.5 2.5 0 0 1 5 0v2"/>',
  clock: '<circle cx="7" cy="7" r="5.5"/><path d="M7 4v3l2 1.5"/>',
  checklist: '<path d="M3 4h2M3 7h2M3 10h2" stroke-width="1.6"/><path d="M6.5 4h5M6.5 7h5M6.5 10h5" stroke-width="1.3"/>',
  gate: '<rect x="4" y="6" width="6" height="5.5" rx="1"/><path d="M5.5 6V4.5a1.5 1.5 0 0 1 3 0V6"/>',
};
const icon = (name, cls = '') => `<svg class="pkg-icon ${cls}" viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const nodeHeight = node => node.kind === 'decision' ? DECISION_H : NODE_H;
const nodeCenter = node => ({ x: node.x + NODE_W / 2, y: node.y + nodeHeight(node) / 2 });

export function renderCanvas(container, opts) {
  const { nodes, edges, mode, nodeStatus = () => 'locked', onNodeClick = () => {}, onGraphChange = () => {}, onDone = null } = opts;
  const editable = mode === 'edit';

  container.innerHTML = `
    ${editable ? `<div class="pkg-canvas-toolbar">
      <button type="button" data-act="add-task">+ Task</button>
      <button type="button" data-act="add-decision">+ Decision</button>
      ${onDone ? '<span class="spacer"></span><button type="button" class="primary" data-act="done-editing">Done editing</button>' : ''}
    </div>` : ''}
    <div class="pkg-canvas"><svg class="pkg-edges"></svg></div>`;

  const canvas = container.querySelector('.pkg-canvas');
  const svg = container.querySelector('.pkg-edges');
  const arrowDefs = ['muted', 'done', 'now'].map(tone => `
    <marker id="pkg-arrow-${tone}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="var(--${tone === 'muted' ? 'muted' : tone === 'done' ? 'green' : 'accent'})"/>
    </marker>`).join('');
  svg.innerHTML = `<defs>${arrowDefs}</defs>`;

  let connecting = null; // { fromId, line }

  function canvasSize() {
    const maxX = Math.max(400, ...nodes.map(n => n.x + NODE_W + 60));
    const maxY = Math.max(300, ...nodes.map(n => n.y + nodeHeight(n) + 60));
    return { w: maxX, h: maxY };
  }

  function drawEdges() {
    const { w, h } = canvasSize();
    canvas.style.minWidth = `${w}px`;
    canvas.style.minHeight = `${h}px`;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const defs = svg.querySelector('defs').outerHTML;
    svg.innerHTML = defs + edges.map(edge => {
      const from = nodes.find(n => n.id === edge.from);
      const to = nodes.find(n => n.id === edge.to);
      if (!from || !to) return '';
      const a = nodeCenter(from);
      const b = nodeCenter(to);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // Travelled ground shows where the package has been: a done "from" paints the
      // whole edge done, the current step's own way forward is picked out in accent.
      const fromState = editable ? '' : nodeStatus(from);
      const tone = fromState === 'done' ? 'done' : fromState === 'now' ? 'now' : 'muted';
      const chip = edge.label
        ? `<g data-act="edge-chip" data-edge="${esc(edge.id)}" style="cursor:${editable ? 'pointer' : 'default'}">
            <rect x="${mx - 18}" y="${my - 10}" width="36" height="20" rx="10" fill="var(--surface)" stroke="var(--border2)"/>
            <text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="10" fill="var(--text2)">${esc(edge.label)}</text>
          </g>`
        : editable
          ? `<g data-act="edge-chip" data-edge="${esc(edge.id)}" style="cursor:pointer"><circle cx="${mx}" cy="${my}" r="6" fill="var(--surface)" stroke="var(--border2)"/></g>`
          : '';
      return `<path class="pkg-edge edge-${tone}" d="M${a.x},${a.y} L${b.x},${b.y}" stroke-width="${tone === 'muted' ? 1.5 : 2}" fill="none" marker-end="url(#pkg-arrow-${tone})"/>${chip}`;
    }).join('');
  }

  function nodeBadges(node) {
    const out = [];
    if (node.when) out.push(`<span class="pkg-node-badge" title="${esc(node.when)}">${icon('clock')}</span>`);
    if (node.todo?.length) out.push(`<span class="pkg-node-badge" title="${node.todo.length} checklist item(s)">${icon('checklist')}${node.todo.length}</span>`);
    if (node.gate) out.push(`<span class="pkg-node-badge" title="Checked against the dependency sheet">${icon('gate')}</span>`);
    return out.length ? `<span class="pkg-node-badges">${out.join('')}</span>` : '';
  }

  function nodeHtml(node) {
    const state = editable ? '' : nodeStatus(node);
    const isDecision = node.kind === 'decision';
    const cls = ['pkg-node', `kind-${node.kind}`, state].filter(Boolean).join(' ');
    // The diamond only has room for a short label: no kind icon or badge row, or
    // they spill past the clipped shape (clip-path trims the box, not overflow).
    return `<div class="${cls}" data-id="${esc(node.id)}" style="left:${node.x}px;top:${node.y}px;width:${NODE_W}px;height:${nodeHeight(node)}px">
      ${state === 'done' ? `<span class="pkg-node-status" aria-hidden="true">${icon('done')}</span>` : ''}
      ${state === 'now' ? '<span class="pkg-node-pulse" aria-hidden="true"></span>' : ''}
      ${isDecision ? '' : `<span class="pkg-node-kind" aria-hidden="true">${icon('task')}</span>`}
      <span class="pkg-node-label" data-role="label">${esc(node.label)}</span>
      ${!editable && !isDecision ? nodeBadges(node) : ''}
      ${editable ? `<button type="button" class="pkg-node-del" data-act="del-node" aria-label="Delete ${esc(node.label)}">✕</button>
        <span class="pkg-node-handle" data-act="connect" aria-hidden="true"></span>` : ''}
    </div>`;
  }

  function drawNodes() {
    canvas.querySelectorAll('.pkg-node').forEach(el => el.remove());
    for (const node of nodes) canvas.insertAdjacentHTML('beforeend', nodeHtml(node));
  }

  function repaint() { drawNodes(); drawEdges(); }
  repaint();

  function commit() { onGraphChange(); repaint(); }

  // ─── Edit-mode toolbar ─────────────────────────────────────────────────────
  if (editable) {
    container.querySelector('.pkg-canvas-toolbar').addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'add-task' || act === 'add-decision') {
        const node = { id: uid(), label: act === 'add-task' ? 'New task' : 'New decision', kind: act === 'add-task' ? 'task' : 'decision', x: 40, y: 40 };
        nodes.push(node);
        commit();
        startRename(node.id);
      } else if (act === 'done-editing') {
        onDone();
      }
    });
  }

  // ─── Rename ────────────────────────────────────────────────────────────────
  function startRename(nodeId) {
    const node = nodes.find(n => n.id === nodeId);
    const el = canvas.querySelector(`.pkg-node[data-id="${CSS.escape(nodeId)}"] [data-role="label"]`);
    if (!node || !el) return;
    el.innerHTML = `<input type="text" class="pkg-node-rename" value="${esc(node.label)}" />`;
    const input = el.querySelector('input');
    input.focus(); input.select();
    const finish = () => { node.label = input.value.trim() || node.label; commit(); };
    input.addEventListener('blur', finish, { once: true });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.removeEventListener('blur', finish); el.textContent = node.label; }
    });
  }

  // ─── Pointer interactions (edit mode only) ─────────────────────────────────
  if (!editable) {
    canvas.addEventListener('click', e => {
      const el = e.target.closest('.pkg-node');
      if (!el) return;
      const node = nodes.find(n => n.id === el.dataset.id);
      if (node) onNodeClick(node);
    });
    return;
  }

  canvas.addEventListener('pointerdown', e => {
    const handle = e.target.closest('[data-act="connect"]');
    const delBtn = e.target.closest('[data-act="del-node"]');
    const label = e.target.closest('[data-role="label"]');
    const nodeEl = e.target.closest('.pkg-node');
    if (delBtn && nodeEl) {
      const id = nodeEl.dataset.id;
      const idx = nodes.findIndex(n => n.id === id);
      if (idx >= 0) nodes.splice(idx, 1);
      for (let i = edges.length - 1; i >= 0; i--) if (edges[i].from === id || edges[i].to === id) edges.splice(i, 1);
      commit();
      return;
    }
    if (handle && nodeEl) {
      e.preventDefault();
      connecting = { fromId: nodeEl.dataset.id };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (label) { startRename(nodeEl.dataset.id); return; }
    if (nodeEl) {
      e.preventDefault();
      const node = nodes.find(n => n.id === nodeEl.dataset.id);
      const rect = canvas.getBoundingClientRect();
      const offX = e.clientX - rect.left - node.x;
      const offY = e.clientY - rect.top - node.y;
      canvas.setPointerCapture(e.pointerId);
      const onMove = ev => {
        node.x = Math.max(0, ev.clientX - rect.left - offX);
        node.y = Math.max(0, ev.clientY - rect.top - offY);
        nodeEl.style.left = `${node.x}px`;
        nodeEl.style.top = `${node.y}px`;
        drawEdges();
      };
      const onUp = () => {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        commit();
      };
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp, { once: true });
    }
  });

  canvas.addEventListener('pointermove', e => {
    if (!connecting) return;
    const rect = canvas.getBoundingClientRect();
    let line = svg.querySelector('#pkg-connect-line');
    const from = nodes.find(n => n.id === connecting.fromId);
    const a = nodeCenter(from);
    const bx = e.clientX - rect.left, by = e.clientY - rect.top;
    if (!line) {
      line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.id = 'pkg-connect-line';
      line.setAttribute('stroke', 'var(--accent)');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke-dasharray', '4 3');
      svg.append(line);
    }
    line.setAttribute('d', `M${a.x},${a.y} L${bx},${by}`);
  });

  canvas.addEventListener('pointerup', e => {
    if (!connecting) return;
    const fromId = connecting.fromId;
    connecting = null;
    svg.querySelector('#pkg-connect-line')?.remove();
    const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pkg-node');
    if (targetEl && targetEl.dataset.id !== fromId) {
      const toId = targetEl.dataset.id;
      const fromNode = nodes.find(n => n.id === fromId);
      let label = '';
      if (fromNode.kind === 'decision') {
        const used = new Set(edges.filter(ed => ed.from === fromId).map(ed => ed.label));
        label = !used.has('yes') ? 'yes' : !used.has('no') ? 'no' : '';
      }
      edges.push({ id: uid(), from: fromId, to: toId, label });
      commit();
    } else {
      repaint();
    }
  });

  svg.addEventListener('click', e => {
    const chip = e.target.closest('[data-act="edge-chip"]');
    if (!chip) return;
    const id = chip.dataset.edge;
    const idx = edges.findIndex(ed => ed.id === id);
    if (idx >= 0) edges.splice(idx, 1);
    commit();
  });
}
