// Reviewing mode in VS Code: while it is on, what the user types becomes local suggestions (the text stays in the
// file, as git will push it). They are kept across reloads and, once pushed, turned into real suggestions on Overleaf
// by the same retry that sends not-synced comments (see Writes).
import * as vscode from 'vscode';
import type { SuggestionEdit, TrackedChange } from '@aloth/olcli';
import { applyEdit, restore, store, type LocalChange, type StoredChange } from './review.ts';
import { groupChanges, type Suggestion } from './suggestions.ts';
import { lfView } from './anchor.ts';
import type { Session } from './session.ts';
import { range, setContext, workspaceRoot } from './common.ts';

const ON_KEY = 'overleafComments.reviewing';
const STORE_KEY = 'overleafComments.localSuggestions';
/** Local suggestions carry this prefix in their id, so commands can tell them from Overleaf's. */
export const LOCAL = 'local:';
const CONTEXT = 24;

/** A local suggestion as drawn: its id is LOCAL + the first change's id; start/end = the inserted text in the document. */
export interface LocalSuggestion { uri: vscode.Uri; s: Suggestion; start: number; end: number }

export class Reviewing implements vscode.Disposable {
  private readonly changes = new Map<string, LocalChange[]>();
  /** Each document's text as of the last change event: VS Code does not report the deleted text, so we keep it. */
  private readonly snapshots = new Map<string, string>();
  /** Stored suggestions of files not opened yet in this window (path -> changes). */
  private stored: Record<string, StoredChange[]>;
  /** Documents we are changing ourselves (Reject): their next edit must not become a suggestion. */
  private readonly quiet = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private counter = 0;

  /** `onChange`: local suggestions changed (redraw threads and the sidebar). */
  constructor(private readonly ctx: vscode.ExtensionContext, private readonly session: Session, private readonly onChange: () => void) {
    this.stored = ctx.workspaceState.get<Record<string, StoredChange[]>>(STORE_KEY) ?? {};
    setContext('reviewing', this.on);
  }

  get on(): boolean {
    return this.ctx.workspaceState.get<boolean>(ON_KEY) ?? false;
  }

  async set(on: boolean): Promise<void> {
    await this.ctx.workspaceState.update(ON_KEY, on);
    setContext('reviewing', on);
    vscode.workspace.textDocuments.forEach(d => this.ensure(d));
    this.onChange();
  }

