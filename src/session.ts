// Which Overleaf project this workspace is (or, with several git repositories in it, which one is in use), and the
// authenticated client for it.
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OverleafClient } from '@aloth/olcli';
import { projectIdFromRemote } from './project.ts';
import { COOKIE_KEY, SetupError, cfg, setContext, setProjectRoot, workspaceRoot, type Client } from './common.ts';

const run = promisify(execFile);
/** The project used last in this workspace: opened again first when the window is reopened. */
const LAST_KEY = 'overleafComments.lastProject';

/** An Overleaf project on disk: the folder of its git clone and its Overleaf id. */
export interface Project { root: vscode.Uri; id: string }
export const sameProject = (a: Project | undefined, b: Project | undefined) => !!a && !!b && a.id === b.id && a.root.toString() === b.root.toString();

export class Session {
  /** Test mode only: a fake client that replaces the real one. */
  injected: Client | undefined;
  /** undefined until the first check; false = this workspace is not an Overleaf project. */
  isOverleaf: boolean | undefined;
  private client: Client | undefined;
  private project: Project | undefined;
  /** Folder -> the Overleaf project whose git clone it is in (or undefined): one git call per folder. */
  private readonly lookups = new Map<string, Promise<Project | undefined>>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  markOverleaf(v: boolean): void {
    this.isOverleaf = v;
    setContext('active', v);
  }

  /** Forget the client (new cookie, new host, or it failed): the next call builds a fresh one. */
  dropClient(): void {
    this.client = undefined;
  }

  get current(): Project | undefined {
    return this.project;
  }

  /** Make `p` the project in use (comments, writes and the sidebar all follow it). */
  use(p: Project): void {
    this.project = p;
    setProjectRoot(p.root);
    void this.ctx.workspaceState.update(LAST_KEY, p.root.fsPath);
  }

  /** Forget which project is in use and what was found where (the projectId setting changed). */
  forget(): void {
    this.project = undefined;
    setProjectRoot(undefined);
    this.lookups.clear();
  }

  /** The project's name when the workspace holds more than this one project (shown in the sidebar and status bar). */
  label(): string | undefined {
    const root = this.project?.root;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!root || (folders.length === 1 && folders[0].uri.toString() === root.toString())) return undefined;
    return basename(root.fsPath);
  }

  async projectId(root: string): Promise<string | undefined> {
    const manual = cfg().get<string>('projectId');
    return manual || this.remoteId(root);
  }

  /** The Overleaf project a file belongs to: the git clone it is in, if that clone's remote is Overleaf's git bridge. */
  projectOf(uri: vscode.Uri): Promise<Project | undefined> {
    return uri.scheme === 'file' ? this.lookup(dirname(uri.fsPath)) : Promise.resolve(undefined);
  }

  private lookup(dir: string): Promise<Project | undefined> {
    let found = this.lookups.get(dir);
    if (!found) {
      found = this.repoAt(dir).catch(() => undefined); // not in a git repo, or no git: not a project
      this.lookups.set(dir, found);
    }
    return found;
  }

  private async repoAt(dir: string): Promise<Project | undefined> {
    // --show-cdup, not --show-toplevel: the root keeps the path the editor uses (a symlinked folder stays symlinked).
    const { stdout } = await run('git', ['rev-parse', '--show-cdup'], { cwd: dir });
    const top = resolve(dir, stdout.trim() || '.');
    // The projectId setting names the project of the workspace folder (as it always has), not of every repo in it.
    const id = top === workspaceRoot()?.fsPath ? await this.projectId(top) : await this.remoteId(top);
    return id ? { root: vscode.Uri.file(top), id } : undefined;
  }

  private async remoteId(root: string): Promise<string | undefined> {
    const { stdout } = await run('git', ['remote', '-v'], { cwd: root });
    return stdout.split('\n').map(projectIdFromRemote).find(Boolean);
  }

  /** Every Overleaf project in the workspace: the workspace folders and their direct subfolders that are git clones. */
  async discover(): Promise<Project[]> {
    const dirs: string[] = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') continue;
      dirs.push(f.uri.fsPath);
      const kids = await Promise.resolve(vscode.workspace.fs.readDirectory(f.uri)).catch(() => []);
      for (const [name, type] of kids) if (type & vscode.FileType.Directory) dirs.push(join(f.uri.fsPath, name));
    }
    const isRepo = (d: string) => Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(join(d, '.git')))).then(() => true, () => false);
    const found = await Promise.all(dirs.map(async d => ((await isRepo(d)) ? this.lookup(d) : undefined)));
    const seen = new Set<string>();
    return found.filter((p): p is Project => !!p && !seen.has(p.root.toString()) && !!seen.add(p.root.toString()));
  }

  /** At startup: the project of the file in the editor, else the one used last, else the workspace folder (a clone of
   * one project, or projectId set by hand), else the only Overleaf clone in the workspace. */
  private async guess(): Promise<Project | undefined> {
    const editor = vscode.window.activeTextEditor;
    const fromEditor = editor && (await this.projectOf(editor.document.uri));
    if (fromEditor) return fromEditor;
    const last = this.ctx.workspaceState.get<string>(LAST_KEY);
    const fromLast = last && (await this.lookup(last));
    if (fromLast && fromLast.root.fsPath === last) return fromLast;
    const root = workspaceRoot();
    if (!root) return undefined;
    const id = await this.projectId(root.fsPath).catch(() => undefined); // not a git repo, or no git: same answer
    if (id) return { root, id };
    const all = await this.discover();
    return all.length === 1 ? all[0] : undefined;
  }

  async needProject(): Promise<Project> {
    if (!this.project) {
      const p = await this.guess();
      if (p && !this.project) this.use(p); // a switch that landed meanwhile wins
    }
    if (!this.project) {
      if (!workspaceRoot()) throw new SetupError('Open the Overleaf project folder first.');
      throw new SetupError('No Overleaf git remote found; open a file of an Overleaf project, or set overleafComments.projectId.');
    }
    return this.project;
  }

  async getClient(): Promise<Client> {
    if (this.injected) return this.injected;
    if (this.client) return this.client;
    // The stored cookie wins; OVERLEAF_SESSION_COOKIE (like olcli's OVERLEAF_EMAIL/PASSWORD) is for headless/dev launches.
    const cookie = (await this.ctx.secrets.get(COOKIE_KEY)) || process.env.OVERLEAF_SESSION_COOKIE;
    setContext('hasCookie', !!cookie);
    if (!cookie) throw new SetupError('No session cookie. Run "Overleaf Comments: Set Session Cookie".', true);
    this.client = await OverleafClient.fromSessionCookie(cookie, cfg().get<string>('baseUrl'));
    return this.client;
  }
}
