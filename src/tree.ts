// The sidebar tree: files -> threads (open and resolved) -> messages.
import * as vscode from 'vscode';
import type { ProjectComment, CommentMessage } from '@aloth/olcli';
import { authorOf } from './hover.ts';

export type Node = { kind: 'file'; path: string; comments: ProjectComment[] } | { kind: 'thread'; c: ProjectComment } | { kind: 'msg'; m: CommentMessage };

export const commentOf = (n: Node): ProjectComment | undefined => (n.kind === 'thread' ? n.c : undefined);
export const firstText = (c: ProjectComment): string => c.messages[0]?.content ?? '(no text)';

export class CommentsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  /** `comments`: everything to list; `liveLine`: current 0-based line of an open comment in the editor, if drawn. */
  constructor(private readonly comments: () => ProjectComment[], private readonly liveLine: (threadId: string) => number | undefined) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(n?: Node): Node[] {
    if (!n) {
      const byFile = new Map<string, ProjectComment[]>();
      for (const c of this.comments()) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
      return [...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([path, cs]) => ({ kind: 'file', path, comments: [...cs].sort((x, y) => x.position - y.position) }));
    }
    if (n.kind === 'file') return n.comments.map(c => ({ kind: 'thread', c }));
    if (n.kind === 'thread') return n.c.messages.map(m => ({ kind: 'msg', m }));
    return [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'file') {
      const it = new vscode.TreeItem(n.path, vscode.TreeItemCollapsibleState.Expanded);
      const done = n.comments.filter(c => c.resolved).length;
      it.description = done ? `${n.comments.length - done} open · ${done} resolved` : `${n.comments.length}`;
      it.iconPath = vscode.ThemeIcon.File;
      return it;
    }
    if (n.kind === 'thread') {
      const c = n.c;
      const replies = c.messages.length - 1;
      const line = (this.liveLine(c.threadId) ?? c.line - 1) + 1;
      const it = new vscode.TreeItem(firstText(c).split('\n')[0].slice(0, 60), vscode.TreeItemCollapsibleState.Collapsed);
      it.description = [`L${line}`, authorOf(c.messages[0]), replies > 0 ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : '', c.resolved ? 'resolved' : ''].filter(Boolean).join(' · ');
      it.tooltip = `${c.selectedText}\n\n${c.messages.map(m => `${authorOf(m)}: ${m.content}`).join('\n')}`;
      it.iconPath = c.resolved ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('comment');
      it.contextValue = c.resolved ? 'resolved' : 'open';
      it.command = { command: 'overleafComments.treeReveal', title: 'Show in editor', arguments: [n] };
      return it;
    }
    const it = new vscode.TreeItem(n.m.content.split('\n')[0].slice(0, 80));
    it.description = authorOf(n.m);
    it.tooltip = n.m.content;
    it.iconPath = new vscode.ThemeIcon('account');
    return it;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
