// Global Find-in-Files / Replace-All panel (the "Search" sidebar view).
//
// Search runs through the main-process search worker (same terminable
// infrastructure the agent's search_files tool uses) with UI limits:
// up to 500 matches with per-line highlight spans. Replace applies only to
// the files that currently have visible matches.

import { showConfirm } from './confirm-modal.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Render one result line with <mark> highlights at the worker-reported spans.
function highlightLine(text, ranges) {
  if (!ranges || ranges.length === 0) return escapeHtml(text);
  let out = '';
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start < pos || start > text.length) continue; // defensive: spans are worker-supplied
    out += escapeHtml(text.slice(pos, start));
    out += `<mark class="sp-hit">${escapeHtml(text.slice(start, Math.min(end, text.length)))}</mark>`;
    pos = Math.min(end, text.length);
  }
  out += escapeHtml(text.slice(pos));
  return out;
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 350;

export function mountSearchPanel({ container, getRoot, onOpenFile, onChangedWorkspace }) {
  let lastResult = null; // {matches, truncated}
  let searchSeq = 0;
  let debounceTimer = null;

  container.innerHTML = `
    <div class="sp-panel">
      <div class="sp-query-row">
        <input type="text" class="sp-input" id="sp-query" placeholder="Search (regex supported)" spellcheck="false" />
        <button class="sp-toggle" id="sp-regex" title="Regular expression" aria-pressed="false">.*</button>
        <button class="sp-toggle" id="sp-case" title="Match case" aria-pressed="false">Aa</button>
        <button class="sp-toggle" id="sp-word" title="Whole word" aria-pressed="false">⟷</button>
      </div>
      <input type="text" class="sp-input sp-filter" id="sp-filter" placeholder="File extension filter, e.g. .js (optional)" spellcheck="false" />
      <div class="sp-replace-row">
        <input type="text" class="sp-input" id="sp-replace" placeholder="Replace with…" spellcheck="false" />
        <button class="btn-ghost sp-replace-btn" id="sp-replace-all" title="Replace all matches in the listed files" disabled>Replace All</button>
      </div>
      <div class="sp-status" id="sp-status"></div>
      <div class="sp-results" id="sp-results"></div>
    </div>
  `;

  const queryInput = container.querySelector('#sp-query');
  const filterInput = container.querySelector('#sp-filter');
  const replaceInput = container.querySelector('#sp-replace');
  const replaceBtn = container.querySelector('#sp-replace-all');
  const statusEl = container.querySelector('#sp-status');
  const resultsEl = container.querySelector('#sp-results');
  const toggles = {
    regex: container.querySelector('#sp-regex'),
    caseSensitive: container.querySelector('#sp-case'),
    wholeWord: container.querySelector('#sp-word'),
  };

  for (const [key, btn] of Object.entries(toggles)) {
    let on = false;
    btn.addEventListener('click', () => {
      on = !on;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.dataset.on = on ? '1' : '0';
      scheduleSearch();
    });
    btn.dataset.on = '0';
  }

  function activeOptions() {
    return {
      query: queryInput.value,
      regex: toggles.regex.dataset.on === '1',
      caseSensitive: toggles.caseSensitive.dataset.on === '1',
      wholeWord: toggles.word.dataset.on === '1',
      fileFilter: filterInput.value.trim() || null,
    };
  }

  function setStatus(msg, cls = '') {
    statusEl.textContent = msg || '';
    statusEl.className = `sp-status ${cls}`;
  }

  queryInput.addEventListener('input', scheduleSearch);
  filterInput.addEventListener('input', scheduleSearch);

  function scheduleSearch() {
    clearTimeout(debounceTimer);
    const { query } = activeOptions();
    if (query.length < MIN_QUERY) {
      lastResult = null;
      renderResults();
      setStatus('');
      return;
    }
    setStatus('Searching…');
    debounceTimer = setTimeout(runSearch, DEBOUNCE_MS);
  }

  async function runSearch() {
    const root = getRoot();
    const opts = activeOptions();
    if (!root) {
      setStatus('Open a folder to search.', 'err');
      return;
    }
    const seq = ++searchSeq;
    try {
      const result = await window.ostro.search.find({ root, ...opts });
      if (seq !== searchSeq) return; // a newer search superseded this one
      lastResult = result;
      renderResults();
      const n = result.matches.length;
      const files = new Set(result.matches.map((m) => m.rel)).size;
      setStatus(
        result.truncated
          ? `${n}+ matches in ${files} files (result list truncated — refine the query)`
          : `${n} match${n === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}`,
        result.truncated ? 'warn' : ''
      );
    } catch (err) {
      if (seq !== searchSeq) return;
      lastResult = null;
      renderResults();
      setStatus(`⚠ ${err.message}`, 'err');
    }
  }

  function renderResults() {
    resultsEl.innerHTML = '';
    replaceBtn.disabled = !lastResult || lastResult.matches.length === 0;
    if (!lastResult || lastResult.matches.length === 0) {
      resultsEl.innerHTML = `<div class="sp-empty">${lastResult ? 'No matches.' : 'Type at least 2 characters to search.'}</div>`;
      return;
    }

    // Group by file preserving first-seen order.
    const byFile = new Map();
    for (const m of lastResult.matches) {
      if (!byFile.has(m.rel)) byFile.set(m.rel, []);
      byFile.get(m.rel).push(m);
    }

    for (const [rel, rows] of byFile) {
      const fileEl = document.createElement('div');
      fileEl.className = 'sp-file';
      fileEl.innerHTML = `
        <div class="sp-file-head">
          <span class="sp-file-name" title="${escapeHtml(rel)}">${escapeHtml(rel.split('/').pop())}</span>
          <span class="sp-file-path">${escapeHtml(rel.split('/').slice(0, -1).join('/'))}</span>
          <span class="sp-file-count">${rows.length}</span>
        </div>
        <div class="sp-file-rows"></div>
      `;
      const rowsEl = fileEl.querySelector('.sp-file-rows');
      for (const m of rows) {
        const row = document.createElement('div');
        row.className = 'sp-row';
        row.innerHTML = `<span class="sp-line-no">${m.line}</span><span class="sp-line-text">${highlightLine(m.text, m.ranges)}</span>`;
        row.title = `${rel}:${m.line}`;
        row.addEventListener('click', () => {
          const abs = `${String(getRoot()).replace(/[\\/]+$/, '')}/${rel}`;
          onOpenFile(abs, m.line, m.ranges?.[0]?.[0] ?? 0);
        });
        rowsEl.appendChild(row);
      }
      resultsEl.appendChild(fileEl);
    }
  }

  replaceBtn.addEventListener('click', async () => {
    const root = getRoot();
    const opts = activeOptions();
    if (!root || !lastResult || lastResult.matches.length === 0) return;
    const files = [...new Set(lastResult.matches.map((m) => m.rel))];
    const action = await showConfirm({
      title: 'Replace in files?',
      message: `Replace all matches of "${opts.query}" with "${replaceInput.value}" in ${files.length} file${files.length === 1 ? '' : 's'}? This cannot be undone (use git to revert).`,
      confirmLabel: 'Replace All',
      danger: true,
    });
    if (action !== 'confirm') return;

    replaceBtn.disabled = true;
    setStatus('Replacing…');
    try {
      const result = await window.ostro.search.replaceAll({
        root,
        ...opts,
        replacement: replaceInput.value,
        paths: files,
      });
      const changed = result.files.filter((f) => f.changed).length;
      setStatus(`✓ Replaced ${result.totalReplacements} occurrence${result.totalReplacements === 1 ? '' : 's'} in ${changed} file${changed === 1 ? '' : 's'}`);
      onChangedWorkspace(); // refresh git decorations / tree
      await runSearch();    // results are now stale
    } catch (err) {
      setStatus(`⚠ ${err.message}`, 'err');
    } finally {
      replaceBtn.disabled = !lastResult || lastResult.matches.length === 0;
    }
  });

  // Enter runs immediately; Escape clears.
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounceTimer);
      runSearch();
    } else if (e.key === 'Escape') {
      queryInput.value = '';
      scheduleSearch();
    }
  });

  renderResults();
  return {
    focus() {
      queryInput.focus();
      queryInput.select();
    },
    refresh: runSearch,
  };
}
