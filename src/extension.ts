// Wiring only: builds the pieces, registers commands and events, and (in test mode) exposes a small test API.
import * as vscode from 'vscode';
import type { ProjectComment } from '@aloth/olcli';
import { Model, serializeCache } from './model.ts';
import { Session } from './session.ts';
import { Threads } from './threads.ts';
import { Sync } from './sync.ts';
import { Writes } from './writes.ts';
import { CommentsTree, commentOf, firstText, type Node } from './tree.ts';
import { focusReply, reveal } from './navigate.ts';
import { CACHE_KEY, COOKIE_KEY, cfg, setContext, type Client, type Entry, type Prompts, type Reply } from './common.ts';

export type { Prompts };

/** Only handed out in extension-test mode; the shipped extension exposes nothing. */
export interface ExtensionApi {
  /** Replace what Overleaf "returned" and render it (no network). */
  render(root: vscode.Uri, comments: ProjectComment[]): Promise<void>;
  /** Restart as if freshly opened: put comments in the cache, then refresh (fetch=false: cache only). */
  seedCacheAndRefresh(comments: ProjectComment[], fetch: boolean): Promise<void>;
  storeCookie(value: string): Promise<void>;
  /** Resolves when every background send has finished. */
  idle(): Promise<void>;
  setPrompts(p: Prompts): void;
  useClient(c: Client): void;
  /** A mouse click in the text, as the selection event would report it. */
  clickAt(uri: vscode.Uri, selection: vscode.Selection): void;
  /** A thread as the UI's "+" creates it (not yet known to Overleaf). */
  newThread(uri: vscode.Uri, range: vscode.Range): vscode.CommentThread;
  thread(i: number): vscode.CommentThread;
  /** What the sidebar shows (file -> thread titles, resolved ones prefixed). */
  tree(): { file: string; threads: string[] }[];
  status(): string;
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
  tree = new CommentsTree(() => model.view(Date.now()), id => threads.byId(id)?.thread.range.start.line);
  const treeView = vscode.window.createTreeView('overleafComments.threads', { treeDataProvider: tree });
  const sync = new Sync(ctx, session, model, threads, output);
  const writes = new Writes(session, model, threads, sync, output);
  drain = writes.drain;

  const command = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(`overleafComments.${id}`, fn);
  const onThread = (fn: (e: Entry) => unknown) => (id: string) => { const e = threads.byId(id); return e && fn(e); };

  ctx.subscriptions.push(
    output, threads, tree, treeView, sync, writes,
    vscode.window.onDidChangeActiveTextEditor(e => e && threads.redraw(e.document.uri)),
    vscode.window.onDidChangeVisibleTextEditors(es => { es.forEach(e => threads.redraw(e.document.uri)); threads.highlights.apply(); }),
    vscode.window.onDidChangeWindowState(w => {
      const mins = cfg().get<number>('refreshMinutes'); // default (5) comes from package.json
      if (w.focused && mins && mins > 0 && sync.lastFetch && Date.now() - sync.lastFetch > mins * 60_000) void sync.refresh({ quiet: true });
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('overleafComments.baseUrl') || e.affectsConfiguration('overleafComments.projectId')) {
        void sync.reset().then(() => sync.refresh({ quiet: true })); // new host / project: start over
      }
    }),
    vscode.workspace.onDidChangeTextDocument(e => threads.onTextChange(e)),
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.kind === vscode.TextEditorSelectionChangeKind.Mouse) threads.collapseOutside(e.textEditor.document.uri, e.selections[0]);
    }),
    command('reply', (r: Reply) => writes.onReply(r)),
    command('resolve', (t: vscode.CommentThread) => { const e = threads.entries.find(x => x.thread === t); return e && writes.track(writes.setResolved(e.comment.threadId, true)); }),
    command('close', (t: vscode.CommentThread) => { t.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed; }),
    command('treeReveal', (n: Node) => { const c = commentOf(n); return c && reveal(threads, c); }),
    command('treeReply', (n: Node) => { const c = commentOf(n); const e = c && threads.byId(c.threadId); return e && focusReply(e); }),
    command('treeResolve', (n: Node) => { const c = commentOf(n); return c && writes.track(writes.setResolved(c.threadId, true)); }),
    command('treeReopen', (n: Node) => { const c = commentOf(n); return c && writes.track(writes.setResolved(c.threadId, false)); }),
    command('hoverReply', onThread(focusReply)),
    command('hoverResolve', (id: string) => writes.track(writes.setResolved(id, true))),
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
  void sync.refresh({ quiet: true }); // quiet: this runs in every git repo, most of which are not Overleaf projects

  if (ctx.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    render: async (_root, comments) => { model.reset(); model.applyFetch(model.nextTicket(), comments); await threads.render(); }, // reset: no intent from an earlier step may leak in
    seedCacheAndRefresh: async (comments, fetch) => {
      model.reset(); // as if the window had just been opened
      sync.statusItem.text = '';
      const { id } = await session.needProject();
      await ctx.workspaceState.update(CACHE_KEY, serializeCache(id, comments, Date.now()));
      await sync.refresh({ fetch });
    },
    storeCookie: v => Promise.resolve(ctx.secrets.store(COOKIE_KEY, v)),
    idle: writes.drain,
    setPrompts: p => { writes.prompts = p; },
    useClient: c => { session.injected = c; },
    clickAt: (uri, selection) => threads.collapseOutside(uri, selection),
    newThread: (uri, at) => threads.controller.createCommentThread(uri, at, []),
    thread: i => threads.entries[i].thread,
    tree: () => tree.getChildren().map(f => (f.kind === 'file' ? { file: f.path, threads: f.comments.map(c => `${c.resolved ? '[resolved] ' : ''}${firstText(c)}`) } : { file: '', threads: [] })),
    status: () => sync.statusItem.text,
    threads: () => threads.entries.map(e => ({ uri: e.thread.uri.toString(), threadId: e.comment.threadId, line: e.thread.range.start.line, label: e.thread.label, messages: e.thread.comments.length })),
  };
}

export function deactivate() {
  return drain(); // let in-flight sends finish before the window closes
}
