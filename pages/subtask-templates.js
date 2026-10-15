// subtask-templates.js — the subtasks Planning suggests for a story, per project and
// story kind. Defaults come from the subtasks teams created in their recent sprints;
// a facilitator's edits are kept per project under TEMPLATES_KEY.
// A line is { title, assignee }: the title may use {subject} (the story title, cut
// short); assignee 'parent' takes the story's assignee, 'none' leaves the
// subtask for a second person (review, cross-test).

export const TEMPLATES_KEY = '__blm_subtask_templates';

const line = (title, assignee = 'parent') => ({ title, assignee });

const DEFAULTS = [
  {
    project: /credit\s*utility/i,
    story: [
      line('Clarify the scope and acceptance criteria with PO/TA'),
      line('Implement the changes described in the story'),
      line('Self-test against the acceptance criteria'),
      line('Cross-test and execute the test cases', 'none'),
      line('Write the test report with evidence'),
      line('Demo the result to the PO'),
    ],
    bug: [
      line('Investigate and reproduce the issue, comparing with the old UI'),
      line('Fix the issue and cover it with tests'),
      line('Retest the fix and run the regression test cases', 'none'),
      line('Update the test report with evidence'),
      line('Demo the fix to the PO'),
    ],
  },
  {
    project: /consultant\s*workplace|salmon/i,
    story: [
      line('Implement the changes described in the story'),
      line('Review the code and test the story', 'none'),
    ],
    bug: [
      line('Fix the issue and verify it locally'),
      line('Review the code and test the fix', 'none'),
    ],
  },
];

/** The template kind for a work package type: bugs have their own, stories and change requests share one. */
export function kindOf(typeName) {
  const n = (typeName ?? '').toLowerCase();
  if (/bug|defect|incident/.test(n)) return 'bug';
  if (/epic|initiative|task|chore|sub/.test(n)) return null;
  return 'story';
}

/** The built-in lines for a project and kind; empty when the project has none. */
export function defaultTemplate(projectName, kind) {
  const d = DEFAULTS.find(x => x.project.test(projectName ?? ''));
  return (d?.[kind] ?? []).map(l => ({ ...l }));
}

// ─── Learning from the team's recent sprints ──────────────────────────────────
// Each subtask the team created is read as one of these steps (or none); a step most
// stories of a kind had becomes a suggestion, with a readable title of its own, so a
// suggestion never repeats the story's title or number. PR/merge tasks are left out.

const SKIP = /\bprs?\b|pull request|merge/;
const STEPS = [   // in suggestion order
  { key: 'clarify',     story: 'Clarify the scope and acceptance criteria with PO/TA', bug: 'Clarify the expected behaviour with PO/TA' },
  { key: 'investigate', story: 'Analyse the current behaviour and agree on the solution', bug: 'Investigate and reproduce the issue, comparing with the old UI' },
  { key: 'testcases',   story: 'Design the test cases from the acceptance criteria', bug: 'Design the test cases for the fix' },
  { key: 'implement',   story: 'Implement the changes described in the story', bug: 'Fix the issue and cover it with tests' },
  { key: 'selftest',    story: 'Self-test against the acceptance criteria', bug: 'Self-test the fix' },
  { key: 'review',      story: 'Review the code and test the changes', bug: 'Review the code and test the fix', assignee: 'none' },
  { key: 'crosstest',   story: 'Cross-test and execute the test cases', bug: 'Cross-test the fix', assignee: 'none' },
  { key: 'test',        story: 'Test the story against the acceptance criteria', bug: 'Retest the fix and run the regression test cases', assignee: 'none' },
  { key: 'report',      story: 'Write the test report with evidence', bug: 'Update the test report with evidence' },
  { key: 'demo',        story: 'Demo the result to the PO', bug: 'Demo the fix to the PO' },
  { key: 'wiki',        story: 'Update the wiki', bug: 'Update the wiki' },
];
// The first match wins, so the specific words come before the general ones.
const MATCHERS = [
  ['report', /test ?report|evidence/],
  ['selftest', /self.?test/],
  ['crosstest', /cross.?test/],
  ['review', /review/],
  ['demo', /\bdemo/],
  ['wiki', /wiki|documentation/],
  ['testcases', /(design|write|define|prepare|create)\b.{0,15}\b(test ?cases?|tcs?)\b/],
  ['clarify', /clarif|confirm with|discuss|ask (the )?(po|ta)\b|align with|define (the )?scope/],
  ['investigate', /investigat|analy[sz]|reproduc|root cause|check (the )?behaviou?r|old ui|\bivy\b/],
  ['test', /\b(re)?test(s|ing)?\b|execute|regression/],
  ['implement', /implement|develop|adapt|coding|\bfix|\b(be|fe)\b|ch-ui|constraint|processing|service|adapter|\bui\b|api|\w+:/],
];

