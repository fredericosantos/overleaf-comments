// The editor side of suggestions: one comment thread per suggestion (Accept/Reject in its header), the inserted text
// in green and a red marker where text was deleted, followed through local edits like comments are.
import * as vscode from 'vscode';
import { lfView, shiftAnchor } from './anchor.ts';
import { locateSuggestion, verbOf, type Suggestion } from './suggestions.ts';
import type { Model } from './model.ts';
import { ANCHOR_LOST, range, workspaceRoot } from './common.ts';

/** A drawn suggestion. start/end: document offsets of the inserted text (equal for a deletion), kept current. */
export interface SuggestionEntry { thread: vscode.CommentThread; s: Suggestion; start: number; end: number; found: boolean }

/** The thread's one comment: "Changed: ~~old~~ to new", by its author. User text is escaped, never run as markdown. */
function body(s: Suggestion): vscode.MarkdownString {
  const md = new vscode.MarkdownString(`${verbOf(s)}: `);
  if (s.deleted) { md.appendMarkdown('~~'); md.appendText(s.deleted); md.appendMarkdown('~~'); }
  if (s.deleted && s.inserted) md.appendMarkdown(' to ');
  if (s.inserted) md.appendText(s.inserted);
  return md;
}

const signature = (s: Suggestion) => `${s.ids.join(',')}\u0000${s.inserted}\u0000${s.deleted}`;

export class SuggestionThreads implements vscode.Disposable {
  entries: SuggestionEntry[] = [];
  private renderGen = 0;
  private readonly insertedText = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(46,160,67,0.25)', borderRadius: '2px' });
  // A zero-width space with a red left border: a thin bar where text was deleted, without shifting the text much.
  private readonly deletedMark = vscode.window.createTextEditorDecorationType({ before: { contentText: '​', border: '0 0 0 2px solid rgba(248,81,73,0.9)' } });

  /** `onChange`: the set or position of suggestions changed (the sidebar redraws). */
  constructor(private readonly controller: vscode.CommentController, private readonly model: Model, private readonly output: vscode.OutputChannel, private readonly onChange: () => void) {}

  byId = (id: string) => this.entries.find(e => e.s.id === id);
  byThread = (t: vscode.CommentThread) => this.entries.find(e => e.thread === t);

  async render(): Promise<void> {
    const root = workspaceRoot();
    if (!root) return;
    const gen = ++this.renderGen;
    const list = this.model.suggestions();
    const docs = await Promise.all(list.map(async s => {
      try {
        return { s, doc: await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, s.path.replace(/^\/+/, ''))) };
      } catch (err) {
        this.output.appendLine(`skip suggestion in ${s.path}: ${err}`);
        return undefined; // the comments side already warns about files missing from the workspace
      }
    }));
    if (gen !== this.renderGen) return;
    const old = new Map(this.entries.map(e => [e.s.id, e]));
    const next: SuggestionEntry[] = [];
    for (const d of docs) {
      if (!d) continue;
      const { s, doc } = d;
      let prev = old.get(s.id);
      old.delete(s.id);
      if (prev && (prev.thread.uri.toString() !== doc.uri.toString() || signature(prev.s) !== signature(s))) { prev.thread.dispose(); prev = undefined; }
      let { start, end, found } = prev ?? { start: 0, end: 0, found: false };
      if (!prev || !prev.found) {
        const v = lfView(doc.getText());
        const a = locateSuggestion(v.lf, s);
        ({ found } = a);
        start = v.toDoc(a.start);
        end = v.toDoc(a.end);
      }
      const where = range(doc, start, end);
      const thread = prev?.thread ?? this.controller.createCommentThread(doc.uri, where, []);
      if (!prev) {
        thread.comments = [{ author: { name: s.author }, body: body(s), mode: vscode.CommentMode.Preview, timestamp: s.timestamp ? new Date(s.timestamp) : undefined }];
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      } else if (!thread.range.isEqual(where)) thread.range = where;
      thread.canReply = false;
      thread.contextValue = 'suggestion';
      thread.label = found ? undefined : ANCHOR_LOST;
      next.push({ thread, s, start, end, found });
    }
    old.forEach(e => e.thread.dispose());
    this.entries = next;
    this.onChange();
    this.apply();
  }

  /** Redraw the green insertions and red deletion markers in every visible editor. */
  apply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const mine = this.entries.filter(e => e.found && e.thread.uri.toString() === editor.document.uri.toString());
      editor.setDecorations(this.insertedText, mine.filter(e => e.end > e.start).map(e => e.thread.range));
      // The deleted text was where the insertion ends (or, with no insertion, at the point itself).
      editor.setDecorations(this.deletedMark, mine.filter(e => e.s.deleted).map(e => new vscode.Range(e.thread.range.end, e.thread.range.end)));
    }
  }

  /** Same as comments: a click elsewhere in the text closes open suggestions. */
  collapseOutside(uri: vscode.Uri, selection: vscode.Selection): void {
    for (const x of this.entries) {
      if (x.thread.uri.toString() !== uri.toString() || x.thread.range.intersection(selection)) continue;
      x.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      x.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    }
  }

  /** Follow the user's edits; if an edit touched a suggestion, find it again by its text. */
  onTextChange(e: vscode.TextDocumentChangeEvent): void {
    const uri = e.document.uri.toString();
    const mine = this.entries.filter(x => x.thread.uri.toString() === uri);
    if (!mine.length || !e.contentChanges.length) return;
    const changes = e.contentChanges.map(c => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text }));
    const v = lfView(e.document.getText());
    for (const x of mine) {
      const moved = shiftAnchor(x.start, x.end, changes);
      let { start, end } = moved;
      let found = x.found;
      if (moved.touched || !found) {
        const a = locateSuggestion(v.lf, x.s, v.fromDoc(moved.start));
        found = a.found;
        start = v.toDoc(a.start);
        end = v.toDoc(a.end);
      }
      Object.assign(x, { start, end, found });
      x.thread.range = range(e.document, start, end);
      x.thread.label = found ? undefined : ANCHOR_LOST;
    }
    this.apply();
    this.onChange();
  }

  /** Drop every suggestion (Clear Session Cookie); a render in flight becomes stale. */
  clear(): void {
    ++this.renderGen;
    this.entries.forEach(e => e.thread.dispose());
    this.entries = [];
    this.apply();
    this.onChange();
  }

  dispose(): void {
    this.entries.forEach(e => e.thread.dispose());
    this.insertedText.dispose();
    this.deletedMark.dispose();
  }
}
