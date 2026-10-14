// Optional markers drawn for each Overleaf thread, on top of VS Code's native comment icon.
// Each one is a separate switch (setting overleafComments.markers) so the useful ones can be kept.
import * as vscode from 'vscode';
import type { ProjectComment, CommentMessage } from '@aloth/olcli';

export const ALL_MARKERS = ['glyphMargin', 'inlineBefore', 'inlineAfter', 'lineTint', 'border', 'overviewRuler', 'codeLens', 'hover'] as const;
export type Marker = (typeof ALL_MARKERS)[number];

export interface MarkerEntry { thread: vscode.CommentThread; comment: ProjectComment }

const OPEN = '#f5a623';
const DONE = '#3fb950';

const authorOf = (m?: CommentMessage) => m?.user?.name ?? ([m?.user?.first_name, m?.user?.last_name].filter(Boolean).join(' ') || m?.user?.email || 'unknown');

export class Markers implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;
  private readonly types: Record<string, vscode.TextEditorDecorationType>;
  private readonly subs: vscode.Disposable[] = [];

  constructor(extensionUri: vscode.Uri, private readonly entries: () => MarkerEntry[], private readonly enabled: () => Marker[]) {
    const glyph = (f: string) => ({ gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', f), gutterIconSize: 'contain' as const });
    const ruler = (c: string) => ({ overviewRulerColor: c, overviewRulerLane: vscode.OverviewRulerLane.Right });
    this.types = {
      glyphOpen: vscode.window.createTextEditorDecorationType(glyph('glyph-open.svg')),
      glyphDone: vscode.window.createTextEditorDecorationType(glyph('glyph-resolved.svg')),
      before: vscode.window.createTextEditorDecorationType({}),
      after: vscode.window.createTextEditorDecorationType({}),
      tintOpen: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: 'rgba(245,166,35,0.12)' }),
      tintDone: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: 'rgba(63,185,80,0.10)' }),
      borderOpen: vscode.window.createTextEditorDecorationType({ border: `1px dotted ${OPEN}`, borderRadius: '3px' }),
      borderDone: vscode.window.createTextEditorDecorationType({ border: `1px dotted ${DONE}`, borderRadius: '3px' }),
      rulerOpen: vscode.window.createTextEditorDecorationType(ruler(OPEN)),
      rulerDone: vscode.window.createTextEditorDecorationType(ruler(DONE)),
      hover: vscode.window.createTextEditorDecorationType({}),
    };
    this.subs.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this), ...Object.values(this.types));
  }

  /** Redraw every visible editor from the current threads and settings. */
  apply(): void {
    const on = new Set(this.enabled());
    for (const editor of vscode.window.visibleTextEditors) {
      const mine = this.entries().filter(e => e.thread.uri.toString() === editor.document.uri.toString());
      const pick = (marker: Marker, f: (e: MarkerEntry) => vscode.DecorationOptions, resolved?: boolean) =>
        on.has(marker) ? mine.filter(e => resolved === undefined || e.comment.resolved === resolved).map(f) : [];
      const lineOf = (e: MarkerEntry) => editor.document.lineAt(e.thread.range.start.line).range;
      const set = (t: string, ranges: vscode.DecorationOptions[]) => editor.setDecorations(this.types[t], ranges);

      set('glyphOpen', pick('glyphMargin', e => ({ range: lineOf(e) }), false));
      set('glyphDone', pick('glyphMargin', e => ({ range: lineOf(e) }), true));
      set('before', pick('inlineBefore', e => ({ range: new vscode.Range(e.thread.range.start, e.thread.range.start), renderOptions: { before: { contentText: '💬 ' } } })));
      set('after', pick('inlineAfter', e => {
        const n = e.comment.messages.length;
        return { range: lineOf(e), renderOptions: { after: { contentText: `  💬 ${n}${e.comment.resolved ? ' ✓' : ''}`, color: e.comment.resolved ? DONE : OPEN } } };
      }));
      set('tintOpen', pick('lineTint', e => ({ range: lineOf(e) }), false));
      set('tintDone', pick('lineTint', e => ({ range: lineOf(e) }), true));
      set('borderOpen', pick('border', e => ({ range: e.thread.range }), false));
      set('borderDone', pick('border', e => ({ range: e.thread.range }), true));
      set('rulerOpen', pick('overviewRuler', e => ({ range: lineOf(e) }), false));
      set('rulerDone', pick('overviewRuler', e => ({ range: lineOf(e) }), true));
      set('hover', pick('hover', e => ({ range: e.thread.range, hoverMessage: this.hoverText(e) })));
    }
    this.lensChanged.fire();
  }

  private hoverText(e: MarkerEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Overleaf thread** ${e.comment.resolved ? '(resolved)' : '(open)'}\n\n`);
    for (const m of e.comment.messages) md.appendText(`${authorOf(m)}: ${m.content}\n\n`);
    return md;
  }

  /** CodeLens: a clickable line above the commented line. */
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled().includes('codeLens')) return [];
    return this.entries()
      .filter(e => e.thread.uri.toString() === doc.uri.toString())
      .flatMap(e => {
        const range = doc.lineAt(e.thread.range.start.line).range;
        const id = e.comment.threadId;
        const n = e.comment.messages.length;
        return [
          new vscode.CodeLens(range, { title: `💬 ${n} ${n === 1 ? 'comment' : 'comments'}${e.comment.resolved ? ' (resolved)' : ''}`, command: 'overleafComments.lensShow', arguments: [id] }),
          new vscode.CodeLens(range, { title: 'Reply', command: 'overleafComments.lensReply', arguments: [id] }),
          new vscode.CodeLens(range, e.comment.resolved
            ? { title: 'Reopen', command: 'overleafComments.lensReopen', arguments: [id] }
            : { title: 'Resolve', command: 'overleafComments.lensResolve', arguments: [id] }),
        ];
      });
  }

  dispose(): void { this.subs.forEach(s => s.dispose()); this.lensChanged.dispose(); }
}
