import { ostroDark } from './theme/ostro-dark.js';
import { installAllLanguages, detectLanguageFromPath } from './languages/index.js';
import { mountFileTree } from './components/file-tree.js';
import { mountChatPanel } from './components/chat-panel.js';
import { mountScmPanel } from './components/scm-panel.js';
import { mountSearchPanel } from './components/search-panel.js';
import { mountSplitters } from './components/splitter.js';
import { mountExtensions } from './components/extensions.js';
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
  terminal: null,
  scm: null,
  search: null,
  splitters: null,
  extensions: null,
  gitStatus: null,
  config: null,
};

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

async function bootMonaco() {
  return new Promise((resolve) => {
    // Monaco's web workers cannot resolve their script path under file://
    // (the blob worker resolves relative URLs against the blob origin, not
    // the document), so they silently fail and tokenization falls back to
    // the main thread. Give Monaco an explicit blob bootstrap that
    // importScripts the ABSOLUTE worker URL instead.
    // Note the trailing slashes: URL resolution replaces the last path
    // segment when the base lacks one. workerMain.js appends module ids
    // (which start with "vs/") to MonacoEnvironment.baseUrl, so baseUrl
    // must be the directory CONTAINING vs/ — i.e. min/, not min/vs/.
    const minUrl = new URL('../../node_modules/monaco-editor/min/', import.meta.url);
    const workerMainUrl = new URL('./vs/base/worker/workerMain.js', minUrl);
    window.MonacoEnvironment = {
      getWorkerUrl() {
        // JSON.stringify emits safely-escaped JS string literals — an
        // install path containing quotes must not break the worker source.
        const proxy = new Blob(
          [
            `self.MonacoEnvironment={baseUrl:${JSON.stringify(minUrl.href)}};`,
            `importScripts(${JSON.stringify(workerMainUrl.href)});`,
          ],
          { type: 'text/javascript' }
        );
        return URL.createObjectURL(proxy);
      },
    };

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
  refreshGitStatus();
  state.extensions?.workspaceOpened();
}

// ---- Git ----

function normJoin(root, rel) {
  return `${String(root).replace(/[\\/]+$/, '')}/${String(rel).replace(/^[\\/]+/, '')}`;
}

async function refreshGitStatus() {
  if (!state.workspaceRoot) return;
  let st;
  try {
    st = await window.ostro.git.status(state.workspaceRoot);
  } catch {
    st = { repo: false };
  }
  state.gitStatus = st;

  const btn = document.getElementById('git-branch-btn');
  if (st.repo) {
    btn.hidden = false;
    const ahead = st.branch.ahead ? ` ↑${st.branch.ahead}` : '';
    const behind = st.branch.behind ? ` ↓${st.branch.behind}` : '';
    btn.textContent = `⎇ ${st.branch.name || 'HEAD'}${ahead}${behind}`;
    btn.title = st.entries.length
      ? `${st.entries.length} change(s) — click to open Source Control`
      : 'Working tree clean — click to open Source Control';
    btn.classList.toggle('dirty', st.entries.length > 0);
  } else {
    btn.hidden = true;
  }

  state.scm?.refresh(st);

  const map = new Map();
  if (st.repo) {
    // Keys must match the absolute entry paths the file tree keys its nodes
    // by — forward-slashed for cross-platform consistency.
    for (const e of st.entries) {
      map.set(normJoin(state.workspaceRoot, e.path).replace(/\\/g, '/'), e);
    }
  }
  state.fileTree?.updateGitStatus?.(map);
}

function switchSidebarView(view) {
  localStorage.setItem('ostro.sidebarView', view);
  document.querySelectorAll('.sidebar-tab').forEach((t) => {
    const active = t.dataset.view === view;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.getElementById('view-explorer').classList.toggle('hidden', view !== 'explorer');
  document.getElementById('view-search').classList.toggle('hidden', view !== 'search');
  document.getElementById('view-scm').classList.toggle('hidden', view !== 'scm');
  if (view === 'scm') refreshGitStatus();
  if (view === 'search') state.search?.focus();
}

async function openFile(filePath, revealLine, revealColumn) {
  if (state.openFiles.has(filePath)) {
    switchTo(filePath);
    if (revealLine) revealInEditor(revealLine, revealColumn);
    return;
  }
  let content;
  try {
    const stat = await window.ostro.fs.stat(filePath);
    if (stat.size > 5 * 1024 * 1024) {
      setStatus(`⚠ ${basename(filePath)} is too large to open (${(stat.size / 1048576).toFixed(1)} MB)`);
      return;
    }
    content = await window.ostro.fs.readFile(filePath);
  } catch (err) {
    setStatus(`⚠ ${err.message}`);
    return;
  }
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
  if (revealLine) revealInEditor(revealLine, revealColumn);
  state.extensions?.fileOpened(filePath);
}

// Jump the editor to a 1-based line (and optional 0-based column) — used
// by the Search panel result rows.
function revealInEditor(line, column) {
  const editor = state.editor;
  if (!editor || !line) return;
  const lineNumber = Math.max(1, Math.floor(line));
  const col = Math.max(1, Math.floor((column || 0)) + 1);
  editor.setSelection({ startLineNumber: lineNumber, startColumn: col, endLineNumber: lineNumber, endColumn: col + 40 });
  editor.revealLineInCenter(lineNumber);
  editor.focus();
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
  state.extensions?.fileSaved(filePath);
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

// ---- Integrated terminal (xterm.js + node-pty in the main process) ----

function mountTerminal() {
  const host = document.getElementById('terminal-host');
  const toggleBtn = document.getElementById('btn-toggle-terminal');
  // UMD global shapes: xterm spreads its exports onto globalThis
  // (window.Terminal IS the Terminal class), while the addons expose a
  // namespace (window.FitAddon.FitAddon is the class).
  const TerminalCtor = window.Terminal;
  const FitAddonCtor = window.FitAddon?.FitAddon;
  if (typeof TerminalCtor !== 'function' || typeof FitAddonCtor !== 'function') return null;

  const term = new TerminalCtor({
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontSize: 12,
    cursorBlink: true,
    theme: { background: '#0b0d10', foreground: '#e6e8ec' },
  });
  const fit = new FitAddonCtor();
  term.loadAddon(fit);
  term.open(host);

  let sessionId = null;
  let starting = false;

  window.ostro.terminal.onData(({ id, data }) => {
    if (id === sessionId) term.write(data);
  });
  window.ostro.terminal.onExit(({ id, exitCode }) => {
    if (id === sessionId) {
      term.write(`\r\n\x1b[90m[process exited with code ${exitCode} — toggle again to restart]\x1b[0m\r\n`);
      sessionId = null;
    }
  });

  term.onData((d) => {
    if (sessionId) window.ostro.terminal.write(sessionId, d);
  });

  async function ensureSession() {
    if (sessionId || starting) return;
    starting = true;
    try {
      const { id } = await window.ostro.terminal.create({
        cwd: state.workspaceRoot || undefined,
        cols: term.cols,
        rows: term.rows,
      });
      sessionId = id;
    } catch (err) {
      term.write(`\x1b[31mTerminal unavailable: ${err.message}\x1b[0m\r\n`);
      term.write('\x1b[90mIf node-pty failed to build, install build tools and run:\x1b[0m\r\n');
      term.write('\x1b[90m  npm install && npx electron-builder install-app-deps\x1b[0m\r\n');
    } finally {
      starting = false;
    }
  }

  function refresh() {
    if (!host.classList.contains('visible')) return;
    try { fit.fit(); } catch { /* host not measurable yet */ }
    if (sessionId) window.ostro.terminal.resize(sessionId, term.cols, term.rows);
  }

  function toggle() {
    const visible = host.classList.toggle('visible');
    toggleBtn.classList.toggle('active', visible);
    state.splitters?.setTerminalVisible(visible);
    if (visible) {
      ensureSession().then(refresh);
      term.focus();
    } else {
      state.editor?.focus();
    }
  }

  toggleBtn.addEventListener('click', toggle);
  window.addEventListener('resize', refresh);

  return { toggle, refresh };
}

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
    } else if ((e.key === 'f' || e.key === 'F') && e.shiftKey) {
      e.preventDefault();
      switchSidebarView('search');
    } else if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      document.getElementById('btn-toggle-chat').click();
    } else if (e.key === '`') {
      e.preventDefault();
      state.terminal?.toggle();
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
    id: 'search.findInFiles',
    label: 'Search: Find in Files',
    shortcut: 'Ctrl+Shift+F',
    run: () => switchSidebarView('search'),
  });
  registerCommand({
    id: 'terminal.toggle',
    label: 'Terminal: Toggle Integrated Terminal',
    shortcut: 'Ctrl+`',
    run: () => state.terminal?.toggle(),
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
      const modeEl = document.getElementById('active-approval-mode');
      modeEl.textContent = cfg.approvalMode || 'ask';
      modeEl.dataset.mode = cfg.approvalMode || 'ask';
      modeEl.title = cfg.approvalMode === 'bypass'
        ? 'Bypass: the agent auto-approves all writes and commands'
        : cfg.approvalMode === 'auto'
          ? 'Auto: writes are auto-approved, commands still ask'
          : 'Ask: every agent action needs approval';
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

  state.terminal = mountTerminal();

  // ---- Extensions (contributions feed the command palette + status bar) ----
  state.extensions = mountExtensions({
    statusHost: document.getElementById('ext-status-host'),
    getRoot: () => state.workspaceRoot,
  });

  // ---- Resizable panels ----
  state.splitters = mountSplitters({
    workbench: document.querySelector('.workbench'),
    sidebar: document.getElementById('sidebar'),
    chat: document.getElementById('chat-panel'),
    editorZone: document.querySelector('.editor-zone'),
    terminalHost: document.getElementById('terminal-host'),
    // Keep the xterm fit addon in sync while its sash is dragged.
    onTerminalResize: () => state.terminal?.refresh(),
  });

  state.search = mountSearchPanel({
    container: document.getElementById('search-panel'),
    getRoot: () => state.workspaceRoot,
    onOpenFile: openFile,
    onChangedWorkspace: () => {
      // The file tree refreshes itself via its own watcher subscription;
      // only the git decorations need an explicit nudge after replacements.
      refreshGitStatus();
    },
  });

  // ---- Git wiring ----
  state.scm = mountScmPanel({
    container: document.getElementById('scm-panel'),
    getRoot: () => state.workspaceRoot,
    onOpenFile: openFile,
    onChanged: refreshGitStatus,
  });
  document.querySelectorAll('.sidebar-tab').forEach((t) => {
    t.addEventListener('click', () => switchSidebarView(t.dataset.view));
  });
  document.getElementById('git-branch-btn').addEventListener('click', () => switchSidebarView('scm'));
  switchSidebarView(localStorage.getItem('ostro.sidebarView') === 'scm' ? 'scm' : 'explorer');

  // Refresh git state (debounced) whenever files change on disk.
  let gitDebounce = null;
  window.ostro.workspace.onEvent(() => {
    clearTimeout(gitDebounce);
    gitDebounce = setTimeout(refreshGitStatus, 500);
  });

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
