// Pure helpers for the thread hover (no vscode import, so plain node tests can cover them).
import type { ProjectComment, CommentMessage } from '@aloth/olcli';

export const MAX_SHOWN = 5; // messages shown in the hover: the first HEAD and the latest MAX_SHOWN - HEAD
export const HEAD = 2;
export const MAX_CHARS = 400; // per message

// Mid-tone colors readable on both dark and light themes.
const PALETTE = ['#e5534b', '#f0883e', '#d4a72c', '#57ab5a', '#39c5cf', '#539bf5', '#986ee2', '#e275ad', '#8ddb8c', '#c69026'];

export const authorOf = (m?: CommentMessage): string =>
  m?.user?.name ?? ([m?.user?.first_name, m?.user?.last_name].filter(Boolean).join(' ') || m?.user?.email || 'unknown');

/** The hover renders HTML (for the colored author span), and MarkdownString.appendText does not escape < or &. */
export const htmlSafe = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Stable per-user color: the same person always gets the same one. */
export function colorOf(m: CommentMessage): string {
  const key = m.user_id ?? m.user?.email ?? authorOf(m);
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export interface HoverLine { author: string; color: string; text: string }
export interface HoverContent { lines: HoverLine[]; hidden: number; hiddenAt: number }

function clip(text: string): string {
  const t = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS).trimEnd()}… (+${t.length - MAX_CHARS} more characters)` : t;
}

export function hoverContent(c: ProjectComment): HoverContent {
  const ms = c.messages;
  const shown = ms.length > MAX_SHOWN ? [...ms.slice(0, HEAD), ...ms.slice(ms.length - (MAX_SHOWN - HEAD))] : ms;
  return {
    lines: shown.map(m => ({ author: authorOf(m), color: colorOf(m), text: clip(m.content) })),
    hidden: ms.length - shown.length,
    hiddenAt: HEAD,
  };
}

export const HOVER_COMMANDS = ['overleafComments.hoverReply', 'overleafComments.hoverResolve'];

/** Markdown command links at the top of the hover: Reply and Resolve (only open comments are drawn in the editor). */
export function actionLinks(c: ProjectComment): string {
  const arg = encodeURIComponent(JSON.stringify([c.threadId]));
  return `[Reply](command:overleafComments.hoverReply?${arg}) · [Resolve](command:overleafComments.hoverResolve?${arg})`;
}

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
