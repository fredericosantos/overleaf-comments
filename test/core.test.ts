import test from 'node:test';
import assert from 'node:assert/strict';
import { locate, occurrenceAt, highlightShape, lfView, shiftAnchor, anchorAt } from '../src/anchor.ts';
import { projectIdFromRemote } from '../src/project.ts';
import { hoverContent, colorOf, actionLinks, htmlSafe, authorOf, MAX_CHARS, MAX_SHOWN } from '../src/hover.ts';

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

test('hover action links carry the thread id', () => {
  const base = { threadId: 'T 1&2', docId: 'd', path: 'a.tex', position: 0, line: 1, column: 1, selectedText: 'x', messages: [], resolved: false };
  const links = actionLinks(base);
  assert.match(links, /\[Reply\]\(command:overleafComments\.hoverReply\?%5B%22T%201%262%22%5D\)/);
  assert.match(links, /\[Resolve\]\(command:overleafComments\.hoverResolve\?%5B%22T%201%262%22%5D\)/);
});

test('highlightShape: text within a line, whole lines across lines or on a blank line', () => {
  const p = (line: number, character: number) => ({ line, character });
  assert.deepEqual(highlightShape(p(2, 4), p(2, 9)), { kind: 'text', lastLine: 2 });
  assert.deepEqual(highlightShape(p(2, 0), p(4, 12)), { kind: 'lines', lastLine: 4 }); // three lines
  assert.deepEqual(highlightShape(p(7, 3), p(8, 5)), { kind: 'lines', lastLine: 8 }); // two lines, partial first/last
  assert.deepEqual(highlightShape(p(2, 0), p(4, 0)), { kind: 'lines', lastLine: 3 }); // ends at col 0 of next line = trailing newline
  assert.deepEqual(highlightShape(p(5, 0), p(6, 0)), { kind: 'lines', lastLine: 5 }); // blank line comment (its line break)
});

test('lfView maps offsets both ways on CRLF text and is free on LF text', () => {
  const plain = lfView('a\nb');
  assert.deepEqual([plain.lf, plain.fromDoc(2), plain.toDoc(2)], ['a\nb', 2, 2]);
  const v = lfView('a\r\nb\r\nc'); // doc: a0 \r1 \n2 b3 \r4 \n5 c6
  assert.equal(v.lf, 'a\nb\nc');
  assert.deepEqual([v.fromDoc(3), v.fromDoc(6)], [2, 4]);
  assert.deepEqual([v.toDoc(2), v.toDoc(4)], [3, 6]); // 'b' and 'c'
  assert.equal(v.lf[v.fromDoc(6)], 'c');
});

test('shiftAnchor: before moves it, after leaves it, boundaries stay outside, inside marks touched', () => {
  assert.deepEqual(shiftAnchor(10, 15, [{ offset: 0, length: 0, text: 'xx' }]), { start: 12, end: 17, touched: false });
  assert.deepEqual(shiftAnchor(10, 15, [{ offset: 20, length: 0, text: 'xx' }]), { start: 10, end: 15, touched: false });
  assert.deepEqual(shiftAnchor(10, 15, [{ offset: 10, length: 0, text: 'xx' }]), { start: 12, end: 17, touched: false }); // typed at the start
  assert.deepEqual(shiftAnchor(10, 15, [{ offset: 15, length: 0, text: 'xx' }]), { start: 10, end: 15, touched: false }); // typed at the end
  assert.deepEqual(shiftAnchor(10, 15, [{ offset: 11, length: 2, text: '' }]), { start: 10, end: 13, touched: true }); // deleted inside
  assert.equal(shiftAnchor(10, 15, [{ offset: 8, length: 4, text: 'z' }]).touched, true); // overlaps the start
  // two changes in one event (multi-cursor), both in pre-change coordinates
  assert.deepEqual(shiftAnchor(10, 15, [{ offset: 0, length: 0, text: 'a' }, { offset: 30, length: 0, text: 'b' }]), { start: 11, end: 16, touched: false });
});