  private relPath = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false);

  /** Only files of this Overleaf project are tracked. */
  private inProject(doc: vscode.TextDocument): boolean {
    const root = workspaceRoot();
    return this.session.isOverleaf === true && doc.uri.scheme === 'file' && !!root && doc.uri.fsPath.startsWith(root.fsPath + '/');
  }

  /** Start following a document: remember its text and bring back its stored suggestions. */
  ensure(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    if (this.snapshots.has(key) || !this.inProject(doc)) return;
    const text = doc.getText();
    this.snapshots.set(key, text);
    const saved = this.stored[this.relPath(doc.uri)];
    if (saved?.length) {
      const back = restore(saved, text);
      if (back.length) this.changes.set(key, back);
      for (const c of back) this.counter = Math.max(this.counter, Number(c.id.replace(/\D/g, '')) || 0);
      this.onChange();
    }
  }

  onTextChange(e: vscode.TextDocumentChangeEvent): void {
    const key = e.document.uri.toString();
    const old = this.snapshots.get(key);
    if (old === undefined) return this.ensure(e.document);
    const text = e.document.getText();
    this.snapshots.set(key, text);
    const list = this.changes.get(key) ?? [];
    // A user edit makes the file dirty (or is an undo/redo); a reload from disk (git pull) does not: then just find
    // the suggestions again in the new text.
    const userEdit = e.document.isDirty || e.reason !== undefined;
    if (!userEdit) {
      if (!list.length) return;
      this.update(key, e.document, restore(store(list, old), text));
      return;
    }
    const tracked = this.on && !this.quiet.delete(key);
    if (!tracked && !list.length) return;
    let next = list;
    let cur = old;
    for (const c of [...e.contentChanges].sort((x, y) => y.rangeOffset - x.rangeOffset)) {
      const edit = { offset: c.rangeOffset, length: c.rangeLength, text: c.text };
      next = applyEdit(next, cur, edit, tracked, () => `${LOCAL}${++this.counter}`);
      cur = cur.slice(0, edit.offset) + edit.text + cur.slice(edit.offset + edit.length);
    }
    this.update(key, e.document, next);
  }

  private update(key: string, doc: vscode.TextDocument, list: LocalChange[]): void {
    if (list.length) this.changes.set(key, list); else this.changes.delete(key);
    this.save(doc);
    this.onChange();
  }

  /** Remember a file's suggestions (with the text around them) in workspace storage, a moment after the last edit. */
  private save(doc: vscode.TextDocument): void {
    const path = this.relPath(doc.uri);
    const list = this.changes.get(doc.uri.toString()) ?? [];
    if (list.length) this.stored[path] = store(list, doc.getText()); else delete this.stored[path];
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.ctx.workspaceState.update(STORE_KEY, this.stored), 300);
  }

  /** Every local suggestion of the open documents, grouped like Overleaf groups them. */
  items(): LocalSuggestion[] {
    const out: LocalSuggestion[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      const list = this.changes.get(doc.uri.toString());
      if (!list?.length) continue;
      const path = this.relPath(doc.uri);
      const asTracked = list.map((c): TrackedChange => ({ id: c.id, docId: '', path, position: c.at, line: doc.positionAt(c.at).line + 1, kind: c.kind, text: c.text, before: '', after: '', userId: 'you', user: { id: 'you', first_name: 'You' } }));
      for (const s of groupChanges(asTracked)) out.push({ uri: doc.uri, s, start: s.position, end: s.position + s.inserted.length });
    }
    return out;
  }

  byId = (id: string) => this.items().find(x => x.s.id === id);

  /** What to ask Overleaf for, per file: each suggestion with the text around it, in Overleaf's "\n" text. */
  pending(): { uri: vscode.Uri; path: string; items: LocalSuggestion[]; edits: SuggestionEdit[] }[] {
    const byFile = new Map<string, LocalSuggestion[]>();
    for (const x of this.items()) byFile.set(x.uri.toString(), [...(byFile.get(x.uri.toString()) ?? []), x]);
    return [...byFile.values()].map(items => {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === items[0].uri.toString())!;
      const v = lfView(doc.getText());
      const edits = items.map(x => {
        const a = v.fromDoc(x.start);
        const b = v.fromDoc(x.end);
        return { before: v.lf.slice(Math.max(0, a - CONTEXT), a), after: v.lf.slice(b, b + CONTEXT), deleted: x.s.deleted, inserted: x.s.inserted, hint: a };
      });
      return { uri: items[0].uri, path: this.relPath(items[0].uri), items, edits };
    });
  }

  /** Forget a suggestion but keep the text (Accept, or it is on Overleaf now). */
  drop(x: LocalSuggestion): void {
    const key = x.uri.toString();
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
    const left = (this.changes.get(key) ?? []).filter(c => !x.s.ids.includes(c.id));
    if (doc) this.update(key, doc, left);
  }

  /** Reject: put the text back as it was, without making that a suggestion. */
  async reject(x: LocalSuggestion): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(x.uri);
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(x.uri, range(doc, x.start, x.end), x.s.deleted.replace(/\r?\n/g, eol));
    // Untracked, putting the deleted text back where its marker is cancels the marker, and our own inserted text just
    // goes: the suggestion disappears by itself. drop() below is for safety only.
    this.quiet.add(x.uri.toString());
    if (!(await vscode.workspace.applyEdit(edit))) {
      this.quiet.delete(x.uri.toString());
      return false;
    }
    this.drop(this.byId(x.s.id) ?? x);
    return true;
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    void this.ctx.workspaceState.update(STORE_KEY, this.stored);
  }
}
