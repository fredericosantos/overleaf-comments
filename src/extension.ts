// Wiring only: builds the pieces, registers commands and events, and (in test mode) exposes a small test API.
import * as vscode from 'vscode';
import type { ProjectComment } from '@aloth/olcli';
import { Model, serializeCache } from './model.ts';
import { Session } from './session.ts';
import { Threads } from './threads.ts';
import { SuggestionThreads } from './suggest.ts';
import { Reviewing } from './reviewing.ts';
import { Sync } from './sync.ts';
import { Writes } from './writes.ts';
import { CommentsTree, commentOf, firstText, type Node } from './tree.ts';
import { focusReply, reveal, revealSuggestion } from './navigate.ts';
import { CACHE_KEY, COOKIE_KEY, cfg, setContext, workspaceRoot, type Client, type Reply } from './common.ts';

/** Only handed out in extension-test mode; the shipped extension exposes nothing. */
export interface ExtensionApi {
  /** Replace what Overleaf "returned" and render it (no network). */
  render(root: vscode.Uri, comments: ProjectComment[]): Promise<void>;
  /** Restart as if freshly opened: put comments in the cache, then refresh (fetch=false: cache only). */
  seedCacheAndRefresh(comments: ProjectComment[], fetch: boolean): Promise<void>;
  storeCookie(value: string): Promise<void>;
  /** Resolves when every background send has finished. */
  idle(): Promise<void>;
  useClient(c: Client): void;
  /** A mouse click in the text, as the selection event would report it. */
  clickAt(uri: vscode.Uri, selection: vscode.Selection): void;
  /** A thread as the UI's "+" creates it (not yet known to Overleaf). */
  newThread(uri: vscode.Uri, range: vscode.Range): vscode.CommentThread;
  thread(i: number): vscode.CommentThread;
  /** What the sidebar shows (file -> thread titles, resolved ones prefixed). */
  tree(): { file: string; threads: string[] }[];
  status(): string;
  /** How many comments are currently drawn as not synced. */
  unsynced(): number;
  threads(): { uri: string; threadId: string; line: number; label?: string; messages: number }[];
}

let drain: () => Promise<void> = async () => {};

