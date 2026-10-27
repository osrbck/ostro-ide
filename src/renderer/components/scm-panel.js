// Source Control panel — the "Source Control" sidebar view.
// Shows branch state, staged/unstaged changes, and provides
// stage/unstage/discard/commit actions via the git IPC bridge.

import { showConfirm } from './confirm-modal.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Status letter shown in the list (VS Code-like coloring).
function statusLetter(e) {
  if (e.x === '?' && e.y === '?') return 'U';
  const l = e.x !== ' ' && e.x !== '?' ? e.x : e.y;
  return l && l !== ' ' ? l : 'M';
}

function statusClass(e) {
  if (e.x === '?' && e.y === '?') return 'untracked';
  if (e.x === 'A') return 'added';
  if (e.x === 'D' || e.y === 'D') return 'deleted';
  return 'modified';
}

export function mountScmPanel({ container, getRoot, onOpenFile, onChanged }) {
  let status = { repo: false };
  let busy = false;

  function refresh(newStatus) {
    status = newStatus || { repo: false };
    render();
  }

  async function run(action, errLabel) {
    if (busy) return;
    busy = true;
    setStatusMessage('…');
    try {
      await action();
      setStatusMessage('');
      await onChanged();
    } catch (err) {
      setStatusMessage(`⚠ ${err.message}`, 'err');
    } finally {
      busy = false;
    }
  }

  let statusEl = null;
  function setStatusMessage(msg, cls = '') {
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.className = `scm-status ${cls}`;
    }
  }

  function render() {
    container.innerHTML = '';
    const root = getRoot();

    if (!root) {
      container.innerHTML = `<div class="scm-empty">Open a folder to use source control.</div>`;
      return;
    }

    if (!status.repo) {
      const empty = document.createElement('div');
      empty.className = 'scm-empty';
      empty.innerHTML = `No git repository in this folder.`;
      const initBtn = document.createElement('button');
      initBtn.className = 'btn-ghost';
      initBtn.textContent = 'Initialize Repository';
      initBtn.addEventListener('click', () => run(() => window.ostro.git.init(root), 'init'));
      empty.appendChild(document.createElement('br'));
      empty.appendChild(initBtn);
      container.appendChild(empty);
      return;
    }

    const staged = status.entries.filter((e) => e.staged && !e.untracked);
    const changes = status.entries.filter((e) => !e.staged || e.untracked);
    const b = status.branch;

    // ---- header ----
    const head = document.createElement('div');
    head.className = 'scm-head';
    const ahead = b.ahead ? ` <span class="scm-aheadbehind">↑${b.ahead}</span>` : '';
    const behind = b.behind ? ` <span class="scm-aheadbehind">↓${b.behind}</span>` : '';
    head.innerHTML = `<span class="scm-branch">⎇ ${escapeHtml(b.name || 'unknown')}${ahead}${behind}</span>
      <span class="scm-count">${staged.length} staged · ${changes.length} changes</span>`;
    container.appendChild(head);

    // ---- commit box ----
    const commitBox = document.createElement('div');
    commitBox.className = 'scm-commit';
    commitBox.innerHTML = `
      <textarea class="scm-msg" rows="2" placeholder="Commit message (Ctrl+Enter to commit)" spellcheck="false"></textarea>
      <button class="btn-primary scm-commit-btn" ${staged.length === 0 && changes.length === 0 ? 'disabled' : ''}>
        ${staged.length > 0 ? '✓ Commit' : '✓ Commit All'}
      </button>
    `;
    const msgInput = commitBox.querySelector('.scm-msg');
    const commitBtn = commitBox.querySelector('.scm-commit-btn');

    const doCommit = () => {
      const message = msgInput.value.trim();
      if (!message) {
        setStatusMessage('⚠ Commit message is required', 'err');
        msgInput.focus();
        return;
      }
      run(async () => {
        await window.ostro.git.commit(root, message, staged.length === 0);
        msgInput.value = '';
      }, 'commit');
    };
    commitBtn.addEventListener('click', doCommit);
    msgInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        doCommit();
      }
    });
    container.appendChild(commitBox);

    statusEl = document.createElement('div');
    statusEl.className = 'scm-status';
    container.appendChild(statusEl);

    // ---- lists ----
    const list = document.createElement('div');
    list.className = 'scm-list';

    if (staged.length) {
      list.appendChild(sectionHeader('Staged Changes', staged.length, null));
      for (const e of staged) list.appendChild(makeRow(e, { mode: 'staged', root }));
    }
    if (changes.length) {
      list.appendChild(sectionHeader('Changes', changes.length, {
        label: '+ Stage All',
        action: () => run(() => window.ostro.git.stageAll(root), 'stage all'),
      }));
      for (const e of changes) list.appendChild(makeRow(e, { mode: 'changes', root }));
    }
    if (!staged.length && !changes.length) {
      list.appendChild(Object.assign(document.createElement('div'), { className: 'scm-clean', textContent: '✓ Working tree clean' }));
    }
    container.appendChild(list);
  }

  function sectionHeader(label, count, action) {
    const head = document.createElement('div');
    head.className = 'scm-section-header';
    head.innerHTML = `<span>${escapeHtml(label)} <span class="scm-count">(${count})</span></span>`;
    if (action) {
      const btn = document.createElement('button');
      btn.className = 'scm-act';
      btn.textContent = action.label;
      btn.title = action.label;
      btn.addEventListener('click', action.action);
      head.appendChild(btn);
    }
    return head;
  }

  function makeRow(e, { mode, root }) {
    const row = document.createElement('div');
    row.className = 'scm-row';
    const letter = statusLetter(e);
    const cls = statusClass(e);
    const display = e.renamedFrom ? `${e.path} (from ${e.renamedFrom})` : e.path;
    row.innerHTML = `
      <span class="scm-badge scm-${cls}">${escapeHtml(letter)}</span>
      <span class="scm-path" title="${escapeHtml(display)}">${escapeHtml(display)}</span>
      <span class="scm-actions"></span>
    `;

    row.addEventListener('click', () => {
      const abs = `${String(root).replace(/[\\/]+$/, '')}/${e.path}`;
      onOpenFile(abs);
    });

    const actions = row.querySelector('.scm-actions');

    const mkBtn = (label, title, fn) => {
      const btn = document.createElement('button');
      btn.className = 'scm-act';
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
      return btn;
    };

    if (mode === 'changes') {
      actions.appendChild(mkBtn('+', 'Stage changes', () =>
        run(() => window.ostro.git.stage(root, [e.path]), 'stage')));
    } else {
      actions.appendChild(mkBtn('−', 'Unstage changes', () =>
        run(() => window.ostro.git.unstage(root, [e.path]), 'unstage')));
    }
    actions.appendChild(mkBtn('⟲', 'Discard changes', async () => {
      const ok = await showConfirm({
        title: 'Discard changes?',
        message: `Discard all changes in "${e.path}"? This cannot be undone.`,
        confirmLabel: 'Discard',
        danger: true,
      });
      if (ok !== 'confirm') return;
      run(() => window.ostro.git.discard(root, [{ path: e.path, x: e.x, y: e.y }]), 'discard');
    }));

    return row;
  }

  render();
  return { refresh };
}
