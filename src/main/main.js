const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fssync = require('fs');
const { pathToFileURL } = require('url');
const chokidar = require('chokidar');

const { registerFsHandlers } = require('./ipc/fs-handlers');
const { registerAiHandlers } = require('./ipc/ai-handlers');
const { registerKeychainHandlers } = require('./ipc/keychain');
const { registerTerminalHandlers } = require('./ipc/terminal-handlers');
const { registerGitHandlers } = require('./ipc/git-handlers');
const { registerExtensionHandlers } = require('./ipc/extension-handlers');
const { registerSearchHandlers } = require('./ipc/search-handlers');

const isDev = !app.isPackaged;

// Canonicalized once: the ostro:// handler compares every request against
// this prefix AFTER realpath()-resolving the request, so both sides must be
// canonical — a symlinked checkout (e.g. macOS /tmp → /private/tmp) would
// otherwise 403 every asset including index.html itself.
const PROJECT_ROOT = fssync.realpathSync(path.join(__dirname, '..', '..'));

// Serve the renderer from a privileged custom protocol instead of file://.
// Monaco's web workers load their scripts with fetch(), which Chromium
// blocks from a blob worker against file:// URLs — under file:// the
// workers silently fall back to main-thread tokenization ("UI freezes").
// A standard+secure+fetch-enabled scheme keeps everything same-origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'ostro', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function registerAppProtocol() {
  protocol.handle('ostro', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const full = path.resolve(PROJECT_ROOT, rel);
    // Containment: never serve anything outside the project directory.
    // realpath also catches symlinks inside the tree that point outside
    // (e.g. under node_modules) — they resolve to their real target first.
    let real = full;
    try {
      real = await fssync.promises.realpath(full);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const prefix = PROJECT_ROOT.endsWith(path.sep) ? PROJECT_ROOT : PROJECT_ROOT + path.sep;
    if (real !== PROJECT_ROOT && !real.startsWith(prefix)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(real).toString());
  });
}

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
    if (!url.startsWith('ostro://app')) e.preventDefault();
  });

  mainWindow.loadURL('ostro://app/src/renderer/index.html');

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
  registerAppProtocol();
  registerFsHandlers(ipcMain);
  registerAiHandlers(ipcMain, { getMainWindow: () => mainWindow });
  registerKeychainHandlers(ipcMain, safeStorage);
  registerTerminalHandlers(ipcMain, { getMainWindow: () => mainWindow });
  registerGitHandlers(ipcMain);
  registerExtensionHandlers(ipcMain, { getMainWindow: () => mainWindow });
  registerSearchHandlers(ipcMain);
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
