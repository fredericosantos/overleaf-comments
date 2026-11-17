// Runs INSIDE the VS Code extension host (see test/host/run.ts, OLC_SUITE=multi): one workspace folder that holds two
// Overleaf clones (paper-a, paper-b) and a folder that is not one. The comments shown follow the file being edited.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { ProjectComment } from '@aloth/olcli';
import type { ExtensionApi } from '../../src/extension.ts';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const comment = (id: string, selectedText: string, position: number): ProjectComment => ({
  threadId: id, docId: id, path: 'main.tex', position, line: 0, column: 0,
  selectedText, resolved: false, messages: [{ id, content: `note ${id}`, user: { name: 'Tester' } }],
});

export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0].uri;
  const ext = vscode.extensions.getExtension<ExtensionApi>('fsx.overleaf-comments')!;
  const api = (await ext.activate())!;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const until = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await sleep(50);
    assert.ok(ok(), `timed out: ${what}`);
  };
  const a = vscode.Uri.joinPath(ws, 'paper-a/main.tex');
  const b = vscode.Uri.joinPath(ws, 'paper-b/main.tex');
  const fetched: string[] = [];
  const added: unknown[][] = [];
  api.useClient({
    listReview: async (id: string) => {
      fetched.push(id);
      return { comments: id === A ? [comment('ta', 'Alpha', 0)] : id === B ? [comment('tb', 'Beta', 0)] : [], changes: [] };
    },
    addComment: async (id: string, o: unknown) => {
      if (id === A) throw new Error('Selected text not found'); // paper-a: the text is not pushed yet
      added.push([id, o]);
      return comment('tn', 'Beta', 0);
    },
  } as never);
  await sleep(300); // the startup check: two clones, none in use yet, so nothing is chosen
  assert.equal(api.project(), undefined, 'a folder of several clones is not itself a project');

  // 1. a file of paper-a: its comments, from its own project id
  await vscode.window.showTextDocument(a);
  await until('paper-a in use', () => api.project() === a.fsPath.replace(/\/main\.tex$/, '') && api.threads().length === 1);
  assert.deepEqual(api.threads().map(t => [t.uri, t.threadId]), [[a.toString(), 'ta']]);
  assert.deepEqual(api.tree(), [{ file: 'main.tex', threads: ['note ta'] }], 'paths are relative to the clone, as Overleaf has them');
  assert.ok(fetched.includes(A));
  assert.match(api.status(), /Overleaf \(paper-a\)/);
  // ... and a comment on text paper-a's Overleaf does not have yet: kept as not synced
  const docA = await vscode.workspace.openTextDocument(a);
  const tA = api.newThread(a, new vscode.Range(docA.positionAt(0), docA.positionAt(5)));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: tA, text: 'waits for a push' });
  await api.idle();
  assert.equal(api.unsynced(), 1);

  // 2. a file of paper-b: paper-a's threads go, paper-b's come
  await vscode.window.showTextDocument(b);
  await until('paper-b in use', () => api.threads().some(t => t.threadId === 'tb'));
  assert.deepEqual(api.threads().map(t => [t.uri, t.threadId]), [[b.toString(), 'tb']]);
  assert.ok(fetched.includes(B));
  assert.equal(api.unsynced(), 0, "paper-a's not-synced comment is put away, not sent to paper-b");

  // 3. a new comment goes to paper-b, with its path inside paper-b
  const doc = await vscode.workspace.openTextDocument(b);
  const at = doc.getText().indexOf('Beta');
  const t = api.newThread(b, new vscode.Range(doc.positionAt(at), doc.positionAt(at + 4)));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: t, text: 'new one' });
  await api.idle();
  assert.equal(added.length, 1);
  assert.equal(added[0][0], B);
  assert.equal((added[0][1] as { filePath: string }).filePath, 'main.tex');

  // 4. a file outside any Overleaf clone: the project in use stays
  await vscode.window.showTextDocument(vscode.Uri.joinPath(ws, 'notes/todo.tex'));
  await sleep(300);
  assert.equal(api.project(), b.fsPath.replace(/\/main\.tex$/, ''));

  // 5. back to paper-a
  await vscode.window.showTextDocument(a);
  await until('paper-a again', () => api.threads().some(x => x.threadId === 'ta'));
  assert.ok(!api.threads().some(x => x.threadId === 'tb'));
  await until("paper-a's not-synced comment is back", () => api.unsynced() === 1);
  assert.equal(added.length, 1, 'nothing of paper-a was sent to paper-b');
}
