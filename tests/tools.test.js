const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TOOL_DEFINITIONS, executeTool, safeResolve, safeResolveReal } = require('../src/main/agent/tools');

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ostro-tools-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('safeResolve accepts paths inside the workspace', () => {
  assert.equal(safeResolve(root, 'src/app.js'), path.join(root, 'src', 'app.js'));
  assert.equal(safeResolve(root, './a.txt'), path.join(root, 'a.txt'));
  assert.equal(safeResolve(root, '.'), path.resolve(root));
});

test('safeResolve rejects sibling-directory prefix escapes', () => {
  const sibling = `${root}-evil`;
  assert.throws(() => safeResolve(root, '../' + path.basename(sibling) + '/secret.txt'), /outside workspace/);
  assert.throws(() => safeResolve(root, sibling), /outside workspace/);
});

test('safeResolve rejects absolute paths outside the workspace', () => {
  assert.throws(() => safeResolve(root, '/etc/passwd'), /outside workspace/);
  assert.throws(() => safeResolve(root, path.resolve('/tmp')), /outside workspace/);
});

test('safeResolve accepts children when the workspace root is a filesystem root', () => {
  // POSIX "/" (on Windows the equivalent is a drive root like "C:\\").
  if (path.sep === '/') {
    assert.doesNotThrow(() => safeResolve('/', 'home/user/file.txt'));
    assert.doesNotThrow(() => safeResolve('/', '/etc/hostname'));
    assert.equal(safeResolve('/', 'tmp/x'), '/tmp/x');
  }
});

test('safeResolveReal rejects symlinks that escape the workspace', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ostro-out-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    // Symlinked file pointing outside the workspace.
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
    await assert.rejects(
      executeTool('read_file', { path: 'leak.txt' }, { workspaceRoot: root }),
      /outside workspace/
    );
    // Symlinked directory pointing outside, with a new file target inside it.
    fs.symlinkSync(outside, path.join(root, 'leakdir'));
    await assert.rejects(
      executeTool('write_file', { path: 'leakdir/new.txt', content: 'x' }, { workspaceRoot: root }),
      /outside workspace/
    );
    await assert.rejects(
      safeResolveReal(root, 'leakdir/new.txt'),
      /outside workspace/
    );
    assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false, 'must not write through the symlink');
    // Multi-level nonexistent path: only one level used to be resolved, so
    // "leakdir/new/sub/file.txt" slipped through the lexical form.
    await assert.rejects(
      executeTool('write_file', { path: 'leakdir/new/sub/file.txt', content: 'x' }, { workspaceRoot: root }),
      /outside workspace/
    );
    assert.equal(fs.existsSync(path.join(outside, 'new')), false, 'must not mkdir through the symlink');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('safeResolveReal allows symlinks that stay inside the workspace', async () => {
  fs.mkdirSync(path.join(root, 'real'));
  fs.writeFileSync(path.join(root, 'real', 'inner.txt'), 'inner');
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
  const result = await executeTool('read_file', { path: 'alias/inner.txt' }, { workspaceRoot: root });
  assert.equal(result.content, 'inner');
});

test('safeResolveReal rejects dangling symlinks pointing outside the workspace', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ostro-dangling-'));
  try {
    // Dangling symlink: its target does not exist (yet) outside the workspace.
    fs.symlinkSync(path.join(outside, 'newly-created.txt'), path.join(root, 'dangle.txt'));
    await assert.rejects(
      executeTool('write_file', { path: 'dangle.txt', content: 'escape' }, { workspaceRoot: root }),
      /outside workspace/
    );
    assert.equal(fs.existsSync(path.join(outside, 'newly-created.txt')), false, 'must not create the outside target');

    // Dangling symlink DIRECTORY with a new file several levels below it.
    fs.symlinkSync(path.join(outside, 'never'), path.join(root, 'dangle-dir'));
    await assert.rejects(
      executeTool('write_file', { path: 'dangle-dir/new/sub/file.txt', content: 'escape' }, { workspaceRoot: root }),
      /outside workspace/
    );
    assert.equal(fs.existsSync(path.join(outside, 'never')), false, 'must not create the outside dir');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('safeResolveReal allows dangling symlinks pointing inside the workspace', async () => {
  fs.symlinkSync(path.join(root, 'future.txt'), path.join(root, 'inside-dangle.txt'));
  const result = await executeTool('write_file', { path: 'inside-dangle.txt', content: 'ok' }, { workspaceRoot: root });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'future.txt'), 'utf8'), 'ok');
});

test('safeResolveReal writes through a dangling symlink DIR to the resolved target (no path duplication)', async () => {
  // Regression for Chimera 73c43f87 (reported target/target duplication):
  // a dangling symlink dir with new files several levels below it must
  // land under the resolved target, reconstructed exactly once.
  fs.symlinkSync(path.join(root, 'real-dir'), path.join(root, 'dangle-dir'));
  const result = await executeTool('write_file', { path: 'dangle-dir/new/sub/file.txt', content: 'deep' }, { workspaceRoot: root });
  assert.equal(result.ok, true);
  const expected = path.join(root, 'real-dir', 'new', 'sub', 'file.txt');
  assert.equal(fs.readFileSync(expected, 'utf8'), 'deep');
  assert.equal(fs.existsSync(path.join(root, 'real-dir', 'real-dir')), false, 'must not duplicate the target component');
});

