// child-rows.js — row actions for a Child work items list: delete (with an iOS-style
// confirmation) and drag-to-reorder.
//
// A classic script (no imports), loaded before the skin scripts in the same content-
// script entry (background.js registerHostScripts), so any skin can use it:
// globalThis.blmChildRows. It owns no section of its own: the caller builds the
// rows and appends the controls these functions return, then rebuilds when told.
//
//   const rows = blmChildRows.create({ apiBase, writeHeaders, onChange, beforeAction, afterDelete });
//   rows.orderedKids(wpId, kids)      the kids in the saved order
//   rows.deleteButton(k)              a trash button (or an empty cell) for a row
//   rows.reorderHandle(k, i, count)   a drag grip (or an empty cell) for a row <li data-row="id">
//   rows.sig(wpId)                    changes whenever the rows need a rebuild
//   rows.deleteError()                the last failed delete's message, or ''
//   rows.dragging()                   true mid-drag: don't rebuild the list then
//
// Deleting is the only write to OpenProject (DELETE /api/v3/work_packages/:id, with
// the caller's session headers). OpenProject keeps no order among a work package's
// children, so the order is saved in this browser only (`__blm_child_order`:
// parent id -> { ids, at }); children missing from it follow in id order.
//
// Styles belong to each skin (content/ios/detail.css draws .blm-jx-delete,
// .blm-jx-reorder, the drag states and dialog.blm-ios-alert).

'use strict';

