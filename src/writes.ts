// Everything that changes things on Overleaf: replies, new comments, resolve/reopen, accepting/rejecting suggestions.
// Each is optimistic: the UI changes at once, and is rolled back (with the error shown) if Overleaf refuses.
import * as vscode from 'vscode';
import { anchorAt, lfView } from './anchor.ts';
import { INTENT_TTL_MS, type Model } from './model.ts';
import type { Session } from './session.ts';
import type { Sync } from './sync.ts';
import type { Threads } from './threads.ts';
import type { SuggestionThreads } from './suggest.ts';
import { LOCAL, type Reviewing } from './reviewing.ts';
import { Cancelled, NOT_ON_OVERLEAF, RERENDER_SLACK_MS, SYNCING, UNSYNCED_KEY, range, type Client, type NewCommentArgs, type Reply, type Written } from './common.ts';

const optimistic = (text: string): vscode.Comment => ({ author: { name: 'You' }, body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview, label: SYNCING });

export class Writes implements vscode.Disposable {
  /** New comments whose text is not in Overleaf's copy yet, shown in their thread as "Not synced" until it is. */
  private readonly unsynced = new Map<vscode.CommentThread, { uri: vscode.Uri; args: NewCommentArgs }>();
  private retrying = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly session: Session,
    private readonly model: Model,
    private readonly threads: Threads,
    private readonly suggestions: SuggestionThreads,
    private readonly reviewing: Reviewing,
    private readonly sync: Sync,
    private readonly output: vscode.OutputChannel,
  ) {
    sync.onFetched = () => void this.retryPending();
  }

  /** Not-synced comments survive a reload: keep them (file and what to send) in workspace storage. */
  private saveUnsynced(): void {
    if (this.restoring) return; // restoreUnsynced saves once at the end
    const shown = [...this.unsynced.values()].map(x => ({ uri: x.uri.toString(), args: x.args }));
    void this.ctx.workspaceState.update(UNSYNCED_KEY, [...shown, ...this.unrestored]);
  }
  private restoring = false;
  /** Saved not-synced comments whose file could not be opened: kept for the next start, so their text is never lost. */
  private unrestored: { uri: string; args: NewCommentArgs }[] = [];

  /** At startup: draw the not-synced comments of the last session again, on their text if it is still there. */
  async restoreUnsynced(): Promise<void> {
    const saved = this.ctx.workspaceState.get<{ uri: string; args: NewCommentArgs }[]>(UNSYNCED_KEY) ?? [];
    const kept: typeof saved = [];
    this.restoring = true;
    for (const { uri, args } of saved) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        const v = lfView(doc.getText());
        let at = -1;
        for (let n = 0, i = v.lf.indexOf(args.selectedText); i !== -1; i = v.lf.indexOf(args.selectedText, i + args.selectedText.length)) {
          at = i; // the occurrence the user commented on, or the last one there is
          if (++n === args.occurrence) break;
        }
        // ponytail: text gone = the comment is shown at the top of the file (it keeps Retry/Discard); re-anchoring UI if this happens often.
        const where = at === -1 ? range(doc, 0, 0) : range(doc, v.toDoc(at), v.toDoc(at + args.selectedText.length));
        this.markUnsynced(doc, this.threads.controller.createCommentThread(doc.uri, where, []), args);
      } catch (e) {
        kept.push({ uri, args });
        this.output.appendLine(`restore unsynced comment in ${uri}: ${e}`);
      }
    }
    this.restoring = false;
    this.unrestored = kept;
    this.saveUnsynced();
  }

  /** Resolves when every background send has finished (deactivate waits for it; so do the tests). */
  drain = async (): Promise<void> => {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  };

  track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    const done = () => void this.pending.delete(p);
    p.then(done, done);
    return p;
  }

  /** Run jobs for one thread one after another, so a reply, a resolve and a reopen never overtake each other. */
  private enqueue<T>(threadId: string, job: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(job);
    this.queues.set(threadId, next);
    const cleanup = () => { if (this.queues.get(threadId) === next) this.queues.delete(threadId); };
    next.then(cleanup, cleanup);
    return next;
  }

  /** Run a write against Overleaf, then re-fetch so the UI shows the server's state. Errors are shown here. */
  private async write<T>(what: string, fn: (c: Client, projectId: string, root: vscode.Uri) => Promise<T>, hint = ''): Promise<Written<T>> {
    try {
      const { id, root } = await this.session.needProject();
      const value = await fn(await this.session.getClient(), id, root);
      // Straight to the server's state: rendering the (stale) cache first would undo our optimistic UI.
      await this.sync.refresh({ useCache: false });
      return { ok: true, value };
    } catch (e) {
      if (e instanceof Cancelled) return { ok: false, cancelled: true };
      this.output.appendLine(`${what}: ${e}`);
      void vscode.window.showErrorMessage(`Overleaf Comments: ${what} failed: ${e instanceof Error ? e.message : e}${hint}`);
      return { ok: false };
    }
  }

  /** A failed send must not lose a long comment: the reply box cannot be refilled, so offer Retry and Copy. */
  private offerFailed(text: string, retry: () => Promise<void>): void {
    void vscode.window.showInformationMessage('Your comment was not sent.', 'Retry', 'Copy text').then(choice => {
      if (choice === 'Retry') this.track(retry());
      else if (choice === 'Copy text') void vscode.env.clipboard.writeText(text);
    });
  }

  /** The reply command: VS Code clears the reply box only when this returns, so it returns at once and the send runs in the background. */
  onReply(r: Reply): void {
    this.track(this.submit(r).catch(e => {
      this.output.appendLine(`submit: ${e}`);
      void vscode.window.showErrorMessage(`Overleaf Comments: could not send your comment: ${e instanceof Error ? e.message : e}`);
      this.offerFailed(r.text.trim(), () => this.submit(r)); // the reply box was already cleared: never lose the text
    }));
  }

  /** The handler for both "reply to a thread" and "new comment from the + button". */
  private async submit(r: Reply): Promise<void> {
    const text = r.text.trim();
    if (!text) return;
    const known = this.threads.entries.find(e => e.thread === r.thread);
    if (known) return this.sendReply(known.comment.threadId, text);
    if (r.thread.comments.length > 0) {
      // A reply to a thread we no longer track (it was re-created by a refresh): never turn it into a new comment.
      void vscode.window.showWarningMessage('Overleaf Comments: that thread was just refreshed. Press Reply again.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(r.thread.uri);
    const anchor = anchorAt(doc.getText(), doc.offsetAt(r.thread.range.start), doc.offsetAt(r.thread.range.end));
    if (!anchor) {
      r.thread.dispose();
      void vscode.window.showErrorMessage('Overleaf Comments: nothing to anchor the comment to. Select some text (or click a non-empty line) and try again.');
      return;
    }
    return this.addNew(doc, r.thread, { filePath: vscode.workspace.asRelativePath(doc.uri, false), content: text, ...anchor });
  }

  private async sendReply(threadId: string, text: string): Promise<void> {
    const { threads } = this;
    const opt = optimistic(text); // shown at once; renders keep it until the server's list has the same text
    const entry = { opt, text };
    threads.pendingReplies.set(threadId, [...(threads.pendingReplies.get(threadId) ?? []), entry]);
    const shown = threads.byId(threadId)?.thread;
    if (shown) shown.comments = [...shown.comments, opt];
    const res = await this.enqueue(threadId, () => this.write('Reply', (c, id) => c.postCommentMessage(id, threadId, text)));
    const left = (threads.pendingReplies.get(threadId) ?? []).filter(p => p !== entry);
    if (left.length) threads.pendingReplies.set(threadId, left); else threads.pendingReplies.delete(threadId);
    const t = threads.byId(threadId)?.thread ?? shown;
    if (!res.ok) {
      if (t) t.comments = t.comments.filter(c => c !== opt);
      if (!res.cancelled) this.offerFailed(text, () => this.sendReply(threadId, text));
    } else if (t?.comments.includes(opt)) {
      // The server's list did not include it yet: keep the text, drop the "Syncing…" label.
      t.comments = t.comments.map(c => (c === opt ? { ...c, label: undefined } : c));
    }
  }

  private async sendNew(uri: vscode.Uri, at: vscode.Range, args: NewCommentArgs): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    return this.addNew(doc, this.threads.controller.createCommentThread(uri, at, []), args);
  }

  /** `temp` shows the typed text until the real thread exists, so nothing disappears and reappears. */
  private async addNew(doc: vscode.TextDocument, temp: vscode.CommentThread, args: NewCommentArgs): Promise<void> {
    const at = temp.range;
    temp.comments = [optimistic(args.content)];
    temp.canReply = false;
    temp.contextValue = 'syncing';
    temp.label = 'Adding comment…';
    temp.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    let notOnOverleaf = false;
    const res = await this.write('Add comment', async (c, id) => {
      try {
        return await c.addComment(id, args);
      } catch (e) {
        if (!NOT_ON_OVERLEAF.test(String(e))) throw e;
        notOnOverleaf = true; // not an error: the text just is not on Overleaf yet. Handled quietly below.
        throw new Cancelled();
      }
    });
    if (!res.ok) {
      if (notOnOverleaf) {
        this.markUnsynced(doc, temp, args);
        return;
      }
      temp.dispose();
      if (!res.cancelled) this.offerFailed(args.content, () => this.sendNew(doc.uri, at, args));
      return;
    }
    const real = this.threads.byId(res.value.threadId);
    if (real) {
      real.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded; // the placeholder was open; so is the real thread
      temp.dispose(); // the real thread was created by the write's refresh, so the swap is seamless
    } else {
      // The post-write refresh failed or has not shown it yet: keep the placeholder until a render has the real thread.
      temp.label = 'Added; it will update on the next refresh';
      this.threads.linger(res.value.threadId, temp);
    }
    const landed = this.model.view(Date.now()).find(c => c.threadId === res.value.threadId);
    if (landed && landed.selectedText !== args.selectedText) {
      void vscode.window.showWarningMessage(`Overleaf Comments: the comment attached to different text than selected ("${landed.selectedText.slice(0, 40)}"). Your local file may differ from Overleaf's copy; git pull and check.`);
    }
  }

  /** The comment stays in its thread, quietly marked as not synced; no alarm, nothing is pushed for the user. */
  private markUnsynced(doc: vscode.TextDocument, temp: vscode.CommentThread, args: NewCommentArgs): void {
    temp.comments = [{ ...optimistic(args.content), label: 'Not synced' }];
    temp.label = "Text not on Overleaf yet · it syncs once you've pushed it";
    temp.contextValue = 'unsynced';
    // The only per-thread gutter icon stable API offers: "unresolved" swaps the plain bubble for the bubble-with-dot.
    // ponytail: the "pending" (comment-draft) icon needs the proposed commentsDraftState API, which Marketplace builds can't use.
    temp.state = vscode.CommentThreadState.Unresolved;
    temp.canReply = false;
    temp.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.unsynced.set(temp, { uri: doc.uri, args });
    this.threads.addUnsynced(temp, doc, args.selectedText);
    this.saveUnsynced();
  }

  /** "Retry sync" (and the automatic retry): try once more to add the comment. */
  retrySync(temp: vscode.CommentThread): Promise<void> {
    const item = this.unsynced.get(temp);
    if (!item) return Promise.resolve();
    this.unsynced.delete(temp);
    this.threads.removeUnsynced(temp);
    this.saveUnsynced();
    return this.track(Promise.resolve(vscode.workspace.openTextDocument(item.uri)).then(doc => this.addNew(doc, temp, item.args)));
  }

  /** "Discard": the user gives up on the comment. */
  discardUnsynced(temp: vscode.CommentThread): void {
    if (this.unsynced.delete(temp)) {
      this.threads.removeUnsynced(temp);
      temp.dispose();
      this.saveUnsynced();
    }
  }

  /** After each successful fetch (e.g. once the user has pushed): send what is waiting for a push, one at a time:
   * not-synced comments, then local suggestions. */
  private async retryPending(): Promise<void> {
    if (this.retrying) return;
    this.retrying = true; // the retries fetch again themselves: do not start another round from inside this one
    try {
      for (const temp of [...this.unsynced.keys()]) await this.retrySync(temp);
      await this.sendLocalSuggestions();
    } finally {
      this.retrying = false;
    }
  }

  /** Local suggestions whose text is on Overleaf now (pushed) become suggestions there. Quiet: this runs after every
   * fetch, and "not pushed yet" is the normal answer. */
  private async sendLocalSuggestions(): Promise<void> {
    const files = this.reviewing.pending();
    if (!files.length) return;
    let sent = 0;
    try {
      const { id } = await this.session.needProject();
      const client = await this.session.getClient();
      for (const f of files) {
        const results = await client.suggestChanges(id, f.path, f.edits);
        results.forEach((r, i) => { if (r === 'done') { this.reviewing.drop(f.items[i]); sent++; } });
      }
    } catch (e) {
      this.output.appendLine(`send local suggestions: ${e}`);
    }
    if (sent) await this.sync.refresh({ quiet: true, useCache: false });
  }

  /** Resolve/reopen. The user's intent is shown at once and kept until the server agrees (or INTENT_TTL_MS passes), so a
   * server that lags cannot flip it back; if Overleaf refuses, it is undone and write() has shown the error. */
  async setResolved(threadId: string, resolved: boolean): Promise<void> {
    const { model, threads } = this;
    if (!model.view(Date.now()).some(c => c.threadId === threadId && c.resolved !== resolved)) return;
    model.setIntent(threadId, resolved, Date.now());
    // When the intent expires the UI falls back to what the server last said, which may be stale: refetch so it is not.
    const timer = setTimeout(() => { this.timers.delete(timer); void this.sync.refresh({ quiet: true, useCache: false }); }, INTENT_TTL_MS + RERENDER_SLACK_MS);
    this.timers.add(timer);
    await threads.render();
    const res = await this.enqueue(threadId, () => this.write(resolved ? 'Resolve' : 'Reopen', (c, id) => (resolved ? c.resolveComment(id, threadId) : c.reopenComment(id, threadId))));
    if (!res.ok) {
      model.clearIntent(threadId, resolved);
      await threads.render();
    }
  }

  /** Accept: Overleaf keeps the change and drops the marker. The local file already has the accepted text. */
  async acceptSuggestion(id: string): Promise<void> {
    if (id.startsWith(LOCAL)) { const x = this.reviewing.byId(id); if (x) this.reviewing.drop(x); return; } // keep the text, forget the suggestion
    const e = this.suggestions.byId(id);
    if (e) await this.clearSuggestion(e.s.ids, e.s.docId, 'Accept suggestion');
  }

  /** Reject: undo the change in the LOCAL file (the user pushes it as usual), then accept on Overleaf, which only clears
   * the marker there. No edit is sent to Overleaf's text, so a later push or pull cannot conflict with it. */
  async rejectSuggestion(id: string): Promise<void> {
    if (id.startsWith(LOCAL)) {
      const x = this.reviewing.byId(id);
      if (x && !(await this.reviewing.reject(x))) void vscode.window.showErrorMessage('Overleaf Comments: could not change the file to reject the suggestion.');
      return;
    }
    const e = this.suggestions.byId(id);
    if (!e) return;
    const doc = await vscode.workspace.openTextDocument(e.thread.uri);
    const v = lfView(doc.getText());
    if (!e.found || v.lf.slice(v.fromDoc(e.start), v.fromDoc(e.end)) !== e.s.inserted) {
      void vscode.window.showErrorMessage('Overleaf Comments: the suggested text is not where it should be in your file (edited locally?). git pull, then try again.');
      return;
    }
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, range(doc, e.start, e.end), e.s.deleted.replace(/\n/g, eol));
    const { ids, docId } = e.s;
    this.model.setHandled(ids, true);
    await this.suggestions.render(); // the thread goes away before the text changes under it
    if (!(await vscode.workspace.applyEdit(edit))) {
      this.model.setHandled(ids, false);
      await this.suggestions.render();
      void vscode.window.showErrorMessage('Overleaf Comments: could not change the file to reject the suggestion.');
      return;
    }
    if (await this.clearSuggestion(ids, docId, 'Clear the rejected suggestion on Overleaf', ' The file was already changed; undo it, or push it and accept the suggestion on Overleaf.')) {
      vscode.window.setStatusBarMessage('$(check) Suggestion rejected in your file. Save and push to update Overleaf.', 8000);
    }
  }

  private async clearSuggestion(ids: string[], docId: string, what: string, hint = ''): Promise<boolean> {
    this.model.setHandled(ids, true);
    await this.suggestions.render();
    const res = await this.enqueue(ids[0], () => this.write(what, (c, pid) => c.acceptTrackedChangesInDoc(pid, docId, ids), hint));
    if (!res.ok) {
      this.model.setHandled(ids, false);
      await this.suggestions.render();
    }
    return res.ok;
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
  }
}
