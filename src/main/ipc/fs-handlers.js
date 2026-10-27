const fs = require('fs/promises');
const path = require('path');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', '.cache', '.venv', '__pycache__', 'target']);
const MAX_INDEX_FILES = 50_000;

function registerFsHandlers(ipcMain) {
  ipcMain.handle('fs:readDir', async (_evt, dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.git') && e.name !== 'node_modules')
      .map((e) => ({
        name: e.name,
        path: path.join(dir, e.name),
        isDir: e.isDirectory(),
      }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  });

  ipcMain.handle('fs:readFile', async (_evt, p) => {
    const buf = await fs.readFile(p);
    // Refuse likely-binary files (NUL byte in the first 8KB) so the editor
    // does not silently render mojibake for images/executables.
    if (buf.subarray(0, 8000).includes(0)) {
      const err = new Error('Cannot open binary file in the text editor');
      err.code = 'EBINARY';
      throw err;
    }
    return buf.toString('utf8');
  });

  ipcMain.handle('fs:writeFile', async (_evt, { path: p, content }) => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
    return true;
  });

  ipcMain.handle('fs:createFile', async (_evt, p) => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, '', { flag: 'wx' });
    return true;
  });

  ipcMain.handle('fs:mkdir', async (_evt, p) => {
    await fs.mkdir(p, { recursive: true });
    return true;
  });

  ipcMain.handle('fs:deleteEntry', async (_evt, p) => {
    await fs.rm(p, { recursive: true, force: true });
    return true;
  });

  ipcMain.handle('fs:rename', async (_evt, { from, to }) => {
    await fs.rename(from, to);
    return true;
  });

  ipcMain.handle('fs:stat', async (_evt, p) => {
    const s = await fs.stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() };
  });

  ipcMain.handle('fs:indexWorkspace', async (_evt, root) => {
    const results = [];
    async function walk(dir) {
      if (results.length >= MAX_INDEX_FILES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.git') && e.isDirectory()) continue;
        if (IGNORE_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          results.push({ path: full, name: e.name, rel: path.relative(root, full) });
          if (results.length >= MAX_INDEX_FILES) return;
        }
      }
    }
    await walk(root);
    return results;
  });
}

module.exports = { registerFsHandlers };
