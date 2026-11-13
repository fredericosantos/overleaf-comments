// Overleaf suggestions (tracked changes) as the review panel shows them: pure, no vscode import.
// The git bridge exports the text with every suggestion applied: insertions are in the file, deletions are not.
import type { TrackedChange } from '@aloth/olcli';
import { locate } from './anchor.ts';

export interface Suggestion {
  /** The first change's id: stable across refreshes, used as the key. */
  id: string;
  /** Every Overleaf change id this suggestion stands for (an insertion and the deletion right next to it). */
  ids: string[];
  docId: string;
  path: string;
  /** Overleaf's offset of the inserted text, or of the deletion point. */
  position: number;
  line: number;
  inserted: string;
  deleted: string;
  /** Overleaf's text just before and after the inserted text (or the deletion point). */
  before: string;
  after: string;
  author: string;
  timestamp?: string;
}

/** How much of the surrounding text must still match to find a suggestion again in an edited file. */
const CONTEXT = 16;

const authorOfChange = (c: TrackedChange): string => c.author.name || c.author.email || 'unknown';

/** One suggestion per change, except that a deletion right at either end of an insertion (same author) is shown with
 * it, as "Changed: old to new", like Overleaf does. */
export function groupChanges(changes: TrackedChange[]): Suggestion[] {
  const taken = new Set<string>();
  const out: Suggestion[] = [];
  const sorted = [...changes].sort((a, b) => a.path.localeCompare(b.path) || a.position - b.position || (a.kind === 'insert' ? -1 : 1));
  for (const c of sorted) {
    if (taken.has(c.id)) continue;
    taken.add(c.id);
    const base = { id: c.id, ids: [c.id], docId: c.docId, path: c.path, position: c.position, line: c.line, before: c.before ?? '', after: c.after ?? '', author: authorOfChange(c), timestamp: c.timestamp };
    if (c.kind === 'delete') {
      out.push({ ...base, inserted: '', deleted: c.text });
      continue;
    }
    const end = c.position + c.text.length;
    const del = sorted.find(d => !taken.has(d.id) && d.kind === 'delete' && d.docId === c.docId && d.author.id === c.author.id && (d.position === end || d.position === c.position));
    if (del) taken.add(del.id);
    out.push({ ...base, ids: del ? [c.id, del.id] : [c.id], inserted: c.text, deleted: del?.text ?? '' });
  }
  return out;
}

/** "Added" / "Deleted" / "Changed", as the review panel says it. */
export const verbOf = (s: Suggestion): string => (s.inserted && s.deleted ? 'Changed' : s.inserted ? 'Added' : 'Deleted');

/**
 * Where a suggestion is in the local ("\n") text: the inserted text (zero-width for a deletion), found by the text
 * around it near Overleaf's offset. The inserted text alone is the fallback, in case nearby text was edited locally.
 * ponytail: exact context match; fuzzy matching if suggestions get lost after nearby local edits.
 */
export function locateSuggestion(text: string, s: Suggestion, hint = s.position): { start: number; end: number; found: boolean } {
  const before = s.before.slice(-CONTEXT);
  const after = s.after.slice(0, CONTEXT);
  const a = locate(text, hint - before.length, before + s.inserted + after);
  if (a.found) return { start: a.start + before.length, end: a.start + before.length + s.inserted.length, found: true };
  if (s.inserted) return locate(text, hint, s.inserted);
  const clamped = Math.min(Math.max(hint, 0), text.length);
  return { start: clamped, end: clamped, found: false };
}
