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
