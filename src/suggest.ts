// The editor side of suggestions: one comment thread per suggestion (Accept/Reject in its header), the inserted text
// in green and a red marker where text was deleted. Overleaf's suggestions are followed through local edits like
// comments are, and shown only when the file has their text (git pull first); local ones (Reviewing mode) come from
// Reviewing and are marked "Not synced" until they are on Overleaf.
import * as vscode from 'vscode';
import { lfView, shiftAnchor } from './anchor.ts';
import { locateSuggestion, verbOf, type Suggestion } from './suggestions.ts';
import type { Model } from './model.ts';
import type { LocalSuggestion } from './reviewing.ts';
import { ANCHOR_LOST, range, workspaceRoot } from './common.ts';

export const LOCAL_LABEL = "Not synced · it becomes a suggestion on Overleaf once you've pushed it";

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
const asComment = (s: Suggestion): vscode.Comment => ({ author: { name: s.author }, body: body(s), mode: vscode.CommentMode.Preview, timestamp: s.timestamp ? new Date(s.timestamp) : undefined });

export class SuggestionThreads implements vscode.Disposable {
  /** Overleaf's suggestions. */
  entries: SuggestionEntry[] = [];
  /** Local ones (Reviewing mode), not on Overleaf yet. */
  localEntries: SuggestionEntry[] = [];
  private renderGen = 0;
  private readonly insertedText = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(46,160,67,0.25)', borderRadius: '2px' });
  // A zero-width space with a red outline: a thin bar where text was deleted (Overleaf draws a red dotted bar there).
  private readonly deletedMark = vscode.window.createTextEditorDecorationType({ before: { contentText: '\u200b', border: '1px dotted rgba(248,81,73,0.95)' } });

  /** `onChange`: the set or position of suggestions changed (the sidebar redraws). */
  constructor(
    private readonly controller: vscode.CommentController,
    private readonly model: Model,
    private readonly local: () => LocalSuggestion[],
    private readonly output: vscode.OutputChannel,
    private readonly onChange: () => void,
  ) {}

  private all = () => [...this.entries, ...this.localEntries];
  byId = (id: string) => this.all().find(e => e.s.id === id);
  byThread = (t: vscode.CommentThread) => this.all().find(e => e.thread === t);

  /** Redraw the local suggestions from Reviewing (cheap: it runs on every keystroke in Reviewing mode). */
  renderLocal(): void {
    const old = new Map(this.localEntries.map(e => [e.s.id, e]));
    const next: SuggestionEntry[] = [];
    for (const x of this.local()) {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === x.uri.toString());
      if (!doc) continue;
      const where = range(doc, x.start, x.end);
      let e = old.get(x.s.id);
      old.delete(x.s.id);
      if (e && e.thread.uri.toString() !== x.uri.toString()) { e.thread.dispose(); e = undefined; }
      const thread = e?.thread ?? this.controller.createCommentThread(x.uri, where, []);
      if (!e) {
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        thread.canReply = false;
        thread.contextValue = 'suggestion';
        thread.label = LOCAL_LABEL;
        thread.state = vscode.CommentThreadState.Unresolved; // the same "not synced" icon as comments waiting for a push
      }
      if (!e || signature(e.s) !== signature(x.s)) thread.comments = [asComment(x.s)];
      if (!thread.range.isEqual(where)) thread.range = where;
      next.push({ thread, s: x.s, start: x.start, end: x.end, found: true });
    }
    old.forEach(e => e.thread.dispose());
    this.localEntries = next;
    this.apply();
    this.onChange();
  }

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
      if (!found) { prev?.thread.dispose(); continue; } // not in the local file (git pull first): the sidebar lists it
      const where = range(doc, start, end);
      const thread = prev?.thread ?? this.controller.createCommentThread(doc.uri, where, []);
      if (!prev) {
        thread.comments = [asComment(s)];
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      } else if (!thread.range.isEqual(where)) thread.range = where;
      thread.canReply = false;
      thread.contextValue = 'suggestion';
      thread.label = found ? 'Suggestion' : ANCHOR_LOST; // with no label VS Code shows "Start discussion"
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
      const mine = this.all().filter(e => e.found && e.thread.uri.toString() === editor.document.uri.toString());
      editor.setDecorations(this.insertedText, mine.filter(e => e.end > e.start).map(e => e.thread.range));
      // The deleted text was where the insertion ends (or, with no insertion, at the point itself).
      editor.setDecorations(this.deletedMark, mine.filter(e => e.s.deleted).map(e => new vscode.Range(e.thread.range.end, e.thread.range.end)));
    }
  }

  /** Same as comments: a click elsewhere in the text closes open suggestions. */
  collapseOutside(uri: vscode.Uri, selection: vscode.Selection): void {
    for (const x of this.all()) {
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
      x.thread.label = found ? 'Suggestion' : ANCHOR_LOST;
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
    this.all().forEach(e => e.thread.dispose());
    this.insertedText.dispose();
    this.deletedMark.dispose();
  }
}
