// What we draw on top of VS Code's native comment icon: a faint background on exactly the commented text
// (whole lines when the comment spans several). Open comments only: resolved ones are shown in the sidebar.
import * as vscode from 'vscode';
import type { ProjectComment } from '@aloth/olcli';
import { highlightShape } from './anchor.ts';

export interface MarkerEntry { thread: vscode.CommentThread; comment: ProjectComment }

export class Highlights implements vscode.Disposable {
  private readonly open = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(245,166,35,0.16)', borderRadius: '2px' });
  private readonly openLines = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: 'rgba(245,166,35,0.16)' });

  constructor(private readonly entries: () => MarkerEntry[]) {}

  /** Redraw every visible editor from the current threads. */
  apply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const mine = this.entries().filter(e => e.thread.uri.toString() === editor.document.uri.toString());
      // One line: highlight exactly the commented text. Several lines: highlight the whole lines.
      const text: vscode.Range[] = [];
      const lines: vscode.Range[] = [];
      for (const e of mine) {
        const { start, end } = e.thread.range;
        const shape = highlightShape(start, end);
        if (shape.kind === 'lines') lines.push(new vscode.Range(start.line, 0, shape.lastLine, 0));
        else text.push(e.thread.range);
      }
      editor.setDecorations(this.open, text);
      editor.setDecorations(this.openLines, lines);
    }
  }

  dispose(): void { [this.open, this.openLines].forEach(d => d.dispose()); }
}
