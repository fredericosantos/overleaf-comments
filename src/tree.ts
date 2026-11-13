// The sidebar tree: files -> threads (open and resolved) and suggestions -> messages.
import * as vscode from 'vscode';
import type { ProjectComment, CommentMessage } from '@aloth/olcli';
import { authorOf } from './text.ts';
import { verbOf, type Suggestion } from './suggestions.ts';
import { LOCAL } from './reviewing.ts';

/** Shown for an open comment or suggestion whose text the local file does not have (yet). */
const NOT_IN_FILE = 'not in your file (git pull?)';

export type Node =
  | { kind: 'file'; path: string; comments: ProjectComment[]; suggestions: Suggestion[] }
  | { kind: 'thread'; c: ProjectComment }
  | { kind: 'suggestion'; s: Suggestion }
  | { kind: 'msg'; m: CommentMessage };

export const commentOf = (n: Node): ProjectComment | undefined => (n.kind === 'thread' ? n.c : undefined);
export const firstText = (c: ProjectComment): string => c.messages[0]?.content ?? '(no text)';

export class CommentsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  /** `comments`/`suggestions`: everything to list; `liveLine`: current 0-based line of a comment (thread id) or suggestion (id) in the editor, if drawn. */
  constructor(private readonly comments: () => ProjectComment[], private readonly suggestions: () => Suggestion[], private readonly liveLine: (id: string) => number | undefined) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(n?: Node): Node[] {
    if (!n) {
      const byFile = new Map<string, { comments: ProjectComment[]; suggestions: Suggestion[] }>();
      const file = (path: string) => byFile.get(path) ?? byFile.set(path, { comments: [], suggestions: [] }).get(path)!;
      for (const c of this.comments()) file(c.path).comments.push(c);
      for (const s of this.suggestions()) file(s.path).suggestions.push(s);
      return [...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([path, f]) => ({ kind: 'file', path, ...f }));
    }
    if (n.kind === 'file') {
      // Comments and suggestions together, in text order.
      const items: { at: number; node: Node }[] = [
        ...n.comments.map(c => ({ at: c.position, node: { kind: 'thread', c } as Node })),
        ...n.suggestions.map(s => ({ at: s.position, node: { kind: 'suggestion', s } as Node })),
      ];
      return items.sort((a, b) => a.at - b.at).map(x => x.node);
    }
    if (n.kind === 'thread') return n.c.messages.map(m => ({ kind: 'msg', m }));
    return [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'file') {
      const it = new vscode.TreeItem(n.path, vscode.TreeItemCollapsibleState.Expanded);
      const done = n.comments.filter(c => c.resolved).length;
      const sug = n.suggestions.length;
      it.description = [done ? `${n.comments.length - done} open · ${done} resolved` : n.comments.length ? `${n.comments.length}` : '', sug ? `${sug} suggestion${sug === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
      it.iconPath = vscode.ThemeIcon.File;
      return it;
    }
    if (n.kind === 'thread') {
      const c = n.c;
      const replies = c.messages.length - 1;
      const live = this.liveLine(c.threadId);
      const line = (live ?? c.line - 1) + 1;
      const it = new vscode.TreeItem(firstText(c).split('\n')[0].slice(0, 60), vscode.TreeItemCollapsibleState.Collapsed);
      const missing = !c.resolved && live === undefined ? NOT_IN_FILE : '';
      it.description = [`L${line}`, authorOf(c.messages[0]), replies > 0 ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : '', c.resolved ? 'resolved' : '', missing].filter(Boolean).join(' · ');
      it.tooltip = `${c.selectedText}\n\n${c.messages.map(m => `${authorOf(m)}: ${m.content}`).join('\n')}`;
      it.iconPath = c.resolved ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('comment');
      it.contextValue = c.resolved ? 'resolved' : 'open';
      it.command = { command: 'overleafComments.treeReveal', title: 'Show in editor', arguments: [n] };
      return it;
    }
    if (n.kind === 'suggestion') {
      const s = n.s;
      const what = s.inserted && s.deleted ? `${s.deleted} → ${s.inserted}` : s.inserted || s.deleted;
      const it = new vscode.TreeItem(`${verbOf(s)}: ${what.split('\n')[0].slice(0, 60)}`);
      const live = this.liveLine(s.id);
      const local = s.id.startsWith(LOCAL);
      it.description = [`L${(live ?? s.line - 1) + 1}`, s.author, local ? 'not synced' : live === undefined ? NOT_IN_FILE : ''].filter(Boolean).join(' · ');
      it.tooltip = `${verbOf(s)} by ${s.author}${s.deleted ? `\n\nDeleted: ${s.deleted}` : ''}${s.inserted ? `\n\nAdded: ${s.inserted}` : ''}`;
      it.iconPath = new vscode.ThemeIcon('edit');
      it.contextValue = 'suggestion';
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