test('anchorAt: selection, line fallback, blank line, CRLF, repeated text', () => {
  const t = 'one two\n\nthree two\n';
  assert.deepEqual(anchorAt(t, 4, 7), { selectedText: 'two', occurrence: 1 });
  assert.deepEqual(anchorAt(t, 15, 18), { selectedText: 'two', occurrence: 2 }); // the second "two"
  assert.deepEqual(anchorAt(t, 11, 11), { selectedText: 'three two', occurrence: 1 }); // nothing selected: the line
  assert.deepEqual(anchorAt(t, 8, 8), { selectedText: '\n', occurrence: 2 }); // blank line = its break (2nd "\n")
  assert.deepEqual(anchorAt('abc', 3, 3), { selectedText: 'abc', occurrence: 1 }); // end of a non-blank line: that line
  assert.equal(anchorAt('abc\n', 4, 4), undefined); // the empty last line has no break to anchor to
  const crlf = 'one two\r\n\r\nthree two\r\n';
  assert.deepEqual(anchorAt(crlf, 4, 7), { selectedText: 'two', occurrence: 1 });
  assert.deepEqual(anchorAt('x\r\ny\r\nz', 0, 4), { selectedText: 'x\ny', occurrence: 1 }); // multi-line selection sent with "\n"
});

import { Model, parseCache, serializeCache, INTENT_TTL_MS } from '../src/model.ts';
const cm = (id: string, resolved = false) => ({ threadId: id, docId: 'd', path: 'a.tex', position: 0, line: 1, column: 1, selectedText: 'x', resolved, messages: [] });

test('Model: a slow older fetch cannot overwrite a newer one', () => {
  const m = new Model();
  const slow = m.nextTicket();
  const fast = m.nextTicket();
  assert.equal(m.applyFetch(fast, [cm('a', true)]), true);
  assert.equal(m.applyFetch(slow, [cm('a', false)]), false); // stale: dropped
  assert.equal(m.view(0)[0].resolved, true);
});

test('Model: a resolve intent survives a lagging server, clears when the server agrees, expires after the TTL', () => {
  const m = new Model();
  m.applyFetch(m.nextTicket(), [cm('a')]);
  m.setIntent('a', true, 1000);
  assert.equal(m.view(1001)[0].resolved, true); // optimistic
  m.applyFetch(m.nextTicket(), [cm('a', false)]); // server lags: still open
  assert.equal(m.view(1002)[0].resolved, true); // still shown resolved
  assert.equal(m.view(1000 + INTENT_TTL_MS)[0].resolved, false); // gave up waiting: server wins
  m.setIntent('a', true, 5000);
  m.applyFetch(m.nextTicket(), [cm('a', true)]); // server caught up: intent dropped
  m.applyFetch(m.nextTicket(), [cm('a', false)]); // later reopened elsewhere
  assert.equal(m.view(5001)[0].resolved, false);
  m.setIntent('a', true, 6000);
  m.clearIntent('a', true); // write failed: rolled back
  assert.equal(m.view(6001)[0].resolved, false);
  m.setIntent('a', true, 7000);
  m.setIntent('a', false, 7001); // user changed their mind
  m.clearIntent('a', true); // the first write fails: must not erase the newer intent
  assert.equal(m.view(7002)[0].resolved, false);
  m.clearIntent('a', false);
});

test('Model.reset makes in-flight fetches stale', () => {
  const m = new Model();
  const t = m.nextTicket();
  m.reset();
  assert.equal(m.applyFetch(t, [cm('a')]), false);
  assert.deepEqual(m.view(0), []);
});

test('cache: only a well-formed cache for the same project is accepted', () => {
  const file = serializeCache('P1', [cm('a')], 123);
  assert.equal(parseCache(file, 'P1')?.comments.length, 1);
  assert.equal(parseCache(file, 'P2'), undefined); // another project
  assert.equal(parseCache(file, undefined)?.at, 123); // project unknown yet: accept for a first paint
  assert.equal(parseCache([cm('a')], 'P1'), undefined); // old unversioned format (a bare array)
  assert.equal(parseCache({ v: 1, projectId: 'P1', at: 1, comments: [{ nope: 1 }] }, 'P1'), undefined);
  assert.equal(parseCache(null, 'P1'), undefined);
});

test('htmlSafe neutralises tags and entities; authorOf tolerates a missing message', () => {
  assert.equal(htmlSafe('<img src="x"> a&b'), '&lt;img src="x"&gt; a&amp;b');
  assert.equal(authorOf(undefined), 'unknown');
  assert.equal(authorOf({ id: '1', content: '', user: { first_name: 'Ada', last_name: 'L' } }), 'Ada L');
});

test('Model.seed shows cached data without beating a real fetch', () => {
  const m = new Model();
  const fetchTicket = m.nextTicket();
  m.seed([cm('old')]); // cache first paint while the fetch is still in flight
  assert.deepEqual(m.view(0).map(c => c.threadId), ['old']);
  assert.equal(m.applyFetch(fetchTicket, [cm('new')]), true); // the fetch still lands
  assert.deepEqual(m.view(0).map(c => c.threadId), ['new']);
});
