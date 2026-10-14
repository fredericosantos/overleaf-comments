import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OverleafClient, type ProjectComment, type CommentMessage } from '@aloth/olcli';
import { locate } from './anchor.ts';
import { projectIdFromRemote } from './project.ts';

const COOKIE_KEY = 'overleafComments.cookie';
const CACHE_KEY = 'overleafComments.cache';
const run = promisify(execFile);

export function activate(ctx: vscode.ExtensionContext) {
  const controller = vscode.comments.createCommentController('overleaf', 'Overleaf');
  const output = vscode.window.createOutputChannel('Overleaf Comments');
  let threads: vscode.CommentThread[] = [];
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

  function render(root: vscode.Uri, comments: ProjectComment[]) {
    threads.forEach(t => t.dispose());
    threads = [];
    for (const c of comments) {
      const uri = vscode.Uri.joinPath(root, c.path.replace(/^\/+/, ''));
      // openTextDocument is cheap for already-open docs; unopened files are read from disk.
      void vscode.workspace.openTextDocument(uri).then(doc => {
        const a = locate(doc.getText(), c.position, c.selectedText);
        const range = new vscode.Range(doc.positionAt(a.start), doc.positionAt(a.end));
        const thread = controller.createCommentThread(uri, range, c.messages.map(m => toComment(m, a.found)));
        thread.canReply = false;
        thread.state = c.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
        thread.label = a.found ? undefined : 'Anchor lost (text edited locally)';
        threads.push(thread);
      }, err => output.appendLine(`skip ${c.path}: ${err}`));
    }
  }

  async function refresh(fetch = true) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const cached = ctx.workspaceState.get<ProjectComment[]>(CACHE_KEY);
    if (cached) render(folder.uri, cached);
    if (!fetch) return;
    try {
      const id = await projectId(folder.uri.fsPath);
      if (!id) throw new Error('No Overleaf git remote found; set overleafComments.projectId.');
      const status = cfg().get<boolean>('showResolved') ? 'all' : 'open';
      const comments = await (await getClient()).listComments(id, { status });
      await ctx.workspaceState.update(CACHE_KEY, comments);
      render(folder.uri, comments);
    } catch (e) {
      client = undefined; // cookie may have expired; rebuild next time
      output.appendLine(String(e));
      void vscode.window.showErrorMessage(`Overleaf Comments: ${e instanceof Error ? e.message : e}`);
    }
  }

  ctx.subscriptions.push(
    controller,
    output,
    vscode.commands.registerCommand('overleafComments.refresh', () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Overleaf comments' }, () => refresh())),
    vscode.commands.registerCommand('overleafComments.clearCookie', async () => {
      await ctx.secrets.delete(COOKIE_KEY);
      await ctx.workspaceState.update(CACHE_KEY, undefined);
      client = undefined;
      threads.forEach(t => t.dispose());
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
