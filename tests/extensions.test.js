const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HOST_VERSION,
  ExtensionHost,
  discoverExtensions,
  isContainedExtensionPath,
} = require('../src/main/extensions/host');

// Builds an extensions root with the given {name: {manifest, code}} map.
function makeExtRoot(exts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ostro-ext-'));
  for (const [name, spec] of Object.entries(exts)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (spec.manifest) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(spec.manifest));
    if (spec.code !== undefined) fs.writeFileSync(path.join(dir, spec.manifest?.main || 'index.js'), spec.code);
  }
  return root;
}

test('discoverExtensions reads manifests and defaults', () => {
  const root = makeExtRoot({
    alpha: { manifest: { name: 'alpha-ext', version: '1.2.3', description: 'first', main: 'main.js' }, code: '' },
    beta: { code: '' }, // no manifest → defaults to index.js + folder name
  });
  try {
    const found = discoverExtensions(root);
    const alpha = found.find((e) => e.id === 'alpha');
    const beta = found.find((e) => e.id === 'beta');
    assert.equal(alpha.name, 'alpha-ext');
    assert.equal(alpha.version, '1.2.3');
    assert.equal(alpha.description, 'first');
    assert.equal(alpha.main, 'main.js');
    assert.equal(beta.main, 'index.js');
    assert.equal(beta.version, '0.0.0');
    assert.ok(fs.existsSync(alpha.entry));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discoverExtensions returns empty for missing root and skips node_modules/hidden', () => {
  assert.deepEqual(discoverExtensions('/definitely/not/here'), []);
  const root = makeExtRoot({ '.hidden': { code: '' }, node_modules: { code: '' }, ok: { code: '' } });
  try {
    assert.deepEqual(discoverExtensions(root).map((e) => e.id), ['ok']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isContainedExtensionPath blocks traversal outside the extension dir', () => {
  assert.equal(isContainedExtensionPath('/a/b/ext', '/a/b/ext/index.js'), true);
  assert.equal(isContainedExtensionPath('/a/b/ext', '/a/b/ext/nested/deep.js'), true);
  assert.equal(isContainedExtensionPath('/a/b/ext', '/a/b/ext-evil/index.js'), false);
  assert.equal(isContainedExtensionPath('/a/b/ext', '/etc/passwd'), false);
});

test('a good extension activates and contributes commands + status items', () => {
  const root = makeExtRoot({
    good: {
      manifest: { name: 'good', version: '1.0.0' },
      code: `module.exports = {
        activate(api) {
          api.registerCommand('hello', 'Say Hello', () => 'hi from ext');
          api.createStatusBarItem('EXT ✓', 'extension loaded');
        }
      };`,
    },
  });
  const emitted = [];
  const host = new ExtensionHost({ rootDir: root, emit: (s) => emitted.push(s) });
  try {
    const list = host.activateAll();
    assert.equal(list.length, 1);
    assert.equal(list[0].ok, true);
    const cmds = host.listCommands();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].id, 'good.hello');
    assert.equal(cmds[0].title, 'Say Hello');
    assert.equal(host.listStatusItems().length, 1);
    assert.equal(host.listStatusItems()[0].text, 'EXT ✓');
    assert.ok(emitted.length >= 1, 'contributions are emitted');
    assert.equal(HOST_VERSION, '1.0.0');
  } finally {
    host.deactivateAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a throwing extension is isolated and its partial contributions roll back', () => {
  const root = makeExtRoot({
    broken: {
      code: `module.exports = { activate(api) {
        api.registerCommand('ok', 'Registered First', () => 1);
        throw new Error('boom during activate');
      } };`,
    },
    fine: {
      code: `module.exports = { activate(api) { api.registerCommand('alive', 'Still Here', () => 2); } };`,
    },
  });
  const host = new ExtensionHost({ rootDir: root });
  try {
    const list = host.activateAll();
    const broken = list.find((e) => e.id === 'broken');
    const fine = list.find((e) => e.id === 'fine');
    assert.equal(broken.ok, false);
    assert.match(broken.error, /boom during activate/);
    assert.equal(fine.ok, true);
    assert.equal(host.listCommands().some((c) => c.extensionId === 'broken'), false, 'partial contributions removed');
    assert.equal(host.listCommands().some((c) => c.extensionId === 'fine'), true);
  } finally {
    host.deactivateAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing entry point and escaping manifest main are reported as failures', () => {
  const root = makeExtRoot({
    missing: { manifest: { main: 'nope.js' } },
    escape: { manifest: { main: '../../../etc/passwd' } },
  });
  const host = new ExtensionHost({ rootDir: root });
  try {
    const list = host.activateAll();
    assert.equal(list.find((e) => e.id === 'missing').ok, false);
    assert.match(list.find((e) => e.id === 'missing').error, /not found/i);
    assert.equal(list.find((e) => e.id === 'escape').ok, false);
    assert.match(list.find((e) => e.id === 'escape').error, /escapes/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeCommand runs the handler and surfaces handler errors', async () => {
  const root = makeExtRoot({
    run: {
      code: `module.exports = { activate(api) {
        api.registerCommand('works', 'Works', async () => 'result-value');
        api.registerCommand('fails', 'Fails', () => { throw new Error('handler exploded'); });
      } };`,
    },
  });
  const host = new ExtensionHost({ rootDir: root });
  try {
    host.activateAll();
    assert.equal(await host.executeCommand('run.works'), 'result-value');
    await assert.rejects(host.executeCommand('run.fails'), /handler exploded/);
    await assert.rejects(host.executeCommand('run.nonexistent'), /Unknown extension command/);
  } finally {
    host.deactivateAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate command ids within one extension are rejected', () => {
  const root = makeExtRoot({
    dup: {
      code: `module.exports = { activate(api) {
        api.registerCommand('same', 'One', () => 1);
        api.registerCommand('same', 'Two', () => 2);
      } };`,
    },
  });
  const host = new ExtensionHost({ rootDir: root });
  try {
    const list = host.activateAll();
    assert.equal(list[0].ok, false);
    assert.match(list[0].error, /already registered/);
  } finally {
    host.deactivateAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle hooks fire only to registered extensions and isolate throws', () => {
  const root = makeExtRoot({
    listener: {
      code: `module.exports = { activate(api) {
        api.onFileOpen((f) => { global.__ostroTestSeen = f; });
        api.onFileSave(() => { throw new Error('save hook exploded'); });
      } };`,
    },
  });
  const host = new ExtensionHost({ rootDir: root });
  try {
    host.activateAll();
    global.__ostroTestSeen = null;
    host.fire('fileOpen', '/tmp/x.js');
    assert.equal(global.__ostroTestSeen, '/tmp/x.js');
    assert.doesNotThrow(() => host.fire('fileSave', '/tmp/x.js'), 'a throwing hook must not propagate');
    delete global.__ostroTestSeen;
  } finally {
    host.deactivateAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status bar items cap out and can be disposed', () => {
  const root = makeExtRoot({
    many: {
      code: `module.exports = { activate(api) {
        global.__ostroItem = api.createStatusBarItem('first', 'tip');
        global.__ostroItem.setText('updated');
      } };`,
    },
  });
  const host = new ExtensionHost({ rootDir: root });
  try {
    host.activateAll();
    const items = host.listStatusItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].text, 'updated');
    global.__ostroItem.dispose();
    assert.equal(host.listStatusItems().length, 0);
    delete global.__ostroItem;
  } finally {
    host.deactivateAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deactivateAll calls extension deactivate and clears contributions', () => {
  const root = makeExtRoot({
    life: {
      code: `module.exports = {
        activate(api) { api.registerCommand('c', 'C', () => 1); },
        deactivate() { global.__ostroDeactivated = true; },
      };`,
    },
  });
  const host = new ExtensionHost({ rootDir: root });
  try {
    host.activateAll();
    assert.equal(host.listCommands().length, 1);
    host.deactivateAll();
    assert.equal(global.__ostroDeactivated, true);
    assert.equal(host.listCommands().length, 0);
    delete global.__ostroDeactivated;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
