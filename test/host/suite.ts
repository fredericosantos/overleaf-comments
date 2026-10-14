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
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  // Settings first: changing them makes the extension reload, so let that finish before any step runs.
  const conf = vscode.workspace.getConfiguration('overleafComments');
  await conf.update('projectId', '0123456789abcdef01234567', vscode.ConfigurationTarget.Global);
  await conf.update('baseUrl', 'http://127.0.0.1:9', vscode.ConfigurationTarget.Global); // unreachable on purpose (step 6)
  await sleep(500);
  const uri = vscode.Uri.joinPath(root, 'chap/f10.tex');
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const quick = text.indexOf('quick brown');
  const gamma = text.indexOf('gamma delta');
  const mine = () => api.threads().filter(t => t.uri === uri.toString());

  // 1. render: open threads on the right lines, replies kept, none dropped or duplicated; a resolved comment only in the sidebar
  const finalAt = text.indexOf('Final');
  const seed1 = () => api.render(root, [comment('a', 'quick brown', quick), comment('b', 'gamma delta', gamma), comment('r', 'Final', finalAt, true)]);
  await seed1();
  await seed1(); // a second render must update in place, not add
  assert.deepEqual(mine().map(t => [t.line, t.messages]), [[1, 2], [2, 2]]);
  assert.deepEqual(api.tree(), [{ file: 'chap/f10.tex', threads: ['c1', 'c1', '[resolved] c1'] }]);

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
  await api.storeCookie('not-a-real-cookie');
  await api.seedCacheAndRefresh([comment('f', 'Final', doc.getText().indexOf('Final'))], true);
  assert.equal(api.threads().filter(t => t.uri === uri.toString()).length, 1);
  assert.match(api.status(), /cached/);

  // 7-9. write path with a fake client: reply, new comment (anchored by occurrence), resolve
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
    // a long comment is collapsed in the thread; Show more expands it; the header button expands/collapses all
    const long = { ...comment('L1', 'gamma delta', doc.getText().indexOf('gamma delta')), messages: [msg(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')), msg('short reply')] };
    await api.render(root, [long]);
    const body = (i: number) => (api.thread(0).comments[i].body as vscode.MarkdownString).value;
    assert.match(body(0), /\[Show more…\]\(command:overleafComments\.toggleMessage\?/);
    assert.ok(!body(0).includes('line 11'), 'collapsed: the tail is not shown');
    assert.ok(!body(1).includes('Show'), 'a short comment has no link');
    assert.equal(api.thread(0).contextValue, 'openLong', 'the header offers Show entire comments');
    await vscode.commands.executeCommand('overleafComments.toggleMessage', 'L1', long.messages[0].id);
    assert.match(body(0), /\[Show less\]/);
    assert.ok(body(0).includes('line 11'), 'expanded: all of it');
    await vscode.commands.executeCommand('overleafComments.toggleMessage', 'L1', long.messages[0].id);
    assert.match(body(0), /Show more…/);
    await vscode.commands.executeCommand('overleafComments.showAll', api.thread(0));
    assert.ok(body(0).includes('line 11'), 'Show entire comments expands everything');
    assert.equal(api.thread(0).contextValue, 'openLongExpanded', 'and the header now offers Collapse comments');
    await vscode.commands.executeCommand('overleafComments.collapseAll', api.thread(0));
    assert.ok(!body(0).includes('line 11'));
    assert.equal(api.thread(0).contextValue, 'openLong');
    await seed();
  }
  {
    // a tall thread is cut to the first and latest comments with a "hidden" marker; Show entire comments lifts the cut
    const many = { ...comment('M1', 'gamma delta', doc.getText().indexOf('gamma delta')), messages: Array.from({ length: 10 }, (_, i) => msg(`m${i}`)) };
    await api.render(root, [many]);
    const th = api.thread(0);
    const texts = () => th.comments.map(c => (c.body as vscode.MarkdownString).value);
    assert.ok(th.comments.length < 11 && texts().some(t => t.includes('hidden')), 'cut with a marker');
    assert.equal(texts()[0], 'm0', 'the first comment stays');
    assert.equal(texts().at(-1), 'm9', 'the latest comment stays');
    assert.equal(th.contextValue, 'openLong', 'the header offers Show entire comments');
    await vscode.commands.executeCommand('overleafComments.showAll', th);
    assert.deepEqual(texts(), Array.from({ length: 10 }, (_, i) => `m${i}`), 'everything, no marker');
    await vscode.commands.executeCommand('overleafComments.showThread', 'M1'); // the marker link toggles back
    assert.ok(texts().some(t => t.includes('hidden')));
    await seed();
  }
  {
    // a click elsewhere in the text closes an open comment; a click inside its own text leaves it open
    const th = api.thread(0);
    const r0 = th.range;
    th.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    api.clickAt(uri, new vscode.Selection(r0.start, r0.start));
    assert.equal(th.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded, 'a click inside the comment text keeps it open');
    api.clickAt(uri, new vscode.Selection(0, 0, 0, 0));
    assert.equal(th.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed, 'a click elsewhere closes it');
  }
  const lensTitles = async () => (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)).map(l => l.command?.title);
  assert.deepEqual(await lensTitles(), []); // no CodeLens line above comments
  await vscode.commands.executeCommand('overleafComments.reply', { thread: api.thread(0), text: '  hello  ' });
  await api.idle();
  assert.deepEqual(calls.pop(), ['reply', '0123456789abcdef01234567', 'T1', 'hello']);

  await seed();
  await vscode.commands.executeCommand('overleafComments.resolve', api.thread(0));
  assert.deepEqual(calls.pop(), ['resolve', '0123456789abcdef01234567', 'T1']);

  const g = doc.getText().indexOf('gamma delta');
  const fresh = api.newThread(uri, new vscode.Range(doc.positionAt(g), doc.positionAt(g + 'gamma delta'.length)));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: fresh, text: 'note' });
  await api.idle();
  assert.deepEqual(calls.pop(), ['add', '0123456789abcdef01234567', { filePath: 'chap/f10.tex', content: 'note', selectedText: 'gamma delta', occurrence: 1 }]);

  // empty selection: anchors to the clicked line's text
  const empty = api.newThread(uri, new vscode.Range(doc.positionAt(g), doc.positionAt(g)));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: empty, text: 'on the line' });
  await api.idle();
  assert.deepEqual(calls.pop(), ['add', '0123456789abcdef01234567', { filePath: 'chap/f10.tex', content: 'on the line', selectedText: 'Alpha beta gamma delta.', occurrence: 1 }]);

  // blank line: nothing to anchor to, nothing sent
  const blank = doc.getText().length;
  const nothing = api.newThread(uri, new vscode.Range(doc.positionAt(blank), doc.positionAt(blank)));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: nothing, text: 'nope' });
  await api.idle();
  assert.equal(calls.length, 0);

  // blank line in the middle of the file: anchored to its line break
  const ins = new vscode.WorkspaceEdit();
  ins.insert(uri, new vscode.Position(1, 0), '\n');
  await vscode.workspace.applyEdit(ins);
  const nl = doc.offsetAt(new vscode.Position(1, 0));
  assert.equal(doc.lineAt(1).text, '');
  const blankMid = api.newThread(uri, new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: blankMid, text: 'on a blank line' });
  await api.idle();
  assert.deepEqual(calls.pop(), ['add', '0123456789abcdef01234567', { filePath: 'chap/f10.tex', content: 'on a blank line', selectedText: '\n', occurrence: doc.getText().slice(0, nl).split('\n').length }]);

  // optimistic UI: nothing disappears while Overleaf syncs, resolve looks done at once, failures roll back
  {
    const server = { messages: [msg('c1'), msg('reply')], resolved: false };
    let fail = false;
    let gate: Promise<void> = Promise.resolve();
    let open = () => {};
    const hold = () => { gate = new Promise<void>(r => { open = r; }); };
    const at = () => doc.getText().indexOf('gamma delta');
    api.useClient({
      listComments: async () => [{ ...comment('T1', 'gamma delta', at()), messages: server.messages, resolved: server.resolved }],
      addComment: async () => { await gate; return { ...comment('T9', 'x', 0) }; },
      postCommentMessage: async (_id: string, _t: string, content: string) => { await gate; if (fail) throw new Error('boom'); server.messages = [...server.messages, msg(content)]; return null; },
      resolveComment: async () => { await gate; if (fail) throw new Error('boom'); server.resolved = true; return comment('T1', 'x', 0); },
      reopenComment: async () => { await gate; if (fail) throw new Error('boom'); server.resolved = false; return comment('T1', 'x', 0); },
    } as never);
    await api.seedCacheAndRefresh([], true);
    const t0 = api.thread(0);
    assert.equal(t0.comments.length, 2);

    hold();
    const p1 = vscode.commands.executeCommand('overleafComments.reply', { thread: t0, text: 'my reply' });
    await sleep(150);
    assert.equal(t0.comments.length, 3, 'reply shows immediately');
    assert.equal(t0.comments.at(-1)?.label, 'Syncing…');
    open(); await p1;
    await api.idle();
    assert.equal(api.thread(0), t0, 'same thread object: never torn down');
    assert.equal(t0.comments.length, 3);
    assert.equal(t0.comments.at(-1)?.label, undefined, 'synced');

    fail = true; hold();
    const p2 = vscode.commands.executeCommand('overleafComments.reply', { thread: t0, text: 'will fail' });
    await sleep(150);
    assert.equal(t0.comments.length, 4, 'optimistic while pending');
    open(); await p2;
    await api.idle();
    assert.equal(t0.comments.length, 3, 'rolled back after the failure');

    fail = false; hold();
    const inEditor = () => api.threads().filter(x => x.uri === uri.toString()).length;
    const p3 = vscode.commands.executeCommand('overleafComments.resolve', t0);
    await sleep(150);
    assert.equal(inEditor(), 0, 'a resolved comment leaves the editor at once');
    assert.match(api.tree()[0].threads[0], /^\[resolved\]/, 'and shows as resolved in the sidebar');
    open(); await p3;
    assert.equal(inEditor(), 0, 'still not in the editor once synced');
    assert.match(api.tree()[0].threads[0], /^\[resolved\]/, 'still listed as resolved in the sidebar');

    // resolve refused by Overleaf: the comment comes back
    server.resolved = false;
    await api.seedCacheAndRefresh([], true);
    assert.equal(inEditor(), 1);
    fail = true; hold();
    const p4 = vscode.commands.executeCommand('overleafComments.resolve', api.thread(0));
    await sleep(150);
    assert.equal(inEditor(), 0, 'optimistic: gone from the editor while syncing');
    open(); await p4;
    assert.equal(inEditor(), 1, 'rolled back: back in the editor after the failure');
    assert.doesNotMatch(api.tree()[0].threads[0], /^\[resolved\]/);

    fail = false; hold();
    const g2 = doc.getText().indexOf('gamma delta');
    const tmp = api.newThread(uri, new vscode.Range(doc.positionAt(g2), doc.positionAt(g2 + 'gamma delta'.length)));
    const p5 = vscode.commands.executeCommand('overleafComments.reply', { thread: tmp, text: 'a brand new one' });
    await sleep(150);
    assert.equal(tmp.comments.at(-1)?.label, 'Syncing…', 'new comment stays on screen while syncing');
    assert.equal((tmp.comments.at(-1)?.body as vscode.MarkdownString).value, 'a brand new one');
    open(); await p5;
    await api.idle();
  }

  // text that is not on Overleaf yet: no alarm, no push; the comment stays in its thread as "Not synced" until it can be added
  let attempts = 0;
  api.useClient({
    listComments: async () => [],
    addComment: async (id: string, o: unknown) => {
      attempts++;
      if (attempts <= 2) throw new Error('Selected text not found in chap/f10.tex'); // the first two tries: the text is not on Overleaf yet
      calls.push(['add', id, o]);
      return { ...comment('T9', 'x', 0) };
    },
    postCommentMessage: async () => null, resolveComment: async () => comment('T', 'x', 0), reopenComment: async () => comment('T', 'x', 0),
  } as never);
  const edit2 = new vscode.WorkspaceEdit();
  edit2.insert(uri, doc.positionAt(doc.getText().length), 'brand new local text\n');
  await vscode.workspace.applyEdit(edit2);
  const at2 = doc.getText().indexOf('brand new local text');
  const pending = api.newThread(uri, new vscode.Range(doc.positionAt(at2), doc.positionAt(at2 + 'brand new local text'.length)));
  await vscode.commands.executeCommand('overleafComments.reply', { thread: pending, text: 'waiting for the push' });
  await api.idle();
  assert.equal(calls.length, 0, 'nothing was added');
  assert.equal(pending.contextValue, 'unsynced', 'the thread offers Retry sync / Discard');
  assert.match(pending.label ?? '', /Not on Overleaf yet|not on Overleaf yet/i, 'quietly labelled, not an error');
  assert.equal(pending.comments.at(-1)?.label, 'Not synced');
  assert.equal(api.unsynced(), 1, 'drawn as not synced (dashed outline), tracked so it follows edits');
  assert.equal((pending.comments.at(-1)?.body as vscode.MarkdownString).value, 'waiting for the push', 'the text is kept');

  await vscode.commands.executeCommand('overleafComments.retrySync', pending); // attempt 2: still not there
  await api.idle();
  assert.equal(pending.contextValue, 'unsynced', 'still not synced, still offered');
  assert.equal(calls.length, 0);
  await vscode.commands.executeCommand('overleafComments.retrySync', pending); // attempt 3: Overleaf has the text now
  await api.idle();
  assert.equal(calls.length, 1, 'added once the text is on Overleaf');
  assert.equal(api.unsynced(), 0, 'no longer drawn as not synced');
  assert.deepEqual(calls[0].slice(0, 1), ['add']);

  const gone = api.newThread(uri, new vscode.Range(doc.positionAt(at2), doc.positionAt(at2 + 5)));
  attempts = 0; // fails again
  await vscode.commands.executeCommand('overleafComments.reply', { thread: gone, text: 'never mind' });
  await api.idle();
  assert.equal(gone.contextValue, 'unsynced');
  assert.equal(api.unsynced(), 1);
  await vscode.commands.executeCommand('overleafComments.discardUnsynced', gone);
  assert.equal(api.unsynced(), 0, 'discarded: nothing drawn any more');
  await vscode.commands.executeCommand('overleafComments.retrySync', gone); // a discarded thread is forgotten: nothing happens
  await api.idle();
  assert.equal(calls.length, 1);
}
