// Runs INSIDE the VS Code extension host (see test/host/run.ts).
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  {
    // click opens the thread: inside the range, or on its gutter (whole line); a dragged partial selection does not
    const th = api.thread(0);
    const r0 = th.range;
    const inside = new vscode.Position(r0.start.line, r0.start.character + 2);
    th.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    assert.equal(await api.click(uri, new vscode.Selection(inside, new vscode.Position(inside.line, inside.character + 3))), false);
    assert.equal(await api.click(uri, new vscode.Selection(inside, inside)), true);
    assert.equal(th.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    th.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    assert.equal(await api.click(uri, new vscode.Selection(r0.start.line, 0, r0.start.line + 1, 0)), true);
    th.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    assert.equal(await api.click(uri, new vscode.Selection(0, 0, 0, 0)), false);
  }
  {
    // click opens the thread: inside the range, or on its gutter (whole line); a dragged partial selection does not
    const th = api.thread(0);
    const r0 = th.range;
    const inside = new vscode.Position(r0.start.line, r0.start.character + 2);
    th.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    assert.equal(await api.click(uri, new vscode.Selection(inside, new vscode.Position(inside.line, inside.character + 3))), false);
    assert.equal(await api.click(uri, new vscode.Selection(inside, inside)), true);
    assert.equal(th.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    th.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    assert.equal(await api.click(uri, new vscode.Selection(r0.start.line, 0, r0.start.line + 1, 0)), true);
    th.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    assert.equal(await api.click(uri, new vscode.Selection(0, 0, 0, 0)), false);
  }
  const lensTitles = async () => (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)).map(l => l.command?.title);
  assert.deepEqual(await lensTitles(), []); // no CodeLens line above comments
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

  // empty selection: anchors to the clicked line's text
  const empty = api.newThread(uri, new vscode.Range(doc.positionAt(g), doc.positionAt(g)));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: empty, text: 'on the line' });
  assert.deepEqual(calls.pop(), ['add', '0123456789abcdef01234567', { filePath: 'chap/f10.tex', content: 'on the line', selectedText: 'Alpha beta gamma delta.', occurrence: 1 }]);

  // blank line: nothing to anchor to, nothing sent
  const blank = doc.getText().length;
  const nothing = api.newThread(uri, new vscode.Range(doc.positionAt(blank), doc.positionAt(blank)));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: nothing, text: 'nope' });
  assert.equal(calls.length, 0);

  // blank line in the middle of the file: anchored to its line break
  const ins = new vscode.WorkspaceEdit();
  ins.insert(uri, new vscode.Position(1, 0), '\n');
  await vscode.workspace.applyEdit(ins);
  const nl = doc.offsetAt(new vscode.Position(1, 0));
  assert.equal(doc.lineAt(1).text, '');
  const blankMid = api.newThread(uri, new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: blankMid, text: 'on a blank line' });
  assert.deepEqual(calls.pop(), ['add', '0123456789abcdef01234567', { filePath: 'chap/f10.tex', content: 'on a blank line', selectedText: '\n', occurrence: doc.getText().slice(0, nl).split('\n').length }]);

  // text that is not on Overleaf yet: decline -> nothing pushed, no extra add; accept -> commit, push, retry add
  const git = (...a: string[]) => execFileSync('git', a, { cwd: process.env.OLC_TEST_WS }).toString().trim();
  const bare = (...a: string[]) => execFileSync('git', ['--git-dir', process.env.OLC_TEST_REMOTE!, ...a]).toString().trim();
  let attempts = 0;
  api.useClient({
    listComments: async () => [],
    addComment: async (id: string, o: unknown) => {
      attempts++;
      if (attempts <= 2) throw new Error('Selected text not found in chap/f10.tex'); // attempt 1: decline path, attempt 2: first try of the accept path
      calls.push(['add', id, o]);
      return { ...comment('T9', 'x', 0) };
    },
    postCommentMessage: async () => null, resolveComment: async () => comment('T', 'x', 0), reopenComment: async () => comment('T', 'x', 0),
  } as never);
  const edit2 = new vscode.WorkspaceEdit();
  edit2.insert(uri, doc.positionAt(doc.getText().length), 'brand new local text\n');
  await vscode.workspace.applyEdit(edit2);
  const at2 = doc.getText().indexOf('brand new local text');
  const rng = () => new vscode.Range(doc.positionAt(at2), doc.positionAt(at2 + 'brand new local text'.length));

  api.setPrompts({ confirmPush: async () => false, commitMessage: async d => d });
  await vscode.commands.executeCommand('overleafComments.reply', { thread: api.newThread(uri, rng()), text: 'declined' });
  assert.equal(calls.length, 0);
  assert.throws(() => bare('log', '--oneline'), 'nothing may be pushed when the user declines');

  api.setPrompts({ confirmPush: async () => true, commitMessage: async d => `${d} (test)` });
  await vscode.commands.executeCommand('overleafComments.reply', { thread: api.newThread(uri, rng()), text: 'accepted' });
  assert.equal(calls.length, 1, 'comment added after the push');
  assert.match(git('log', '--format=%s', '-1'), /^Update chap\/f10\.tex \(test\)$/);
  assert.equal(bare('log', '--format=%s', '-1'), git('log', '--format=%s', '-1'), 'remote has the commit');
  assert.equal(doc.isDirty, false, 'file saved before committing');
}
