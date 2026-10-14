// Commit one file and push it, with the safety checks a push to Overleaf needs. No vscode import.
import { execFile } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (args: string[], cwd: string) => Promise<ExecResult>;

const PUSH_TIMEOUT_MS = 60_000;

/** Runs git without ever prompting for credentials (a prompt would hang the extension) and with a timeout. */
export const gitExec: Exec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: PUSH_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err); // spawn failure / timeout
      resolve({ code: err ? (err as { code: number }).code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

async function must(exec: Exec, cwd: string, args: string[]): Promise<ExecResult> {
  const r = await exec(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return r;
}

/**
 * Commit `file` (only that path; other staged files are left alone) if it has changes, then push the current branch
 * to its configured upstream. Refuses a detached HEAD and a branch without an upstream instead of guessing where to push.
 */
export async function pushFile(opts: { cwd: string; file: string; message: string; exec?: Exec }): Promise<void> {
  const { cwd, file, message } = opts;
  const exec = opts.exec ?? gitExec;
  const branch = (await must(exec, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (branch === 'HEAD') throw new Error('git is on a detached HEAD: check out a branch first.');
  const upstream = await exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
  if (upstream.code !== 0) throw new Error(`branch "${branch}" has no upstream: run "git push -u origin ${branch}" once, then try again.`);
  await must(exec, cwd, ['add', '--', file]);
  const diff = await exec(['diff', '--cached', '--quiet', '--', file], cwd);
  if (diff.code > 1) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  if (diff.code === 1) await must(exec, cwd, ['commit', '-m', message, '--', file]);
  await must(exec, cwd, ['push']);
}