export function activate(ctx: vscode.ExtensionContext): ExtensionApi | undefined {
  const output = vscode.window.createOutputChannel('Overleaf Comments');
  const model = new Model();
  const session = new Session(ctx);
  // threads <-> tree: the tree reads the model and asks threads where an open comment currently is.
  let tree: CommentsTree;
  const threads = new Threads(model, output, session, () => tree.refresh());
  // reviewing -> suggestions: every local edit in Reviewing mode redraws the local suggestions.
  let suggestions: SuggestionThreads;
  const reviewing = new Reviewing(ctx, session, () => suggestions.renderLocal());
  suggestions = new SuggestionThreads(threads.controller, model, () => reviewing.items(), output, () => tree.refresh());
  tree = new CommentsTree(() => model.view(Date.now()), () => [...model.suggestions(), ...reviewing.items().map(x => x.s)], id => (threads.byId(id) ?? suggestions.byId(id))?.thread.range.start.line);
  const treeView = vscode.window.createTreeView('overleafComments.threads', { treeDataProvider: tree });
  // The view's description is hidden when it is the only view in its container: say it at the top of the list too.
  const showMode = () => {
    treeView.description = reviewing.on ? 'Reviewing' : '';
    treeView.message = reviewing.on ? 'Reviewing: your edits become suggestions. The button above switches back to Editing.' : undefined;
  };
  showMode();
  const sync = new Sync(ctx, session, model, threads, suggestions, output);
  const writes = new Writes(ctx, session, model, threads, suggestions, reviewing, sync, output);
  /** Accept/Reject come from a thread header (a thread) or the sidebar (a tree node). */
  const suggestionId = (x: vscode.CommentThread | Node) => ('kind' in x ? (x.kind === 'suggestion' ? x.s.id : undefined) : suggestions.byThread(x)?.s.id);
  drain = writes.drain;

  const command = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(`overleafComments.${id}`, fn);

  ctx.subscriptions.push(
    output, reviewing, suggestions, threads, tree, treeView, sync, writes,
    vscode.window.onDidChangeActiveTextEditor(e => e && threads.redraw(e.document.uri)),
    vscode.window.onDidChangeVisibleTextEditors(es => { es.forEach(e => threads.redraw(e.document.uri)); threads.highlights.apply(); suggestions.apply(); }),
    vscode.window.onDidChangeWindowState(w => {
      const mins = cfg().get<number>('refreshMinutes'); // default (5) comes from package.json
      if (w.focused && mins && mins > 0 && sync.lastFetch && Date.now() - sync.lastFetch > mins * 60_000) void sync.refresh({ quiet: true });
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('overleafComments.baseUrl') || e.affectsConfiguration('overleafComments.projectId')) {
        void sync.reset().then(() => sync.refresh({ quiet: true })); // new host / project: start over
      }
    }),
    vscode.workspace.onDidChangeTextDocument(e => { reviewing.onTextChange(e); threads.onTextChange(e); suggestions.onTextChange(e); }),
    vscode.workspace.onDidOpenTextDocument(d => reviewing.ensure(d)),
    command('startReviewing', async () => { await reviewing.set(true); showMode(); }),
    command('stopReviewing', async () => { await reviewing.set(false); showMode(); }),
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
      threads.collapseOutside(e.textEditor.document.uri, e.selections[0]);
      suggestions.collapseOutside(e.textEditor.document.uri, e.selections[0]);
    }),
    command('reply', (r: Reply) => writes.onReply(r)),
    command('resolve', (t: vscode.CommentThread) => { const e = threads.entries.find(x => x.thread === t); return e && writes.track(writes.setResolved(e.comment.threadId, true)); }),
    command('toggleMessage', (threadId: string, messageId: string) => threads.toggleMessage(threadId, messageId)),
    command('retrySync', (t: vscode.CommentThread) => writes.retrySync(t)),
    command('discardUnsynced', (t: vscode.CommentThread) => writes.discardUnsynced(t)),
    command('showThread', (threadId: string) => threads.toggleAll(threadId)),
    command('showAll', (t: vscode.CommentThread) => threads.toggleAll(t)), // the header shows one or the other, depending on the thread's state
    command('collapseAll', (t: vscode.CommentThread) => threads.toggleAll(t)),
    command('treeReveal', (n: Node) => {
      if (n.kind === 'suggestion') { const e = suggestions.byId(n.s.id); return e && revealSuggestion(e); }
      const c = commentOf(n);
      return c && reveal(threads, c);
    }),
    command('acceptSuggestion', (x: vscode.CommentThread | Node) => { const id = suggestionId(x); return id && writes.track(writes.acceptSuggestion(id)); }),
    command('rejectSuggestion', (x: vscode.CommentThread | Node) => { const id = suggestionId(x); return id && writes.track(writes.rejectSuggestion(id)); }),
    command('treeReply', (n: Node) => { const c = commentOf(n); const e = c && threads.byId(c.threadId); return e && focusReply(e); }),
    command('treeResolve', (n: Node) => { const c = commentOf(n); return c && writes.track(writes.setResolved(c.threadId, true)); }),
    command('treeReopen', (n: Node) => { const c = commentOf(n); return c && writes.track(writes.setResolved(c.threadId, false)); }),
    command('refresh', () => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Overleaf comments' }, () => sync.refresh())),
    command('clearCookie', async () => {
      await ctx.secrets.delete(COOKIE_KEY);
      await sync.reset();
      setContext('hasCookie', !!process.env.OVERLEAF_SESSION_COOKIE);
      if (process.env.OVERLEAF_SESSION_COOKIE) void vscode.window.showInformationMessage('Overleaf Comments: the stored cookie is cleared, but OVERLEAF_SESSION_COOKIE in the environment still applies.');
    }),
    command('setCookie', async () => {
      const v = await vscode.window.showInputBox({ prompt: 'overleaf_session2 cookie value (browser devtools → cookies)', password: true, ignoreFocusOut: true });
      if (!v) return;
      await ctx.secrets.store(COOKIE_KEY, v.trim());
      session.dropClient();
      await sync.refresh();
    }),
  );

  void ctx.secrets.get(COOKIE_KEY).then(cookie => setContext('hasCookie', !!(cookie || process.env.OVERLEAF_SESSION_COOKIE)));
  // quiet: this runs in every git repo, most of which are not Overleaf projects. Once we know this one is, bring back
  // what was waiting for a push in the last session.
  void sync.refresh({ quiet: true }).then(async () => {
    if (!session.isOverleaf) return;
    vscode.workspace.textDocuments.forEach(d => reviewing.ensure(d));
    await writes.restoreUnsynced();
  });
  // A push or fetch moves the remote-tracking refs: refresh then, so what waited for the push is sent right away.
  const root = workspaceRoot();
  if (root) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pushed = () => { clearTimeout(timer); timer = setTimeout(() => { if (session.isOverleaf) void sync.refresh({ quiet: true, useCache: false }); }, 1500); };
    const refs = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.git/refs/remotes/**'));
    ctx.subscriptions.push(refs, refs.onDidChange(pushed), refs.onDidCreate(pushed), { dispose: () => clearTimeout(timer) });
  }

  if (ctx.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    render: async (_root, comments) => { model.reset(); model.applyFetch(model.nextTicket(), comments); await Promise.all([threads.render(), suggestions.render()]); }, // reset: no intent from an earlier step may leak in
    seedCacheAndRefresh: async (comments, fetch) => {
      model.reset(); // as if the window had just been opened
      sync.statusItem.text = '';
      const { id } = await session.needProject();
      await ctx.workspaceState.update(CACHE_KEY, serializeCache(id, comments, Date.now()));
      await sync.refresh({ fetch });
    },
    storeCookie: v => Promise.resolve(ctx.secrets.store(COOKIE_KEY, v)),
    idle: writes.drain,
    useClient: c => { session.injected = c; },
    clickAt: (uri, selection) => threads.collapseOutside(uri, selection),
    newThread: (uri, at) => threads.controller.createCommentThread(uri, at, []),
    thread: i => threads.entries[i].thread,
    tree: () => tree.getChildren().map(f => (f.kind === 'file' ? { file: f.path, threads: f.comments.map(c => `${c.resolved ? '[resolved] ' : ''}${firstText(c)}`) } : { file: '', threads: [] })),
    status: () => sync.statusItem.text,
    unsynced: () => threads.unsyncedCount(),
    threads: () => threads.entries.map(e => ({ uri: e.thread.uri.toString(), threadId: e.comment.threadId, line: e.thread.range.start.line, label: e.thread.label, messages: e.thread.comments.length })),
  };
}

export function deactivate() {
  return drain(); // let in-flight sends finish before the window closes
}
