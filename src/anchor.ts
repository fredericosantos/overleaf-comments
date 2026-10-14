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

/**
 * Overleaf documents use "\n"; a local file may use "\r\n". Anchors are matched in "\n" space and mapped back, so
 * multi-line anchors and offsets stay right on CRLF files. Identity (and free) when the text has no "\r\n".
 */
export interface LfView {
  lf: string;
  /** document offset -> "\n"-space offset */
  fromDoc(offset: number): number;
  /** "\n"-space offset -> document offset */
  toDoc(offset: number): number;
}

export function lfView(text: string): LfView {
  if (!text.includes('\r\n')) return { lf: text, fromDoc: o => o, toDoc: o => o };
  const crs: number[] = []; // document offsets of every "\r" that belongs to a "\r\n"
  for (let i = text.indexOf('\r\n'); i !== -1; i = text.indexOf('\r\n', i + 2)) crs.push(i);
  return {
    lf: text.replace(/\r\n/g, '\n'),
    fromDoc: o => o - crs.filter(c => c < o).length,
    toDoc: o => {
      let d = o;
      for (const c of crs) { if (c < d) d++; else break; }
      return d;
    },
  };
}

export interface TextChange { offset: number; length: number; text: string }

/**
 * Move an anchor [start, end) through one editor change event (all changes are in pre-change coordinates).
 * `touched` = a change overlapped the anchor or edited inside it, so the caller must re-verify its text.
 * Text typed exactly at either boundary stays outside the anchor.
 */
export function shiftAnchor(start: number, end: number, changes: TextChange[]): { start: number; end: number; touched: boolean } {
  let s = start;
  let e = end;
  let touched = false;
  for (const c of changes) {
    const cs = c.offset;
    const ce = c.offset + c.length;
    const delta = c.text.length - c.length;
    if (ce <= start) s += delta;
    if (ce < end || (ce === end && cs < ce)) e += delta;
    if (cs < end && ce > start) touched = true; // overlaps (or edits inside) the anchor
  }
  return { start: s, end: Math.max(s, e), touched };
}

/**
 * What to tell Overleaf when the user comments on [startOffset, endOffset) of `text` (both in `text`'s own offsets):
 * the selected text, or, with nothing selected, the line's text, or for a blank line its line break. `occurrence` is
 * which match of that text (counted like olcli: left to right, non-overlapping) the anchor is, so Overleaf picks the
 * same one. Everything is in "\n" space, so CRLF files work.
 */
export function anchorAt(text: string, startOffset: number, endOffset: number): { selectedText: string; occurrence: number } | undefined {
  const v = lfView(text);
  const lf = v.lf;
  const a = v.fromDoc(startOffset);
  const b = v.fromDoc(endOffset);
  let selected = lf.slice(a, b);
  let at = a;
  if (!selected.trim()) {
    const lineStart = lf.lastIndexOf('\n', a - 1) + 1;
    const nl = lf.indexOf('\n', a);
    const lineEnd = nl === -1 ? lf.length : nl;
    const line = lf.slice(lineStart, lineEnd);
    if (line.trim()) {
      selected = line.trim();
      at = lineStart + (line.length - line.trimStart().length);
    } else if (nl !== -1) {
      selected = '\n'; // blank line: Overleaf wants a non-empty range, so use its line break
      at = nl;
    } else {
      return undefined;
    }
  }
  const occurrence = occurrenceAt(lf, at, selected);
  return occurrence === undefined ? undefined : { selectedText: selected, occurrence };
}
