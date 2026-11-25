// story-brief.js — formats a work package as plain text for Claude: shared by Planning's Claude
// strip (which already has { wp, kids, comments } cached) and the floating assistant (which fetches
// them fresh via shared/api.js).

/** d: { wp, kids, comments }. The story as Claude reads it: plain fields only, no HTML. */
export function storyBrief(id, d, withComments = false) {
  const kids = (d.kids ?? []).map(k => `- ${k.subject}`).join('\n') || '(none)';
  const comments = withComments
    ? `\n\nComments, oldest first:\n${(d.comments ?? []).slice(-30).map(c => `- ${c._links?.user?.title ?? 'Someone'}: ${(c.comment?.raw ?? '').trim().slice(0, 2000)}`).join('\n') || '(none)'}`
    : '';
  return `Work package #${id} (${d.wp._links?.type?.title ?? 'Story'}): ${d.wp.subject}

Description:
${(d.wp.description?.raw ?? '').trim() || '(empty)'}

Existing subtasks:
${kids}${comments}`;
}
