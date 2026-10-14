import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OverleafClient, type ProjectComment, type CommentMessage } from '@aloth/olcli';
import { locate, occurrenceAt } from './anchor.ts';
import { projectIdFromRemote } from './project.ts';
import { Highlights } from './markers.ts';
import { authorOf as author } from './hover.ts';

const COOKIE_KEY = 'overleafComments.cookie';
const CACHE_KEY = 'overleafComments.cache';
const CACHE_AT_KEY = 'overleafComments.cacheAt';
const run = promisify(execFile);

/** User-fixable setup problems (no cookie / no remote): reported, but not counted as a fetch attempt. */
class SetupError extends Error {}
/** The user said no to a prompt: stop quietly, no error toast. */
class Cancelled extends Error {}

export interface Prompts {
  confirmPush(message: string, okLabel: string): Thenable<boolean>;
  commitMessage(defaultMessage: string): Thenable<string | undefined>;
}

export interface ExtensionApi {
  /** Test seam: render fixture comments without touching the network. */
  render(root: vscode.Uri, comments: ProjectComment[]): Promise<void>;
  /** Test seam: put comments in the cache, then refresh (fetch=false renders the cache only). */
  seedCacheAndRefresh(comments: ProjectComment[], fetch: boolean): Promise<void>;
  /** Test seam: store a cookie as the Set Session Cookie command would. */
  storeCookie(value: string): Promise<void>;
  /** Test seam: resolves when every background send has finished. */
  idle(): Promise<void>;
  /** Test seam: replace the confirmation/commit-message prompts of the commit-and-push flow. */
  setPrompts(p: Prompts): void;
  /** Test seam: replace the Overleaf client (no network). */
  useClient(c: Pick<OverleafClient, 'listComments' | 'addComment' | 'postCommentMessage' | 'resolveComment' | 'reopenComment'>): void;
  /** Test seam: create a thread the way the UI's "+" does (not yet known to Overleaf). */
  newThread(uri: vscode.Uri, range: vscode.Range): vscode.CommentThread;
  thread(i: number): vscode.CommentThread;
  /** Test seam: what the sidebar tree shows (file -> thread titles). */
  tree(): { file: string; threads: string[] }[];
  status(): string;
  threads(): { uri: string; threadId: string; line: number; label?: string; resolved: boolean; messages: number }[];
}

