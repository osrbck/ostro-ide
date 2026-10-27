const path = require('path');
const { app } = require('electron');

const { ExtensionHost } = require('../extensions/host');

function registerExtensionHandlers(ipcMain, { getMainWindow }) {
  let host = null;

  function extensionsRoot() {
    return path.join(app.getPath('userData'), 'extensions');
  }

  function emit(state) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('extensions:state', state);
  }

  ipcMain.handle('extensions:activate', () => {
    if (!host) {
      host = new ExtensionHost({
        rootDir: extensionsRoot(),
        emit,
        logger: (...args) => console.log(...args),
      });
    } else {
      host.deactivateAll();
    }
    const list = host.activateAll();
    return {
      root: extensionsRoot(),
      list,
      commands: host.listCommands(),
      statusItems: host.listStatusItems(),
    };
  });

  ipcMain.handle('extensions:list', () => ({
    root: extensionsRoot(),
    list: host ? host.list() : [],
    commands: host ? host.listCommands() : [],
    statusItems: host ? host.listStatusItems() : [],
  }));

  ipcMain.handle('extensions:executeCommand', async (_evt, id) => {
    if (!host) throw new Error('Extensions are not active');
    return host.executeCommand(id);
  });

  // Lifecycle forwarding from the renderer (isolation preserved: a throwing
  // extension handler never reaches the renderer).
  ipcMain.handle('extensions:fire', (_evt, { name, payload }) => {
    if (!host) return false;
    if (!['workspaceOpen', 'fileOpen', 'fileSave', 'command'].includes(name)) return false;
    host.fire(name, payload);
    return true;
  });
}

module.exports = { registerExtensionHandlers };
