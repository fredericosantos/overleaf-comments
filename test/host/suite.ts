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

  // 7-9. write path with a fake client: reply, new comment (anchored by occurrence), resolve
  await vscode.workspace.getConfiguration('overleafComments').update('projectId', '0123456789abcdef01234567', vscode.ConfigurationTarget.Global);
  const calls: unknown[][] = [];
  api.useClient({
    listComments: async () => [],
    addComment: async (id: string, o: unknown) => { calls.push(['add', id, o]); return { ...comment('T9', 'x', 0) }; },
    postCommentMessage: async (id: string, t: string, c: string) => { calls.push(['reply', id, t, c]); return null; },
    resolveComment: async (id: string, t: string) => { calls.push(['resolve', id, t]); return comment(t, 'x', 0); },
    reopenComment: async (id: string, t: string) => { calls.push(['reopen', id, t]); return comment(t, 'x', 0); },
  } as never);
  const seed = () => api.render(root, [{ ...comment('T1', 'gamma delta', doc.getText().indexOf('gamma delta')) }]);

  await seed();
  assert.deepEqual(api.tree(), [{ file: 'chap/f10.tex', threads: ['c1'] }]); // sidebar tree mirrors the thread
  await vscode.commands.executeCommand('overleafComments.reply', { thread: api.thread(0), text: '  hello  ' });
  assert.deepEqual(calls.pop(), ['reply', '0123456789abcdef01234567', 'T1', 'hello']);

  await seed();
  await vscode.commands.executeCommand('overleafComments.resolve', api.thread(0));
  assert.deepEqual(calls.pop(), ['resolve', '0123456789abcdef01234567', 'T1']);
  await seed();
  await vscode.commands.executeCommand('overleafComments.reopen', api.thread(0));
  assert.deepEqual(calls.pop(), ['reopen', '0123456789abcdef01234567', 'T1']);

  const g = doc.getText().indexOf('gamma delta');
  const fresh = api.newThread(uri, new vscode.Range(doc.positionAt(g), doc.positionAt(g + 'gamma delta'.length)));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: fresh, text: 'note' });
  assert.deepEqual(calls.pop(), ['add', '0123456789abcdef01234567', { filePath: 'chap/f10.tex', content: 'note', selectedText: 'gamma delta', occurrence: 1 }]);

  // empty selection: refused, nothing sent
  const empty = api.newThread(uri, new vscode.Range(doc.positionAt(g), doc.positionAt(g)));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: empty, text: 'nope' });
  assert.equal(calls.length, 0);
}
