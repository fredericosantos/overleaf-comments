// What we draw on top of VS Code's native comment icon: a faint background on exactly the commented text
// (orange when open, green when resolved) and a hover with the thread's text.
import * as vscode from 'vscode';
import type { ProjectComment } from '@aloth/olcli';
import { hoverContent, actionLinks, HOVER_COMMANDS } from './hover.ts';

export interface MarkerEntry { thread: vscode.CommentThread; comment: ProjectComment }

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
    md.isTrusted = { enabledCommands: HOVER_COMMANDS }; // lets the Reply/Resolve links run our commands only
    md.supportHtml = true; // only for the colored <span> around each author; message text goes through appendText (escaped)
    md.appendMarkdown(`**Overleaf thread** ${e.comment.resolved ? '(resolved)' : '(open)'} · ${actionLinks(e.comment)}\n\n`);
    const { lines, hidden, hiddenAt } = hoverContent(e.comment);
    lines.forEach((l, i) => {
      if (hidden && i === hiddenAt) md.appendMarkdown(`*… ${hidden} more message${hidden === 1 ? '' : 's'} hidden — open the thread from the comment icon or the side panel …*\n\n`);
      md.appendMarkdown(`<span style="color:${l.color};">**`).appendText(l.author).appendMarkdown('**</span>\n\n');
      md.appendText(l.text).appendMarkdown('\n\n');
    });
    return md;
  }

  dispose(): void { this.open.dispose(); this.done.dispose(); this.hover.dispose(); }
}
