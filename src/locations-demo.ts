// Dev aid: opens a scratch document that marks, in red, every place an extension can draw a comment marker.
// ponytail: delete this file and its command once the placement is chosen.
import * as vscode from 'vscode';

export async function showIconLocations(ctx: vscode.ExtensionContext, controller: vscode.CommentController): Promise<void> {
  await vscode.workspace.getConfiguration('editor').update('glyphMargin', true, vscode.ConfigurationTarget.Workspace);
  const lines = [
    'A  glyph margin: an icon to the LEFT of the line numbers',
    'B  inline, BEFORE the text on this line',
    'C  inline, AFTER the text on this line',
    'D  whole-line background tint',
    'E  border / underline around a word or range',
    'F  overview ruler: the strip at the far RIGHT (scrollbar)',
    'G  CodeLens: a clickable line ABOVE this one (see line above)',
    'H  hover message: hover this line',
    'N  the NATIVE comment icon sits right of the line numbers (VS Code fixes this spot; cannot be moved or recolored)',
  ];
  const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' });
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const red = '#ff0000';
  const mk = (o: vscode.DecorationRenderOptions) => { const d = vscode.window.createTextEditorDecorationType(o); ctx.subscriptions.push(d); return d; };
  const line = (i: number) => doc.lineAt(i).range;
  const label = (t: string) => ({ after: { contentText: `   ← ${t}`, color: red, fontWeight: 'bold' } });

  editor.setDecorations(mk({ gutterIconPath: vscode.Uri.joinPath(ctx.extensionUri, 'media/demo-glyph.svg'), gutterIconSize: 'contain' }), [{ range: line(0) }]);
  editor.setDecorations(mk({ before: { contentText: '💬 ', color: red } }), [{ range: new vscode.Range(1, 0, 1, 0) }]);
  editor.setDecorations(mk({}), [{ range: line(2), renderOptions: { after: { contentText: '  ◀ 💬 2', color: red, fontWeight: 'bold' } } }]);
  editor.setDecorations(mk({ isWholeLine: true, backgroundColor: 'rgba(255,0,0,0.25)' }), [{ range: line(3) }]);
  editor.setDecorations(mk({ border: `2px solid ${red}`, borderRadius: '3px' }), [{ range: new vscode.Range(4, 3, 4, 9) }]);
  editor.setDecorations(mk({ overviewRulerColor: red, overviewRulerLane: vscode.OverviewRulerLane.Right }), [{ range: line(5) }]);
  editor.setDecorations(mk({}), [{ range: line(7), hoverMessage: 'This is what a hover message can show: the thread text, author, replies.' }]);
  editor.setDecorations(mk({}), [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ range: line(i), renderOptions: i === 2 ? undefined : label(['glyph margin', 'inline before', '', 'whole-line tint', 'border', 'overview ruler', 'CodeLens (above)', 'hover', 'native icon'][i]) })));

  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: 'plaintext' }, {
    provideCodeLenses: d => (d === doc ? [new vscode.CodeLens(line(6), { title: '💬 2 comments · Reply · Resolve  (CodeLens: sits ABOVE its line, theme-colored)', command: '' })] : []),
  }));
  const thread = controller.createCommentThread(doc.uri, line(8), [{ author: { name: 'You' }, body: 'native comment widget (opens BELOW its line)', mode: vscode.CommentMode.Preview }]);
  thread.canReply = false;
  ctx.subscriptions.push({ dispose: () => thread.dispose() });
}
