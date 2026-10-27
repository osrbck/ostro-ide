const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseStatus,
  categorizeForDiscard,
  validateCommitMessage,
} = require('../src/main/ipc/git-handlers');

test('parseStatus reads the branch header with ahead/behind', () => {
  const out = [
    '## main...origin/main [ahead 1, behind 2]',
    'M  src/a.js',
    '',
  ].join('\0');
  const { branch, entries } = parseStatus(out);
  assert.equal(branch.name, 'main');
  assert.equal(branch.ahead, 1);
  assert.equal(branch.behind, 2);
  assert.equal(branch.initial, false);
  assert.equal(entries.length, 1);
});

test('parseStatus handles initial repo, detached HEAD, and no-upstream headers', () => {
  const a = parseStatus('## No commits yet on main\0');
  assert.deepEqual([a.branch.initial, a.branch.name], [true, 'main']);

  const b = parseStatus('## HEAD (no branch)\0');
  assert.deepEqual([b.branch.detached, b.branch.name], [true, 'HEAD']);

  const c = parseStatus('## feature-x\0');
  assert.deepEqual([c.branch.name, c.branch.ahead, c.branch.behind], ['feature-x', 0, 0]);
});

test('parseStatus reads the real -z rename format (separate original-path record)', () => {
  // git status --porcelain=v1 -z emits "R  newpath\0oldpath\0" — the original
  // path is its own record, NOT an inline "old -> new" arrow.
  const out = ['## main', 'R  new-name.js', 'old-name.js', ''].join('\0');
  const { entries } = parseStatus(out);
  assert.equal(entries.length, 1, 'the original-path record must not become a status entry');
  assert.equal(entries[0].path, 'new-name.js');
  assert.equal(entries[0].renamedFrom, 'old-name.js');
  assert.equal(entries[0].x, 'R');
});

test('parseStatus handles a -z copy record the same way', () => {
  const out = ['## main', 'C  copy.js', 'source.js', ' M other.js', ''].join('\0');
  const { entries } = parseStatus(out);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].renamedFrom, 'source.js');
  assert.equal(entries[1].path, 'other.js');
});

test('parseStatus classifies staged, unstaged, untracked and renamed entries', () => {
  const out = [
    '## main',
    'M  staged-modified.js',      // staged modification
    ' M unstaged-modified.js',    // unstaged modification
    'A  added.js',                // staged new file
    'MM both.js',                 // staged + further unstaged edit
    '?? untracked.js',            // untracked
    'R  new-name.js',             // rename: new path ...
    'old-name.js',                // ... followed by its own original-path record
    '',
  ].join('\0');
  const { entries } = parseStatus(out);

  const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
  assert.equal(byPath['staged-modified.js'].staged, true);
  assert.equal(byPath['staged-modified.js'].unstaged, false);
  assert.equal(byPath['unstaged-modified.js'].staged, false);
  assert.equal(byPath['unstaged-modified.js'].unstaged, true);
  assert.equal(byPath['added.js'].x, 'A');
  assert.equal(byPath['both.js'].staged, true);
  assert.equal(byPath['both.js'].unstaged, true);
  assert.equal(byPath['untracked.js'].untracked, true);
  assert.equal(byPath['new-name.js'].renamedFrom, 'old-name.js');
  assert.equal(entries.length, 6, 'original-path records must not become entries');
});

test('parseStatus tolerates empty output', () => {
  const { branch, entries } = parseStatus('');
  assert.equal(branch.name, null);
  assert.deepEqual(entries, []);
});

test('categorizeForDiscard splits entries into safe action buckets', () => {
  const cats = categorizeForDiscard([
    { path: 'a.js', x: 'M', y: ' ' },
    { path: 'b.js', x: 'M', y: 'M' },
    { path: 'new.js', x: 'A', y: ' ' },
    { path: 'ren.js', x: 'R', y: ' ' },
    { path: 'u.js', x: '?', y: '?' },
    { path: 'gone.js', x: 'D', y: ' ' },
  ]);
  assert.deepEqual(cats.modified, ['a.js', 'b.js']);
  assert.deepEqual(cats.added, ['new.js', 'ren.js']);
  assert.deepEqual(cats.untracked, ['u.js']);
  assert.deepEqual(cats.deletedStaged, ['gone.js']);
});

test('validateCommitMessage trims, rejects empty and oversized messages', () => {
  assert.equal(validateCommitMessage('  fix: thing  '), 'fix: thing');
  assert.throws(() => validateCommitMessage('   '), /required/);
  assert.throws(() => validateCommitMessage(undefined), /required/);
  assert.throws(() => validateCommitMessage('x'.repeat(501)), /too long/);
});
