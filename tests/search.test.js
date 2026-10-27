const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildSearchRegex,
  replaceAllInContent,
  UI_SEARCH_LIMITS,
} = require('../src/main/ipc/search-handlers');
const { runSearchWorker, SEARCH_LIMITS } = require('../src/main/agent/tools');

// ---------------------------------------------------------------------------
// buildSearchRegex
// ---------------------------------------------------------------------------

test('buildSearchRegex escapes plain-text queries (dots/brackets match literally)', () => {
  const re = buildSearchRegex({ query: 'a.b(c)*', regex: false });
  assert.equal('a.b(c)*'.match(re)[0], 'a.b(c)*');
  assert.equal(re.test('axbyc'), false);
});

test('buildSearchRegex honors regex mode, case sensitivity and whole word', () => {
  // NOTE: g-flagged regexes are stateful (test() advances lastIndex), so
  // each assertion uses String.match on a fresh check instead.
  assert.equal('color code'.match(buildSearchRegex({ query: 'colou?r', regex: true }))[0], 'color');
  assert.equal('colour code'.match(buildSearchRegex({ query: 'colou?r', regex: true }))[0], 'colour');

  assert.equal('FOO bar'.match(buildSearchRegex({ query: 'FOO', caseSensitive: true })) !== null, true);
  assert.equal('foo bar'.match(buildSearchRegex({ query: 'FOO', caseSensitive: true })), null);

  assert.equal('foo bar'.match(buildSearchRegex({ query: 'FOO' })) !== null, true, 'case-insensitive by default');

  assert.equal('the log file'.match(buildSearchRegex({ query: 'log', wholeWord: true }))[0], 'log');
  assert.equal('logger'.match(buildSearchRegex({ query: 'log', wholeWord: true })), null);
});

test('buildSearchRegex always builds a GLOBAL regex and rejects invalid ones', () => {
  assert.equal(buildSearchRegex({ query: 'x' }).global, true, 'replace needs the g flag');
  assert.throws(() => buildSearchRegex({ query: '(', regex: true }), /Invalid regular expression/);
  assert.throws(() => buildSearchRegex({ query: '' }), /Empty search query/);
});

// ---------------------------------------------------------------------------
// replaceAllInContent (pure)
// ---------------------------------------------------------------------------

test('replaceAllInContent counts and applies replacements with $-semantics', () => {
  const r1 = replaceAllInContent('foo bar foo', /foo/g, 'baz');
  assert.equal(r1.count, 2);
  assert.equal(r1.content, 'baz bar baz');

  // Capture groups and whole-match references work like String.replace.
  const r2 = replaceAllInContent('v1.2 v1.3', /v(\d)\.(\d)/g, 'v$2.$1');
  assert.equal(r2.content, 'v2.1 v3.1');
  assert.equal(r2.count, 2);

  const r3 = replaceAllInContent('abc', /(b)/g, '[$&]');
  assert.equal(r3.content, 'a[b]c');
});

test('replaceAllInContent returns null content for untouched input', () => {
  const r = replaceAllInContent('nothing here', /zzz/g, 'x');
  assert.equal(r.content, null);
  assert.equal(r.count, 0);
});

// ---------------------------------------------------------------------------
// Worker integration: ranges + multi-match per line
// ---------------------------------------------------------------------------

function makeWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ostro-search-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const UI_LIMITS = { ...UI_SEARCH_LIMITS };

