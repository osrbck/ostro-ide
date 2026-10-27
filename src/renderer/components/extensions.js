// Renderer-side extension surface: keeps contributed commands in sync with
// the command palette and renders contributed status-bar items.
//
// Extensions run in the MAIN process (see src/main/extensions/host.js); this
// module only reflects their contributions in the UI and forwards lifecycle
// events back through IPC.

import { registerCommand } from './commands.js';

export function mountExtensions({ statusHost, getRoot }) {
  let state = { root: '', list: [], commands: [], statusItems: [] };
  const registered = new Map(); // id -> wrapper object (for de-dup)
  const statusEls = new Map(); // item id -> element

  function renderStatusItems() {
    if (!statusHost) return;
    const seen = new Set();
    for (const item of state.statusItems || []) {
      seen.add(item.id);
      let el = statusEls.get(item.id);
      if (!el) {
        el = document.createElement('span');
        el.className = 'ext-status-item';
        statusHost.appendChild(el);
        statusEls.set(item.id, el);
      }
      el.textContent = item.text;
      el.title = item.tooltip || `from ${item.extensionId}`;
    }
    // Remove items that disappeared (extension deactivated/failed).
    for (const [id, el] of statusEls) {
      if (!seen.has(id)) {
        el.remove();
        statusEls.delete(id);
      }
    }
  }

  function syncCommands() {
    for (const cmd of state.commands || []) {
      if (registered.has(cmd.id)) continue;
      const wrapper = {
        id: `ext.${cmd.id}`,
        label: `${cmd.title} (${cmd.extensionId})`,
        run: async () => {
          try {
            await window.ostro.extensions.executeCommand(cmd.id);
          } catch (err) {
            console.error(`[extension ${cmd.extensionId}] command failed:`, err.message);
          }
        },
      };
      registerCommand(wrapper);
      registered.set(cmd.id, wrapper);
    }
  }

  function apply(next) {
    state = { ...state, ...next };
    syncCommands();
    renderStatusItems();
  }

  window.ostro.extensions.onState((next) => apply(next));

  async function activate() {
    try {
      const result = await window.ostro.extensions.activate();
      apply(result);
      return result;
    } catch (err) {
      console.error('Failed to activate extensions:', err.message);
      return null;
    }
  }

  // Lifecycle forwarding (main process isolates extension failures).
  function fire(name, payload) {
    window.ostro.extensions.fire(name, payload).catch(() => { /* extensions optional */ });
  }

  return {
    activate,
    fire,
    getState: () => ({ ...state }),
    // Called by the shell after a workspace opens.
    workspaceOpened: () => fire('workspaceOpen', { root: getRoot() }),
    fileOpened: (path) => fire('fileOpen', { path }),
    fileSaved: (path) => fire('fileSave', { path }),
  };
}
