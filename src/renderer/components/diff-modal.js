let monacoRef = null;
let queue = [];
let active = null;

export function initDiffApproval({ getMonaco }) {
  monacoRef = getMonaco;

  window.ostro.ai.onApprovalRequest(({ id, request }) => {
    queue.push({ id, request });
    pump();
  });
}

function pump() {
  if (active || queue.length === 0) return;
  active = queue.shift();
  const open = active.request.kind === 'command' ? openCommandModal : openDiffModal;
  open(active.id, active.request).finally(() => {
    active = null;
    pump();
  });
}

function openDiffModal(runId, req) {
  return new Promise((resolve) => {
    const monaco = monacoRef?.();
    const overlay = document.createElement('div');
    overlay.className = 'diff-overlay';
    overlay.innerHTML = `
      <div class="diff-modal">
        <div class="diff-header">
          <div class="diff-title">
            <span class="diff-badge ${req.isNew ? 'new' : 'edit'}">${req.isNew ? 'NEW FILE' : 'EDIT'}</span>
            <span class="diff-path">${escapeHtml(req.path)}</span>
          </div>
          <div class="diff-actions">
            <button class="btn-ghost" data-act="reject">Reject</button>
            <button class="btn-primary" data-act="accept">Apply</button>
          </div>
        </div>
        <div class="diff-host"></div>
        <div class="diff-foot">
          <span class="diff-hint">Edit the right side to tweak. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> apply · <kbd>Esc</kbd> reject</span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const host = overlay.querySelector('.diff-host');
    const originalModel = monaco.editor.createModel(req.current ?? '', languageOf(req.path));
    const modifiedModel = monaco.editor.createModel(req.proposed ?? '', languageOf(req.path));

    const diffEditor = monaco.editor.createDiffEditor(host, {
      theme: 'ostro-dark',
      automaticLayout: true,
      readOnly: false,
      originalEditable: false,
      renderSideBySide: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize: 12,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });

    const cleanup = () => {
      diffEditor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
      overlay.remove();
      window.removeEventListener('keydown', onKey);
    };

    const finish = (action) => {
      let decision;
      if (action === 'reject') {
        decision = { action: 'reject' };
      } else {
        const finalContent = modifiedModel.getValue();
        decision = finalContent === req.proposed
          ? { action: 'accept' }
          : { action: 'edit', content: finalContent };
      }
      window.ostro.ai.respondApproval(runId, req.tool_use_id, decision);
      cleanup();
      resolve();
    };

    overlay.querySelector('[data-act="accept"]').addEventListener('click', () => finish('accept'));
    overlay.querySelector('[data-act="reject"]').addEventListener('click', () => finish('reject'));

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish('reject'); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); finish('accept'); }
    };
    window.addEventListener('keydown', onKey);

    requestAnimationFrame(() => overlay.classList.add('show'));
  });
}

function openCommandModal(runId, req) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'diff-overlay';
    overlay.innerHTML = `
      <div class="cmd-modal">
        <div class="diff-header">
          <div class="diff-title">
            <span class="diff-badge cmd">RUN COMMAND</span>
            <span class="diff-path">cwd: ${escapeHtml(req.cwd || '.')}</span>
          </div>
          <div class="diff-actions">
            <button class="btn-ghost" data-act="reject">Reject</button>
            <button class="btn-primary" data-act="accept">Run</button>
          </div>
        </div>
        <div class="cmd-body">
          <label class="cmd-label">Command (editable):</label>
          <textarea class="cmd-input" rows="4" spellcheck="false"></textarea>
          <div class="cmd-warn">
            <span class="cmd-warn-dot"></span>
            This runs with full shell access in the workspace. Only approve commands you trust.
          </div>
        </div>
        <div class="diff-foot">
          <span class="diff-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> run · <kbd>Esc</kbd> reject</span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('.cmd-input');
    input.value = req.command;
    setTimeout(() => { input.focus(); input.select(); }, 30);

    const cleanup = () => {
      overlay.remove();
      window.removeEventListener('keydown', onKey);
    };

    const finish = (action) => {
      let decision;
      if (action === 'reject') {
        decision = { action: 'reject' };
      } else {
        const finalCmd = input.value.trim();
        if (!finalCmd) { decision = { action: 'reject' }; }
        else if (finalCmd === req.command) decision = { action: 'accept' };
        else decision = { action: 'edit', command: finalCmd };
      }
      window.ostro.ai.respondApproval(runId, req.tool_use_id, decision);
      cleanup();
      resolve();
    };

    overlay.querySelector('[data-act="accept"]').addEventListener('click', () => finish('accept'));
    overlay.querySelector('[data-act="reject"]').addEventListener('click', () => finish('reject'));

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish('reject'); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); finish('accept'); }
    };
    window.addEventListener('keydown', onKey);

    requestAnimationFrame(() => overlay.classList.add('show'));
  });
}

function languageOf(p) {
  const ext = p.split('.').pop()?.toLowerCase();
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
    json: 'json', md: 'markdown', html: 'html', css: 'css',
    sh: 'shell', bash: 'shell',
    yml: 'yaml', yaml: 'yaml',
    rs: 'rust', go: 'go', java: 'java',
  };
  return map[ext] || 'plaintext';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
