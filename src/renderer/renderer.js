import { ostroDark } from './theme/ostro-dark.js';
import { installAllLanguages, detectLanguageFromPath } from './languages/index.js';
import { mountFileTree } from './components/file-tree.js';
import { mountChatPanel } from './components/chat-panel.js';
import { mountSettings } from './components/settings.js';
import { mountTabs } from './components/tabs.js';
import { showConfirm } from './components/confirm-modal.js';
import { buildIndex, getIndexSize, destroyIndex } from './components/file-index.js';
import { openQuickFiles, openCommandPalette } from './components/quick-open.js';
import { registerCommand } from './components/commands.js';
import { initDiffApproval } from './components/diff-modal.js';

const state = {
  monaco: null,
  editor: null,
  workspaceRoot: null,
  openFiles: new Map(), // path -> { model, savedVersionId, disposer }
  activePath: null,
  fileTree: null,
  config: null,
};

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

async function bootMonaco() {
  return new Promise((resolve) => {
    require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
    require(['vs/editor/editor.main'], async () => {
      const monaco = window.monaco;
      monaco.editor.defineTheme('ostro-dark', ostroDark);
      monaco.editor.setTheme('ostro-dark');
      await installAllLanguages(monaco);

      const editor = monaco.editor.create(document.getElementById('editor-host'), {
        value: '// Welcome to Ostro.\n// Open a folder to get started.\n',
        language: 'javascript',
        theme: 'ostro-dark',
        fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: 'phase',
        cursorSmoothCaretAnimation: 'on',
        renderLineHighlight: 'line',
        padding: { top: 12 },
        automaticLayout: true,
      });

      state.monaco = monaco;
      state.editor = editor;
      resolve();
    });
  });
}

async function openWorkspace() {
  const root = await window.ostro.workspace.open();
  if (!root) return;
  state.workspaceRoot = root;
  setStatus(root);
  state.fileTree?.destroy?.();
  state.fileTree = mountFileTree({
    root,
    container: document.getElementById('file-tree'),
    onOpenFile: openFile,
  });
  destroyIndex();
  buildIndex(root).then(() => setStatus(`${root} · ${getIndexSize()} files indexed`));
}

async function openFile(filePath) {
  if (state.openFiles.has(filePath)) {
    switchTo(filePath);
    return;
  }
  const content = await window.ostro.fs.readFile(filePath);
  const lang = detectLanguageFromPath(filePath);
  const model = state.monaco.editor.createModel(content, lang);
  const savedVersionId = model.getAlternativeVersionId();

  const disposer = model.onDidChangeContent(() => {
    const entry = state.openFiles.get(filePath);
    if (!entry) return;
    const isDirty = model.getAlternativeVersionId() !== entry.savedVersionId;
    tabs.setDirty(filePath, isDirty);
  });

  state.openFiles.set(filePath, { model, savedVersionId, disposer });
  tabs.add(filePath);
  switchTo(filePath);
}

function switchTo(filePath) {
  const entry = state.openFiles.get(filePath);
  if (!entry) return;
  state.activePath = filePath;
  state.editor.setModel(entry.model);
  state.editor.focus();
  tabs.setActive(filePath);
}

async function saveActive() {
  if (!state.activePath) return;
  await saveFile(state.activePath);
}

async function saveFile(filePath) {
  const entry = state.openFiles.get(filePath);
  if (!entry) return;
  await window.ostro.fs.writeFile(filePath, entry.model.getValue());
  entry.savedVersionId = entry.model.getAlternativeVersionId();
  tabs.setDirty(filePath, false);
  setStatus(`saved ${filePath}`);
}

async function closeFile(filePath) {
  if (tabs.isDirty(filePath)) {
    switchTo(filePath); // bring it into view so user sees what's being closed
    const action = await showConfirm({
      title: 'Save changes?',
      message: `"${basename(filePath)}" has unsaved changes. Do you want to save before closing?`,
      confirmLabel: 'Save',
      secondaryLabel: "Don't Save",
      cancelLabel: 'Cancel',
    });
    if (action === 'cancel') return;
    if (action === 'confirm') await saveFile(filePath);
  }

  const entry = state.openFiles.get(filePath);
  if (entry) {
    entry.disposer?.dispose?.();
    entry.model.dispose();
  }
  state.openFiles.delete(filePath);
  tabs.remove(filePath);

  if (state.activePath === filePath) {
    const next = tabs.order()[0] || null;
    if (next) switchTo(next);
    else {
      state.activePath = null;
      state.editor.setModel(state.monaco.editor.createModel('// Welcome to Ostro.\n// Open a file to start editing.\n', 'javascript'));
    }
  }
}

