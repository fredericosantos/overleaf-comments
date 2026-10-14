// `npm run dev`: open a throwaway VS Code (own profile in .test-profile) with this extension loaded,
// on a pulled copy of the scratch Overleaf project (.test-ws). Both are gitignored.
// The cookie comes from olcli's stored session and is passed via the environment only.
import { getSessionCookie } from '@aloth/olcli';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ws = `${root}/.test-ws`;
const project = process.env.OLC_PROJECT ?? 'olcli-comments-bench';
const projectId = process.env.OLC_PROJECT_ID ?? '6acf64d6fe2f2fd26f343c60';

if (!existsSync(ws)) {
  execFileSync('olcli', ['pull', project, ws], { stdio: 'inherit' });
  execFileSync('git', ['init', '-q'], { cwd: ws });
  execFileSync('git', ['remote', 'add', 'origin', `https://git.overleaf.com/${projectId}`], { cwd: ws });
}
spawn('code', ['--new-window', '--disable-extensions', '--user-data-dir', `${root}/.test-profile`,
  `--extensionDevelopmentPath=${root}`, ws, `${ws}/chap/f1.tex`], {
  detached: true, stdio: 'ignore', env: { ...process.env, OVERLEAF_SESSION_COOKIE: getSessionCookie() },
}).unref();
