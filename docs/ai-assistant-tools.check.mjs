// Self-check for the assistant's tools: node docs/ai-assistant-tools.check.mjs
// Runs shared/assistant-tools.js (and the pure helpers in assistant-context.js) with fake OpenProject
// calls: every kind's shape allow-list, its check against the values OpenProject allows, what Apply
// sends and what Undo sends back. Not part of the extension or its release zip.

import assert from 'node:assert/strict';

globalThis.chrome = { runtime: { getURL: p => p }, storage: { onChanged: { addListener() {} }, local: { get: async () => ({}) } } };
const T = await import('../shared/assistant-tools.js');
const C = await import('../shared/assistant-context.js');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok  ${name}`); };

// ─── Fake OpenProject ─────────────────────────────────────────────────────────

const self = (href, name) => ({ _links: { self: { href } }, name });
const wp = () => ({
  id: 100, subject: 'Old', storyPoints: 3, description: { raw: 'old desc' },
  _links: {
    project: { href: '/api/v3/projects/9' }, version: { href: '/api/v3/versions/5', title: 'Sprint A' },
    status: { href: '/api/v3/statuses/1', title: 'New' }, priority: { href: '/api/v3/priorities/2', title: 'Normal' },
    assignee: { href: '/api/v3/users/7', title: 'Ann' }, customField6: [{ href: '/api/v3/custom_options/1', title: 'Core' }],
  },
});
const schema = () => ({
  priority: { _embedded: { allowedValues: [self('/api/v3/priorities/2', 'Normal'), self('/api/v3/priorities/3', 'High')] } },
  customField6: { type: '[]CustomOption', _embedded: { allowedValues: [self('/api/v3/custom_options/1', 'Core'), self('/api/v3/custom_options/2', 'Edge')] } },
  version: { _embedded: { allowedValues: [self('/api/v3/versions/5', 'Sprint A'), self('/api/v3/versions/6', 'Sprint B')] } },
});

function fake(over = {}) {
  const calls = [];
  const rec = name => async (...a) => { calls.push([name, ...a]); return { id: 555 }; };
  const deps = {
    calls,
    fetchWorkPackage: async id => { if (String(id) === '404') throw new Error('HTTP 404'); return String(id) === '101' ? kid() : wp(); },
    fetchEditForm: async () => ({ schema: schema(), payload: {} }),
    fetchAllowedStatuses: async () => [{ href: '/api/v3/statuses/1', name: 'New' }, { href: '/api/v3/statuses/2', name: 'In progress' }, { href: '/api/v3/statuses/3', name: 'Resolved' }],
    fetchAvailableAssignees: async () => [{ href: '/api/v3/users/7', name: 'Ann' }, { href: '/api/v3/users/8', name: 'Bob Lee' }, { href: '/api/v3/users/9', name: 'Bob Ray' }],
    fetchChildWorkPackages: async () => [kid()],
    fetchProjectTypes: async () => [{ href: '/api/v3/types/1', name: 'User story' }, { href: '/api/v3/types/2', name: 'Task' }],
    fetchCreateForm: async () => ({ schema: schema(), payload: { _links: { project: { href: '/api/v3/projects/9' }, priority: { href: '/api/v3/priorities/2' } } } }),
    fetchOpenVersions: async () => [{ name: 'Sprint A', _links: { self: { href: '/api/v3/versions/5' } } }, { name: 'Sprint C', _links: { self: { href: '/api/v3/versions/7' } } }],
    patchWorkPackage: rec('patch'), createWorkPackage: rec('create'), postComment: rec('comment'),
    createRelation: rec('relation'), deleteRelation: rec('unrelate'),
    read: {
      wp: async id => `story ${id}`, comments: async id => `comments ${id}`, search: async q => `found ${q}`,
      sprint: async name => `sprint ${name}`, time: async r => `time ${JSON.stringify(r)}`, workload: async () => 'x'.repeat(7000),
    },
    ...over,
  };
  return deps;
}
function kid() {
  return { id: 101, subject: 'Kid A', _links: { type: { href: '/api/v3/types/2', title: 'Task' }, status: { href: '/api/v3/statuses/1', title: 'New' }, project: { href: '/api/v3/projects/9' } } };
}
const story = { screen: 'story', wp: '100', project: 'demo' };
const list  = { screen: 'list', wp: null, project: 'demo' };

/** Parse one action as Claude would write it, then resolve it. */
async function go(action, scope = story, deps = fake()) {
  const p = T.parseActions('```blm-actions\n' + JSON.stringify({ actions: [action] }) + '\n```', scope.screen);
  if (!p || p.bad) return { parsed: null, deps };
  const [a] = await T.resolveActions(p.actions, T.makeCx(scope, deps));
  return { a, deps, parsed: p.actions[0] };
}
const patches = deps => deps.calls.filter(c => c[0] === 'patch');

// ─── parseActions: the envelope ───────────────────────────────────────────────

await test('parseActions: no block, broken JSON, empty, unknown or prototype kinds', () => {
  assert.equal(T.parseActions('just text', 'story'), null);
  assert.deepEqual(T.parseActions('```blm-actions\n{nope\n```', 'story'), { bad: true });
  assert.deepEqual(T.parseActions('```blm-actions\n{"actions":[]}\n```', 'story'), { bad: true });
  for (const kind of ['delete', 'constructor', '__proto__', 'toString', 42, null]) {
    assert.deepEqual(T.parseActions('```blm-actions\n' + JSON.stringify({ actions: [{ kind, subject: 'x' }] }) + '\n```', 'story'), { bad: true }, String(kind));
  }
});

await test('parseActions: only kinds valid for the screen survive', () => {
  const block = acts => '```blm-actions\n' + JSON.stringify({ actions: acts }) + '\n```';
  const mixed = [{ kind: 'create-story', subject: 'S', type: 'Task' }, { kind: 'subject', subject: 'New' }];
  assert.deepEqual(T.parseActions(block(mixed), 'story').actions.map(a => a.kind), ['subject']);
  assert.deepEqual(T.parseActions(block(mixed), 'list').actions.map(a => a.kind), ['create-story']);
  assert.deepEqual(T.parseActions(block(mixed), null), { bad: true });
});

await test('parseActions: single-value kinds once, at most MAX_ACTIONS, extra fields dropped', () => {
  const block = acts => '```blm-actions\n' + JSON.stringify({ actions: acts }) + '\n```';
  const dup = T.parseActions(block([{ kind: 'status', to: 'A' }, { kind: 'status', to: 'B' }]), 'story');
  assert.deepEqual(dup.actions, [{ kind: 'status', to: 'A' }]);
  const many = Array.from({ length: 30 }, (_, i) => ({ kind: 'comment', text: `c${i}` }));
  assert.equal(T.parseActions(block(many), 'story').actions.length, T.MAX_ACTIONS);
  assert.deepEqual(T.parseActions(block([{ kind: 'status', to: 'A', evil: '<script>', href: '/api/v3/x' }]), 'story').actions[0], { kind: 'status', to: 'A' });
});

await test('resolveActions never throws: a failing lookup becomes a skipped action', async () => {
  const deps = fake({ fetchAllowedStatuses: async () => { throw Object.assign(new Error('boom'), {}); } });
  const { a } = await go({ kind: 'status', to: 'Resolved' }, story, deps);
  assert.equal(a.ok, false);
  assert.match(a.why, /boom/);
  const signedOut = fake({ fetchAllowedStatuses: async () => { throw Object.assign(new Error('x'), { code: 'NOT_AUTHENTICATED' }); } });
  assert.match((await go({ kind: 'status', to: 'Resolved' }, story, signedOut)).a.why, /signed out/);
});

// ─── The older kinds ──────────────────────────────────────────────────────────

await test('subject: shape and size limits, no-op, Apply and Undo', async () => {
  for (const bad of ['', '   ', 'two\nlines', 'x'.repeat(256), 5, null]) assert.equal((await go({ kind: 'subject', subject: bad })).parsed, null, String(bad).slice(0, 10));
  assert.ok((await go({ kind: 'subject', subject: 'x'.repeat(255) })).parsed);
  assert.equal((await go({ kind: 'subject', subject: 'Old' })).a.ok, false);
  const { a, deps } = await go({ kind: 'subject', subject: 'New title' });
  assert.deepEqual(a.view, { label: 'Rename', from: 'Old', to: 'New title' });
  const r = await a.run();
  assert.deepEqual(patches(deps)[0], ['patch', '100', { subject: 'New title' }]);
  await r.undo();
  assert.deepEqual(patches(deps)[1], ['patch', '100', { subject: 'Old' }]);
});

await test('description: size limit, replaces whole text, undo restores it', async () => {
  assert.equal((await go({ kind: 'description', text: 'x'.repeat(30001) })).parsed, null);
  assert.equal((await go({ kind: 'description', text: '  ' })).parsed, null);
  const { a, deps } = await go({ kind: 'description', text: '# Goal\nNew' });
  const r = await a.run();
  assert.deepEqual(patches(deps)[0][2], { description: { raw: '# Goal\nNew' } });
  assert.deepEqual(r.marks, ['Goal']);
  await r.undo();
  assert.deepEqual(patches(deps)[1][2], { description: { raw: 'old desc' } });
});

await test('comment: size limit, posts, has no undo', async () => {
  assert.equal((await go({ kind: 'comment', text: 'x'.repeat(4001) })).parsed, null);
  const { a, deps } = await go({ kind: 'comment', text: 'Hello' });
  const r = await a.run();
  assert.deepEqual(deps.calls[0], ['comment', '100', 'Hello']);
  assert.equal(r.undo, undefined);
});

await test('subtasks: capped, blank titles dropped, created under the story in its sprint, retry does not repeat', async () => {
  const { parsed } = await go({ kind: 'subtasks', titles: [...Array.from({ length: 14 }, (_, i) => `T${i}`), '', 'a\nb'] });
  assert.equal(parsed.titles.length, T.MAX_SUBTASKS);
  assert.equal((await go({ kind: 'subtasks', titles: [] })).parsed, null);
  let fail = true;
  const deps = fake({ createWorkPackage: async b => { if (fail && b.subject === 'B') { fail = false; throw new Error('x'); } deps.calls.push(['create', b]); return { id: 1 }; } });
  const { a } = await go({ kind: 'subtasks', titles: ['A', 'B', 'C'] }, story, deps);
  await assert.rejects(a.run());
  await a.run();
  const made = deps.calls.filter(c => c[0] === 'create').map(c => c[1]);
  assert.deepEqual(made.map(b => b.subject), ['A', 'B', 'C']);
  assert.equal(made[0]._links.parent.href, '/api/v3/work_packages/100');
  assert.equal(made[0]._links.version.href, '/api/v3/versions/5');
  assert.equal(made[0]._links.type.href, '/api/v3/types/2');
});

// ─── Phase 1 ──────────────────────────────────────────────────────────────────

await test('status: only allowed next statuses, closing warns, Apply and Undo', async () => {
  for (const bad of ['', 5, null, 'x'.repeat(61)]) assert.equal((await go({ kind: 'status', to: bad })).parsed, null);
  const nope = (await go({ kind: 'status', to: 'Archived' })).a;
  assert.equal(nope.ok, false);
  assert.match(nope.why, /Archived/);
  assert.match((await go({ kind: 'status', to: 'new' })).a.why, /Already New/);
  const prog = await go({ kind: 'status', to: 'in progress' });
  assert.equal(prog.a.ok, true);
  assert.equal(prog.a.view.warn, '');
  const closing = await go({ kind: 'status', to: 'Resolved' });
  assert.match(closing.a.view.warn, /closes/);
  const r = await closing.a.run();
  assert.deepEqual(patches(closing.deps)[0], ['patch', '100', { _links: { status: { href: '/api/v3/statuses/3' } } }]);
  await r.undo();
  assert.deepEqual(patches(closing.deps)[1][2], { _links: { status: { href: '/api/v3/statuses/1' } } });
});

await test('assignee: name from available assignees, ambiguous refused, null unassigns, undo restores', async () => {
  assert.equal((await go({ kind: 'assignee', to: 5 })).parsed, null);
  assert.equal((await go({ kind: 'assignee' })).parsed, null);
  assert.equal((await go({ kind: 'assignee', to: 'x'.repeat(101) })).parsed, null);
  assert.match((await go({ kind: 'assignee', to: 'Bob' })).a.why, /more than one/);
  assert.equal((await go({ kind: 'assignee', to: 'Mallory' })).a.ok, false);
  assert.match((await go({ kind: 'assignee', to: 'ann' })).a.why, /Already/);
  const bob = await go({ kind: 'assignee', to: 'Bob Lee' });
  assert.equal(bob.a.view.to, 'Bob Lee');
  const r = await bob.a.run();
  assert.deepEqual(patches(bob.deps)[0][2], { _links: { assignee: { href: '/api/v3/users/8' } } });
  await r.undo();
  assert.deepEqual(patches(bob.deps)[1][2], { _links: { assignee: { href: '/api/v3/users/7' } } });
  const none = await go({ kind: 'assignee', to: null });
  assert.equal(none.a.view.to, 'Unassigned');
  await (await none.a.run()).undo();
  assert.deepEqual(patches(none.deps)[0][2], { _links: { assignee: { href: null } } });
  assert.deepEqual(patches(none.deps)[1][2], { _links: { assignee: { href: '/api/v3/users/7' } } });
});

await test('points: only the team scale, numbers only, undo restores', async () => {
  for (const bad of ['5', null, undefined]) assert.equal((await go({ kind: 'points', to: bad })).parsed, null);
  for (const off of [4, 3.5, -1, 101, 7]) assert.match((await go({ kind: 'points', to: off })).a.why, /scale/, String(off));
  assert.match((await go({ kind: 'points', to: 3 })).a.why, /Already/);
  const five = await go({ kind: 'points', to: 5 });
  assert.deepEqual(five.a.view, { label: 'Story points', from: '3', to: '5', warn: '' });
  const r = await five.a.run();
  assert.deepEqual(patches(five.deps)[0][2], { storyPoints: 5 });
  await r.undo();
  assert.deepEqual(patches(five.deps)[1][2], { storyPoints: 3 });
});

await test('priority: only values from the edit form', async () => {
  assert.equal((await go({ kind: 'priority', to: '' })).parsed, null);
  assert.equal((await go({ kind: 'priority', to: 'Urgent' })).a.ok, false);
  const high = await go({ kind: 'priority', to: 'high' });
  await (await high.a.run()).undo();
  assert.deepEqual(patches(high.deps).map(c => c[2]), [{ _links: { priority: { href: '/api/v3/priorities/3' } } }, { _links: { priority: { href: '/api/v3/priorities/2' } } }]);
});

await test('label: list field takes an array, text/no field refused, undo restores the old options', async () => {
  assert.equal((await go({ kind: 'label', to: 'x'.repeat(101) })).parsed, null);
  assert.equal((await go({ kind: 'label', to: 'Zzz' })).a.ok, false);
  const edge = await go({ kind: 'label', to: 'edge' });
  assert.equal(edge.a.view.from, 'Core');
  await (await edge.a.run()).undo();
  assert.deepEqual(patches(edge.deps).map(c => c[2]), [
    { _links: { customField6: [{ href: '/api/v3/custom_options/2' }] } }, { _links: { customField6: [{ href: '/api/v3/custom_options/1' }] } }]);
  const noField = fake({ fetchEditForm: async () => ({ schema: { priority: schema().priority }, payload: {} }) });
  assert.match((await go({ kind: 'label', to: 'Core' }, story, noField)).a.why, /no Label field/);
});

// ─── Phase 2 ──────────────────────────────────────────────────────────────────

await test('sprint: version from the edit form (or open versions), null leaves the sprint, both warn', async () => {
  assert.equal((await go({ kind: 'sprint', to: 7 })).parsed, null);
  assert.equal((await go({ kind: 'sprint', to: 'Sprint Z' })).a.ok, false);
  assert.match((await go({ kind: 'sprint', to: 'Sprint A' })).a.why, /Already/);
  const b = await go({ kind: 'sprint', to: 'Sprint B' });
  assert.match(b.a.view.warn, /out of its current sprint/);
  await (await b.a.run()).undo();
  assert.deepEqual(patches(b.deps).map(c => c[2]), [{ _links: { version: { href: '/api/v3/versions/6' } } }, { _links: { version: { href: '/api/v3/versions/5' } } }]);
  const none = await go({ kind: 'sprint', to: null });
  assert.match(none.a.view.warn, /out of its sprint/);
  await none.a.run();
  assert.deepEqual(patches(none.deps)[0][2], { _links: { version: { href: null } } });
  const noList = fake({ fetchEditForm: async () => ({ schema: { priority: schema().priority }, payload: {} }) });
  assert.equal((await go({ kind: 'sprint', to: 'Sprint C' }, story, noList)).a.ok, true);
});

await test('relation: known type, numeric id, not itself, target must be readable, undo deletes it', async () => {
  assert.equal((await go({ kind: 'relation', type: 'friends', to: 5 })).parsed, null);
  assert.equal((await go({ kind: 'relation', type: 'blocks', to: 'abc' })).parsed, null);
  assert.equal((await go({ kind: 'relation', type: 'blocks', to: -3 })).parsed, null);
  assert.equal((await go({ kind: 'relation', type: 'blocks', to: 5.5 })).parsed, null);
  assert.equal((await go({ kind: 'relation', type: 'blocks', to: 1e10 })).parsed, null);
  assert.match((await go({ kind: 'relation', type: 'blocks', to: 100 })).a.why, /itself/);
  assert.match((await go({ kind: 'relation', type: 'blocks', to: 404 })).a.why, /can't read it/);
  const ok = await go({ kind: 'relation', type: 'blocks', to: '12' });
  assert.equal(ok.parsed.to, 12);
  const r = await ok.a.run();
  assert.deepEqual(ok.deps.calls[0], ['relation', '100', 12, 'blocks']);
  await r.undo();
  assert.deepEqual(ok.deps.calls[1], ['unrelate', 555]);
});

await test('subtask-edit: only the story\'s own subtasks, a real change, type from the project, undo restores', async () => {
  assert.equal((await go({ kind: 'subtask-edit', id: 101 })).parsed, null);
  assert.equal((await go({ kind: 'subtask-edit', id: 101, subject: 'x'.repeat(256) })).parsed, null);
  assert.equal((await go({ kind: 'subtask-edit', id: 'x', subject: 'S' })).parsed, null);
  assert.equal((await go({ kind: 'subtask-edit', id: 101, subject: 'a\nb' })).parsed, null);
  assert.match((await go({ kind: 'subtask-edit', id: 999, subject: 'S' })).a.why, /isn't a subtask of #100/);
  assert.match((await go({ kind: 'subtask-edit', id: 101, subject: 'Kid A' })).a.why, /Nothing would change/);
  assert.equal((await go({ kind: 'subtask-edit', id: 101, type: 'Bug' })).a.ok, false);
  const both = await go({ kind: 'subtask-edit', id: '101', subject: 'Kid B', type: 'user story' });
  assert.deepEqual(both.a.view.rows.map(r => r.k), ['Title', 'Type']);
  const r = await both.a.run();
  assert.deepEqual(patches(both.deps)[0], ['patch', 101, { subject: 'Kid B', _links: { type: { href: '/api/v3/types/1' } } }]);
  await r.undo();
  assert.deepEqual(patches(both.deps)[1][2], { subject: 'Kid A', _links: { type: { href: '/api/v3/types/2' } } });
});

await test('subtask-status: only the story\'s own subtasks, allowed statuses of that subtask, undo restores', async () => {
  assert.equal((await go({ kind: 'subtask-status', id: 101 })).parsed, null);
  assert.equal((await go({ kind: 'subtask-status', to: 'Resolved' })).parsed, null);
  assert.match((await go({ kind: 'subtask-status', id: 999, to: 'Resolved' })).a.why, /isn't a subtask/);
  assert.equal((await go({ kind: 'subtask-status', id: 101, to: 'Archived' })).a.ok, false);
  assert.match((await go({ kind: 'subtask-status', id: 101, to: 'New' })).a.why, /Already/);
  const ok = await go({ kind: 'subtask-status', id: 101, to: 'Resolved' });
  const r = await ok.a.run();
  assert.deepEqual(patches(ok.deps)[0], ['patch', 101, { _links: { status: { href: '/api/v3/statuses/3' } } }]);
  await r.undo();
  assert.deepEqual(patches(ok.deps)[1][2], { _links: { status: { href: '/api/v3/statuses/1' } } });
});

// ─── Phase 4: create-story ────────────────────────────────────────────────────

await test('create-story: list only, type and priority from the project, points on the scale, label from the form', async () => {
  const act = { kind: 'create-story', subject: 'New thing', type: 'user story' };
  assert.equal((await go(act, story)).parsed, null);
  for (const bad of [{ subject: '' }, { type: '' }, { description: 5 }, { priority: '' }, { points: '3' }, { label: 5 }, { subject: 'x'.repeat(256) }]) {
    assert.equal((await go({ ...act, ...bad }, list)).parsed, null, JSON.stringify(bad));
  }
  assert.equal((await go({ ...act, description: 'x'.repeat(30001) }, list)).parsed, null);
  assert.equal((await go({ ...act, type: 'Epic' }, list)).a.ok, false);
  assert.equal((await go({ ...act, priority: 'Urgent' }, list)).a.ok, false);
  assert.match((await go({ ...act, points: 4 }, list)).a.why, /scale/);
  assert.equal((await go({ ...act, label: 'Zzz' }, list)).a.ok, false);
  const full = await go({ ...act, description: 'Body', priority: 'high', points: 5, label: 'edge' }, list);
  assert.equal(full.a.ok, true);
  const r = await full.a.run();
  const body = full.deps.calls[0][1];
  assert.deepEqual(body, {
    subject: 'New thing', description: { raw: 'Body' }, storyPoints: 5,
    _links: { project: { href: '/api/v3/projects/9' }, type: { href: '/api/v3/types/1' }, priority: { href: '/api/v3/priorities/3' }, customField6: [{ href: '/api/v3/custom_options/2' }] },
  });
  assert.deepEqual(r.created, { id: '555', subject: 'New thing' });
  assert.equal(r.undo, undefined);
  const plain = await go(act, list);
  await plain.a.run();
  assert.equal(plain.deps.calls[0][1]._links.priority.href, '/api/v3/priorities/2');   // the form's default
});

// ─── Names and the prompt ─────────────────────────────────────────────────────

await test('pickByName: exact, case-insensitive, unique partial, ambiguous, none, empty', () => {
  const l = [{ name: 'In progress' }, { name: 'In review' }, { name: 'Done' }];
  assert.equal(T.pickByName(l, 'done').item.name, 'Done');
  assert.equal(T.pickByName(l, 'progress').item.name, 'In progress');
  assert.match(T.pickByName(l, 'in').why, /more than one|isn't one/);
  assert.match(T.pickByName(l, 'zzz').why, /zzz/);
  assert.match(T.pickByName(l, '  ').why, /No value/);
  assert.match(T.pickByName([], 'x').why, /isn't one/);
});

await test('proposePrompt lists only the kinds valid for the screen', () => {
  const s = T.proposePrompt('story'), l = T.proposePrompt('list');
  for (const k of ['subject', 'status', 'assignee', 'points', 'priority', 'label', 'sprint', 'relation', 'subtask-edit', 'subtask-status']) assert.ok(s.includes(`- ${k}:`), k);
  assert.ok(!s.includes('create-story'));
  assert.ok(l.includes('- create-story:'));
  for (const k of ['subject', 'status', 'relation', 'subtask-edit']) assert.ok(!l.includes(`- ${k}:`), `list has ${k}`);
});

// ─── Reads ────────────────────────────────────────────────────────────────────

const reads = o => '```blm-read\n' + (typeof o === 'string' ? o : JSON.stringify({ reads: o })) + '\n```';

await test('parseReads: none/broken → [], unknown dropped, at most MAX_READS, shapes checked', () => {
  assert.deepEqual(T.parseReads('plain'), []);
  assert.deepEqual(T.parseReads(reads('{nope')), []);
  assert.deepEqual(T.parseReads(reads([{ kind: 'delete', id: 1 }, { kind: 'constructor' }, { kind: '__proto__' }])), []);
  assert.equal(T.parseReads(reads(Array.from({ length: 9 }, (_, i) => ({ kind: 'wp', id: i + 1 })))).length, T.MAX_READS);
  assert.deepEqual(T.parseReads(reads([{ kind: 'wp', id: '12' }])), [{ kind: 'wp', id: 12 }]);
  for (const bad of [{ kind: 'wp', id: 'x' }, { kind: 'wp', id: 0 }, { kind: 'wp' }, { kind: 'search', q: '' }, { kind: 'search', q: 'x'.repeat(101) },
    { kind: 'comments', id: -1 }, { kind: 'sprint', name: '' }, { kind: 'time' }, { kind: 'time', wp: 'x' }]) {
    assert.deepEqual(T.parseReads(reads([bad])), [], JSON.stringify(bad));
  }
  assert.deepEqual(T.parseReads(reads([{ kind: 'time', sprint: 'S' }, { kind: 'time', wp: 7 }, { kind: 'workload', junk: 1 }])),
    [{ kind: 'time', sprint: 'S' }, { kind: 'time', wp: 7 }, { kind: 'workload' }]);
});

await test('runRead: each kind goes to its own reader, results are clipped, labels read well', async () => {
  const cx = T.makeCx(story, fake());
  const run = r => T.runRead(r, cx);
  assert.equal(await run({ kind: 'wp', id: 5 }), 'story 5');
  assert.equal(await run({ kind: 'search', q: 'abc' }), 'found abc');
  assert.equal(await run({ kind: 'comments', id: 5 }), 'comments 5');
  assert.equal(await run({ kind: 'sprint', name: 'S' }), 'sprint S');
  assert.equal(await run({ kind: 'time', wp: 5 }), 'time {"kind":"time","wp":5}');
  const big = await run({ kind: 'workload' });
  assert.ok(big.length < 6100 && big.includes('cut'));
  assert.equal(T.readLabel({ kind: 'search', q: 'abc' }), 'Searching "abc"');
  assert.equal(T.readLabel({ kind: 'wp', id: 5 }), 'Reading #5');
});

await test('readPrompt names every read and the limits', () => {
  const p = T.readPrompt();
  for (const k of Object.keys(T.READS)) assert.ok(p.includes(`- ${k}:`), k);
  assert.ok(p.includes(`at most ${T.MAX_READS}`));
  assert.equal(T.MAX_ROUNDS, 3);
});

// ─── Context helpers ──────────────────────────────────────────────────────────

await test('workloadBrief and hoursBrief total per person', () => {
  const w = (who, status, pts) => ({ storyPoints: pts, _links: { assignee: who ? { title: who } : undefined, status: { title: status } } });
  const out = C.workloadBrief([w('Ann', 'New', 5), w('Ann', 'In progress', 3), w('Ann', 'Closed', 8), w('Bob', 'New', 2), w(null, 'New', 1), w('Bob', 'New', null)]);
  assert.match(out, /Ann: 8 pts open in 2 item\(s\), 8 pts done/);
  assert.match(out, /Bob: 2 pts open in 2 item\(s\), 0 pts done/);
  assert.match(out, /Unassigned: 1 pts open/);
  assert.ok(out.indexOf('Ann') < out.indexOf('Bob'));
  assert.equal(C.workloadBrief([]), 'No work packages to total.');
  const h = C.hoursBrief('Hours', [{ userName: 'Ann', hours: 1.5 }, { userName: 'Ann', hours: 2 }, { userName: 'Bob', hours: 1 }]);
  assert.match(h, /4\.5 h in all/);
  assert.match(h, /- Ann: 3\.5 h/);
  assert.equal(C.hoursBrief('Hours', []), 'Hours: nothing logged.');
});

console.log(`\n${n} checks passed`);
