// OPT-IN live test: drives the extension's real write handlers against a real Overleaf project.
// Needs OLC_LIVE_WS (pulled clone of a SCRATCH project), OLC_PROJECT_ID, OLC_COOKIE. Deletes what it creates.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { OverleafClient } from '@aloth/olcli';
import type { ExtensionApi } from '../../src/extension.ts';

export async function run(): Promise<void> {
  const { OLC_PROJECT_ID: id, OLC_COOKIE: cookie } = process.env;
  assert.ok(id && cookie, 'OLC_PROJECT_ID and OLC_COOKIE are required');
  const real = await OverleafClient.fromSessionCookie(cookie);
  const root = vscode.workspace.workspaceFolders![0].uri;
  const ext = vscode.extensions.getExtension<ExtensionApi>('fredericosantos.overleaf-comments')!;
  const api = await ext.activate();
  await vscode.workspace.getConfiguration('overleafComments').update('projectId', id, vscode.ConfigurationTarget.Global);
  api.useClient(real);
  const uri = vscode.Uri.joinPath(root, 'chap/f1.tex');
  const doc = await vscode.workspace.openTextDocument(uri);
  const sel = 'Alpha beta';
  const at = doc.getText().indexOf(sel);
  assert.ok(at >= 0, 'fixture text missing in chap/f1.tex');
  const marker = `live-test ${Date.now()}`;
  let threadId: string | undefined;
  try {
    // 1. add a comment on a selection -> server round trip -> thread rendered on the same text
    const t = api.newThread(uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + sel.length)));
    await vscode.commands.executeCommand('overleafComments.reply', { thread: t, text: marker });
    const added = (await real.listComments(id, { status: 'all' })).find(c => c.messages.some(m => m.content === marker));
    assert.ok(added, 'new comment not found on Overleaf');
    threadId = added.threadId;
    assert.equal(added.selectedText, sel, 'anchored to the wrong text');
    assert.equal(added.path, 'chap/f1.tex');
    assert.ok(api.threads().some(x => x.threadId === threadId), 'thread not rendered after add');

    // 2. reply to it
    const idx = api.threads().findIndex(x => x.threadId === threadId);
    await vscode.commands.executeCommand('overleafComments.reply', { thread: api.thread(idx), text: `${marker} reply` });
    const replied = (await real.listComments(id, { status: 'all' })).find(c => c.threadId === threadId)!;
    assert.deepEqual(replied.messages.map(m => m.content), [marker, `${marker} reply`]);

    // 3. resolve it: the server must show it resolved (poll: Overleaf may lag); it stays visible, as resolved
    await vscode.commands.executeCommand('overleafComments.resolve', api.thread(api.threads().findIndex(x => x.threadId === threadId)));
    let serverResolved = false;
    for (let i = 0; i < 6 && !serverResolved; i++) {
      serverResolved = (await real.listComments(id, { status: 'resolved' })).some(c => c.threadId === threadId);
      if (!serverResolved) await new Promise(r => setTimeout(r, 2000));
    }
    assert.equal(serverResolved, true, 'server does not show it resolved');
    assert.equal(api.threads().some(x => x.threadId === threadId), false, 'a resolved comment must leave the editor');
    assert.ok(api.tree().some(f => f.threads.some(t => t.startsWith('[resolved] '))), 'and be listed as resolved in the sidebar');
  } finally {
    if (threadId) await real.deleteComment(id, threadId); // leave the scratch project as we found it
  }
  assert.equal((await real.listComments(id, { status: 'all' })).some(c => c.threadId === threadId), false, 'cleanup failed');
}
