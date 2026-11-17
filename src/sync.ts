// Loading comments and suggestions from Overleaf (and the cache), the status bar, and resetting everything.
import * as vscode from 'vscode';
import { Model, parseCache, serializeCache } from './model.ts';
import type { Session } from './session.ts';
import type { Threads } from './threads.ts';
import type { SuggestionThreads } from './suggest.ts';
import type { ProjectComment, TrackedChange } from '@aloth/olcli';
import { buildSnapshot, snapshotPath, writeSnapshot } from './snapshot.ts';
import { CACHE_KEY, SetupError, cacheKey, cfg, setContext } from './common.ts';

/** Text around each suggestion to ask for: enough to find it again after local edits (suggestions.ts uses up to 16). */
const SURROUNDING = 40;

export class Sync implements vscode.Disposable {
  /** When the last fetch finished (0 = none yet); the focus refresh and its back-off look at it. */
  lastFetch = 0;
  /** Called after every successful fetch has been rendered (the writes layer retries unsynced comments then). */
  onFetched: (() => void) | undefined;
  readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  private syncedAt: number | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly session: Session,
    private readonly model: Model,
    private readonly threads: Threads,
    private readonly suggestions: SuggestionThreads,
    private readonly output: vscode.OutputChannel,
  ) {}

  private renderAll = () => Promise.all([this.threads.render(), this.suggestions.render()]);

  private time = (ms?: number) => (ms ? new Date(ms) : new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  setStatus(kind: 'synced' | 'cached' | 'cookie' | 'error'): void {
    this.statusItem.text =
      kind === 'cookie' ? '$(key) Overleaf: set session cookie'
      : kind === 'error' ? '$(error) Overleaf: cannot load comments (click to retry)'
      : kind === 'synced' ? `$(comment) Overleaf synced ${this.time(this.syncedAt)}`
      : `$(warning) Overleaf: cached${this.syncedAt ? ` from ${this.time(this.syncedAt)}` : ''}`;
    const name = this.session.label(); // several projects in the workspace: say which one this is
    if (name) this.statusItem.text = this.statusItem.text.replace('Overleaf', `Overleaf (${name})`);
    this.statusItem.tooltip = this.session.current ? `Overleaf project ${this.session.current.id}` : undefined;
    this.statusItem.command = kind === 'cookie' ? 'overleafComments.setCookie' : 'overleafComments.refresh';
    this.statusItem.show();
  }

  /** Load comments. `quiet`: log problems instead of toasting (startup, focus). `useCache`: first paint from the cache. */
  async refresh({ quiet = false, useCache = true, fetch = true } = {}): Promise<void> {
    const { session, model, output } = this;
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
      const cached = parseCache(this.ctx.workspaceState.get(cacheKey(id)) ?? this.ctx.workspaceState.get(CACHE_KEY), id); // CACHE_KEY: written by 0.2.0
      if (cached) {
        model.seed(cached.comments, cached.changes);
        this.syncedAt = cached.at;
        await this.renderAll().catch(e => output.appendLine(`cache render: ${e}`));
      }
    }
    if (!fetch) return;
    const ticket = model.nextTicket();
    try {
      const { comments, changes } = await (await session.getClient()).listReview(id, { status: 'all', surroundingChars: SURROUNDING }); // resolved too: the sidebar lists them
      if (!model.applyFetch(ticket, comments, changes)) return; // a newer fetch already landed
      this.syncedAt = Date.now();
      this.lastFetch = this.syncedAt;
      await this.ctx.workspaceState.update(cacheKey(id), serializeCache(id, comments, this.syncedAt, changes));
      void this.snapshot(id, comments, changes, this.syncedAt);
      this.setStatus('synced');
      setContext('loadFailed', false);
      await this.renderAll();
      this.onFetched?.();
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

  /** overleafComments.snapshotFile set: the fetched comments as a file in the project, for agents and scripts to read. */
  private async snapshot(id: string, comments: ProjectComment[], changes: TrackedChange[], at: number): Promise<void> {
    const rel = cfg().get<string>('snapshotFile');
    const root = this.session.current?.root.fsPath;
    if (!rel || !root) return;
    const target = snapshotPath(root, rel);
    if (!target) return void this.output.appendLine(`snapshotFile "${rel}" is outside the project folder: not written`);
    const data = buildSnapshot(id, comments, changes, at);
    // One write at a time: two quick fetches must not share the temporary file.
    this.writing = this.writing.then(() => writeSnapshot(root, target, data)).catch(e => this.output.appendLine(`snapshot: ${e}`));
    await this.writing;
  }
  private writing: Promise<void> = Promise.resolve();

  /** Forget everything (Clear Session Cookie, or a new host/project). In-flight fetches and renders become stale. */
  async reset(): Promise<void> {
    this.clearView();
    const ws = this.ctx.workspaceState;
    await Promise.all(ws.keys().filter(k => k === CACHE_KEY || k.startsWith(`${CACHE_KEY}.`)).map(k => ws.update(k, undefined)));
    this.session.dropClient();
  }

  /** Another project of the workspace takes over: clear what is drawn (its cache is kept for when it is back). */
  clearView(): void {
    this.model.reset();
    this.threads.clear();
    this.suggestions.clear();
    this.statusItem.hide();
    this.lastFetch = 0;
    this.syncedAt = undefined;
  }

  dispose(): void {
    this.statusItem.dispose();
  }
}
