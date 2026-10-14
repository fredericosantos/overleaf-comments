import test from 'node:test';
import assert from 'node:assert/strict';
import { locate, occurrenceAt } from '../src/anchor.ts';
import { projectIdFromRemote } from '../src/project.ts';

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
