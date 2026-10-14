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
execFileSync('git', ['init', '-q'], { cwd: ws }); // activation event: workspaceContains:.git

await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, live ? 'dist/host-live.cjs' : 'dist/host-suite.cjs'),
  launchArgs: [ws, '--disable-extensions', '--user-data-dir', mkdtempSync(join(tmpdir(), 'olc-ud-'))],
});