function basename(p) {
  return p.split(/[\\/]/).pop();
}

const tabs = mountTabs({
  container: document.getElementById('tab-bar'),
  onSwitch: switchTo,
  onClose: closeFile,
});

function bindKeybindings() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    if (e.key === 's' && !e.shiftKey) {
      e.preventDefault();
      saveActive();
    } else if ((e.key === 'w' || e.key === 'W') && !e.shiftKey) {
      e.preventDefault();
      if (state.activePath) closeFile(state.activePath);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (!state.activePath) return;
      const next = tabs.nextOf(state.activePath, e.shiftKey ? -1 : 1);
      if (next) switchTo(next);
    } else if ((e.key === 'p' || e.key === 'P') && !e.shiftKey) {
      e.preventDefault();
      if (!state.workspaceRoot) { setStatus('open a folder first'); return; }
      openQuickFiles({ onPickFile: openFile });
    } else if ((e.key === 'p' || e.key === 'P') && e.shiftKey) {
      e.preventDefault();
      openCommandPalette();
    } else if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      document.getElementById('btn-toggle-chat').click();
    }
  });
}

function registerCoreCommands() {
  registerCommand({
    id: 'workbench.openFolder',
    label: 'File: Open Folder…',
    run: () => openWorkspace(),
  });
  registerCommand({
    id: 'workbench.openFile',
    label: 'File: Quick Open…',
    shortcut: 'Ctrl+P',
    run: () => state.workspaceRoot && openQuickFiles({ onPickFile: openFile }),
  });
  registerCommand({
    id: 'file.save',
    label: 'File: Save',
    shortcut: 'Ctrl+S',
    run: () => saveActive(),
  });
  registerCommand({
    id: 'file.closeTab',
    label: 'File: Close Active Tab',
    shortcut: 'Ctrl+W',
    run: () => state.activePath && closeFile(state.activePath),
  });
  registerCommand({
    id: 'settings.open',
    label: 'Preferences: Open Settings…',
    run: () => state.settings?.open(),
  });
}

async function init() {
  await bootMonaco();

  const settings = mountSettings({
    modal: document.getElementById('settings-modal'),
    onSaved: (cfg) => {
      state.config = cfg;
      document.getElementById('active-model').textContent = cfg.model;
    },
  });
  state.settings = settings;
  await settings.hydrate();

  document.getElementById('btn-open-workspace').addEventListener('click', openWorkspace);
  document.getElementById('btn-settings').addEventListener('click', () => settings.open());

  const workbench = document.querySelector('.workbench');
  const toggleBtn = document.getElementById('btn-toggle-chat');
  const CHAT_HIDDEN_KEY = 'ostro.chatHidden';
  function applyChatVisibility(hidden) {
    workbench.classList.toggle('chat-collapsed', hidden);
    toggleBtn.classList.toggle('active', !hidden);
    localStorage.setItem(CHAT_HIDDEN_KEY, hidden ? '1' : '0');
  }
  applyChatVisibility(localStorage.getItem(CHAT_HIDDEN_KEY) === '1');
  toggleBtn.addEventListener('click', () => {
    applyChatVisibility(!workbench.classList.contains('chat-collapsed'));
  });

  registerCoreCommands();
  bindKeybindings();

  mountChatPanel({
    container: document.getElementById('chat-panel'),
    getContext: () => ({
      workspaceRoot: state.workspaceRoot,
      activePath: state.activePath,
      config: state.settings.getConfig(),
    }),
  });

  initDiffApproval({ getMonaco: () => state.monaco });

  // Warn before close if any tab is dirty
  window.addEventListener('beforeunload', (e) => {
    for (const p of state.openFiles.keys()) {
      if (tabs.isDirty(p)) {
        e.preventDefault();
        e.returnValue = '';
        return;
      }
    }
  });

  setStatus('ready');
}

init();
