// The project's comments and suggestions as a file in the project, for other tools to read (coding agents, scripts):
// written after every fetch when overleafComments.snapshotFile is set. A read-only copy: nothing reads it back, so
// editing it changes nothing on Overleaf. No vscode import, so plain node tests cover it.
import type { CommentMessage, ProjectComment, TrackedChange } from '@aloth/olcli';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathIn } from './project.ts';
import { groupChanges } from './suggestions.ts';
import { authorOf } from './text.ts';

const run = promisify(execFile);

const iso = (t: string | number | undefined) => {
  const d = t === undefined ? undefined : new Date(t);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
};
const file = (path: string) => path.replace(/^\/+/, '');
const message = (m: CommentMessage) => ({ author: authorOf(m), date: iso(m.timestamp), text: m.content });

export function buildSnapshot(projectId: string, comments: ProjectComment[], changes: TrackedChange[], at: number) {
  const byPlace = <T extends { file: string; line: number }>(a: T, b: T) => a.file.localeCompare(b.file) || a.line - b.line;
  return {
    about: "Overleaf review comments and suggestions (track changes) of this project, written by the Overleaf Comments VS Code extension after each fetch from Overleaf. Read-only copy: editing this file changes nothing on Overleaf. 'line' is 1-based, in Overleaf's copy of the file (git pull to match it).",
    version: 1,
    projectId,
    fetchedAt: new Date(at).toISOString(),
    comments: comments
      .map(c => ({ threadId: c.threadId, file: file(c.path), line: c.line, resolved: c.resolved, selectedText: c.selectedText, messages: c.messages.map(message) }))
      .sort(byPlace),
    suggestions: groupChanges(changes)
      .map(s => ({ id: s.id, file: file(s.path), line: s.line, author: s.author, date: iso(s.timestamp), deleted: s.deleted, inserted: s.inserted }))
      .sort(byPlace),
  };
}

/** Where the snapshot goes: `rel` inside the project folder `root`, or undefined if it points outside. */
export const snapshotPath = (root: string, rel: string): string | undefined => {
  const target = resolve(root, rel.trim());
  return rel.trim() && pathIn(root, target) ? target : undefined;
};

/** Write the snapshot (whole, never half-written: a temporary file renamed over it) and keep it out of git through
 * .git/info/exclude (local, never committed), so it is never pushed to Overleaf. */
export async function writeSnapshot(root: string, target: string, data: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, target);
  await excludeFromGit(root, target);
}

async function excludeFromGit(root: string, target: string): Promise<void> {
  const rel = pathIn(root, target);
  if (!rel) return;
  const { stdout } = await run('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root });
  const exclude = resolve(root, stdout.trim());
  const line = `/${rel}*`; // with the temporary file
  const text = await readFile(exclude, 'utf8').catch(() => '');
  if (text.split(/\r?\n/).includes(line)) return;
  await mkdir(dirname(exclude), { recursive: true });
  await appendFile(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}# Overleaf Comments snapshot (local copy of the review comments)\n${line}\n`);
}
