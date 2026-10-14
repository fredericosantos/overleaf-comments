import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushFile } from '../src/git.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

/** A work clone with an upstream, backed by a local bare repo standing in for git.overleaf.com. */
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'olc-git-'));
  const bare = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
  const work = join(base, 'work');
  execFileSync('git', ['clone', '-q', bare, work]);
  git(work, 'config', 'user.email', 't@example.com');
  git(work, 'config', 'user.name', 'T');
  writeFileSync(join(work, 'a.tex'), 'one\n');
  git(work, 'add', 'a.tex');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'HEAD:main');
  git(work, 'branch', '-q', '-u', 'origin/main');
  return { bare, work };
}

test('pushFile commits only the given file and pushes it', async () => {
  const { bare, work } = setup();
  writeFileSync(join(work, 'a.tex'), 'one\ntwo\n');
  writeFileSync(join(work, 'b.tex'), 'other\n');
  git(work, 'add', 'b.tex'); // someone else's staged change must not be committed
  await pushFile({ cwd: work, file: 'a.tex', message: 'Update a.tex' });
  assert.equal(git(bare, 'log', '--format=%s', '-1', 'main'), 'Update a.tex');
  assert.deepEqual(git(bare, 'show', '--name-only', '--format=', 'main').split('\n'), ['a.tex']);
  assert.match(git(work, 'status', '--porcelain'), /^A\s+b\.tex$/m); // b.tex still staged, not committed
});

test('pushFile with nothing new to commit just pushes pending commits', async () => {
  const { bare, work } = setup();
  writeFileSync(join(work, 'a.tex'), 'changed\n');
  git(work, 'commit', '-q', '-am', 'local only');
  await pushFile({ cwd: work, file: 'a.tex', message: 'unused' });
  assert.equal(git(bare, 'log', '--format=%s', '-1', 'main'), 'local only');
});

test('pushFile refuses a detached HEAD and a branch without an upstream', async () => {
  const { work } = setup();
  git(work, 'checkout', '-q', '-b', 'feature');
  await assert.rejects(pushFile({ cwd: work, file: 'a.tex', message: 'm' }), /no upstream/);
  git(work, 'checkout', '-q', '--detach');
  await assert.rejects(pushFile({ cwd: work, file: 'a.tex', message: 'm' }), /detached HEAD/);
});

test('pushFile surfaces the real push error (not a second, different one)', async () => {
  const { bare, work } = setup();
  const other = join(mkdtempSync(join(tmpdir(), 'olc-git-')), 'other');
  execFileSync('git', ['clone', '-q', bare, other]);
  git(other, 'config', 'user.email', 't@example.com');
  git(other, 'config', 'user.name', 'T');
  writeFileSync(join(other, 'a.tex'), 'remote change\n');
  git(other, 'commit', '-q', '-am', 'remote');
  git(other, 'push', '-q');
  writeFileSync(join(work, 'a.tex'), 'local change\n');
  await assert.rejects(pushFile({ cwd: work, file: 'a.tex', message: 'Update' }), /git push failed:[\s\S]*(rejected|fetch first|non-fast-forward)/i);
});
