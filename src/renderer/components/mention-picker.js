import { searchFiles } from './file-index.js';
import { highlight } from './fuzzy.js';

let picker = null;
let activeIdx = 0;
let items = [];
let currentQuery = '';
let onSelectCb = null;

export function showMentionPicker({ anchor, query, onSelect }) {
  currentQuery = query;
  onSelectCb = onSelect;

  if (!picker) {
    picker = document.createElement('div');
    picker.className = 'mention-picker';
    document.body.appendChild(picker);
  }
  positionPicker(anchor);
  refresh();
}

export function hideMentionPicker() {
  if (picker) { picker.remove(); picker = null; }
  items = [];
  activeIdx = 0;
  onSelectCb = null;
}

export function updateMentionPicker(query) {
  if (!picker) return;
  currentQuery = query;
  refresh();
}

export function isMentionPickerOpen() {
  return !!picker;
}

export function moveMentionPickerSelection(dir) {
  if (!picker || items.length === 0) return;
  activeIdx = (activeIdx + dir + items.length) % items.length;
  updateActive();
}

export function commitMentionPickerSelection() {
  if (!picker || items.length === 0) return false;
  const it = items[activeIdx];
  onSelectCb?.(it);
  hideMentionPicker();
  return true;
}

function positionPicker(anchor) {
  const r = anchor.getBoundingClientRect();
  picker.style.left = `${r.left}px`;
  picker.style.bottom = `${window.innerHeight - r.top + 4}px`;
  picker.style.width = `${Math.max(r.width, 360)}px`;
}

function refresh() {
  items = searchFiles(currentQuery, 30);
  activeIdx = 0;
  render();
}

function render() {
  if (!picker) return;
  if (items.length === 0) {
    picker.innerHTML = `<div class="mp-empty">No matching files</div>`;
    return;
  }
  picker.innerHTML = items
    .map((it, i) => {
      const name = it.rel.split(/[\\/]/).pop();
      const dir = it.rel.slice(0, it.rel.length - name.length).replace(/[\\/]$/, '');
      return `<div class="mp-row" data-idx="${i}">
        <span class="mp-name">${escapeHtml(name)}</span>
        ${dir ? `<span class="mp-dir">${escapeHtml(dir)}</span>` : ''}
      </div>`;
    })
    .join('');
  updateActive();
  picker.querySelectorAll('.mp-row').forEach((row) => {
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep textarea focused
      activeIdx = Number(row.dataset.idx);
      commitMentionPickerSelection();
    });
  });
}

function updateActive() {
  if (!picker) return;
  picker.querySelectorAll('.mp-row').forEach((el, i) => {
    el.classList.toggle('active', i === activeIdx);
    if (i === activeIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