test('worker returns per-line match ranges relative to the trimmed text', async () => {
  const root = makeWorkspace({
    'a.js': 'const TARGET = 1;\n  const TARGET2 = TARGET + TARGET;\n',
  });
  try {
    const { matches } = await runSearchWorker(root, {
      pattern: 'TARGET\\d?',
      flags: '',
      extFilter: null,
      limits: UI_LIMITS,
    });
    assert.equal(matches.length, 2);

    const line1 = matches.find((m) => m.line === 1);
    assert.equal(line1.text, 'const TARGET = 1;');
    assert.deepEqual(line1.ranges, [[6, 12]], 'one match, span within the trimmed line');

    // Indented line: ranges must be relative to the TRIMMED text.
    const line2 = matches.find((m) => m.line === 2);
    assert.equal(line2.text, 'const TARGET2 = TARGET + TARGET;');
    assert.deepEqual(line2.ranges, [[6, 13], [16, 22], [25, 31]], 'all three matches with their spans');
    // The reported spans must select exactly the matched text.
    for (const [s, e] of line2.ranges) {
      assert.match(line2.text.slice(s, e), /^TARGET\d?$/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker ranges respect the per-line cap and agent mode omits ranges', async () => {
  const root = makeWorkspace({
    'many.js': 'a a a a a a a a a a a a a a a a a a a a a a a a a a a a\n',
    'agent.js': 'hello world\n',
  });
  try {
    const { matches } = await runSearchWorker(root, {
      pattern: 'a',
      flags: '',
      extFilter: 'many.js',
      limits: { ...UI_LIMITS, maxPerLine: 5 },
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].ranges.length, 5, 'per-line range cap applies');

    // The agent's compact mode: no ranges field at all.
    const agent = await runSearchWorker(root, {
      pattern: 'hello',
      flags: '',
      extFilter: 'agent.js',
      limits: { ...SEARCH_LIMITS, ranges: false },
    });
    assert.equal(agent.matches[0].text, 'hello world');
    assert.equal('ranges' in agent.matches[0], false, 'agent mode must not compute ranges');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end: find → replaceAll over a temp workspace (same building blocks
// the IPC handlers use, containment included)
// ---------------------------------------------------------------------------

test('find → replaceAll cycle rewrites only matched files, exactly like the handler', async () => {
  const { safeResolveReal } = require('../src/main/agent/tools');
  const root = makeWorkspace({
    'src/one.js': 'TODO: first\nkeep me\nTODO: second\n',
    'src/two.js': 'nothing to see\n',
    'src/three.txt': 'TODO in txt\n',
  });
  try {
    // --- search:find equivalent ---
    const re = buildSearchRegex({ query: 'TODO:?', regex: true });
    const found = await runSearchWorker(root, {
      pattern: re.source,
      flags: re.flags.replace('g', ''),
      extFilter: null,
      limits: UI_LIMITS,
    });
    assert.equal(found.matches.length, 3);
    const files = [...new Set(found.matches.map((m) => m.rel))];
    assert.deepEqual(files.sort(), ['src/one.js', 'src/three.txt']);

    // --- search:replaceAll equivalent (per-file, containment-checked) ---
    const results = [];
    let total = 0;
    for (const rel of files) {
      const abs = await safeResolveReal(root, rel); // containment like the handler
      const content = fs.readFileSync(abs, 'utf8');
      const { content: next, count } = replaceAllInContent(content, re, 'DONE');
      if (next === null) continue;
      fs.writeFileSync(abs, next, 'utf8');
      results.push({ path: rel, count, changed: true });
      total += count;
    }

    assert.equal(total, 3);
    assert.equal(fs.readFileSync(path.join(root, 'src/one.js'), 'utf8'), 'DONE first\nkeep me\nDONE second\n');
    assert.equal(fs.readFileSync(path.join(root, 'src/three.txt'), 'utf8'), 'DONE in txt\n');
    assert.equal(fs.readFileSync(path.join(root, 'src/two.js'), 'utf8'), 'nothing to see\n', 'untouched file stays untouched');

    // --- re-running the search finds nothing (results refresh to empty) ---
    const after = await runSearchWorker(root, {
      pattern: re.source,
      flags: re.flags.replace('g', ''),
      extFilter: null,
      limits: UI_LIMITS,
    });
    assert.equal(after.matches.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plain-text (non-regex) end-to-end search escapes metacharacters', async () => {
  const root = makeWorkspace({
    'cfg.js': 'const url = "https://x.io/a?q=1";\nconst plain = "a.b";\n',
  });
  try {
    const re = buildSearchRegex({ query: 'a?q=1', regex: false });
    assert.equal(re.source, 'a\\?q=1', 'metacharacters are escaped in plain mode');
    const found = await runSearchWorker(root, {
      pattern: re.source,
      flags: re.flags.replace('g', ''),
      extFilter: null,
      limits: UI_LIMITS,
    });
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0].line, 1);
    // 'const url = "https://x.io/' is 26 chars, then 'a?q=1' spans 5 more.
    assert.deepEqual(found.matches[0].ranges, [[26, 31]]);
    assert.equal(found.matches[0].text.slice(26, 31), 'a?q=1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
