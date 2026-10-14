// The editor side: one comment thread per OPEN comment (resolved ones live only in the sidebar), kept in place across
// refreshes, re-anchored as the file is edited, with the highlight on top.
import * as vscode from 'vscode';
import type { ProjectComment, CommentMessage } from '@aloth/olcli';
import { locate, lfView, shiftAnchor } from './anchor.ts';
import { authorOf, clipForThread, messageHeight, visibleIndices } from './text.ts';
import { Highlights } from './markers.ts';
import type { Model } from './model.ts';
import type { Session } from './session.ts';
import { ANCHOR_LOST, range, workspaceRoot, type Entry } from './common.ts';

const TOGGLE = 'overleafComments.toggleMessage';
const SHOW_THREAD = 'overleafComments.showThread';
/** The thread's context value: which header buttons apply. Long = some comment is collapsible. */
const contextFor = (hasLong: boolean, allExpanded: boolean) => (!hasLong ? 'open' : allExpanded ? 'openLongExpanded' : 'openLong');
const signature = (c: ProjectComment) => c.messages.map(m => `${m.id}\u0000${m.content}`).join('\u0001');

export class Threads implements vscode.Disposable {
  readonly controller = vscode.comments.createCommentController('overleaf', 'Overleaf');
  readonly highlights = new Highlights(() => this.entries);
  entries: Entry[] = [];
  /** Optimistic replies not yet confirmed, per thread: renders keep showing them until the server's list has the same text. */
  readonly pendingReplies = new Map<string, { opt: vscode.Comment; text: string }[]>();
  /** New-comment placeholders waiting for their real thread to render. */
  private readonly lingering = new Map<string, vscode.CommentThread>();
  /** Long comments the user expanded with their own Show more link (key: threadId:messageId). */
  private readonly expanded = new Set<string>();
  /** Threads where the user pressed "Show entire comments". */
  private readonly allExpanded = new Set<string>();
  private renderGen = 0;
  private warnedMissing = '';

