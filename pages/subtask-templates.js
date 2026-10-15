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
      line('Clarify scope and acceptance criteria of {subject} with PO/TA'),
      line('Implement {subject}'),
      line('Self-test {subject} against the acceptance criteria'),
      line('Cross-test {subject} and execute its test cases', 'none'),
      line('Write the test report with evidence for {subject}'),
      line('Demo {subject} to the PO'),
    ],
    bug: [
      line('Investigate and reproduce {subject}, comparing with the old UI'),
      line('Fix {subject}'),
      line('Retest the fix for {subject} and run the regression test cases', 'none'),
      line('Update the test report with evidence for {subject}'),
      line('Demo the fix for {subject} to the PO'),
    ],
  },
  {
    project: /consultant\s*workplace|salmon/i,
    story: [
      line('Implement {subject}'),
      line('Review and test {subject}', 'none'),
    ],
    bug: [
      line('Fix {subject}'),
      line('Review and test the fix for {subject}', 'none'),
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

/** The facilitator's lines when saved (an empty list counts), else the defaults. */
export function templateFor(stored, projectId, projectName, kind) {
  const own = stored?.[projectId]?.[kind];
  return Array.isArray(own) ? own.map(l => ({ ...l })) : defaultTemplate(projectName, kind);
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
