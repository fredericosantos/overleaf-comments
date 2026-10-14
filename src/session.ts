// Which Overleaf project this workspace is, and the authenticated client for it.
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OverleafClient } from '@aloth/olcli';
import { projectIdFromRemote } from './project.ts';
import { COOKIE_KEY, SetupError, cfg, setContext, workspaceRoot, type Client } from './common.ts';

const run = promisify(execFile);

export class Session {
  /** Test mode only: a fake client that replaces the real one. */
  injected: Client | undefined;
  /** undefined until the first check; false = this workspace is not an Overleaf project. */
  isOverleaf: boolean | undefined;
  private client: Client | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  markOverleaf(v: boolean): void {
    this.isOverleaf = v;
    setContext('active', v);
  }

  /** Forget the client (new cookie, new host, or it failed): the next call builds a fresh one. */
  dropClient(): void {
    this.client = undefined;
  }

  async projectId(root: string): Promise<string | undefined> {
    const manual = cfg().get<string>('projectId');
    if (manual) return manual;
    const { stdout } = await run('git', ['remote', '-v'], { cwd: root });
    return stdout.split('\n').map(projectIdFromRemote).find(Boolean);
  }

  async needProject(): Promise<{ root: vscode.Uri; id: string }> {
    const root = workspaceRoot();
    if (!root) throw new SetupError('Open the Overleaf project folder first.');
    const id = await this.projectId(root.fsPath).catch(() => undefined); // not a git repo, or no git: same answer
    if (!id) throw new SetupError('No Overleaf git remote found; set overleafComments.projectId.');
    return { root, id };
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
