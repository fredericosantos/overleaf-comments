export interface Anchor {
  /** UTF-16 offset in the local text. */
  start: number;
  end: number;
  /** false = selected text no longer found locally; start/end is a zero-width guess. */
  found: boolean;
}

/**
 * Overleaf anchors a comment to `selectedText` at `position` in ITS version of the doc.
 * Local edits shift that, so: exact hit, else the occurrence nearest `position`, else lost.
 * ponytail: nearest-occurrence heuristic; fuzzy matching if edits inside the selection matter.
 */
export function locate(text: string, position: number, selectedText: string): Anchor {
  const clamped = Math.min(Math.max(position, 0), text.length);
  if (!selectedText) return { start: clamped, end: clamped, found: false };
  if (text.startsWith(selectedText, position)) {
    return { start: position, end: position + selectedText.length, found: true };
  }
  let best = -1;
  for (let i = text.indexOf(selectedText); i !== -1; i = text.indexOf(selectedText, i + 1)) {
    if (best === -1 || Math.abs(i - position) < Math.abs(best - position)) best = i;
  }
  if (best === -1) return { start: clamped, end: clamped, found: false };
  return { start: best, end: best + selectedText.length, found: true };
}

/**
 * 1-based occurrence number of `selected` at offset `start`, counted the way olcli's addComment scans
 * (non-overlapping, left to right), or undefined if `start` is not on that scan. Lets us ask olcli
 * for exactly the occurrence the user selected, even when the phrase appears several times.
 */
export function occurrenceAt(text: string, start: number, selected: string): number | undefined {
  if (!selected) return undefined;
  let from = 0;
  for (let n = 1; ; n++) {
    const pos = text.indexOf(selected, from);
    if (pos === -1 || pos > start) return undefined;
    if (pos === start) return n;
    from = pos + selected.length;
  }
}

/**
 * How to highlight a comment's range: just its text when it sits inside one line, whole lines when it spans
 * several (or is only a line break, i.e. a comment on a blank line). `lastLine` ignores a range that ends at
 * column 0 of the following line, which is how a trailing newline shows up.
 */
export function highlightShape(start: { line: number; character: number }, end: { line: number; character: number }): { kind: 'text' | 'lines'; lastLine: number } {
  const lastLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  const blank = start.line === lastLine && end.line > start.line; // only a line break: nothing to underline, so mark the line
  return { kind: lastLine > start.line || blank ? 'lines' : 'text', lastLine };
}