(() => {
  if (globalThis.blmChildRows) return;

  const CFG_CHILD_ORDER = '__blm_child_order';
  const ORDER_KEEP = 300;   // parents remembered; the least recently reordered go first

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function gapCell(cls) {
    const gap = el('span', cls);
    gap.setAttribute('aria-hidden', 'true');
    return gap;
  }

  /** A modal iOS alert; resolves true when the confirm button is chosen. */
  function confirmDialog({ title, message, confirmLabel }) {
    return new Promise(resolve => {
      const dlg = el('dialog', 'blm-ios-alert');
      dlg.setAttribute('role', 'alertdialog');
      const t = el('h2', 'blm-ios-alert-title', title);
      t.id = 'blm-ios-alert-title';
      const m = el('p', 'blm-ios-alert-msg', message);
      m.id = 'blm-ios-alert-msg';
      dlg.setAttribute('aria-labelledby', t.id);
      dlg.setAttribute('aria-describedby', m.id);
      const row = el('div', 'blm-ios-alert-actions');
      const cancel = el('button', 'blm-ios-alert-btn', 'Cancel');
      cancel.type = 'button';
      const ok = el('button', 'blm-ios-alert-btn destructive', confirmLabel);
      ok.type = 'button';
      cancel.addEventListener('click', () => dlg.close('cancel'));
      ok.addEventListener('click', () => dlg.close('ok'));
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close('cancel'); });   // backdrop
      dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue === 'ok'); }, { once: true });
      row.append(cancel, ok);
      dlg.append(t, m, row);
      document.body.append(dlg);
      dlg.showModal();
      cancel.focus();             // the safe choice has focus, so Enter doesn't delete
    });
  }

  function create({ apiBase, writeHeaders, onChange, beforeAction = () => {}, afterDelete = () => {} }) {
    // ─── Delete ──────────────────────────────────────────────────────────────────
    //  It asks first; a child that isn't a Task asks a second time, because deleting
    //  a story or a bug also deletes the work packages under it. Only children
    //  OpenProject lets this user delete (k.deletable, its `delete` link) get the
    //  button; others get an empty cell so the columns line up.

    const deletingKids = new Set();
    let deleteError = '';

    function deleteButton(k) {
      if (!k.deletable) return gapCell('blm-jx-delete-gap');
      const b = el('button', 'blm-jx-delete');
      b.type = 'button';
      b.dataset.kid = k.id;
      b.dataset.focus = 'delete';
      b.title = `Delete #${k.id}`;
      b.setAttribute('aria-label', `Delete #${k.id}: ${k.subject}`);
      if (deletingKids.has(k.id)) { b.classList.add('saving'); b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-busy', 'true'); }
      b.addEventListener('click', e => {
        e.stopPropagation();
        const wpId = b.closest('[data-wp]')?.dataset.wp;
        if (wpId) deleteChild(wpId, k);
      });
      return b;
    }

    async function deleteChild(wpId, k) {
      if (deletingKids.has(k.id)) return;
      beforeAction();
      const ok = await confirmDialog({
        title: `Delete #${k.id}?`,
        message: `"${k.subject}" will be deleted from OpenProject. This can't be undone.`,
        confirmLabel: 'Delete',
      });
      if (!ok) return;
      if (!/^task$/i.test(k.type.trim())) {
        const type = k.type || 'work package';
        const sure = await confirmDialog({
          title: `#${k.id} is a ${type}, not a Task`,
          message: `Deleting a ${type} also deletes every work package under it. Delete it anyway?`,
          confirmLabel: `Delete ${type}`,
        });
        if (!sure) return;
      }
      deletingKids.add(k.id);
      deleteError = '';
      onChange();
      try {
        const res = await fetch(`${apiBase}/api/v3/work_packages/${k.id}`, {
          method: 'DELETE', credentials: 'include', headers: writeHeaders(),
        });
        if (!res.ok) {
          let msg = '';
          try { msg = (await res.json()).message ?? ''; } catch { /* not JSON */ }
          throw new Error(msg || `HTTP ${res.status}`);
        }
        afterDelete(wpId, k.id);                     // e.g. drop the cache so the list refetches
      } catch (err) {
        deleteError = `Couldn't delete #${k.id}: ${err.message || 'request failed'}`;
        const shown = deleteError;
        setTimeout(() => { if (deleteError === shown) { deleteError = ''; onChange(); } }, 6000);
      } finally {
        deletingKids.delete(k.id);
        onChange();
      }
    }

    // ─── Reorder ─────────────────────────────────────────────────────────────────
    //  The grip drags its row up or down; with the grip focused, ↑ and ↓ move it one
    //  place. Rows are the list's <li data-row="id"> children.

    let childOrder = {};
    let drag = null;          // { pointerId, handle, li, list, rows, tops, heights, height, from, to, startY, wpId }
    chrome.storage.local.get(CFG_CHILD_ORDER).then(s => { childOrder = s[CFG_CHILD_ORDER] ?? {}; onChange(); }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(CFG_CHILD_ORDER in changes)) return;
      childOrder = changes[CFG_CHILD_ORDER].newValue ?? {};
      onChange();
    });

    /** The kids in the saved order; unsaved ones after them, by id. */
    function orderedKids(wpId, kids) {
      const ids = childOrder[wpId]?.ids;
      if (!Array.isArray(ids) || !ids.length) return kids;
      const rank = new Map(ids.map((id, i) => [String(id), i]));
      return [...kids].sort((a, b) =>
        (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || Number(a.id) - Number(b.id));
    }

    function saveOrder(wpId, ids) {
      childOrder = { ...childOrder, [wpId]: { ids, at: Date.now() } };
      const keys = Object.keys(childOrder);
      if (keys.length > ORDER_KEEP) {
        keys.sort((a, b) => (childOrder[a]?.at ?? 0) - (childOrder[b]?.at ?? 0))
          .slice(0, keys.length - ORDER_KEEP).forEach(key => delete childOrder[key]);
      }
      try { chrome.storage.local.set({ [CFG_CHILD_ORDER]: childOrder }).catch(() => {}); } catch { /* context gone */ }
      onChange();
    }

    function reorderHandle(k, index, count) {
      if (count < 2) return gapCell('blm-jx-reorder-gap');
      const b = el('button', 'blm-jx-reorder');
      b.type = 'button';
      b.dataset.kid = k.id;
      b.dataset.focus = 'reorder';
      b.title = 'Drag to reorder';
      b.setAttribute('aria-label', `Move #${k.id}: ${k.subject}, ${index + 1} of ${count}. Up and down arrows move it`);
      b.addEventListener('pointerdown', startDrag);
      b.addEventListener('keydown', onKey);
      return b;
    }

    const rowsOf = list => [...list.querySelectorAll(':scope > li[data-row]')];

    function onKey(e) {
      if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const li = e.currentTarget.closest('li');
      const wpId = li?.closest('[data-wp]')?.dataset.wp;
      if (!wpId) return;
      const ids = rowsOf(li.parentElement).map(r => r.dataset.row);
      const from = ids.indexOf(li.dataset.row);
      const to = from + (e.key === 'ArrowUp' ? -1 : 1);
      if (from < 0 || to < 0 || to >= ids.length) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      saveOrder(wpId, ids);      // the caller's rebuild puts focus back on this grip
    }

    function startDrag(e) {
      if (e.button !== 0 || drag) return;
      const handle = e.currentTarget;
      const li = handle.closest('li');
      const list = li?.parentElement;
      const wpId = list?.closest('[data-wp]')?.dataset.wp;
      if (!wpId) return;
      e.preventDefault();        // no text selection while dragging
      beforeAction();
      const rows = rowsOf(list);
      const listTop = list.getBoundingClientRect().top;
      // Row tops relative to the list, so a scroll mid-drag doesn't throw the maths off.
      const rects = rows.map(r => r.getBoundingClientRect());
      const tops = rects.map(r => r.top - listTop);
      const heights = rects.map(r => r.height);
      const from = rows.indexOf(li);
      drag = {
        pointerId: e.pointerId, handle, li, list, rows, tops, heights, wpId, from, to: from,
        height: heights[from], startY: e.clientY - listTop,
      };
      try { handle.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      list.classList.add('reordering');
      li.classList.add('dragging');
      document.documentElement.classList.add('blm-reordering');
      handle.addEventListener('pointermove', moveDrag);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, endDrag);
    }

    function moveDrag(e) {
      const d = drag;
      if (!d || e.pointerId !== d.pointerId) return;
      const y = e.clientY - d.list.getBoundingClientRect().top;
      const last = d.rows.length - 1;
      // The row stays inside the card: its top no higher than the first row's top,
      // its bottom no lower than the last row's bottom.
      const minDy = d.tops[0] - d.tops[d.from];
      const maxDy = d.tops[last] + d.heights[last] - (d.tops[d.from] + d.height);
      const dy = Math.max(minDy, Math.min(maxDy, y - d.startY));
      d.li.style.transform = `translateY(${dy}px)`;
      // Its new index: a row below is passed once the dragged row's bottom reaches its
      // middle, a row above once the dragged row's top rises past its middle. Edges, not
      // the middle, so the clamped row can always reach the first and the last place.
      const top = d.tops[d.from] + dy;
      const bottom = top + d.height;
      let to = 0;
      d.rows.forEach((r, i) => {
        const middle = d.tops[i] + d.heights[i] / 2;
        if (i < d.from ? top > middle : i > d.from && bottom >= middle) to++;
      });
      if (to === d.to) return;
      d.to = to;
      d.rows.forEach((r, i) => {
        if (i === d.from) return;
        const shift = d.from < to && i > d.from && i <= to ? -d.height
                    : to < d.from && i >= to && i < d.from ? d.height : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    }

    function endDrag(e) {
      const d = drag;
      if (!d || (e.pointerId != null && e.pointerId !== d.pointerId)) return;
      drag = null;
      d.handle.removeEventListener('pointermove', moveDrag);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) d.handle.removeEventListener(type, endDrag);
      try { d.handle.releasePointerCapture(d.pointerId); } catch { /* already released */ }
      document.documentElement.classList.remove('blm-reordering');
      // Settle without animating: transitions go with .reordering, then the row moves
      // in the DOM so nothing jumps before the caller's rebuild.
      d.list.classList.remove('reordering');
      d.li.classList.remove('dragging');
      for (const r of d.rows) r.style.transform = '';
      if (e.type === 'pointerup' && d.to !== d.from) {
        const ids = d.rows.map(r => r.dataset.row);
        ids.splice(d.to, 0, ids.splice(d.from, 1)[0]);
        const after = d.rows.filter(r => r !== d.li)[d.to];
        d.list.insertBefore(d.li, after ?? d.rows[d.rows.length - 1].nextSibling);
        saveOrder(d.wpId, ids);
      } else onChange();
    }

    return {
      orderedKids,
      deleteButton,
      reorderHandle,
      sig: wpId => `${[...deletingKids].join(',')}|${deleteError}|${(childOrder[wpId]?.ids ?? []).join(',')}`,
      deleteError: () => deleteError,
      dragging: () => !!drag,
    };
  }

  globalThis.blmChildRows = { create, confirmDialog };
})();
