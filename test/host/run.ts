// Launches an isolated VS Code (installed copy), loads the extension, runs test/host/suite.ts inside it.
import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
// OLC_LIVE_WS = an already-pulled Overleaf project clone: runs the opt-in live suite (real Overleaf, see live.ts).
const live = process.env.OLC_LIVE_WS;
// OLC_SUITE=multi: a folder holding two Overleaf clones and a plain folder (see multi.ts).
const multi = process.env.OLC_SUITE === 'multi';
const ws = live ?? mkdtempSync(join(tmpdir(), 'olc-ws-'));
if (multi) {
  for (const [dir, id, text] of [['paper-a', 'a', 'Alpha one.\n'], ['paper-b', 'b', 'Beta two.\n']]) {
    mkdirSync(join(ws, dir));
    writeFileSync(join(ws, dir, 'main.tex'), text);
    execFileSync('git', ['init', '-q'], { cwd: join(ws, dir) }); // activation event: workspaceContains:*/.git
    execFileSync('git', ['remote', 'add', 'origin', `https://git.overleaf.com/${id.repeat(24)}`], { cwd: join(ws, dir) });
  }
  mkdirSync(join(ws, 'notes'));
  writeFileSync(join(ws, 'notes/todo.tex'), 'Not a project.\n');
} else {
  if (!live) {
    mkdirSync(join(ws, 'chap'));
    writeFileSync(join(ws, 'chap/f10.tex'), 'Line one\nThe quick brown fox.\nAlpha beta gamma delta.\nFinal.\n');
  }
  execFileSync('git', ['init', '-q'], { cwd: ws }); // activation event: workspaceContains:.git
}
if (!live) delete process.env.OVERLEAF_SESSION_COOKIE; // a cookie in the caller's shell must not leak into the "no cookie" step

await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, live ? 'dist/host-live.cjs' : multi ? 'dist/host-multi.cjs' : 'dist/host-suite.cjs'),
  // Always pass --extensions-dir: a private --user-data-dir with the default extensions dir makes VS Code delete the user's real extensions.
  launchArgs: [ws, '--disable-extensions', '--user-data-dir', mkdtempSync(join(tmpdir(), 'olc-ud-')), '--extensions-dir', mkdtempSync(join(tmpdir(), 'olc-ext-'))],
});
