const os = require('os');

let pty;
try {
  pty = require('node-pty');
} catch {
  pty = null;
}

const sessions = new Map();

function registerTerminalHandlers(ipcMain, { getMainWindow }) {
  ipcMain.handle('terminal:create', (_evt, opts = {}) => {
    if (!pty) throw new Error('node-pty not available — run electron-rebuild');
    const shell = opts.shell || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash');
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: opts.cwd || os.homedir(),
      env: process.env,
    });
    sessions.set(id, proc);

    proc.onData((data) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('terminal:data', { id, data });
    });
    proc.onExit(({ exitCode }) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('terminal:exit', { id, exitCode });
      sessions.delete(id);
    });

    return { id };
  });

  ipcMain.handle('terminal:write', (_evt, { id, data }) => {
    sessions.get(id)?.write(data);
    return true;
  });

  ipcMain.handle('terminal:resize', (_evt, { id, cols, rows }) => {
    sessions.get(id)?.resize(cols, rows);
    return true;
  });

  ipcMain.handle('terminal:kill', (_evt, id) => {
    sessions.get(id)?.kill();
    sessions.delete(id);
    return true;
  });
}

module.exports = { registerTerminalHandlers };