  /** `onChange`: called whenever the set or position of threads changed (the sidebar redraws). */
  constructor(private readonly model: Model, private readonly output: vscode.OutputChannel, session: Session, private readonly onChange: () => void) {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: doc => (session.isOverleaf !== false && doc.uri.scheme === 'file' && /\.tex$/i.test(doc.uri.fsPath) && doc.lineCount ? [new vscode.Range(0, 0, doc.lineCount - 1, 0)] : []),
    };
  }

  byId = (id: string) => this.entries.find(e => e.comment.threadId === id);

  /** Something is cut: a long comment, or comments hidden by the thread's height cutoff. */
  private isCut = (c: ProjectComment) => c.messages.some(m => clipForThread(m.content, false).long) || visibleIndices(c.messages.map(m => messageHeight(m.content))).length < c.messages.length;
  private contextValue = (c: ProjectComment) => contextFor(this.isCut(c), this.allExpanded.has(c.threadId));

  /** One comment as shown in the thread: long ones are cut to a few lines with a Show more / Show less link. */
  private toComment(c: ProjectComment, m: CommentMessage): vscode.Comment {
    const open = this.allExpanded.has(c.threadId) || this.expanded.has(`${c.threadId}:${m.id}`);
    const { text, long } = clipForThread(m.content, open);
    const body = new vscode.MarkdownString(text);
    if (long) {
      body.isTrusted = { enabledCommands: [TOGGLE] }; // only so that the link below can run our own command
      body.appendMarkdown(`\n\n[${open ? 'Show less' : 'Show more…'}](command:${TOGGLE}?${encodeURIComponent(JSON.stringify([c.threadId, m.id]))})`);
    }
    return { author: { name: authorOf(m) }, body, mode: vscode.CommentMode.Preview, timestamp: m.timestamp ? new Date(m.timestamp) : undefined };
  }

  private redrawComments(e: Entry): void {
    e.thread.comments = this.withPending(e.comment);
    e.thread.contextValue = this.contextValue(e.comment);
  }

  /** Show more / Show less on one comment. */
  toggleMessage(threadId: string, messageId: string): void {
    const key = `${threadId}:${messageId}`;
    if (!this.expanded.delete(key)) this.expanded.add(key);
    const e = this.byId(threadId);
    if (e) this.redrawComments(e);
  }

  /** The thread-header button (or the "Show entire thread" link): show every comment of the thread in full, or cut it again. */
  toggleAll(thread: vscode.CommentThread | string): void {
    const e = typeof thread === 'string' ? this.byId(thread) : this.entries.find(x => x.thread === thread);
    if (!e) return;
    const id = e.comment.threadId;
    if (!this.allExpanded.delete(id)) this.allExpanded.add(id);
    for (const m of e.comment.messages) this.expanded.delete(`${id}:${m.id}`); // the per-comment choices start over
    this.redrawComments(e);
  }

  /** The thread's comments: all of them when expanded, otherwise the first and the latest that fit, with a marker for the gap. */
  private shownMessages(c: ProjectComment): vscode.Comment[] {
    const all = this.allExpanded.has(c.threadId);
    const idx = all ? c.messages.map((_, i) => i) : visibleIndices(c.messages.map(m => messageHeight(m.content)));
    const out: vscode.Comment[] = [];
    idx.forEach((i, k) => {
      const gap = k > 0 ? i - idx[k - 1] - 1 : 0;
      if (gap > 0) {
        const marker = new vscode.MarkdownString(`… ${gap} more comment${gap === 1 ? '' : 's'} hidden. `);
        marker.isTrusted = { enabledCommands: [SHOW_THREAD] };
        marker.appendMarkdown(`[Show entire thread](command:${SHOW_THREAD}?${encodeURIComponent(JSON.stringify([c.threadId]))})`);
        out.push({ author: { name: 'Overleaf Comments' }, body: marker, mode: vscode.CommentMode.Preview });
      }
      out.push(this.toComment(c, c.messages[i]));
    });
    return out;
  }

  /** The server's messages, plus our own replies that are still being sent (unless the server already has them). */
  private withPending = (c: ProjectComment): vscode.Comment[] => [
    ...this.shownMessages(c),
    ...(this.pendingReplies.get(c.threadId) ?? []).filter(p => !c.messages.some(m => m.content === p.text)).map(p => p.opt),
  ];

  /** VS Code can leave a thread's gutter marker undrawn in an editor that was already open when the thread was created;
   * re-assigning the range redraws it. Unverified workaround (it was added without being able to reproduce on demand). */
  redraw(uri?: vscode.Uri): void {
    for (const e of this.entries) if (!uri || e.thread.uri.toString() === uri.toString()) e.thread.range = new vscode.Range(e.thread.range.start, e.thread.range.end);
  }

  /** Keep a placeholder alive until a render shows the real thread for `threadId`. */
  linger(threadId: string, temp: vscode.CommentThread): void {
    this.lingering.set(threadId, temp);
  }

  async render(): Promise<void> {
    const root = workspaceRoot();
    if (!root) return;
    const gen = ++this.renderGen;
    const open = this.model.view(Date.now()).filter(c => !c.resolved); // resolved comments are not drawn in the editor
    // Open every document first, then swap threads in one step; a newer render supersedes this one.
    const docs = await Promise.all(open.map(async c => {
      const uri = vscode.Uri.joinPath(root, c.path.replace(/^\/+/, ''));
      try {
        return { c, uri, doc: await vscode.workspace.openTextDocument(uri) };
      } catch (err) {
        this.output.appendLine(`skip ${c.path}: ${err}`);
        return undefined;
      }
    }));
    if (gen !== this.renderGen) return;
    const missing = docs.flatMap((d, i) => (d ? [] : [open[i].path])).sort().join(', ');
    if (missing && missing !== this.warnedMissing) void vscode.window.showWarningMessage(`Overleaf Comments: comment thread(s) hidden because their file is not in this workspace (git pull?): ${missing}`);
    this.warnedMissing = missing;
    // Update existing threads in place (no tear-down), so nothing blinks and open/closed state is kept.
    const old = new Map(this.entries.map(e => [e.comment.threadId, e]));
    const next: Entry[] = [];
    for (const d of docs) {
      if (!d) continue;
      const { c, uri, doc } = d;
      let prev = old.get(c.threadId);
      old.delete(c.threadId);
      if (prev && prev.thread.uri.toString() !== uri.toString()) { prev.thread.dispose(); prev = undefined; }
      const v = lfView(doc.getText());
      let start: number;
      let end: number;
      let found = true;
      if (prev && v.lf.slice(v.fromDoc(prev.start), v.fromDoc(prev.end)) === c.selectedText) {
        ({ start, end } = prev); // already placed and still matching: do not re-search by Overleaf's older offset
      } else {
        const a = locate(v.lf, c.position, c.selectedText);
        found = a.found;
        start = v.toDoc(a.start);
        end = v.toDoc(a.end);
      }
      const where = range(doc, start, end);
      const thread = prev?.thread ?? this.controller.createCommentThread(uri, where, this.withPending(c));
      if (prev) {
        // Only touch what changed: re-assigning comments would drop an optimistic "Syncing…" reply for nothing.
        if (signature(prev.comment) !== signature(c)) thread.comments = this.withPending(c);
        if (!thread.range.isEqual(where)) thread.range = where;
      }
      thread.canReply = true;
      thread.contextValue = this.contextValue(c);
      thread.label = found ? undefined : ANCHOR_LOST;
      next.push({ thread, comment: c, start, end });
      const waiting = this.lingering.get(c.threadId);
      if (waiting) {
        thread.collapsibleState = waiting.collapsibleState; // the placeholder was open; so is the thread that replaces it
        waiting.dispose();
        this.lingering.delete(c.threadId);
      }
    }
    old.forEach(e => e.thread.dispose());
    this.entries = next;
    this.onChange();
    for (const e of vscode.window.visibleTextEditors) this.redraw(e.document.uri);
    this.highlights.apply();
  }

  /** A click elsewhere in the text closes open comments; a click inside a comment's own text leaves that one alone.
   * No event tells us whether the user opened a thread, so every other thread of the file is closed: setting it open
   * and then closed makes sure the change is always sent, even if our idea of its state is stale. */
  collapseOutside(uri: vscode.Uri, selection: vscode.Selection): void {
    for (const x of this.entries) {
      if (x.thread.uri.toString() !== uri.toString() || x.thread.range.intersection(selection)) continue;
      x.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      x.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    }
  }

  /** Drop every thread (Clear Session Cookie); a render in flight becomes stale. */
  clear(): void {
    ++this.renderGen;
    this.entries.forEach(e => e.thread.dispose());
    this.entries = [];
    this.lingering.forEach(temp => temp.dispose());
    this.lingering.clear();
    this.pendingReplies.clear();
    this.warnedMissing = '';
    this.highlights.apply();
    this.onChange();
  }

  /** Move threads with the user's edits instead of re-searching the whole file on every keystroke. */
  onTextChange(e: vscode.TextDocumentChangeEvent): void {
    const uri = e.document.uri.toString();
    const mine = this.entries.filter(x => x.thread.uri.toString() === uri);
    if (!mine.length || !e.contentChanges.length) return;
    const changes = e.contentChanges.map(c => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text }));
    const v = lfView(e.document.getText());
    for (const x of mine) {
      let { start, end } = shiftAnchor(x.start, x.end, changes);
      let found = true;
      if (v.lf.slice(v.fromDoc(start), v.fromDoc(end)) !== x.comment.selectedText) {
        // The edit touched the anchor's text: look for it again, nearest to where it was.
        const a = locate(v.lf, v.fromDoc(start), x.comment.selectedText);
        found = a.found;
        start = v.toDoc(a.start);
        end = v.toDoc(a.end);
      }
      x.start = start;
      x.end = end;
      x.thread.range = range(e.document, start, end);
      x.thread.label = found ? undefined : ANCHOR_LOST;
    }
    this.highlights.apply();
    this.onChange();
  }

  dispose(): void {
    this.controller.dispose();
    this.highlights.dispose();
  }
}
