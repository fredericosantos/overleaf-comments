// Shared constants, types and tiny helpers for the extension's modules.
import * as vscode from 'vscode';
import type { OverleafClient, ProjectComment } from '@aloth/olcli';

export const COOKIE_KEY = 'overleafComments.cookie';
export const CACHE_KEY = 'overleafComments.cache';
export const SYNCING = 'Syncing…';
export const ANCHOR_LOST = 'Anchor lost (text edited locally)';
/** The message olcli's addComment throws when the text is not in Overleaf's copy of the file. */
export const NOT_ON_OVERLEAF = /Selected text not found/;
/** After a push, Overleaf's git bridge can take a few seconds to show the new text. */
export const PUSH_RETRIES = 4;
export const PUSH_WAIT_MS = 3000;
export const RERENDER_SLACK_MS = 100;

export type Client = Pick<OverleafClient, 'listComments' | 'addComment' | 'postCommentMessage' | 'resolveComment' | 'reopenComment'>;
/** What VS Code passes to a reply handler (structurally a CommentReply). */
export interface Reply { thread: vscode.CommentThread; text: string }
/** An editor thread for an OPEN comment. start/end are the anchor's document offsets, kept current as the file is edited. */
export interface Entry { thread: vscode.CommentThread; comment: ProjectComment; start: number; end: number }
export type Written<T> = { ok: true; value: T } | { ok: false; cancelled?: boolean };
export type NewCommentArgs = { filePath: string; content: string; selectedText: string; occurrence: number };

export interface Prompts {
  confirmPush(message: string, okLabel: string): Thenable<boolean>;
  commitMessage(defaultMessage: string): Thenable<string | undefined>;
}

/** User-fixable setup problems (no cookie / no remote): reported, but not counted as a failed fetch. */
export class SetupError extends Error {
  constructor(message: string, readonly needsCookie = false) {
    super(message);
  }
}
/** The user said no to a prompt: stop quietly, no error toast. */
export class Cancelled extends Error {}

export const cfg = () => vscode.workspace.getConfiguration('overleafComments');
export const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri;
/** Set a context key that `when` clauses in package.json can use. */
export const setContext = (key: string, value: boolean) => void vscode.commands.executeCommand('setContext', `overleafComments.${key}`, value);
export const range = (doc: vscode.TextDocument, start: number, end: number) => new vscode.Range(doc.positionAt(start), doc.positionAt(end));