export function activate(ctx: vscode.ExtensionContext): ExtensionApi {
  const controller = vscode.comments.createCommentController('overleaf', 'Overleaf');
  const output = vscode.window.createOutputChannel('Overleaf Comments');
  // Each thread remembers its comment and last known offset so edits can re-anchor it.
  let threads: { thread: vscode.CommentThread; comment: ProjectComment; pos: number }[] = []; // editor threads: OPEN comments only
  let all: ProjectComment[] = []; // every comment (open + resolved): resolved ones live only in the sidebar
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
    // The stored cookie wins; OVERLEAF_SESSION_COOKIE (like olcli's OVERLEAF_EMAIL/PASSWORD) is for headless/dev launches.
    const cookie = (await ctx.secrets.get(COOKIE_KEY)) || process.env.OVERLEAF_SESSION_COOKIE;
    if (!cookie) throw new SetupError('No session cookie. Run "Overleaf Comments: Set Session Cookie".');
    client = await OverleafClient.fromSessionCookie(cookie, cfg().get<string>('baseUrl'));
    return client;
  }

  // Sidebar tree: files -> threads (open and resolved) -> messages. Built from `all`.
  type Node = { kind: 'file'; path: string; comments: ProjectComment[] } | { kind: 'thread'; c: ProjectComment } | { kind: 'msg'; m: CommentMessage };
  const treeChanged = new vscode.EventEmitter<void>();
  const firstText = (c: ProjectComment) => c.messages[0]?.content ?? '(no text)';
  const treeProvider: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: treeChanged.event,
    getChildren(n) {
      if (!n) {
        const byFile = new Map<string, ProjectComment[]>();
        for (const c of all) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
        return [...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([path, comments]) => ({ kind: 'file', path, comments: comments.sort((x, y) => x.position - y.position) }));
      }
      if (n.kind === 'file') return n.comments.map(c => ({ kind: 'thread', c }));
      if (n.kind === 'thread') return n.c.messages.map(m => ({ kind: 'msg', m }));
      return [];
    },
    getTreeItem(n) {
      if (n.kind === 'file') {
        const it = new vscode.TreeItem(n.path, vscode.TreeItemCollapsibleState.Expanded);
        const done = n.comments.filter(c => c.resolved).length;
        it.description = done ? `${n.comments.length - done} open · ${done} resolved` : `${n.comments.length}`;
        it.iconPath = vscode.ThemeIcon.File;
        return it;
      }
      if (n.kind === 'thread') {
        const c = n.c;
        const live = threads.find(t => t.comment.threadId === c.threadId);
        const it = new vscode.TreeItem(firstText(c).split('\n')[0].slice(0, 60), vscode.TreeItemCollapsibleState.Collapsed);
        it.description = `L${(live ? live.thread.range.start.line : c.line - 1) + 1} · ${author(c.messages[0] ?? ({} as CommentMessage))}${c.messages.length > 1 ? ` · ${c.messages.length - 1} repl${c.messages.length === 2 ? 'y' : 'ies'}` : ''}${c.resolved ? ' · resolved' : ''}`;
        it.tooltip = `${c.selectedText}\n\n${c.messages.map(m => `${author(m)}: ${m.content}`).join('\n')}`;
        it.iconPath = c.resolved ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('comment');
        it.contextValue = c.resolved ? 'resolved' : 'open';
        it.command = { command: 'overleafComments.treeReveal', title: 'Show in editor', arguments: [n] };
        return it;
      }
      const it = new vscode.TreeItem(n.m.content.split('\n')[0].slice(0, 80));
      it.description = author(n.m);
      it.tooltip = n.m.content;
      it.iconPath = new vscode.ThemeIcon('account');
      return it;
    },
  };
  const treeView = vscode.window.createTreeView('overleafComments.threads', { treeDataProvider: treeProvider });
  const commentOf = (n: Node) => (n.kind === 'thread' ? n.c : undefined);

  /** VS Code can leave a thread's gutter marker undrawn in an editor that was already open when the thread was
   * created, until the thread is touched. Re-assigning the range for a document's threads redraws them. */
  function poke(uri?: vscode.Uri) {
    for (const t of threads) {
      if (uri && t.thread.uri.toString() !== uri.toString()) continue;
      t.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      t.thread.range = new vscode.Range(t.thread.range.start, t.thread.range.end);
    }
  }

  const highlights = new Highlights(() => threads);
  ctx.subscriptions.push(highlights);

  let renderGen = 0;
  async function render(root: vscode.Uri, comments: ProjectComment[]) {
    const gen = ++renderGen;
    const model = comments;
    comments = comments.filter(c => !c.resolved); // resolved comments are not drawn in the editor
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
    all = model;
    const skipped = docs.filter(d => !d).length;
    if (skipped) void vscode.window.showWarningMessage(`Overleaf Comments: ${skipped} comment thread(s) hidden because their file is not in this workspace (git pull?).`);
    // Update existing threads in place (no tear-down), so nothing blinks and open/closed state is kept.
    const old = new Map(threads.map(t => [t.comment.threadId, t]));
    const next: typeof threads = [];
    for (const d of docs) {
      if (!d) continue;
      const { c, uri, doc } = d;
      const a = locate(doc.getText(), c.position, c.selectedText);
      const range = new vscode.Range(doc.positionAt(a.start), doc.positionAt(a.end));
      const comments = c.messages.map(m => toComment(m, a.found));
      let prev = old.get(c.threadId);
      old.delete(c.threadId);
      if (prev && prev.thread.uri.toString() !== uri.toString()) { prev.thread.dispose(); prev = undefined; }
      const thread = prev?.thread ?? controller.createCommentThread(uri, range, comments);
      if (prev) {
        // Only touch what changed: re-assigning comments would drop an optimistic "Syncing…" reply for nothing.
        if (prev.comment.messages.map(m => m.id).join() !== c.messages.map(m => m.id).join()) thread.comments = comments;
        if (!thread.range.isEqual(range)) thread.range = range;
      }
      thread.canReply = true;
      thread.contextValue = c.resolved ? 'resolved' : 'open';
      thread.state = c.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      thread.label = a.found ? undefined : 'Anchor lost (text edited locally)';
      next.push({ thread, comment: c, pos: a.start });
    }
    old.forEach(t => t.thread.dispose());
    threads = next;
    treeChanged.fire();
    for (const e of vscode.window.visibleTextEditors) poke(e.document.uri);
    highlights.apply();
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
  async function refresh(fetch = true, useCache = true) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const cached = ctx.workspaceState.get<ProjectComment[]>(CACHE_KEY);
    if (cached && useCache) await render(folder.uri, cached);
    if (!fetch) return;
    try {
      const id = await projectId(folder.uri.fsPath);
      if (!id) throw new SetupError('No Overleaf git remote found; set overleafComments.projectId.');
      const comments = await (await getClient()).listComments(id, { status: 'all' }); // resolved threads too: they show as resolved
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

  let prompts: Prompts = {
    confirmPush: (m, ok) => vscode.window.showWarningMessage(m, { modal: true }, ok).then(r => r === ok),
    commitMessage: d => vscode.window.showInputBox({ prompt: 'Commit message', value: d, ignoreFocusOut: true }),
  };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const notThere = (e: unknown) => /Selected text not found/.test(String(e));

  /** The anchor text is not in Overleaf's copy: offer to commit and push this file, then wait for Overleaf to have it. */
  async function pushFile(doc: vscode.TextDocument, cwd: string) {
    const file = vscode.workspace.asRelativePath(doc.uri, false);
    const ok = await prompts.confirmPush(`"${file}" has changes Overleaf does not have yet, so the text you selected is not there. Commit this file and push it to Overleaf, then add the comment?${doc.isDirty ? ' (Unsaved changes will be saved first.)' : ''} Other pending commits on this branch are pushed too.`, 'Commit & push');
    if (!ok) throw new Cancelled();
    const msg = await prompts.commitMessage(`Update ${file}`);
    if (!msg) throw new Cancelled();
    if (doc.isDirty) await doc.save();
    const git = (...args: string[]) => run('git', args, { cwd }).catch((e: { stderr?: string; message: string }) => { throw new Error(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`); });
    await git('add', '--', file);
    const staged = await run('git', ['diff', '--cached', '--quiet', '--', file], { cwd }).then(() => false, () => true);
    if (staged) await git('commit', '-m', msg, '--', file);
    await run('git', ['push'], { cwd }).catch(() => git('push', '-u', 'origin', 'HEAD')); // no upstream yet
    output.appendLine(`pushed ${file}`);
  }

  /** Run a write against Overleaf for the workspace's project, then re-fetch so the UI shows the server's state. */
  type Written<T> = { ok: true; value: T } | { ok: false; cancelled?: boolean };
  async function write<T>(what: string, fn: (c: NonNullable<typeof client>, projectId: string) => Promise<T>, hint = ''): Promise<Written<T>> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    try {
      if (!folder) throw new SetupError('Open the Overleaf project folder first.');
      const id = await projectId(folder.uri.fsPath);
      if (!id) throw new SetupError('No Overleaf git remote found; set overleafComments.projectId.');
      const value = await fn(await getClient(), id);
      // Straight to the server's state: rendering the (stale) cache first would undo our optimistic UI.
      await refresh(true, false);
      return { ok: true, value };
    } catch (e) {
      if (e instanceof Cancelled) return { ok: false, cancelled: true };
      output.appendLine(`${what}: ${e}`);
      void vscode.window.showErrorMessage(`Overleaf Comments: ${what} failed: ${e instanceof Error ? e.message : e}${hint}`);
      return { ok: false };
    }
  }

  /** A failed send must not lose a long comment: the reply box cannot be refilled, so offer Retry and Copy. */
  function offerFailed(text: string, retry: () => Promise<void>) {
    void vscode.window.showInformationMessage('Your comment was not sent.', 'Retry', 'Copy text').then(choice => {
      if (choice === 'Retry') track(retry());
      else if (choice === 'Copy text') void vscode.env.clipboard.writeText(text);
    });
  }

  // The reply command returns at once (VS Code clears the reply box only when it returns); the work runs here.
  const pending = new Set<Promise<unknown>>();
  function track<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  }

  const SYNCING = 'Syncing…';

  async function replyOrCreate(r: vscode.CommentReply) {
    const text = r.text.trim();
    if (!text) return;
    const known = threads.find(t => t.thread === r.thread);
    if (known) {
      // Optimistic: show the reply now, marked as syncing; the next render swaps in the server's copy.
      const before = r.thread.comments;
      r.thread.comments = [...before, { author: { name: 'You' }, body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview, label: SYNCING }];
      const res = await write('Reply', (c, id) => c.postCommentMessage(id, known.comment.threadId, text));
      if (!res.ok) {
        r.thread.comments = before;
        if (!res.cancelled) offerFailed(text, () => replyOrCreate({ thread: r.thread, text } as vscode.CommentReply));
      } else {
        // If the server list did not include it yet, keep the text but drop the "Syncing…" label.
        const last = r.thread.comments.at(-1);
        if (last?.label === SYNCING) r.thread.comments = [...r.thread.comments.slice(0, -1), { ...last, label: undefined }];
      }
      return;
    }
    // New thread from the UI: anchor it to the selected text, or to the clicked line's text if nothing is selected.
    const doc = await vscode.workspace.openTextDocument(r.thread.uri);
    let selected = doc.getText(r.thread.range);
    let start = doc.offsetAt(r.thread.range.start);
    if (!selected.trim()) {
      const l = doc.lineAt(r.thread.range.start.line);
      if (l.text.trim()) {
        selected = l.text.trim();
        start = doc.offsetAt(l.range.start) + l.firstNonWhitespaceCharacterIndex;
      } else if (doc.getText().charAt(doc.offsetAt(l.range.end)) === '\n') {
        // Blank line: anchor to its line break (Overleaf wants a non-empty range).
        selected = '\n';
        start = doc.offsetAt(l.range.end);
      } else {
        selected = '';
      }
    }
    const occurrence = occurrenceAt(doc.getText(), start, selected);
    const temp = r.thread;
    const tempUri = temp.uri;
    const tempRange = temp.range;
    if (!selected || occurrence === undefined) {
      temp.dispose();
      void vscode.window.showErrorMessage('Overleaf Comments: nothing to anchor the comment to. Select some text (or click a non-empty line) and try again.');
      return;
    }
    const filePath = vscode.workspace.asRelativePath(doc.uri, false);
    const hint = `\nAnchor text: "${selected.length > 60 ? selected.slice(0, 60) + '…' : selected}"${doc.isDirty ? ' (this file has unsaved changes; Overleaf only has the pushed version)' : ''}. If your local file differs from Overleaf, git pull/push first.`;
    const args = { filePath, content: text, selectedText: selected, occurrence };
    // Keep the thread on screen with the typed text until the real one exists (no disappear/reappear).
    temp.comments = [{ author: { name: 'You' }, body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview, label: SYNCING }];
    temp.canReply = false;
    temp.label = 'Adding comment…';
    temp.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const res = await write('Add comment', async (c, id) => {
      try {
        return await c.addComment(id, args);
      } catch (e) {
        if (!notThere(e)) throw e;
        const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
        await pushFile(doc, folder);
        // The git bridge can take a few seconds to show the push in Overleaf.
        for (let i = 0; ; i++) {
          try { return await c.addComment(id, args); } catch (e2) { if (!notThere(e2) || i >= 4) throw e2; await sleep(3000); }
        }
      }
    }, hint);
    temp.dispose(); // the real thread was created by write()'s refresh, so the swap is seamless
    if (!res.ok && !res.cancelled) offerFailed(text, () => replyOrCreate({ thread: controller.createCommentThread(tempUri, tempRange, []), text } as vscode.CommentReply));
    const added = res.ok ? res.value : undefined;
    const landed = added && ctx.workspaceState.get<ProjectComment[]>(CACHE_KEY)?.find(c => c.threadId === added.threadId);
    if (added && landed && landed.selectedText !== selected) {
      void vscode.window.showWarningMessage(`Overleaf Comments: the comment attached to different text than selected ("${landed.selectedText.slice(0, 40)}"). Your local file may differ from Overleaf's copy; git pull and check.`);
    }
  }

  const byId = (id: string) => threads.find(t => t.comment.threadId === id);
  async function revealEntry(e: (typeof threads)[number]) {
    const editor = await vscode.window.showTextDocument(e.thread.uri, { selection: e.thread.range });
    editor.revealRange(e.thread.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    e.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }
  /** Open the thread and put the cursor in its reply box, as if the comment icon had been clicked and Reply pressed.
   * VS Code has no extension API for this, but its own "Go to Next Comment Thread" does it: park the cursor just
   * before the thread so that it is the next one. */
  async function focusReply(e: (typeof threads)[number]) {
    const editor = await vscode.window.showTextDocument(e.thread.uri, { selection: e.thread.range, preserveFocus: false });
    const { start } = e.thread.range;
    const before = start.character > 0 ? start.translate(0, -1) : start.line > 0 ? editor.document.lineAt(start.line - 1).range.end : start;
    editor.selection = new vscode.Selection(before, before);
    e.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    await vscode.commands.executeCommand('editor.action.nextCommentThreadAction');
  }

  /** Resolve/reopen. Optimistic: the comment moves between the editor and the sidebar's resolved list at once;
   * if Overleaf refuses, it moves back and write() has shown the error. */
  async function setResolvedById(id: string, resolved: boolean) {
    const c = all.find(x => x.threadId === id);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!c || !folder || c.resolved === resolved) return;
    c.resolved = resolved;
    await render(folder.uri, all);
    const res = await write(resolved ? 'Resolve' : 'Reopen', (cl, pid) => (resolved ? cl.resolveComment(pid, id) : cl.reopenComment(pid, id)));
    if (!res.ok) {
      c.resolved = !resolved;
      await render(folder.uri, all);
    }
  }
  const resolveThread = (thread: vscode.CommentThread) => {
    const known = threads.find(t => t.thread === thread);
    return known ? setResolvedById(known.comment.threadId, true) : Promise.resolve();
  };

  /** A resolved comment has no editor thread: just take the user to its text. */
  async function revealResolved(c: ProjectComment) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const uri = vscode.Uri.joinPath(folder.uri, c.path.replace(/^\/+/, ''));
    const doc = await vscode.workspace.openTextDocument(uri);
    const a = locate(doc.getText(), c.position, c.selectedText);
    const range = new vscode.Range(doc.positionAt(a.start), doc.positionAt(a.end));
    const editor = await vscode.window.showTextDocument(doc, { selection: range });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  ctx.subscriptions.push(
    controller,
    treeView,
    treeChanged,
    output,
    statusItem,
    vscode.window.onDidChangeActiveTextEditor(e => e && poke(e.document.uri)),
    vscode.window.onDidChangeVisibleTextEditors(es => { es.forEach(e => poke(e.document.uri)); highlights.apply(); }),
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
      treeChanged.fire();
    }),
    vscode.commands.registerCommand('overleafComments.reply', (r: vscode.CommentReply) => { track(replyOrCreate(r)); }),
    vscode.commands.registerCommand('overleafComments.resolve', (t: vscode.CommentThread) => resolveThread(t)),
    vscode.commands.registerCommand('overleafComments.treeReveal', (n: Node) => { const c = commentOf(n); if (!c) return; const e = byId(c.threadId); return e ? revealEntry(e) : revealResolved(c); }),
    vscode.commands.registerCommand('overleafComments.treeReply', (n: Node) => { const c = commentOf(n); const e = c && byId(c.threadId); return e && focusReply(e); }),
    vscode.commands.registerCommand('overleafComments.treeResolve', (n: Node) => { const c = commentOf(n); return c && setResolvedById(c.threadId, true); }),
    vscode.commands.registerCommand('overleafComments.treeReopen', (n: Node) => { const c = commentOf(n); return c && setResolvedById(c.threadId, false); }),
    vscode.commands.registerCommand('overleafComments.close', (t: vscode.CommentThread) => { t.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed; }),
    vscode.commands.registerCommand('overleafComments.hoverReply', (id: string) => { const e = byId(id); return e && focusReply(e); }),
    vscode.commands.registerCommand('overleafComments.hoverResolve', (id: string) => setResolvedById(id, true)),
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
      all = [];
      treeChanged.fire();
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
    idle: async () => { while (pending.size) await Promise.allSettled([...pending]); },
    setPrompts: p => { prompts = p; },
    useClient: c => { injected = c; },
    newThread: (uri, range) => controller.createCommentThread(uri, range, []),
    thread: i => threads[i].thread,
    tree: () => (treeProvider.getChildren(undefined) as Node[]).map(f => f.kind === 'file' ? { file: f.path, threads: f.comments.map(c => `${c.resolved ? '[resolved] ' : ''}${firstText(c)}`) } : { file: '', threads: [] }),
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