test('safeResolveReal resolves chained dangling symlinks without duplication', async () => {
  fs.symlinkSync(path.join(root, 'link2'), path.join(root, 'link1'));
  fs.symlinkSync(path.join(root, 'deep.txt'), path.join(root, 'link2'));
  const resolved = await safeResolveReal(root, 'link1');
  assert.equal(resolved, path.join(root, 'deep.txt'));

  const result = await executeTool('write_file', { path: 'link1', content: 'chain' }, { workspaceRoot: root });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'deep.txt'), 'utf8'), 'chain');
  assert.equal(fs.statSync(path.join(root, 'deep.txt')).isFile(), true);
});

test('safeResolveReal works when the workspace root itself is a symlink', async () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'ostro-real-'));
  const link = path.join(os.tmpdir(), `ostro-link-${Date.now()}`);
  fs.symlinkSync(real, link);
  try {
    // Existing file read through the symlinked root.
    fs.writeFileSync(path.join(real, 'data.txt'), 'via-link');
    const read = await executeTool('read_file', { path: 'data.txt' }, { workspaceRoot: link });
    assert.equal(read.content, 'via-link');

    // New file creation inside the symlinked root.
    const write = await executeTool('write_file', { path: 'brand/new.txt', content: 'created' }, { workspaceRoot: link });
    assert.equal(write.ok, true);
    assert.equal(fs.readFileSync(path.join(real, 'brand', 'new.txt'), 'utf8'), 'created');

    // Escapes are still rejected from a symlinked root.
    await assert.rejects(
      executeTool('write_file', { path: '../escape.txt', content: 'x' }, { workspaceRoot: link }),
      /outside workspace/
    );
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(link, { force: true });
  }
});

test('read_file / write_file / list_dir roundtrip', async () => {
  await executeTool('write_file', { path: 'notes/hello.txt', content: 'hi there' }, { workspaceRoot: root });
  const read = await executeTool('read_file', { path: 'notes/hello.txt' }, { workspaceRoot: root });
  assert.equal(read.content, 'hi there');

  const dir = await executeTool('list_dir', { path: 'notes' }, { workspaceRoot: root });
  assert.deepEqual(dir.entries, [{ name: 'hello.txt', isDir: false }]);
});

test('write_file requires approval and honors reject', async () => {
  await assert.rejects(
    executeTool('write_file', { path: 'x.txt', content: 'no' }, {
      workspaceRoot: root,
      requestApproval: async () => ({ action: 'reject' }),
      toolUseId: 't1',
    }),
    /rejected/
  );
  assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
});

test('write_file honors edited approval content', async () => {
  const result = await executeTool('write_file', { path: 'x.txt', content: 'original' }, {
    workspaceRoot: root,
    requestApproval: async () => ({ action: 'edit', content: 'edited' }),
    toolUseId: 't2',
  });
  assert.equal(result.edited, true);
  assert.equal(fs.readFileSync(path.join(root, 'x.txt'), 'utf8'), 'edited');
});

test('write_file detects no-op writes', async () => {
  await executeTool('write_file', { path: 'same.txt', content: 'stable' }, { workspaceRoot: root });
  const result = await executeTool('write_file', { path: 'same.txt', content: 'stable' }, { workspaceRoot: root });
  assert.equal(result.unchanged, true);
});

test('run_command executes and reports exit code', async () => {
  const ok = await executeTool('run_command', { command: 'printf hello' }, { workspaceRoot: root });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, 'hello');

  const fail = await executeTool('run_command', { command: 'exit 3' }, { workspaceRoot: root });
  assert.equal(fail.exitCode, 3);
});

test('run_command approval can amend the command', async () => {
  const result = await executeTool('run_command', { command: 'printf original' }, {
    workspaceRoot: root,
    requestApproval: async () => ({ action: 'edit', command: 'printf amended' }),
    toolUseId: 't3',
  });
  assert.equal(result.stdout, 'amended');
});

test('run_command approval reject stops execution', async () => {
  await assert.rejects(
    executeTool('run_command', { command: 'printf nope' }, {
      workspaceRoot: root,
      requestApproval: async () => ({ action: 'reject' }),
      toolUseId: 't4',
    }),
    /rejected/
  );
});

test('search_files finds matches with file and line', async () => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const TARGET = 1;\nconst other = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'nothing here\n');
  fs.writeFileSync(path.join(root, 'skip.pyc'), Buffer.from([0x00, 0x01])); // binary — must be skipped

  const result = await executeTool('search_files', { pattern: 'target' }, { workspaceRoot: root });
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0], /src\/a\.js:1: const TARGET = 1;/);
});

test('search_files respects extension filter and rejects invalid regex', async () => {
  fs.writeFileSync(path.join(root, 'a.js'), 'target\n');
  fs.writeFileSync(path.join(root, 'a.py'), 'target\n');

  const filtered = await executeTool('search_files', { pattern: 'target', glob: '.py' }, { workspaceRoot: root });
  assert.equal(filtered.matches.length, 1);
  assert.match(filtered.matches[0], /a\.py/);

  await assert.rejects(
    executeTool('search_files', { pattern: '(' }, { workspaceRoot: root }),
    /Invalid regex/
  );
});

test('tool definitions advertise all five harness tools', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  assert.deepEqual(names.sort(), ['list_dir', 'read_file', 'run_command', 'search_files', 'write_file']);
});
