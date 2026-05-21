const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fssync = require('fs');
const chokidar = require('chokidar');

const { registerFsHandlers } = require('./ipc/fs-handlers');
const { registerAiHandlers } = require('./ipc/ai-handlers');
const { registerKeychainHandlers } = require('./ipc/keychain');
const { registerTerminalHandlers } = require('./ipc/terminal-handlers');

const isDev = !app.isPackaged;

let mainWindow = null;
let workspaceWatcher = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      devTools: isDev,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function registerWorkspaceWatcher() {
  ipcMain.handle('workspace:open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = result.filePaths[0];
    startWatcher(root);
    return root;
  });

  ipcMain.handle('workspace:watch', async (_evt, root) => {
    startWatcher(root);
    return true;
  });
}

function startWatcher(root) {
  if (workspaceWatcher) workspaceWatcher.close();
  workspaceWatcher = chokidar.watch(root, {
    ignored: /node_modules|\.git/,
    ignoreInitial: true,
    persistent: true,
  });
  workspaceWatcher.on('all', (event, p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('workspace:event', { event, path: p });
    }
  });
}

app.whenReady().then(() => {
  registerFsHandlers(ipcMain);
  registerAiHandlers(ipcMain, { getMainWindow: () => mainWindow });
  registerKeychainHandlers(ipcMain, safeStorage);
  registerTerminalHandlers(ipcMain, { getMainWindow: () => mainWindow });
  registerWorkspaceWatcher();

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (workspaceWatcher) workspaceWatcher.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (_evt, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
