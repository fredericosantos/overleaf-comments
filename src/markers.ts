// What we draw on top of VS Code's native comment icon: a faint background on exactly the commented text
// (orange when open, green when resolved) and a hover with the thread's text.
import * as vscode from 'vscode';
import type { ProjectComment, CommentMessage } from '@aloth/olcli';

export interface MarkerEntry { thread: vscode.CommentThread; comment: ProjectComment }

const authorOf = (m: CommentMessage) => m.user?.name ?? ([m.user?.first_name, m.user?.last_name].filter(Boolean).join(' ') || m.user?.email || 'unknown');

export class Highlights implements vscode.Disposable {
  private readonly open = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(245,166,35,0.16)', borderRadius: '2px' });
  private readonly done = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(63,185,80,0.12)', borderRadius: '2px' });

  private readonly hover = vscode.window.createTextEditorDecorationType({});

  constructor(private readonly entries: () => MarkerEntry[]) {}

  /** Redraw every visible editor from the current threads. */
  apply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const mine = this.entries().filter(e => e.thread.uri.toString() === editor.document.uri.toString());
      editor.setDecorations(this.open, mine.filter(e => !e.comment.resolved).map(e => e.thread.range));
      editor.setDecorations(this.done, mine.filter(e => e.comment.resolved).map(e => e.thread.range));
      editor.setDecorations(this.hover, mine.map(e => ({ range: e.thread.range, hoverMessage: this.hoverText(e) })));
    }
  }

  private hoverText(e: MarkerEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Overleaf thread** ${e.comment.resolved ? '(resolved)' : '(open)'}\n\n`);
    for (const msg of e.comment.messages) md.appendText(`${authorOf(msg)}: ${msg.content}\n\n`);
    return md;
  }

  dispose(): void { this.open.dispose(); this.done.dispose(); this.hover.dispose(); }
}
