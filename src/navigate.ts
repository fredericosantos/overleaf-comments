// Taking the user to a comment.
import * as vscode from 'vscode';
import type { ProjectComment } from '@aloth/olcli';
import { locate, lfView } from './anchor.ts';
import type { Threads } from './threads.ts';
import { range, workspaceRoot, type Entry } from './common.ts';

export async function reveal(threads: Threads, c: ProjectComment): Promise<void> {
  const live = threads.byId(c.threadId);
  if (live) {
    const editor = await vscode.window.showTextDocument(live.thread.uri, { selection: live.thread.range });
    editor.revealRange(live.thread.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    live.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return;
  }
  // A resolved comment has no editor thread: just take the user to its text.
  const root = workspaceRoot();
  if (!root) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, c.path.replace(/^\/+/, '')));
  const v = lfView(doc.getText());
  const a = locate(v.lf, c.position, c.selectedText);
  const where = range(doc, v.toDoc(a.start), v.toDoc(a.end));
  const editor = await vscode.window.showTextDocument(doc, { selection: where });
  editor.revealRange(where, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Open the thread and put the cursor in its reply box, as if the comment icon had been clicked and Reply pressed.
 * VS Code has no extension API for this; its own "Go to Next Comment Thread" focuses the thread: park the cursor just
 * before it so that it is the next one. Best effort: the reply area itself may still need one click. */
export async function focusReply(e: Entry): Promise<void> {
  const editor = await vscode.window.showTextDocument(e.thread.uri, { selection: e.thread.range, preserveFocus: false });
  const { start } = e.thread.range;
  const before = start.character > 0 ? start.translate(0, -1) : start.line > 0 ? editor.document.lineAt(start.line - 1).range.end : start;
  editor.selection = new vscode.Selection(before, before);
  e.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  await vscode.commands.executeCommand('editor.action.nextCommentThreadAction');
}
