import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OverleafClient, type ProjectComment, type CommentMessage } from '@aloth/olcli';
import { locate } from './anchor.ts';
import { projectIdFromRemote } from './project.ts';

const COOKIE_KEY = 'overleafComments.cookie';
const CACHE_KEY = 'overleafComments.cache';
const run = promisify(execFile);

export interface ExtensionApi {
  /** Test seam: render fixture comments without touching the network. */
  render(root: vscode.Uri, comments: ProjectComment[]): Promise<void>;
  /** Test seam: put comments in the cache, then refresh (fetch=false renders the cache only). */
  seedCacheAndRefresh(comments: ProjectComment[], fetch: boolean): Promise<void>;
  threads(): { uri: string; line: number; label?: string; resolved: boolean; messages: number }[];
}

export function activate(ctx: vscode.ExtensionContext): ExtensionApi {
  const controller = vscode.comments.createCommentController('overleaf', 'Overleaf');
  const output = vscode.window.createOutputChannel('Overleaf Comments');
  // Each thread remembers its comment and last known offset so edits can re-anchor it.
  let threads: { thread: vscode.CommentThread; comment: ProjectComment; pos: number }[] = [];
  let client: OverleafClient | undefined;

  const cfg = () => vscode.workspace.getConfiguration('overleafComments');

  async function projectId(root: string): Promise<string | undefined> {
    const manual = cfg().get<string>('projectId');
    if (manual) return manual;
    const { stdout } = await run('git', ['remote', '-v'], { cwd: root });
    return stdout.split('\n').map(projectIdFromRemote).find(Boolean);
  }

  async function getClient(): Promise<OverleafClient> {
    if (client) return client;
    const cookie = await ctx.secrets.get(COOKIE_KEY);
    if (!cookie) throw new Error('No session cookie. Run "Overleaf Comments: Set Session Cookie".');
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
      thread.canReply = false;
      thread.state = c.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      thread.label = a.found ? undefined : 'Anchor lost (text edited locally)';
      threads.push({ thread, comment: c, pos: a.start });
    }
  }

  let lastFetch = 0;
  async function refresh(fetch = true) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const cached = ctx.workspaceState.get<ProjectComment[]>(CACHE_KEY);
    if (cached) await render(folder.uri, cached);
    if (!fetch) return;
    try {
      const id = await projectId(folder.uri.fsPath);
      if (!id) throw new Error('No Overleaf git remote found; set overleafComments.projectId.');
      const status = cfg().get<boolean>('showResolved') ? 'all' : 'open';
      const comments = await (await getClient()).listComments(id, { status });
      await ctx.workspaceState.update(CACHE_KEY, comments);
      lastFetch = Date.now();
      await render(folder.uri, comments);
    } catch (e) {
      client = undefined; // cookie may have expired; rebuild next time
      output.appendLine(String(e));
      void vscode.window.showErrorMessage(`Overleaf Comments: ${e instanceof Error ? e.message : e}`);
    }
  }

  ctx.subscriptions.push(
    controller,
    output,
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
    vscode.commands.registerCommand('overleafComments.refresh', () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Overleaf comments' }, () => refresh())),
    vscode.commands.registerCommand('overleafComments.clearCookie', async () => {
      await ctx.secrets.delete(COOKIE_KEY);
      await ctx.workspaceState.update(CACHE_KEY, undefined);
      client = undefined;
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
    seedCacheAndRefresh: async (comments, fetch) => {
      await ctx.workspaceState.update(CACHE_KEY, comments);
      await refresh(fetch);
    },
    threads: () => threads.map(t => ({
      uri: t.thread.uri.toString(),
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
