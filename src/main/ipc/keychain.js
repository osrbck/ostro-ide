const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function storePath() {
  return path.join(app.getPath('userData'), 'secrets.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return {};
  }
}

function save(obj) {
  fs.writeFileSync(storePath(), JSON.stringify(obj), { mode: 0o600 });
}

function registerKeychainHandlers(ipcMain, safeStorage) {
  ipcMain.handle('keychain:isEncryptionAvailable', () => safeStorage.isEncryptionAvailable());

  ipcMain.handle('keychain:setApiKey', (_evt, { provider, key }) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level encryption unavailable. Refusing to store key in plaintext.');
    }
    const store = load();
    store[provider] = safeStorage.encryptString(key).toString('base64');
    save(store);
    return true;
  });

  ipcMain.handle('keychain:getApiKey', (_evt, provider) => {
    const store = load();
    const enc = store[provider];
    if (!enc) return null;
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  });

  ipcMain.handle('keychain:clearApiKey', (_evt, provider) => {
    const store = load();
    delete store[provider];
    save(store);
    return true;
  });
}

module.exports = { registerKeychainHandlers };
