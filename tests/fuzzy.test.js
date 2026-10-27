const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fuzzyMatch, highlight } = require('../src/renderer/components/fuzzy.js');

test('fuzzyMatch returns null on no match, object on match', () => {
  assert.equal(fuzzyMatch('xyz', 'src/app.js'), null);
  const m = fuzzyMatch('app', 'src/app.js');
  assert.ok(m);
  assert.deepEqual(m.positions, [4, 5, 6]);
});

test('fuzzyMatch prefers consecutive matches over scattered ones', () => {
  // Non-boundary contexts so the boundary bonus does not dominate.
  const scattered = fuzzyMatch('abc', 'xaxbxcx');
  const consecutive = fuzzyMatch('abc', 'xxabcxx');
  assert.ok(consecutive.score > scattered.score, `consecutive (${consecutive.score}) should outscore scattered (${scattered.score})`);
});

test('fuzzyMatch is case-insensitive', () => {
  const m = fuzzyMatch('APP', 'src/app.js');
  assert.ok(m);
});

test('highlight escapes HTML in unmatched text', () => {
  const out = highlight('<script>&', []);
  assert.equal(out, '&lt;script&gt;&amp;');
  assert.ok(!out.includes('<script'));
});

test('highlight wraps matched positions in <mark>', () => {
  const out = highlight('app', [0, 1, 2]);
  assert.equal(out, '<mark>a</mark><mark>p</mark><mark>p</mark>');
});

test('empty needle matches everything with zero score', () => {
  const m = fuzzyMatch('', 'anything');
  assert.deepEqual(m, { score: 0, positions: [] });
});
