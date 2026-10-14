// Small pure text helpers for comment threads (no vscode import, so plain node tests cover them).
import type { CommentMessage } from '@aloth/olcli';

export const authorOf = (m?: CommentMessage): string =>
  m?.user?.name ?? ([m?.user?.first_name, m?.user?.last_name].filter(Boolean).join(' ') || m?.user?.email || 'unknown');

/** A comment longer than this many lines or characters is collapsed in the thread, with "Show more" (like Overleaf). */
export const COLLAPSE_LINES = 5;
export const COLLAPSE_CHARS = 400;

/** The text to show for a comment in the thread: all of it, or its first lines when it is long and not expanded. */
export function clipForThread(text: string, expanded: boolean): { text: string; clipped: boolean; long: boolean } {
  const t = text.replace(/\r\n/g, '\n').trimEnd();
  const long = t.split('\n').length > COLLAPSE_LINES || t.length > COLLAPSE_CHARS;
  if (!long || expanded) return { text: t, clipped: false, long };
  let cut = t.split('\n').slice(0, COLLAPSE_LINES).join('\n');
  if (cut.length > COLLAPSE_CHARS) cut = cut.slice(0, COLLAPSE_CHARS).replace(/\s+\S*$/, ''); // back to a word boundary
  cut = cut.trimEnd();
  if ((cut.match(/```/g) ?? []).length % 2 === 1) cut += '\n```'; // do not leave a code block open
  return { text: `${cut} …`, clipped: true, long };
}

/** A thread taller than this many lines is cut: the first comment and the latest ones that fit are shown. */
export const THREAD_MAX_LINES = 24;

/** How tall a comment is in a collapsed thread: its (clipped) lines, plus the author line and the Show more line. */
export const messageHeight = (content: string): number => clipForThread(content, false).text.split('\n').length + 2;

/** Which comments of a collapsed thread to show: the first (the root) and the latest ones that fit in the budget. */
export function visibleIndices(heights: number[], budget = THREAD_MAX_LINES): number[] {
  const n = heights.length;
  if (n === 0 || heights.reduce((a, b) => a + b, 0) <= budget) return heights.map((_, i) => i);
  const keep = new Set([0]);
  let used = heights[0];
  for (let i = n - 1; i > 0; i--) {
    if (i !== n - 1 && used + heights[i] > budget) break; // the latest comment is always shown
    keep.add(i);
    used += heights[i];
  }
  return [...keep].sort((a, b) => a - b);
}
