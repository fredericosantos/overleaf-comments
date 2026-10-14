import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OverleafClient, type ProjectComment, type CommentMessage } from '@aloth/olcli';
import { locate, occurrenceAt } from './anchor.ts';
import { projectIdFromRemote } from './project.ts';

const COOKIE_KEY = 'overleafComments.cookie';
const CACHE_KEY = 'overleafComments.cache';
const CACHE_AT_KEY = 'overleafComments.cacheAt';
const run = promisify(execFile);

/** User-fixable setup problems (no cookie / no remote): reported, but not counted as a fetch attempt. */
class SetupError extends Error {}

export interface ExtensionApi {
  /** Test seam: render fixture comments without touching the network. */
  render(root: vscode.Uri, comments: ProjectComment[]): Promise<void>;
  /** Test seam: put comments in the cache, then refresh (fetch=false renders the cache only). */
  seedCacheAndRefresh(comments: ProjectComment[], fetch: boolean): Promise<void>;
  /** Test seam: store a cookie as the Set Session Cookie command would. */
  storeCookie(value: string): Promise<void>;
  /** Test seam: replace the Overleaf client (no network). */
  useClient(c: Pick<OverleafClient, 'listComments' | 'addComment' | 'postCommentMessage' | 'resolveComment' | 'reopenComment'>): void;
  /** Test seam: create a thread the way the UI's "+" does (not yet known to Overleaf). */
  newThread(uri: vscode.Uri, range: vscode.Range): vscode.CommentThread;
  thread(i: number): vscode.CommentThread;
  status(): string;
  threads(): { uri: string; threadId: string; line: number; label?: string; resolved: boolean; messages: number }[];
}

