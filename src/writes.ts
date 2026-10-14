// Everything that changes things on Overleaf: replies, new comments (with the commit-and-push offer), resolve/reopen.
// Each is optimistic: the UI changes at once, and is rolled back (with the error shown) if Overleaf refuses.
import * as vscode from 'vscode';
import { anchorAt } from './anchor.ts';
import { INTENT_TTL_MS, type Model } from './model.ts';
import type { Session } from './session.ts';
import type { Sync } from './sync.ts';
import type { Threads } from './threads.ts';
import { Cancelled, NOT_ON_OVERLEAF, RERENDER_SLACK_MS, SYNCING, type Client, type NewCommentArgs, type Reply, type Written } from './common.ts';

const optimistic = (text: string): vscode.Comment => ({ author: { name: 'You' }, body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview, label: SYNCING });

export class Writes implements vscode.Disposable {
  /** New comments whose text is not in Overleaf's copy yet, shown in their thread as "Not synced" until it is. */
  private readonly unsynced = new Map<vscode.CommentThread, { uri: vscode.Uri; args: NewCommentArgs }>();
  private retrying = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly session: Session,
    private readonly model: Model,
    private readonly threads: Threads,
    private readonly sync: Sync,
    private readonly output: vscode.OutputChannel,
  ) {
    sync.onFetched = () => void this.retryUnsynced();
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
    temp.canReply = false;
    temp.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.unsynced.set(temp, { uri: doc.uri, args });
    this.threads.addUnsynced(temp, doc, args.selectedText);
  }

  /** "Retry sync" (and the automatic retry): try once more to add the comment. */
  retrySync(temp: vscode.CommentThread): Promise<void> {
    const item = this.unsynced.get(temp);
    if (!item) return Promise.resolve();
    this.unsynced.delete(temp);
    this.threads.removeUnsynced(temp);
    return this.track(Promise.resolve(vscode.workspace.openTextDocument(item.uri)).then(doc => this.addNew(doc, temp, item.args)));
  }

  /** "Discard": the user gives up on the comment. */
  discardUnsynced(temp: vscode.CommentThread): void {
    if (this.unsynced.delete(temp)) {
      this.threads.removeUnsynced(temp);
      temp.dispose();
    }
  }

  /** After each successful fetch (e.g. once the user has pushed): retry the unsynced comments, one at a time. */
  private async retryUnsynced(): Promise<void> {
    if (this.retrying || !this.unsynced.size) return;
    this.retrying = true; // the retries fetch again themselves: do not start another round from inside this one
    try {
      for (const temp of [...this.unsynced.keys()]) await this.retrySync(temp);
    } finally {
      this.retrying = false;
    }
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

  dispose(): void {
    this.timers.forEach(clearTimeout);
  }
}
