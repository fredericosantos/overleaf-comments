// What we draw on top of VS Code's native comment icon: a faint orange background on exactly the commented text
// (whole lines when the comment spans several). Open comments only: resolved ones are shown in the sidebar.
// Comments that are not on Overleaf yet look different: same orange, but with a dashed outline (the native icon
// cannot be changed per thread, so the difference lives in the text highlight).
import * as vscode from 'vscode';
import type { ProjectComment } from '@aloth/olcli';
import { highlightShape } from './anchor.ts';

export interface MarkerEntry { thread: vscode.CommentThread; comment: ProjectComment }

export class Highlights implements vscode.Disposable {
  private readonly open = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(245,166,35,0.16)', borderRadius: '2px' });
  private readonly openLines = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: 'rgba(245,166,35,0.16)' });

  private readonly unsyncedText = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(245,166,35,0.16)', border: '1px dashed rgba(245,166,35,0.85)', borderRadius: '2px' });
  private readonly unsyncedLines = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: 'rgba(245,166,35,0.16)', borderStyle: 'dashed', borderColor: 'rgba(245,166,35,0.85)', borderWidth: '1px 0' });

  constructor(private readonly entries: () => MarkerEntry[], private readonly unsynced: () => vscode.CommentThread[]) {}

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
      const pending = this.unsynced().filter(t => t.uri.toString() === editor.document.uri.toString());
      const pText: vscode.Range[] = [];
      const pLines: vscode.Range[] = [];
      for (const t of pending) {
        const shape = highlightShape(t.range.start, t.range.end);
        if (shape.kind === 'lines') pLines.push(new vscode.Range(t.range.start.line, 0, shape.lastLine, 0));
        else pText.push(t.range);
      }
      editor.setDecorations(this.unsyncedText, pText);
      editor.setDecorations(this.unsyncedLines, pLines);
    }
  }

  dispose(): void { [this.open, this.openLines, this.unsyncedText, this.unsyncedLines].forEach(d => d.dispose()); }
}
