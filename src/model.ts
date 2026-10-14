// Pure state for the comments (no vscode import): ordered fetches, optimistic resolve intents, validated cache.
import type { ProjectComment } from '@aloth/olcli';

/** How long we keep showing an optimistic resolve/reopen if the server still reports the old state. */
export const INTENT_TTL_MS = 15_000;
const CACHE_VERSION = 1;

export class Model {
  private server: ProjectComment[] = [];
  private ticket = 0;
  private applied = 0;
  private readonly intents = new Map<string, { resolved: boolean; until: number }>();

  isEmpty(): boolean {
    return this.server.length === 0;
  }

  /** First paint from the cache: shows data without counting as a fetch, so any real fetch still wins. */
  seed(comments: ProjectComment[]): void {
    this.server = comments;
  }

  /** Call when a fetch STARTS; pass the ticket to applyFetch when it lands. */
  nextTicket(): number {
    return ++this.ticket;
  }

  /** Apply a fetch result. A result older than one already applied is dropped (returns false): slow fetches can't undo newer state. */
  applyFetch(ticket: number, comments: ProjectComment[]): boolean {
    if (ticket < this.applied) return false;
    this.applied = ticket;
    this.server = comments;
    for (const [id, intent] of this.intents) {
      if (comments.find(c => c.threadId === id)?.resolved === intent.resolved) this.intents.delete(id); // server caught up
    }
    return true;
  }

  /** Remember that the user resolved/reopened a thread, so a server that lags does not flip it back. */
  setIntent(id: string, resolved: boolean, now: number): void {
    this.intents.set(id, { resolved, until: now + INTENT_TTL_MS });
  }

  /** Undo an intent after its write failed, but only that intent: a newer resolve/reopen for the thread stays. */
  clearIntent(id: string, resolved: boolean): void {
    if (this.intents.get(id)?.resolved === resolved) this.intents.delete(id);
  }

  /** Server state with the user's pending resolve/reopen overlaid. Never mutates what the server returned. */
  view(now: number): ProjectComment[] {
    for (const [id, i] of this.intents) if (i.until <= now) this.intents.delete(id);
    return this.server.map(c => {
      const i = this.intents.get(c.threadId);
      return i && i.resolved !== c.resolved ? { ...c, resolved: i.resolved } : c;
    });
  }

  reset(): void {
    this.server = [];
    this.intents.clear();
    this.applied = ++this.ticket; // anything still in flight is now stale
  }
}

export interface CacheFile { v: number; projectId: string; at: number; comments: ProjectComment[] }

export const serializeCache = (projectId: string, comments: ProjectComment[], at: number): CacheFile => ({ v: CACHE_VERSION, projectId, at, comments });

/** Accept a stored cache only if it has the expected shape and belongs to this project. */
export function parseCache(raw: unknown, projectId: string | undefined): CacheFile | undefined {
  const r = raw as Partial<CacheFile> | null | undefined;
  if (!r || r.v !== CACHE_VERSION || !Array.isArray(r.comments) || typeof r.at !== 'number') return undefined;
  if (projectId !== undefined && r.projectId !== projectId) return undefined;
  const ok = r.comments.every(c => c && typeof c.threadId === 'string' && typeof c.path === 'string' && typeof c.position === 'number' && Array.isArray(c.messages));
  return ok ? (r as CacheFile) : undefined;
}
