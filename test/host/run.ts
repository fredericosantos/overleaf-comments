// Launches an isolated VS Code (installed copy), loads the extension, runs test/host/suite.ts inside it.
import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
// OLC_LIVE_WS = an already-pulled Overleaf project clone: runs the opt-in live suite (real Overleaf, see live.ts).
const live = process.env.OLC_LIVE_WS;
const ws = live ?? mkdtempSync(join(tmpdir(), 'olc-ws-'));
if (!live) {
  mkdirSync(join(ws, 'chap'));
  writeFileSync(join(ws, 'chap/f10.tex'), 'Line one\nThe quick brown fox.\nAlpha beta gamma delta.\nFinal.\n');
}
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws }); // activation event: workspaceContains:.git
if (!live) {
  // a local bare remote stands in for git.overleaf.com in the commit-and-push test
  const remote = mkdtempSync(join(tmpdir(), 'olc-remote-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]);
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: ws });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws });
  // the push flow needs a branch with an upstream, like a real Overleaf clone
  execFileSync('git', ['add', '-A'], { cwd: ws });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: ws });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: ws });
  process.env.OLC_TEST_REMOTE = remote;
  delete process.env.OVERLEAF_SESSION_COOKIE; // a cookie in the caller's shell must not leak into the "no cookie" step
  process.env.OLC_TEST_WS = ws;
}

await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, live ? 'dist/host-live.cjs' : 'dist/host-suite.cjs'),
  launchArgs: [ws, '--disable-extensions', '--user-data-dir', mkdtempSync(join(tmpdir(), 'olc-ud-'))],
});
