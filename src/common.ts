// Shared constants, types and tiny helpers for the extension's modules.
import * as vscode from 'vscode';
import { pathIn } from './project.ts';
import type { OverleafClient, ProjectComment } from '@aloth/olcli';

export const COOKIE_KEY = 'overleafComments.cookie';
export const CACHE_KEY = 'overleafComments.cache';
export const UNSYNCED_KEY = 'overleafComments.unsyncedComments';
export const SYNCING = 'Syncing…';
export const ANCHOR_LOST = 'Anchor lost (text edited locally)';
/** The message olcli's addComment throws when the text is not in Overleaf's copy of the file. */
export const NOT_ON_OVERLEAF = /Selected text not found/;
export const RERENDER_SLACK_MS = 100;

export type Client = Pick<OverleafClient, 'listReview' | 'acceptTrackedChangesInDoc' | 'suggestChanges' | 'addComment' | 'postCommentMessage' | 'resolveComment' | 'reopenComment'>;
/** What VS Code passes to a reply handler (structurally a CommentReply). */
export interface Reply { thread: vscode.CommentThread; text: string }
/** An editor thread for an OPEN comment. start/end are the anchor's document offsets, kept current as the file is edited. */
export interface Entry { thread: vscode.CommentThread; comment: ProjectComment; start: number; end: number }
export type Written<T> = { ok: true; value: T } | { ok: false; cancelled?: boolean };
export type NewCommentArgs = { filePath: string; content: string; selectedText: string; occurrence: number };

/** User-fixable setup problems (no cookie / no remote): reported, but not counted as a failed fetch. */
export class SetupError extends Error {
  constructor(message: string, readonly needsCookie = false) {
    super(message);
  }
}
/** Stop quietly, no error toast (the caller already showed what it wants to show). */
export class Cancelled extends Error {}

export const cfg = () => vscode.workspace.getConfiguration('overleafComments');
export const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri;

let current: vscode.Uri | undefined;
/** The folder of the Overleaf project in use (set by Session). A workspace can hold several git repositories (a
 * multi-root workspace, or one folder with a clone per paper): the project is the one of the file being edited. Before
 * any project is known it is the workspace folder, as for a workspace that is one Overleaf clone. */
export const projectRoot = () => current ?? workspaceRoot();
export const setProjectRoot = (root: vscode.Uri | undefined) => { current = root; };
/** A file's path inside the project as Overleaf names it ('chap/intro.tex'), or undefined when it is not in the project. */
export function projectPath(uri: vscode.Uri, root = projectRoot()): string | undefined {
  return root && uri.scheme === 'file' ? pathIn(root.fsPath, uri.fsPath) : undefined;
}
/** Cached comments, one entry per project (a workspace can switch between several). */
export const cacheKey = (projectId: string) => `${CACHE_KEY}.${projectId}`;
/** Set a context key that `when` clauses in package.json can use. */
export const setContext = (key: string, value: boolean) => void vscode.commands.executeCommand('setContext', `overleafComments.${key}`, value);
export const range = (doc: vscode.TextDocument, start: number, end: number) => new vscode.Range(doc.positionAt(start), doc.positionAt(end));
