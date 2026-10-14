// Runs INSIDE the VS Code extension host (see test/host/run.ts).
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { ProjectComment } from '@aloth/olcli';
import type { ExtensionApi } from '../../src/extension.ts';

const msg = (content: string) => ({ id: content, content, user: { name: 'Tester' } });
const comment = (id: string, selectedText: string, position: number, resolved = false): ProjectComment => ({
  threadId: id, docId: id, path: 'chap/f10.tex', position, line: 0, column: 0,
  selectedText, resolved, messages: [msg('c1'), msg('reply')],
});

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri;
  const ext = vscode.extensions.getExtension<ExtensionApi>('fredericosantos.overleaf-comments')!;
  const api = await ext.activate();
  const uri = vscode.Uri.joinPath(root, 'chap/f10.tex');
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const quick = text.indexOf('quick brown');
  const gamma = text.indexOf('gamma delta');
  const mine = () => api.threads().filter(t => t.uri === uri.toString());

  // 1. render: threads on the right lines, replies kept, resolved state mapped, none dropped or duplicated
  await api.render(root, [comment('a', 'quick brown', quick), comment('b', 'gamma delta', gamma, true)]);
  await api.render(root, [comment('a', 'quick brown', quick), comment('b', 'gamma delta', gamma, true)]); // second render must replace, not add
  assert.deepEqual(mine().map(t => [t.line, t.resolved, t.messages]), [[1, false, 2], [2, true, 2]]);

  // 2. edit above: threads follow their text
  const top = new vscode.WorkspaceEdit();
  top.insert(uri, new vscode.Position(0, 0), 'inserted\n');
  await vscode.workspace.applyEdit(top);
  assert.deepEqual(mine().map(t => t.line), [2, 3]);
  assert.equal(mine().every(t => t.label === undefined), true);

  // 3. selected text removed: thread flagged, not dropped
  const edit = new vscode.WorkspaceEdit();
  const i = doc.getText().indexOf('quick brown');
  edit.delete(uri, new vscode.Range(doc.positionAt(i), doc.positionAt(i + 'quick brown'.length)));
  await vscode.workspace.applyEdit(edit);
  assert.equal(mine().length, 2);
  assert.match(mine()[0].label ?? '', /Anchor lost/);

  // 4. file that does not exist: skipped without throwing, others still render
  await api.render(root, [comment('c', 'x', 0), { ...comment('d', 'x', 0), path: 'nope/missing.tex' }]);
  assert.equal(api.threads().filter(t => t.uri.endsWith('missing.tex')).length, 0);

  // 5. fetch fails (no cookie in the test profile): cached comments still render
  await api.seedCacheAndRefresh([comment('e', 'Final', doc.getText().indexOf('Final'))], true);
  assert.equal(api.threads().filter(t => t.uri === uri.toString()).length, 1);
  assert.match(api.status(), /cached/); // and the user is told it is stale

  // 6. real network failure (cookie present, server unreachable): cached comments stay and are marked stale
  await vscode.workspace.getConfiguration('overleafComments').update('baseUrl', 'http://127.0.0.1:9', vscode.ConfigurationTarget.Global);
  await api.storeCookie('not-a-real-cookie');
  await api.seedCacheAndRefresh([comment('f', 'Final', doc.getText().indexOf('Final'))], true);
  assert.equal(api.threads().filter(t => t.uri === uri.toString()).length, 1);
  assert.match(api.status(), /cached/);
}
