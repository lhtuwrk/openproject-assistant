// package-templates.js — the release pipeline template(s) the Package page steps
// through. Mirrors the team's package process (the wiki page and its flow-chart
// PDF): 16 steps, the timeline note each one carries there, and the checklist of
// what the person on duty has to do. Same plain-array shape as
// subtask-templates.js: no build step, so this is just data a page imports.
//
// A template is a graph: { id, name, seed, nodes, edges }.
//   Node = { id, label, kind: 'task' | 'decision', x, y, when?, todo?, gate? }
//     when — the day/time the process pins this step to, shown as a note
//     todo — the step's checklist
//     gate — show what the dependency sheet says about the services in this
//            package: 'deps' just reports it, 'merged' also keeps the step from
//            starting until every changed service is merged into ch-app
//   Edge = { id, from: nodeId, to: nodeId, label: '' | 'yes' | 'no' }
//     (label only meaningful when the `from` node is kind:'decision')
// This is the seed only — package.js copies it into the editable, persisted
// `__blm_package_templates` store, and re-seeds when SEED below changes.

/** Bump whenever the seed graph changes, so an installed copy is replaced. */
export const SEED = 2;

const DEPLOYMENT_CHECKLIST = [
  'Events and calculations work',
  'Estimation works',
  'Credit score and ZEK check work',
  'Finnova works (can create a dossier for existing business)',
  'A new-business dossier can reach Completed status (New business TC flow)',
  'Basic functions work for the MB tenant (create dossier, calculation, pricing, estimation…)',
  'No manual configuration steps on Acceptance, or any manual steps are documented',
];

export const PACKAGE_TEMPLATES = [{
  id: 'release-pipeline-v2',
  name: 'Release Pipeline',
  seed: SEED,
  nodes: [
    {
      id: 'prepare', label: 'Prepare', kind: 'task', x: 160, y: 20,
      gate: 'deps',
      when: 'Wednesday 1:30 PM · the package process starts (code freeze from the start of Wednesday to the end of Friday)',
      todo: [
        { text: 'Check the dependency sheet: every service going into the package is released', auto: 'released' },
        { text: 'Version per db kind is correct: odd for Postgres, even for Oracle', auto: 'parity' },
        'Release.adoc changes are fulfilled',
      ],
    },
    {
      id: 'cve', label: 'Check and resolve CVE with TA', kind: 'task', x: 160, y: 120,
      todo: [
        'Scan vulnerabilities',
        'Email the TA if the report has Critical and/or High items',
        'Add a vulnerability section to Release.adoc with the planned fix version for each Critical and High item',
        'If there are Critical items, wait for the TA’s fix or sign-off before packaging further',
      ],
    },
    {
      id: 'build-int', label: 'Build ch-app-postgresql / ch-app-mock', kind: 'task', x: 160, y: 220,
      gate: 'merged',
    },
    { id: 'deploy-int', label: 'Deploy to INT (jar + k8s): smoke test', kind: 'task', x: 160, y: 320 },
    { id: 'inform-int', label: 'Inform deployment status on the ch-app channel', kind: 'task', x: 160, y: 420 },
    {
      id: 'qa-gates', label: 'Execute QA gates', kind: 'task', x: 160, y: 520,
      todo: ['Automation test', 'Regression test', 'Load test', 'Scan the logs during the test'],
    },
    {
      id: 'sync-result', label: 'Sync up test result', kind: 'task', x: 160, y: 620,
      when: 'Thursday 11:30 AM',
    },
    { id: 'repackage-decision', label: 'Repackage needed?', kind: 'decision', x: 170, y: 720 },
    {
      id: 'build-cover-fix', label: 'Build ch-app / ch-app-mock to cover bug found', kind: 'task', x: 460, y: 780,
      when: 'Thursday 4:00 PM · the 2nd ch-app build, only if a repackage is needed',
    },
    { id: 'verify-fix', label: 'Execute test to verify bug fixes', kind: 'task', x: 460, y: 880 },
    {
      id: 'build-oracle', label: 'Build ch-app-oracle', kind: 'task', x: 160, y: 980,
      when: 'Code freeze ends at the end of Friday',
    },
    {
      id: 'deploy-acpt', label: 'Deploy to ACPT (jar + k8s): smoke test, inform deployment status', kind: 'task', x: 160, y: 1080,
      when: 'Monday, before 12:00 · the 1st week of the next sprint',
    },
    {
      id: 'acpt-checklist', label: 'Check & update ACPT deployment checklist', kind: 'task', x: 160, y: 1180,
      todo: [...DEPLOYMENT_CHECKLIST, 'Add the row to the Records table on the package-process wiki page'],
    },
    {
      id: 'update-gates', label: 'Update package test gates', kind: 'task', x: 160, y: 1280,
      todo: ['Record the TG2 – Build decision for this release in the Test Gate & Release Approval Matrix'],
    },
    {
      id: 'deliver', label: 'Deliver package', kind: 'task', x: 160, y: 1380,
      when: 'Wednesday',
      todo: [
        'Send the delivery email (Valiant: tgz; Migros Bank: Kubernetes jars + ch-mock-app)',
        'Send the test result email with the regression and load test results attached',
      ],
    },
    {
      id: 'reset-doc', label: 'Reset Release.adoc', kind: 'task', x: 160, y: 1480,
      todo: ['Reset Release.adoc once the delivery email has been sent', 'For a hotfix, cherry-pick the release-notes content into the right version'],
    },
  ],
  edges: [
    { id: 'e1',  from: 'prepare',            to: 'cve',                label: '' },
    { id: 'e2',  from: 'cve',                to: 'build-int',          label: '' },
    { id: 'e3',  from: 'build-int',          to: 'deploy-int',         label: '' },
    { id: 'e4',  from: 'deploy-int',         to: 'inform-int',         label: '' },
    { id: 'e5',  from: 'inform-int',         to: 'qa-gates',           label: '' },
    { id: 'e6',  from: 'qa-gates',           to: 'sync-result',        label: '' },
    { id: 'e7',  from: 'sync-result',        to: 'repackage-decision', label: '' },
    { id: 'e8',  from: 'repackage-decision', to: 'build-cover-fix',    label: 'yes' },
    { id: 'e9',  from: 'repackage-decision', to: 'build-oracle',       label: 'no' },
    { id: 'e10', from: 'build-cover-fix',    to: 'verify-fix',         label: '' },
    { id: 'e11', from: 'verify-fix',         to: 'build-oracle',       label: '' },
    { id: 'e12', from: 'build-oracle',       to: 'deploy-acpt',        label: '' },
    { id: 'e13', from: 'deploy-acpt',        to: 'acpt-checklist',     label: '' },
    { id: 'e14', from: 'acpt-checklist',     to: 'update-gates',       label: '' },
    { id: 'e15', from: 'update-gates',       to: 'deliver',            label: '' },
    { id: 'e16', from: 'deliver',            to: 'reset-doc',          label: '' },
  ],
}];
