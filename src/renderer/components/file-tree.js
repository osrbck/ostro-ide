import { iconForFile } from './icons.js';
import { showContextMenu } from './context-menu.js';
import { promptInline } from './inline-prompt.js';

const CHEVRON = `<svg class="chev" width="10" height="10" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function mountFileTree({ root, container, onOpenFile }) {
  container.innerHTML = '';
  container.classList.add('ft-root');

  const nodes = new Map();
  let activePath = null;

  function pathJoin(a, b) {
    return a.replace(/[\\/]+$/, '') + '/' + b;
  }

  function dirOf(p) {
    return p.replace(/[\\/][^\\/]*$/, '');
  }

  function basename(p) {
    return p.split(/[\\/]/).pop();
  }

  function makeEntryEl(entry, depth) {
    const el = document.createElement('div');
    el.className = 'ft-entry' + (entry.isDir ? ' ft-dir' : ' ft-file');
    el.dataset.path = entry.path;
    el.dataset.depth = String(depth);
    el.style.paddingLeft = `${6 + depth * 14}px`;

    const chev = entry.isDir
      ? `<span class="ft-chev">${CHEVRON}</span>`
      : `<span class="ft-chev ft-chev-empty"></span>`;
    const icon = entry.isDir
      ? `<span class="ft-icon ft-icon-folder">${folderIconSvg(false)}</span>`
      : `<span class="ft-icon">${iconForFile(entry.name)}</span>`;
    el.innerHTML = `${chev}${icon}<span class="ft-name">${escapeHtml(entry.name)}</span>`;
    return el;
  }

  function folderIconSvg(open) {
    return open
      ? `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 4.5a1 1 0 011-1h3l1.5 1.5h5a1 1 0 011 1V6H1.5z M1.5 6h11l-1 5a1 1 0 01-1 .8H2.6a1 1 0 01-1-.8z" fill="currentColor" opacity=".85"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 4a1 1 0 011-1h3l1.5 1.5h5a1 1 0 011 1V11a1 1 0 01-1 1H2a1 1 0 01-1-1z" fill="currentColor" opacity=".85"/></svg>`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadDir(dirPath, parentEl, depth) {
    const entries = await window.ostro.fs.readDir(dirPath);
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      const el = makeEntryEl(e, depth);
      frag.appendChild(el);
      nodes.set(e.path, { el, entry: e, depth, loaded: false, expanded: false, parentPath: dirPath });

      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (e.isDir) toggleDir(e.path);
        else openFile(e.path);
      });
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openContextMenu(ev.clientX, ev.clientY, e);
      });
    }
    parentEl.appendChild(frag);
  }

  async function toggleDir(dirPath) {
    const node = nodes.get(dirPath);
    if (!node) return;
    const folderIcon = node.el.querySelector('.ft-icon-folder');
    if (node.expanded) {
      collapse(dirPath);
      node.el.classList.remove('ft-open');
      if (folderIcon) folderIcon.innerHTML = folderIconSvg(false);
    } else {
      if (!node.loaded) {
        await loadDir(dirPath, dirPath === root ? container : node.childrenEl || mountChildren(node), node.depth + 1);
        node.loaded = true;
      } else if (node.childrenEl) {
        node.childrenEl.style.display = '';
      }
      node.expanded = true;
      node.el.classList.add('ft-open');
      if (folderIcon) folderIcon.innerHTML = folderIconSvg(true);
    }
  }

  function mountChildren(node) {
    const wrap = document.createElement('div');
    wrap.className = 'ft-children';
    node.el.after(wrap);
    node.childrenEl = wrap;
    return wrap;
  }

  function collapse(dirPath) {
    const node = nodes.get(dirPath);
    if (!node) return;
    node.expanded = false;
    if (node.childrenEl) node.childrenEl.style.display = 'none';
  }

  function openFile(p) {
    if (activePath) {
      const prev = nodes.get(activePath);
      if (prev) prev.el.classList.remove('ft-active');
    }
    activePath = p;
    const cur = nodes.get(p);
    if (cur) cur.el.classList.add('ft-active');
    onOpenFile(p);
  }

  function openContextMenu(x, y, entry) {
    const items = [];
    if (entry.isDir) {
      items.push({ label: 'New File', action: () => createInside(entry.path, false) });
      items.push({ label: 'New Folder', action: () => createInside(entry.path, true) });
      items.push({ type: 'separator' });
    }
    items.push({ label: 'Rename', shortcut: 'F2', action: () => renameEntry(entry.path) });
    items.push({ label: 'Delete', shortcut: 'Del', action: () => deleteEntry(entry.path), danger: true });
    showContextMenu(x, y, items);
  }

  async function createInside(dirPath, isDir) {
    const node = nodes.get(dirPath);
    if (!node) return;
    if (!node.expanded) await toggleDir(dirPath);
    const childWrap = node.childrenEl || mountChildren(node);

    const newName = await promptInline({
      container: childWrap,
      paddingLeft: 6 + (node.depth + 1) * 14,
      placeholder: isDir ? 'folder-name' : 'file.ext',
    });
    if (!newName) return;
    const newPath = pathJoin(dirPath, newName);
    if (isDir) {
      await window.ostro.fs.mkdir(newPath);
    } else {
      await window.ostro.fs.createFile(newPath);
    }
  }

  async function renameEntry(p) {
    const node = nodes.get(p);
    if (!node) return;
    const nameEl = node.el.querySelector('.ft-name');
    const oldName = nameEl.textContent;
    const newName = await promptInline({
      inline: nameEl,
      initialValue: oldName,
    });
    if (!newName || newName === oldName) return;
    const newPath = pathJoin(dirOf(p), newName);
    await window.ostro.fs.rename(p, newPath);
  }

  async function deleteEntry(p) {
    const name = basename(p);
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await window.ostro.fs.deleteEntry(p);
  }

  // ---- Live refresh from chokidar ----

  function handleWatcherEvent({ event, path: p }) {
    if (event === 'add' || event === 'addDir') {
      const parent = dirOf(p);
      const node = nodes.get(parent);
      if (parent === root) refreshDirShallow(root, container, 0);
      else if (node && node.loaded && node.expanded) refreshDirShallow(parent, node.childrenEl, node.depth + 1);
    } else if (event === 'unlink' || event === 'unlinkDir') {
      const node = nodes.get(p);
      if (node) {
        if (node.childrenEl) node.childrenEl.remove();
        node.el.remove();
        nodes.delete(p);
        if (activePath === p) activePath = null;
      }
    }
  }

  async function refreshDirShallow(dirPath, parentEl, depth) {
    const entries = await window.ostro.fs.readDir(dirPath);
    const existing = new Set();
    for (const e of entries) existing.add(e.path);

    // remove deleted
    for (const [p, node] of nodes) {
      if (node.parentPath === dirPath && !existing.has(p)) {
        if (node.childrenEl) node.childrenEl.remove();
        node.el.remove();
        nodes.delete(p);
      }
    }
    // add missing
    for (const e of entries) {
      if (nodes.has(e.path)) continue;
      const el = makeEntryEl(e, depth);
      nodes.set(e.path, { el, entry: e, depth, loaded: false, expanded: false, parentPath: dirPath });
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (e.isDir) toggleDir(e.path);
        else openFile(e.path);
      });
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openContextMenu(ev.clientX, ev.clientY, e);
      });
      parentEl.appendChild(el);
    }
  }

  const unsubscribe = window.ostro.workspace.onEvent(handleWatcherEvent);

  // ---- root level ----
  nodes.set(root, {
    el: null,
    entry: { name: '/', path: root, isDir: true },
    childrenEl: container,
    depth: -1,
    loaded: true,
    expanded: true,
    parentPath: null,
  });
  loadDir(root, container, 0);

  // empty-area context menu (create at root)
  container.addEventListener('contextmenu', (ev) => {
    if (ev.target.closest('.ft-entry')) return;
    ev.preventDefault();
    showContextMenu(ev.clientX, ev.clientY, [
      { label: 'New File', action: () => createInside(root, false) },
      { label: 'New Folder', action: () => createInside(root, true) },
    ]);
  });

  // F2 / Delete on focused entry
  container.tabIndex = 0;
  container.addEventListener('keydown', (e) => {
    if (!activePath) return;
    if (e.key === 'F2') { e.preventDefault(); renameEntry(activePath); }
    if (e.key === 'Delete') { e.preventDefault(); deleteEntry(activePath); }
  });

  return {
    destroy() { unsubscribe?.(); },
    getActive() { return activePath; },
  };
}
