// Loading comments from Overleaf (and the cache), the status bar, and resetting everything.
import * as vscode from 'vscode';
import { Model, parseCache, serializeCache } from './model.ts';
import type { Session } from './session.ts';
import type { Threads } from './threads.ts';
import { CACHE_KEY, SetupError, setContext } from './common.ts';

export class Sync implements vscode.Disposable {
  /** When the last fetch finished (0 = none yet); the focus refresh and its back-off look at it. */
  lastFetch = 0;
  readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  private syncedAt: number | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly session: Session,
    private readonly model: Model,
    private readonly threads: Threads,
    private readonly output: vscode.OutputChannel,
  ) {}

  private time = (ms?: number) => (ms ? new Date(ms) : new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  setStatus(kind: 'synced' | 'cached' | 'cookie' | 'error'): void {
    this.statusItem.text =
      kind === 'cookie' ? '$(key) Overleaf: set session cookie'
      : kind === 'error' ? '$(error) Overleaf: cannot load comments (click to retry)'
      : kind === 'synced' ? `$(comment) Overleaf synced ${this.time(this.syncedAt)}`
      : `$(warning) Overleaf: cached${this.syncedAt ? ` from ${this.time(this.syncedAt)}` : ''}`;
    this.statusItem.command = kind === 'cookie' ? 'overleafComments.setCookie' : 'overleafComments.refresh';
    this.statusItem.show();
  }

  /** Load comments. `quiet`: log problems instead of toasting (startup, focus). `useCache`: first paint from the cache. */
  async refresh({ quiet = false, useCache = true, fetch = true } = {}): Promise<void> {
    const { session, model, threads, output } = this;
    let id: string;
    try {
      id = (await session.needProject()).id;
    } catch (e) {
      session.markOverleaf(false);
      if (!quiet) void vscode.window.showErrorMessage(`Overleaf Comments: ${e instanceof Error ? e.message : e}`);
      return;
    }
    session.markOverleaf(true);
    if (useCache && model.isEmpty()) {
      const cached = parseCache(this.ctx.workspaceState.get(CACHE_KEY), id);
      if (cached) {
        model.seed(cached.comments);
        this.syncedAt = cached.at;
        await threads.render().catch(e => output.appendLine(`cache render: ${e}`));
      }
    }
    if (!fetch) return;
    const ticket = model.nextTicket();
    try {
      const comments = await (await session.getClient()).listComments(id, { status: 'all' }); // resolved too: the sidebar lists them
      if (!model.applyFetch(ticket, comments)) return; // a newer fetch already landed
      this.syncedAt = Date.now();
      this.lastFetch = this.syncedAt;
      await this.ctx.workspaceState.update(CACHE_KEY, serializeCache(id, comments, this.syncedAt));
      this.setStatus('synced');
      setContext('loadFailed', false);
      await threads.render();
    } catch (e) {
      session.dropClient(); // cookie may have expired; rebuild next time
      // Back off after real failures (e.g. Overleaf 429): the focus refresh waits refreshMinutes before retrying.
      if (!(e instanceof SetupError)) this.lastFetch = Date.now();
      output.appendLine(String(e));
      if (!model.isEmpty()) this.setStatus('cached'); // stale: showing the last good fetch
      else if (e instanceof SetupError && e.needsCookie) this.setStatus('cookie');
      else {
        this.setStatus('error'); // nothing to show and not a setup problem (expired cookie, offline): say so, don't look like an empty project
        setContext('loadFailed', true);
      }
      if (!quiet) void vscode.window.showErrorMessage(`Overleaf Comments: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Forget everything (Clear Session Cookie, or a new host/project). In-flight fetches and renders become stale. */
  async reset(): Promise<void> {
    this.model.reset();
    this.threads.clear();
    await this.ctx.workspaceState.update(CACHE_KEY, undefined);
    this.statusItem.hide();
    this.session.dropClient();
    this.lastFetch = 0;
    this.syncedAt = undefined;
  }

  dispose(): void {
    this.statusItem.dispose();
  }
}
