// claude-icon.js — the AI mark: OpenProject's one-line o·p mark (in --op-blue) with the Claude spark
// (in --claude) in its empty top-left corner. Shared by every surface that shows it (Planning's Claude
// strip, the floating assistant's popup). Its parts move per task through a data-mark attribute on an
// ancestor, styled in shared/ai-mark.css: idle, thinking, writing, drafting, applying, done, error,
// offline; with no data-mark it stays still. content/assistant-fab.js keeps its own copy (a content
// script can't import a module) — keep the two in step.

/** The o·p as one line: the p's stem (its stub under the bar, then above it), the p's bowl, the bar
 *  running left, the o's bowl, ending just under the bar. The gaps are where the line passes beneath the bar. */
export const MARK_LINE = 'M13.92 17.62V15.8M13.92 11.93V5.82A2.4 2.4 0 0 1 16.32 3.42H18.43A2.4 2.4 0 0 1 20.83 5.82V9.53A2.4 2.4 0 0 1 18.43 11.93H5.52A2.4 2.4 0 0 0 3.12 14.33V18.15A2.4 2.4 0 0 0 5.52 20.55H7.53A2.4 2.4 0 0 0 9.93 18.15V15.8';
const SPARK = 'M6.4 2.9C6.76 5.11 7.49 5.84 9.7 6.2C7.49 6.56 6.76 7.29 6.4 9.5C6.04 7.29 5.31 6.56 3.1 6.2C5.31 5.84 6.04 5.11 6.4 2.9Z';
const RAYS = 'M6.4 0.6V1.8M11.9 6.2H10.7M0.9 6.2H2.1M2.3 2.1L3.1 2.9';
const bead = cls => `<circle class="m-bead ${cls}" r="1.9" style="offset-path: path('${MARK_LINE}')" />`;

export const CLAUDE_ICON = `<svg class="claude-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
<path class="m-line" pathLength="100" d="${MARK_LINE}" /><path class="m-glint" pathLength="100" d="${MARK_LINE}" />
${bead('b1')}${bead('b2')}<path class="m-spark" d="${SPARK}" /><path class="m-ray" d="${RAYS}" /></svg>`;
