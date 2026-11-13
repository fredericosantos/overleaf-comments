// Reviewing mode, the pure part (no vscode import): turn the user's edits into local suggestions, the way Overleaf's
// track changes does. Kept as Overleaf keeps them: insertions (their text is in the file) and deletion markers (their
// text is not), in document offsets of the local file.
import { locate } from './anchor.ts';

export interface LocalChange { id: string; kind: 'insert' | 'delete'; at: number; text: string }

/** One editor change, in the coordinates of the text before it (like VS Code's contentChanges). */
export interface Edit { offset: number; length: number; text: string }

const end = (c: LocalChange) => (c.kind === 'insert' ? c.at + c.text.length : c.at);

/**
 * Apply one edit to the local suggestions. `old` is the text before the edit; `tracked` = Reviewing mode is on (the
 * edit becomes a suggestion) or off (the suggestions only move with it). `newId` names a new change.
 *
 * Like Overleaf: deleting your own suggested text just removes it, deleting other text leaves a marker (merged with a
 * marker it touches), typing next to or inside your own insertion extends it, and typing back exactly the text a
 * marker holds (undo) removes the marker instead of suggesting "Changed: x to x".
 */
export function applyEdit(changes: LocalChange[], old: string, edit: Edit, tracked: boolean, newId: () => string): LocalChange[] {
  let list = changes.map(c => ({ ...c }));
  const a = edit.offset;
  const b = edit.offset + edit.length;

  if (b > a) {
    // Walk the deleted range: our own inserted text just disappears, other text (and any marker inside) is what was deleted.
    const inserts = list.filter(c => c.kind === 'insert');
    const inInsert = (x: number) => inserts.some(c => x >= c.at && x < end(c));
    const markers = list.filter(c => c.kind === 'delete' && c.at >= a && c.at <= b).sort((x, y) => x.at - y.at);
    let deleted = '';
    for (let x = a; x <= b; x++) {
      for (const m of markers) if (m.at === x) deleted += m.text;
      if (x < b && !inInsert(x)) deleted += old[x];
    }
    const len = b - a;
    list = list.flatMap((c): LocalChange[] => {
      if (c.kind === 'delete') {
        if (markers.includes(c)) return []; // merged into one marker at the cut, below
        return [{ ...c, at: c.at > b ? c.at - len : c.at }];
      }
      const s = c.at;
      const e = end(c);
      const keepBefore = c.text.slice(0, Math.max(0, Math.min(e, a) - s));
      const keepAfter = c.text.slice(Math.max(0, b - s));
      const text = s >= b ? c.text : e <= a ? c.text : keepBefore + keepAfter;
      return [{ ...c, at: s >= b ? s - len : Math.min(s, a), text }];
    });
    // Untracked: the cut text is simply gone, but markers it touched are kept (merged) where it was.
    const merged = tracked ? deleted : markers.map(m => m.text).join('');
    if (merged) list.push({ id: markers[0]?.id ?? newId(), kind: 'delete', at: a, text: merged });
  }

  const t = edit.text;
  if (t) {
    const marker = list.find(c => c.kind === 'delete' && c.at === a);
    const host = list.find(c => c.kind === 'insert' && (tracked ? a >= c.at && a <= end(c) : a > c.at && a < end(c)));
    if (marker && marker.text.startsWith(t)) {
      marker.text = marker.text.slice(t.length); // typing back what was deleted (undo): no suggestion for it
      for (const c of list) if (c !== marker && c.at > a) c.at += t.length;
      marker.at += t.length;
    } else {
      for (const c of list) {
        if (c === host) c.text = c.text.slice(0, a - c.at) + t + c.text.slice(a - c.at);
        else if (c.at > a || (c.at === a && (c.kind === 'delete' || !host))) c.at += t.length; // a marker stays after the typed text
      }
      if (tracked && !host) list.push({ id: newId(), kind: 'insert', at: a, text: t });
    }
  }
  return list.filter(c => c.text.length > 0).sort((x, y) => x.at - y.at || (x.kind === 'insert' ? -1 : 1));
}

/** How much text around a local change is stored with it, to find it again after a reload or `git pull`. */
export const CONTEXT = 24;

export interface StoredChange { id: string; kind: 'insert' | 'delete'; text: string; before: string; after: string; at: number }

/** What to keep across a reload: each change with the text around it. */
export const store = (changes: LocalChange[], text: string): StoredChange[] =>
  changes.map(c => ({ ...c, before: text.slice(Math.max(0, c.at - CONTEXT), c.at), after: text.slice(end(c), end(c) + CONTEXT) }));

/** Find stored changes again in (possibly changed) text; the ones whose text is gone are dropped. */
export function restore(stored: StoredChange[], text: string): LocalChange[] {
  return stored.flatMap(s => {
    const body = s.kind === 'insert' ? s.text : '';
    const a = locate(text, s.at - s.before.length, s.before + body + s.after);
    return a.found ? [{ id: s.id, kind: s.kind, at: a.start + s.before.length, text: s.text }] : [];
  });
}