/** The step a subtask's title stands for, or null. */
function stepOf(subject) {
  const t = (subject ?? '').toLowerCase();
  if (!t.trim() || SKIP.test(t)) return null;
  return MATCHERS.find(([, re]) => re.test(t))?.[0] ?? null;
}

const MIN_STORIES = 5;    // fewer stories of a kind with subtasks: too little to learn from
const MIN_SHARE = 0.3;    // a step at least this share of them had

/**
 * The template the team's own subtasks suggest, per kind, from the work packages of
 * recent sprints: { story, bug } with { lines, stories } each, or null when too few.
 * @param {Array<Object>} wps  every work package of those sprints, open or closed
 */
export function learnTemplates(wps) {
  const byId = new Map(wps.map(wp => [String(wp.id), wp]));
  const parents = new Map();   // parent id -> { kind, assignee, steps: Map(key -> { same, other }) }
  for (const wp of wps) {
    const pid = (wp._links?.parent?.href ?? '').split('/').pop();
    const parent = pid && byId.get(pid);
    const kind = parent && kindOf(parent._links?.type?.title);
    const step = kind && stepOf(wp.subject);
    if (!step) continue;
    const p = parents.get(pid) ?? { kind, assignee: parent._links?.assignee?.href ?? null, steps: new Map() };
    parents.set(pid, p);
    const who = p.steps.get(step) ?? { same: 0, other: 0 };
    const a = wp._links?.assignee?.href;
    if (a) a === p.assignee ? who.same++ : who.other++;
    p.steps.set(step, who);
  }
  const out = {};
  for (const kind of ['story', 'bug']) {
    const ps = [...parents.values()].filter(p => p.kind === kind);
    if (ps.length < MIN_STORIES) { out[kind] = null; continue; }
    const lines = STEPS.filter(st => ps.filter(p => p.steps.has(st.key)).length / ps.length >= MIN_SHARE).map(st => {
      const who = ps.reduce((t, p) => { const w = p.steps.get(st.key); return w ? { same: t.same + w.same, other: t.other + w.other } : t; }, { same: 0, other: 0 });
      // Usually done by someone other than the story's owner: leave it for the team to pick.
      const assignee = who.same + who.other >= 3 ? (who.other > who.same ? 'none' : 'parent') : st.assignee ?? 'parent';
      return { title: st[kind], assignee };
    });
    out[kind] = lines.length ? { lines, stories: ps.length } : null;
  }
  return out;
}

/** What the team's recent sprints suggest, else the built-in lines for the project. */
export function suggestedTemplate(projectName, kind, learned) {
  const l = learned?.[kind];
  return l ? l.lines.map(x => ({ ...x })) : defaultTemplate(projectName, kind);
}

/** The lines to suggest and where they come from: 'yours' (saved), 'learned' or 'default'. */
export function templateFor(stored, projectId, projectName, kind, learned) {
  const own = stored?.[projectId]?.[kind];
  if (Array.isArray(own)) return { lines: own.map(l => ({ ...l })), source: 'yours' };
  if (learned?.[kind]) return { lines: suggestedTemplate(projectName, kind, learned), source: 'learned' };
  return { lines: defaultTemplate(projectName, kind), source: 'default' };
}

/** The story title cut at a word boundary, so a subtask title stays readable. */
function shortSubject(subject, max = 60) {
  const s = (subject ?? '').trim().replace(/\s+/g, ' ');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  const words = (at > max / 2 ? cut.slice(0, at) : cut).split(' ');
  while (words.length > 3 && /^(a|an|the|of|in|on|for|to|with|and|or|by|at|from|as|is|[,;:.\-–]+)$/i.test(words.at(-1))) words.pop();
  return `${words.join(' ').replace(/[\s,;:.\-–]+$/, '')}…`;
}

/** A template title with the story's number and title filled in. */
export function fillTitle(title, story) {
  return title
    .replace(/\{id\}/g, String(story.id))
    .replace(/\{subject\}/g, shortSubject(story.subject))
    .trim();
}
