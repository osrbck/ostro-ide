// Minimal local extension host.
//
// Extensions are plain CommonJS folders under <userData>/extensions/<name>/
// whose package.json "main" (default index.js) exports:
//
//   module.exports = {
//     activate(api) { ... },   // optional
//     deactivate() { ... },    // optional
//   }
//
// Each extension gets a small, stable API. Loading is isolated: a throwing
// extension is recorded as failed and never takes down the app. Contributions
// (commands, status-bar items) are forwarded to the renderer over IPC.
//
// Deliberately NOT supported yet (documented): marketplace install,
// activation events beyond the four lifecycle hooks, webviews, language
// servers. This is a hook surface for local extensions, not VS Code parity.

const fs = require('fs');
const path = require('path');

const HOST_VERSION = '1.0.0';
const MAX_STATUS_ITEMS = 50;

function readManifest(dir) {
  const pkgPath = path.join(dir, 'package.json');
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    pkg = {};
  }
  return {
    name: pkg.name || path.basename(dir),
    version: pkg.version || '0.0.0',
    description: pkg.description || '',
    main: pkg.main || 'index.js',
  };
}

// Enumerate extension directories without activating them.
function discoverExtensions(rootDir) {
  if (!rootDir) return [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const dir = path.join(rootDir, e.name);
    const manifest = readManifest(dir);
    found.push({ ...manifest, dir, entry: path.join(dir, manifest.main), id: e.name });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

// Validate that an extension entry point stays inside its own directory.
function isContainedExtensionPath(dir, entry) {
  const root = path.resolve(dir);
  const full = path.resolve(entry);
  return full === root || full.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

class ExtensionHost {
  constructor({ rootDir, emit, logger } = {}) {
    this.rootDir = rootDir;
    this.emit = emit || (() => {});
    this.logger = logger || (() => {});
    this.commands = new Map(); // id -> { id, title, handler, extensionId }
    this.statusItems = new Map(); // id -> { id, text, extensionId }
    this.loaded = []; // { id, name, version, description, ok, error? }
    this.activated = new Map(); // extensionId -> api
    this.seq = 0;
  }

  // ---- API surface handed to each extension ----

  makeApi(extensionId, manifest) {
    const host = this;

    const api = {
      version: HOST_VERSION,
      extension: { id: extensionId, name: manifest.name, version: manifest.version },

      log(...args) {
        host.logger(`[ext:${extensionId}]`, ...args);
      },

      // Register a palette command. `title` is what the palette shows.
      registerCommand(id, title, handler) {
        if (typeof id !== 'string' || !id.trim()) throw new Error('registerCommand: id is required');
        if (typeof handler !== 'function') throw new Error('registerCommand: handler must be a function');
        const fullId = `${extensionId}.${id}`;
        if (host.commands.has(fullId)) throw new Error(`Command already registered: ${fullId}`);
        host.commands.set(fullId, {
          id: fullId,
          title: String(title || id),
          handler,
          extensionId,
        });
        host.emitContributions();
        return fullId;
      },

      // Small status-bar message. Returns a handle with setText/dispose.
      createStatusBarItem(text, tooltip) {
        if (host.statusItems.size >= MAX_STATUS_ITEMS) {
          throw new Error('Too many status bar items');
        }
        const id = `${extensionId}.status.${host.seq++}`;
        host.statusItems.set(id, { id, text: String(text || ''), tooltip: String(tooltip || ''), extensionId });
        host.emitContributions();
        return {
          setText(next) {
            const item = host.statusItems.get(id);
            if (item) {
              item.text = String(next || '');
              host.emitContributions();
            }
          },
          setTooltip(next) {
            const item = host.statusItems.get(id);
            if (item) {
              item.tooltip = String(next || '');
              host.emitContributions();
            }
          },
          dispose() {
            if (host.statusItems.delete(id)) host.emitContributions();
          },
        };
      },

      // Lifecycle hooks (renderer forwards these events).
      onWorkspaceOpen(cb) { host.hook(extensionId, 'workspaceOpen', cb); },
      onFileOpen(cb) { host.hook(extensionId, 'fileOpen', cb); },
      onFileSave(cb) { host.hook(extensionId, 'fileSave', cb); },
      onCommand(cb) { host.hook(extensionId, 'command', cb); },
    };

    return api;
  }

  hook(extensionId, name, cb) {
    if (typeof cb !== 'function') return;
    if (!this.hooks) this.hooks = new Map();
    const key = `${extensionId}:${name}`;
    const list = this.hooks.get(key) || [];
    list.push(cb);
    this.hooks.set(key, list);
  }

  // ---- Lifecycle ----

  activateAll() {
    const found = discoverExtensions(this.rootDir);
    for (const ext of found) {
      this.loaded.push({
        id: ext.id,
        name: ext.name,
        version: ext.version,
        description: ext.description,
        ok: true,
      });
      if (!isContainedExtensionPath(ext.dir, ext.entry)) {
        this.markFailed(ext.id, 'Entry point escapes the extension directory');
        continue;
      }
      if (!fs.existsSync(ext.entry)) {
        this.markFailed(ext.id, `Entry point not found: ${path.basename(ext.entry)}`);
        continue;
      }
      try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const mod = require(ext.entry);
        const api = this.makeApi(ext.id, ext);
        this.activated.set(ext.id, { mod, api });
        if (typeof mod?.activate === 'function') {
          mod.activate(api);
        }
      } catch (err) {
        this.markFailed(ext.id, err.message);
      }
    }
    this.emitContributions();
    return this.list();
  }

  markFailed(id, message) {
    const rec = this.loaded.find((e) => e.id === id);
    if (rec) {
      rec.ok = false;
      rec.error = String(message).slice(0, 300);
    }
    this.logger(`[ext:${id}] failed to activate: ${message}`);
    // Roll back any partial contributions from the failed extension.
    for (const [cmdId, cmd] of [...this.commands]) {
      if (cmd.extensionId === id) this.commands.delete(cmdId);
    }
    for (const [itemId, item] of [...this.statusItems]) {
      if (item.extensionId === id) this.statusItems.delete(itemId);
    }
  }

  deactivateAll() {
    for (const [id, { mod }] of this.activated) {
      try {
        mod?.deactivate?.();
      } catch (err) {
        this.logger(`[ext:${id}] deactivate threw: ${err.message}`);
      }
    }
    this.activated.clear();
    this.commands.clear();
    this.statusItems.clear();
    this.hooks?.clear();
  }

  // ---- Contributions ----

  list() {
    return this.loaded.map((e) => ({ ...e }));
  }

  listCommands() {
    return [...this.commands.values()].map((c) => ({
      id: c.id, title: c.title, extensionId: c.extensionId,
    }));
  }

  listStatusItems() {
    return [...this.statusItems.values()].map((s) => ({ ...s }));
  }

  emitContributions() {
    this.emit({
      commands: this.listCommands(),
      statusItems: this.listStatusItems(),
      extensions: this.list(),
    });
  }

  // ---- Dispatch ----

  async executeCommand(id) {
    const cmd = this.commands.get(id);
    if (!cmd) throw new Error(`Unknown extension command: ${id}`);
    try {
      return await cmd.handler();
    } catch (err) {
      this.logger(`[ext:${cmd.extensionId}] command ${id} threw: ${err.message}`);
      throw err;
    }
  }

  // Fire a lifecycle event to every extension, isolating failures.
  fire(name, payload) {
    if (!this.hooks) return;
    for (const [key, callbacks] of this.hooks) {
      if (!key.endsWith(`:${name}`)) continue;
      const extensionId = key.slice(0, key.lastIndexOf(':'));
      for (const cb of callbacks) {
        try {
          cb(payload);
        } catch (err) {
          this.logger(`[ext:${extensionId}] ${name} handler threw: ${err.message}`);
        }
      }
    }
  }
}

module.exports = {
  HOST_VERSION,
  ExtensionHost,
  discoverExtensions,
  isContainedExtensionPath,
};
