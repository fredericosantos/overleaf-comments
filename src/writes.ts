// Everything that changes things on Overleaf: replies, new comments (with the commit-and-push offer), resolve/reopen.
// Each is optimistic: the UI changes at once, and is rolled back (with the error shown) if Overleaf refuses.
import * as vscode from 'vscode';
import { anchorAt } from './anchor.ts';
import { pushFile } from './git.ts';
import { INTENT_TTL_MS, type Model } from './model.ts';
import type { Session } from './session.ts';
import type { Sync } from './sync.ts';
import type { Threads } from './threads.ts';
import { Cancelled, NOT_ON_OVERLEAF, PUSH_RETRIES, PUSH_WAIT_MS, RERENDER_SLACK_MS, SYNCING, type Client, type NewCommentArgs, type Prompts, type Reply, type Written } from './common.ts';

const optimistic = (text: string): vscode.Comment => ({ author: { name: 'You' }, body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview, label: SYNCING });

export class Writes implements vscode.Disposable {
  prompts: Prompts = {
    confirmPush: (m, ok) => vscode.window.showWarningMessage(m, { modal: true }, ok).then(r => r === ok),
    commitMessage: d => vscode.window.showInputBox({ prompt: 'Commit message', value: d, ignoreFocusOut: true }),
  };
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly session: Session,
    private readonly model: Model,
    private readonly threads: Threads,
    private readonly sync: Sync,
    private readonly output: vscode.OutputChannel,
  ) {}

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

  /** The text is not in Overleaf's copy: offer to commit and push this file, so Overleaf has it. */
  private async pushForComment(doc: vscode.TextDocument, cwd: string): Promise<void> {
    const file = vscode.workspace.asRelativePath(doc.uri, false);
    const ok = await this.prompts.confirmPush(
      `Overleaf's copy of "${file}" does not contain the text you selected. Commit this file and push it to Overleaf, then add the comment?${doc.isDirty ? ' (Unsaved changes will be saved first.)' : ''} Other pending commits on this branch are pushed too.`,
      'Commit & push',
    );
    if (!ok) throw new Cancelled();
    const message = await this.prompts.commitMessage(`Update ${file}`);
    if (!message) throw new Cancelled();
    if (doc.isDirty && !(await doc.save())) throw new Error(`Could not save ${file}.`);
    await pushFile({ cwd, file, message });
    this.output.appendLine(`pushed ${file}`);
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
    const hint = `\nAnchor text: "${args.selectedText.length > 60 ? args.selectedText.slice(0, 60) + '…' : args.selectedText}"${doc.isDirty ? ' (this file has unsaved changes; Overleaf only has the pushed version)' : ''}. If your local file differs from Overleaf, git pull/push first.`;
    const res = await this.write('Add comment', async (c, id, root) => {
      try {
        return await c.addComment(id, args);
      } catch (e) {
        if (!NOT_ON_OVERLEAF.test(String(e))) throw e;
        await this.pushForComment(doc, root.fsPath);
        for (let i = 0; ; i++) {
          try { return await c.addComment(id, args); } catch (e2) { if (!NOT_ON_OVERLEAF.test(String(e2)) || i >= PUSH_RETRIES) throw e2; await new Promise(r => setTimeout(r, PUSH_WAIT_MS)); }
        }
      }
    }, hint);
    if (!res.ok) {
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