export function activate(ctx: vscode.ExtensionContext): ExtensionApi {
  const controller = vscode.comments.createCommentController('overleaf', 'Overleaf');
  const output = vscode.window.createOutputChannel('Overleaf Comments');
  // Each thread remembers its comment and last known offset so edits can re-anchor it.
  let threads: { thread: vscode.CommentThread; comment: ProjectComment; pos: number }[] = [];
  let client: Pick<OverleafClient, 'listComments' | 'addComment' | 'postCommentMessage' | 'resolveComment' | 'reopenComment'> | undefined;
  const isTex = (doc: vscode.TextDocument) => doc.uri.scheme === 'file' && /\.tex$/i.test(doc.uri.fsPath);
  controller.commentingRangeProvider = {
    provideCommentingRanges: doc => (isTex(doc) && doc.lineCount ? [new vscode.Range(0, 0, doc.lineCount - 1, 0)] : []),
  };

  const cfg = () => vscode.workspace.getConfiguration('overleafComments');

  async function projectId(root: string): Promise<string | undefined> {
    const manual = cfg().get<string>('projectId');
    if (manual) return manual;
    const { stdout } = await run('git', ['remote', '-v'], { cwd: root });
    return stdout.split('\n').map(projectIdFromRemote).find(Boolean);
  }

  let injected: typeof client; // test seam: survives the error handler's `client = undefined`
  async function getClient() {
    if (injected) return injected;
    if (client) return client;
    const cookie = await ctx.secrets.get(COOKIE_KEY);
    if (!cookie) throw new SetupError('No session cookie. Run "Overleaf Comments: Set Session Cookie".');
    client = await OverleafClient.fromSessionCookie(cookie, cfg().get<string>('baseUrl'));
    return client;
  }

  let renderGen = 0;
  async function render(root: vscode.Uri, comments: ProjectComment[]) {
    const gen = ++renderGen;
    // Open docs first, then swap threads in one step; a newer render supersedes this one.
    const docs = await Promise.all(comments.map(async c => {
      const uri = vscode.Uri.joinPath(root, c.path.replace(/^\/+/, ''));
      try {
        return { c, uri, doc: await vscode.workspace.openTextDocument(uri) };
      } catch (err) {
        output.appendLine(`skip ${c.path}: ${err}`);
        return undefined;
      }
    }));
    if (gen !== renderGen) return;
    const skipped = docs.filter(d => !d).length;
    if (skipped) void vscode.window.showWarningMessage(`Overleaf Comments: ${skipped} comment thread(s) hidden because their file is not in this workspace (git pull?).`);
    threads.forEach(t => t.thread.dispose());
    threads = [];
    for (const d of docs) {
      if (!d) continue;
      const { c, uri, doc } = d;
      const a = locate(doc.getText(), c.position, c.selectedText);
      const range = new vscode.Range(doc.positionAt(a.start), doc.positionAt(a.end));
      const thread = controller.createCommentThread(uri, range, c.messages.map(m => toComment(m, a.found)));
      thread.canReply = true;
      thread.contextValue = c.resolved ? 'resolved' : 'open';
      thread.state = c.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      thread.label = a.found ? undefined : 'Anchor lost (text edited locally)';
      threads.push({ thread, comment: c, pos: a.start });
    }
  }

  let lastFetch = 0;
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  const time = (ms?: number) => (ms ? new Date(ms) : new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function setStatus(synced: boolean) {
    const at = ctx.workspaceState.get<number>(CACHE_AT_KEY);
    statusItem.text = synced ? `$(comment) Overleaf synced ${time(at)}` : `$(warning) Overleaf: cached${at ? ` from ${time(at)}` : ''}`;
    statusItem.command = 'overleafComments.refresh';
    statusItem.show();
  }
  async function refresh(fetch = true) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const cached = ctx.workspaceState.get<ProjectComment[]>(CACHE_KEY);
    if (cached) await render(folder.uri, cached);
    if (!fetch) return;
    try {
      const id = await projectId(folder.uri.fsPath);
      if (!id) throw new SetupError('No Overleaf git remote found; set overleafComments.projectId.');
      const status = cfg().get<boolean>('showResolved') ? 'all' : 'open';
      const comments = await (await getClient()).listComments(id, { status });
      await ctx.workspaceState.update(CACHE_KEY, comments);
      await ctx.workspaceState.update(CACHE_AT_KEY, Date.now());
      lastFetch = Date.now();
      setStatus(true);
      await render(folder.uri, comments);
    } catch (e) {
      if (cached) setStatus(false); // stale: showing the last good fetch
      client = undefined; // cookie may have expired; rebuild next time
      // Back off after real failures (e.g. Overleaf 429): the focus refresh waits refreshMinutes before retrying.
      if (!(e instanceof SetupError)) lastFetch = Date.now();
      output.appendLine(String(e));
      void vscode.window.showErrorMessage(`Overleaf Comments: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Run a write against Overleaf for the workspace's project, then re-fetch so the UI shows the server's state. */
  async function write<T>(what: string, fn: (c: NonNullable<typeof client>, projectId: string) => Promise<T>): Promise<T | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    try {
      if (!folder) throw new SetupError('Open the Overleaf project folder first.');
      const id = await projectId(folder.uri.fsPath);
      if (!id) throw new SetupError('No Overleaf git remote found; set overleafComments.projectId.');
      const result = await fn(await getClient(), id);
      await refresh();
      return result;
    } catch (e) {
      output.appendLine(`${what}: ${e}`);
      void vscode.window.showErrorMessage(`Overleaf Comments: ${what} failed: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  async function replyOrCreate(r: vscode.CommentReply) {
    const text = r.text.trim();
    if (!text) return;
    const known = threads.find(t => t.thread === r.thread);
    if (known) {
      // Optimistic: show the reply now; refresh() replaces it with the server's copy.
      r.thread.comments = [...r.thread.comments, { author: { name: 'You' }, body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview }];
      await write('Reply', (c, id) => c.postCommentMessage(id, known.comment.threadId, text));
      return;
    }
    // New thread from the UI: anchor it to the selected text.
    const doc = await vscode.workspace.openTextDocument(r.thread.uri);
    const selected = doc.getText(r.thread.range);
    const start = doc.offsetAt(r.thread.range.start);
    const occurrence = occurrenceAt(doc.getText(), start, selected);
    r.thread.dispose();
    if (!selected.trim() || occurrence === undefined) {
      void vscode.window.showErrorMessage('Overleaf Comments: select the text to comment on first (a non-empty selection that does not overlap an identical earlier match).');
      return;
    }
    const filePath = vscode.workspace.asRelativePath(doc.uri, false);
    const added = await write('Add comment', (c, id) => c.addComment(id, { filePath, content: text, selectedText: selected, occurrence }));
    const landed = added && ctx.workspaceState.get<ProjectComment[]>(CACHE_KEY)?.find(c => c.threadId === added.threadId);
    if (added && landed && landed.selectedText !== selected) {
      void vscode.window.showWarningMessage(`Overleaf Comments: the comment attached to different text than selected ("${landed.selectedText.slice(0, 40)}"). Your local file may differ from Overleaf's copy; git pull and check.`);
    }
  }

  async function setResolved(thread: vscode.CommentThread, resolved: boolean) {
    const known = threads.find(t => t.thread === thread);
    if (!known) return;
    await write(resolved ? 'Resolve' : 'Reopen', (c, id) => (resolved ? c.resolveComment(id, known.comment.threadId) : c.reopenComment(id, known.comment.threadId)));
  }

  ctx.subscriptions.push(
    controller,
    output,
    statusItem,
    vscode.window.onDidChangeWindowState(w => {
      const mins = cfg().get<number>('refreshMinutes') ?? 0;
      if (w.focused && mins > 0 && lastFetch && Date.now() - lastFetch > mins * 60_000) void refresh();
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      const text = e.document.getText();
      for (const t of threads) {
        if (t.thread.uri.toString() !== e.document.uri.toString()) continue;
        const a = locate(text, t.pos, t.comment.selectedText);
        t.pos = a.start;
        t.thread.range = new vscode.Range(e.document.positionAt(a.start), e.document.positionAt(a.end));
        t.thread.label = a.found ? undefined : 'Anchor lost (text edited locally)';
      }
    }),
    vscode.commands.registerCommand('overleafComments.reply', replyOrCreate),
    vscode.commands.registerCommand('overleafComments.resolve', (t: vscode.CommentThread) => setResolved(t, true)),
    vscode.commands.registerCommand('overleafComments.reopen', (t: vscode.CommentThread) => setResolved(t, false)),
    vscode.commands.registerCommand('overleafComments.refresh', () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Overleaf comments' }, () => refresh())),
    vscode.commands.registerCommand('overleafComments.clearCookie', async () => {
      await ctx.secrets.delete(COOKIE_KEY);
      await ctx.workspaceState.update(CACHE_KEY, undefined);
      await ctx.workspaceState.update(CACHE_AT_KEY, undefined);
      statusItem.hide();
      client = undefined;
      lastFetch = 0; // focus-refresh only runs after a successful fetch
      threads.forEach(t => t.thread.dispose());
      threads = [];
    }),
    vscode.commands.registerCommand('overleafComments.setCookie', async () => {
      const v = await vscode.window.showInputBox({
        prompt: 'overleaf_session2 cookie value (browser devtools → cookies)',
        password: true,
        ignoreFocusOut: true,
      });
      if (!v) return;
      await ctx.secrets.store(COOKIE_KEY, v.trim());
      client = undefined;
      await refresh();
    }),
  );
  void refresh(false).then(() => refresh());
  return {
    render,
    useClient: c => { injected = c; },
    newThread: (uri, range) => controller.createCommentThread(uri, range, []),
    thread: i => threads[i].thread,
    storeCookie: v => Promise.resolve(ctx.secrets.store(COOKIE_KEY, v)),
    status: () => statusItem.text,
    seedCacheAndRefresh: async (comments, fetch) => {
      await ctx.workspaceState.update(CACHE_KEY, comments);
      await refresh(fetch);
    },
    threads: () => threads.map(t => ({
      uri: t.thread.uri.toString(),
      threadId: t.comment.threadId,
      line: t.thread.range.start.line,
      label: t.thread.label,
      resolved: t.thread.state === vscode.CommentThreadState.Resolved,
      messages: t.thread.comments.length,
    })),
  };
}

function author(m: CommentMessage): string {
  const u = m.user;
  return u?.name ?? ([u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || 'unknown');
}

function toComment(m: CommentMessage, found: boolean): vscode.Comment {
  return {
    author: { name: author(m) },
    body: new vscode.MarkdownString(m.content),
    mode: vscode.CommentMode.Preview,
    timestamp: m.timestamp ? new Date(m.timestamp) : undefined,
    label: found ? undefined : 'anchor lost',
  };
}

export function deactivate() {}
