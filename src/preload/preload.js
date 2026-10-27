const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel, handler) => {
  const listener = (_evt, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('ostro', {
  workspace: {
    open: () => invoke('workspace:open'),
    watch: (root) => invoke('workspace:watch', root),
    onEvent: (handler) => subscribe('workspace:event', handler),
  },

  fs: {
    readDir: (p) => invoke('fs:readDir', p),
    readFile: (p) => invoke('fs:readFile', p),
    writeFile: (p, content) => invoke('fs:writeFile', { path: p, content }),
    createFile: (p) => invoke('fs:createFile', p),
    mkdir: (p) => invoke('fs:mkdir', p),
    deleteEntry: (p) => invoke('fs:deleteEntry', p),
    rename: (from, to) => invoke('fs:rename', { from, to }),
    stat: (p) => invoke('fs:stat', p),
    indexWorkspace: (root) => invoke('fs:indexWorkspace', root),
  },

  keychain: {
    setApiKey: (provider, key) => invoke('keychain:setApiKey', { provider, key }),
    getApiKey: (provider) => invoke('keychain:getApiKey', provider),
    clearApiKey: (provider) => invoke('keychain:clearApiKey', provider),
    isEncryptionAvailable: () => invoke('keychain:isEncryptionAvailable'),
  },

  ai: {
    sendMessage: (payload) => invoke('ai:sendMessage', payload),
    cancel: (id) => invoke('ai:cancel', id),
    respondApproval: (id, tool_use_id, decision) =>
      invoke('ai:approvalResponse', { id, tool_use_id, decision }),
    testConnection: (payload) => invoke('ai:testConnection', payload),
    approvalModes: () => invoke('ai:approvalModes'),
    onChunk: (handler) => subscribe('ai:chunk', handler),
    onAutoApproved: (handler) => subscribe('ai:autoApproved', handler),
    onToolUse: (handler) => subscribe('ai:toolUse', handler),
    onToolResult: (handler) => subscribe('ai:toolResult', handler),
    onDone: (handler) => subscribe('ai:done', handler),
    onError: (handler) => subscribe('ai:error', handler),
    onApprovalRequest: (handler) => subscribe('ai:approvalRequest', handler),
  },

  terminal: {
    create: (opts) => invoke('terminal:create', opts),
    write: (id, data) => invoke('terminal:write', { id, data }),
    resize: (id, cols, rows) => invoke('terminal:resize', { id, cols, rows }),
    kill: (id) => invoke('terminal:kill', id),
    onData: (handler) => subscribe('terminal:data', handler),
    onExit: (handler) => subscribe('terminal:exit', handler),
  },

  search: {
    find: (payload) => invoke('search:find', payload),
    replaceAll: (payload) => invoke('search:replaceAll', payload),
  },

  extensions: {
    activate: () => invoke('extensions:activate'),
    list: () => invoke('extensions:list'),
    executeCommand: (id) => invoke('extensions:executeCommand', id),
    fire: (name, payload) => invoke('extensions:fire', { name, payload }),
    onState: (handler) => subscribe('extensions:state', handler),
  },

  git: {
    status: (root) => invoke('git:status', root),
    init: (root) => invoke('git:init', root),
    stage: (root, paths) => invoke('git:stage', { root, paths }),
    stageAll: (root) => invoke('git:stageAll', root),
    unstage: (root, paths) => invoke('git:unstage', { root, paths }),
    discard: (root, items) => invoke('git:discard', { root, items }),
    commit: (root, message, stageAll) => invoke('git:commit', { root, message, stageAll }),
  },

  app: {
    platform: process.platform,
  },
});
