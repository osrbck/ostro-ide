import { searchFiles } from './file-index.js';
import { searchCommands } from './commands.js';
import { highlight } from './fuzzy.js';

let overlay = null;
let mode = 'files'; // 'files' | 'commands'
let onPickFile = null;

export function openQuickFiles(handlers) {
  onPickFile = handlers.onPickFile;
  show('files', '');
}

export function openCommandPalette() {
  show('commands', '> ');
}

function show(newMode, initial) {
  if (overlay) { overlay.remove(); overlay = null; }
  mode = newMode;

  overlay = document.createElement('div');
  overlay.className = 'qo-overlay';
  overlay.innerHTML = `
    <div class="qo-panel">
      <input class="qo-input" placeholder="${mode === 'files' ? 'Search files by name...' : 'Type a command...'}" />
      <div class="qo-list"></div>
      <div class="qo-hint">↑↓ navigate · Enter open · Esc close</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('.qo-input');
  const list = overlay.querySelector('.qo-list');
  let activeIdx = 0;
  let items = [];

  function render() {
    const q = input.value.replace(/^>\s*/, '');
    items = mode === 'files' ? searchFiles(q, 80) : searchCommands(q);
    list.innerHTML = items.map((it, i) => renderRow(it, i, q)).join('');
    if (items.length === 0) list.innerHTML = `<div class="qo-empty">No results</div>`;
    activeIdx = Math.min(activeIdx, items.length - 1);
    if (activeIdx < 0) activeIdx = 0;
    updateActive();
  }

  function renderRow(it, i, q) {
    if (mode === 'files') {
      const name = it.rel.split(/[\\/]/).pop();
      const dir = it.rel.slice(0, it.rel.length - name.length).replace(/[\\/]$/, '');
      return `<div class="qo-row" data-idx="${i}">
        <div class="qo-row-main">
          <span class="qo-row-name">${highlight(name, it.positions ? it.positions.filter((p) => p >= it.rel.length - name.length).map((p) => p - (it.rel.length - name.length)) : [])}</span>
          ${dir ? `<span class="qo-row-dir">${escapeHtml(dir)}</span>` : ''}
        </div>
      </div>`;
    } else {
      return `<div class="qo-row" data-idx="${i}">
        <div class="qo-row-main">
          <span class="qo-row-name">${escapeHtml(it.label)}</span>
        </div>
        ${it.shortcut ? `<span class="qo-row-shortcut">${escapeHtml(it.shortcut)}</span>` : ''}
      </div>`;
    }
  }

  function updateActive() {
    overlay.querySelectorAll('.qo-row').forEach((el, i) => {
      el.classList.toggle('active', i === activeIdx);
      if (i === activeIdx) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function close() {
    overlay?.remove();
    overlay = null;
  }

  function commit() {
    const it = items[activeIdx];
    if (!it) return close();
    close();
    if (mode === 'files') onPickFile?.(it.path);
    else it.run?.();
  }

  input.value = initial;
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); updateActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); updateActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.qo-row');
    if (!row) return;
    activeIdx = Number(row.dataset.idx);
    commit();
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  setTimeout(() => input.focus(), 0);
  render();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
