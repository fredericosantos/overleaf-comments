import test from 'node:test';
import assert from 'node:assert/strict';
import { locate, occurrenceAt } from '../src/anchor.ts';
import { projectIdFromRemote } from '../src/project.ts';
import { hoverContent, colorOf, actionLinks, MAX_CHARS, MAX_SHOWN } from '../src/hover.ts';

const id = '6acf64d6fe2f2fd26f343c60';

test('projectIdFromRemote', () => {
  assert.equal(projectIdFromRemote(`https://git.overleaf.com/${id}`), id);
  assert.equal(projectIdFromRemote(`https://git@git.overleaf.com/${id}.git\n`), id);
  // exactly what `git remote -v` prints
  assert.equal(projectIdFromRemote(`origin\thttps://git.overleaf.com/${id} (fetch)`), id);
  assert.equal(projectIdFromRemote('https://github.com/a/b'), undefined);
});

test('locate: exact, shifted, lost', () => {
  const t = 'foo bar foo baz';
  assert.deepEqual(locate(t, 8, 'foo'), { start: 8, end: 11, found: true });
  // comment said position 7 (stale): nearest occurrence wins
  assert.deepEqual(locate(t, 7, 'foo'), { start: 8, end: 11, found: true });
  assert.deepEqual(locate(t, 2, 'foo'), { start: 0, end: 3, found: true });
  assert.deepEqual(locate(t, 100, 'zzz'), { start: 15, end: 15, found: false });
});

test('occurrenceAt matches olcli scan order', () => {
  const t = 'ab ab ab';
  assert.equal(occurrenceAt(t, 0, 'ab'), 1);
  assert.equal(occurrenceAt(t, 3, 'ab'), 2);
  assert.equal(occurrenceAt(t, 6, 'ab'), 3);
  assert.equal(occurrenceAt(t, 1, 'ab'), undefined); // not a match start
  assert.equal(occurrenceAt('aaa', 1, 'aa'), undefined); // overlapping: olcli would pick offset 0 or none
  assert.equal(occurrenceAt(t, 0, ''), undefined);
});

test('hover: a wall of huge comments stays bounded; users keep their own color', () => {
  const wall = 'Lorem ipsum dolor sit amet. '.repeat(400); // ~11 000 chars per message
  const users = [{ id: 'u1', name: 'Ada' }, { id: 'u2', name: 'Grace' }];
  const messages = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, content: `${i}: ${wall}`, user_id: users[i % 2].id, user: users[i % 2] }));
  const h = hoverContent({ threadId: 't', docId: 'd', path: 'a.tex', position: 0, line: 1, column: 1, selectedText: 'x', resolved: false, messages });
  assert.equal(h.lines.length, MAX_SHOWN);
  assert.equal(h.hidden, 10 - MAX_SHOWN);
  assert.deepEqual(h.lines.map(l => l.text.slice(0, 1)), ['0', '1', '7', '8', '9']); // first 2 + latest 3
  assert.ok(h.lines.every(l => l.text.length < MAX_CHARS + 60 && l.text.includes('more characters')));
  const total = h.lines.reduce((n, l) => n + l.text.length + l.author.length, 0);
  assert.ok(total < MAX_SHOWN * (MAX_CHARS + 80), `hover text bounded (${total})`);
  assert.equal(colorOf(messages[0]), colorOf(messages[2])); // same user, same color
  assert.notEqual(colorOf(messages[0]), colorOf(messages[1])); // different users differ (palette has no collision for u1/u2)
  // short threads are untouched
  const few = hoverContent({ threadId: 't', docId: 'd', path: 'a.tex', position: 0, line: 1, column: 1, selectedText: 'x', resolved: false, messages: messages.slice(0, 3).map(m => ({ ...m, content: 'short' })) });
  assert.deepEqual([few.lines.length, few.hidden, few.lines[0].text], [3, 0, 'short']);
});

test('hover action links carry the thread id and swap Resolve/Reopen', () => {
  const base = { threadId: 'T 1&2', docId: 'd', path: 'a.tex', position: 0, line: 1, column: 1, selectedText: 'x', messages: [] };
  const open = actionLinks({ ...base, resolved: false });
  assert.match(open, /\[Reply\]\(command:overleafComments\.hoverReply\?%5B%22T%201%262%22%5D\)/);
  assert.match(open, /\[Resolve\]\(command:overleafComments\.hoverResolve\?/);
  assert.ok(!open.includes('Reopen'));
  assert.match(actionLinks({ ...base, resolved: true }), /\[Reopen\]\(command:overleafComments\.hoverReopen\?/);
});
