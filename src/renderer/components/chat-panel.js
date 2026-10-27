import { renderMarkdown } from './markdown.js';
import {
  showMentionPicker,
  hideMentionPicker,
  updateMentionPicker,
  isMentionPickerOpen,
  moveMentionPickerSelection,
  commitMentionPickerSelection,
} from './mention-picker.js';

const MAX_ATTACH_CHARS = 60_000; // ~15k tokens; protect against giant files

export function mountChatPanel({ container, getContext }) {
  const messagesEl = container.querySelector('#chat-messages');
  const input = container.querySelector('#chat-input');
  const sendBtn = container.querySelector('#btn-send-chat');
  const clearBtn = container.querySelector('#btn-clear-chat');
  const attachActiveBtn = container.querySelector('#btn-attach-active');
  const attachmentsEl = container.querySelector('#chat-attachments');

  // Full-fidelity conversation (user turns, assistant text + tool_use blocks,
  // tool_result turns) maintained across sends so multi-turn agent tasks keep
  // their context. Display bubbles are independent of this.
  const apiHistory = [];
  let historyGeneration = 0; // bumped on Clear; stale ai:done events must not repopulate history
  const requests = new Map();
  const attached = new Map(); // path -> { rel }
  let activeRequestId = null;
  let stickToBottom = true;
  let suppressScrollEvents = 0; // counter: programmatic scrolls in flight

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }

  function pinToBottom() {
    suppressScrollEvents++;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Release after the scroll event for this assignment fires (next tick).
    setTimeout(() => { if (suppressScrollEvents > 0) suppressScrollEvents--; }, 0);
  }

  // Jump-to-latest button (appears when scrolled up)
  const jumpBtn = document.createElement('button');
  jumpBtn.className = 'chat-jump-btn';
  jumpBtn.title = 'Jump to latest';
  jumpBtn.innerHTML = '↓ new';
  jumpBtn.addEventListener('click', () => {
    stickToBottom = true;
    pinToBottom();
    jumpBtn.classList.remove('show');
  });
  messagesEl.parentElement.appendChild(jumpBtn);

  messagesEl.addEventListener('scroll', () => {
    if (suppressScrollEvents > 0) return; // ignore self-induced scrolls
    stickToBottom = isNearBottom();
    jumpBtn.classList.toggle('show', !stickToBottom);
  });

  function scrollToBottom(force = false) {
    if (stickToBottom || force) pinToBottom();
  }

  // Re-pin on any DOM growth while sticky (handles text deltas during streaming).
  const mo = new MutationObserver(() => {
    if (stickToBottom) pinToBottom();
  });
  mo.observe(messagesEl, { childList: true, subtree: true, characterData: true });

  function appendUserMessage(text, attachments) {
    const el = document.createElement('div');
    el.className = 'msg msg-user';
    if (attachments && attachments.length) {
      const chips = attachments.map((a) => `<span class="msg-attach-chip">${escapeHtml(a.rel)}</span>`).join('');
      el.innerHTML = `<div class="msg-attach-row">${chips}</div><div class="msg-user-text"></div>`;
      el.querySelector('.msg-user-text').textContent = text;
    } else {
      el.textContent = text;
    }
    messagesEl.appendChild(el);
    scrollToBottom(true);
  }

  function appendStatusMessage(text, variant = 'info') {
    const el = document.createElement('div');
    el.className = `msg msg-status msg-${variant}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function createAssistantBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    wrap.innerHTML = `
      <div class="assistant-tools"></div>
      <div class="assistant-text streaming"></div>
      <div class="assistant-cursor"></div>
    `;
    messagesEl.appendChild(wrap);
    scrollToBottom(true);
    return {
      wrap,
      toolsEl: wrap.querySelector('.assistant-tools'),
      textEl: wrap.querySelector('.assistant-text'),
      cursorEl: wrap.querySelector('.assistant-cursor'),
    };
  }

  function makeToolCard(name, input) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    const summary = previewInput(name, input);
    card.innerHTML = `
      <div class="tool-card-head">
        <span class="tool-card-icon">🔧</span>
        <span class="tool-card-name">${escapeHtml(name)}</span>
        <span class="tool-card-summary">${escapeHtml(summary)}</span>
        <span class="tool-card-status pending">running…</span>
      </div>
      <pre class="tool-card-body" hidden></pre>
    `;
    card.querySelector('.tool-card-head').addEventListener('click', () => {
      const body = card.querySelector('.tool-card-body');
      body.hidden = !body.hidden;
      if (!body.hidden) body.textContent = JSON.stringify(input, null, 2);
    });
    return card;
  }

  function previewInput(name, input) {
    if (name === 'run_command' && input?.command) {
      return `$ ${String(input.command).slice(0, 80)}`;
    }
    if (input?.path) return input.path;
    const keys = Object.keys(input || {});
    if (keys.length === 0) return '';
    return `${keys[0]}=${String(input[keys[0]]).slice(0, 60)}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- Attachments ----

  function renderAttachments() {
    attachmentsEl.innerHTML = '';
    if (attached.size === 0) {
      attachmentsEl.classList.add('empty');
      return;
    }
    attachmentsEl.classList.remove('empty');
    for (const [path, meta] of attached) {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.innerHTML = `<span class="attach-chip-icon">@</span><span class="attach-chip-name">${escapeHtml(meta.rel)}</span><span class="attach-chip-x">×</span>`;
      chip.querySelector('.attach-chip-x').addEventListener('click', () => {
        attached.delete(path);
        renderAttachments();
      });
      attachmentsEl.appendChild(chip);
    }
  }

  function attachFile(filePath, rel) {
    if (attached.has(filePath)) return;
    attached.set(filePath, { rel: rel || filePath });
    renderAttachments();
  }

  // ---- IPC listeners ----

  window.ostro.ai.onChunk(({ id, delta }) => {
    const req = requests.get(id);
    if (!req) return;
    req.text += delta;
    req.textEl.textContent = req.text;
    scrollToBottom();
  });

  window.ostro.ai.onToolUse(({ id, tool }) => {
    const req = requests.get(id);
    if (!req) return;
    const card = makeToolCard(tool.name, tool.input);
    req.toolsEl.appendChild(card);
    req.toolCards.push({ card, tool_use_id: tool.tool_use_id });
    scrollToBottom();
  });

  window.ostro.ai.onToolResult(({ id, result }) => {
    const req = requests.get(id);
    if (!req) return;
    const card = req.toolCards.find((tc) => tc.tool_use_id === result.tool_use_id)?.card;
    if (!card) return;
    const statusEl = card.querySelector('.tool-card-status');
    statusEl.classList.remove('pending');
    if (result.ok) {
      if (result.preview) {
        const p = result.preview;
        const ok = p.exitCode === 0 && !p.timedOut;
        statusEl.classList.add(ok ? 'ok' : 'err');
        statusEl.textContent = p.timedOut ? 'timeout' : `exit ${p.exitCode}`;
        const body = card.querySelector('.tool-card-body');
        body.hidden = false;
        body.textContent = formatCommandOutput(p);
      } else {
        statusEl.classList.add('ok');
        statusEl.textContent = 'done';
      }
    } else {
      statusEl.classList.add('err');
      statusEl.textContent = 'error';
      const body = card.querySelector('.tool-card-body');
      body.hidden = false;
      body.textContent = result.error;
    }
  });

  function formatCommandOutput(p) {
    const parts = [];
    if (p.stdout) parts.push(`--- stdout ---\n${p.stdout}`);
    if (p.stderr) parts.push(`--- stderr ---\n${p.stderr}`);
    if (!p.stdout && !p.stderr) parts.push('(no output)');
    if (p.truncated) parts.push('[output truncated]');
    if (p.timedOut) parts.push('[command timed out after 120s]');
    return parts.join('\n\n');
  }

  window.ostro.ai.onDone(({ id, final }) => {
    const req = requests.get(id);
    if (!req) return;
    for (const tc of req.toolCards) {
      const statusEl = tc.card.querySelector('.tool-card-status');
      if (statusEl?.classList.contains('pending')) {
        statusEl.classList.remove('pending');
        statusEl.classList.add('ok');
        statusEl.textContent = 'done';
      }
    }
    if (req.text) {
      req.textEl.classList.remove('streaming');
      req.textEl.innerHTML = renderMarkdown(req.text);
    }
    // Adopt the authoritative conversation (includes tool_use/tool_result
    // turns and, for Claude, signed thinking blocks) for later turns —
    // unless the user cleared the chat while this request was in flight.
    if (Array.isArray(final?.conversation) && req.generation === historyGeneration) {
      apiHistory.length = 0;
      apiHistory.push(...final.conversation);
    }
    req.cursorEl.remove();
    finalizeRequest(id);
  });

  window.ostro.ai.onError(({ id, message }) => {
    const req = requests.get(id);
    if (req) {
      req.textEl.classList.remove('streaming');
      req.textEl.classList.add('error');
      req.textEl.textContent = `⚠ ${message}`;
      req.cursorEl.remove();
    } else {
      appendStatusMessage(`⚠ ${message}`, 'error');
    }
    finalizeRequest(id);
  });

  // Auto-approved actions (auto/bypass modes) are announced inline so the
  // user still sees what the agent did without a blocking modal.
  window.ostro.ai.onAutoApproved(({ id, request, mode }) => {
    const req = requests.get(id);
    if (!req) return;
    const label = request?.kind === 'command'
      ? `$ ${String(request.command || '').slice(0, 80)}`
      : `write ${request?.path || ''}`;
    const note = document.createElement('div');
    note.className = 'msg msg-status msg-auto-approved';
    note.textContent = `⚡ auto-approved (${mode}): ${label}`;
    req.toolsEl.appendChild(note);
    scrollToBottom();
  });

  function finalizeRequest(id) {
    requests.delete(id);
    if (activeRequestId === id) {
      activeRequestId = null;
      setSendButtonMode('send');
    }
  }

  function setSendButtonMode(mode) {
    if (mode === 'stop') {
      sendBtn.textContent = 'Stop';
      sendBtn.classList.add('btn-stop');
      sendBtn.classList.remove('btn-primary');
    } else {
      sendBtn.textContent = 'Send';
      sendBtn.classList.remove('btn-stop');
      sendBtn.classList.add('btn-primary');
    }
  }

  async function buildAttachedContext(ctx) {
    if (attached.size === 0) return null;
    const parts = [];
    let total = 0;
    for (const [path, meta] of attached) {
      try {
        const content = await window.ostro.fs.readFile(path);
        const truncated = content.length > MAX_ATTACH_CHARS
          ? content.slice(0, MAX_ATTACH_CHARS) + '\n…[truncated]'
          : content;
        parts.push(`=== ${meta.rel} ===\n${truncated}`);
        total += truncated.length;
        if (total > MAX_ATTACH_CHARS * 3) break;
      } catch (err) {
        parts.push(`=== ${meta.rel} ===\n[failed to read: ${err.message}]`);
      }
    }
    return parts.join('\n\n');
  }

  async function send() {
    if (activeRequestId) {
      window.ostro.ai.cancel(activeRequestId);
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    const ctx = getContext();
    const cfg = ctx.config || {};
    const provider = cfg.provider || 'anthropic';
    const apiKey = await window.ostro.keychain.getApiKey(provider);
    if (!apiKey) {
      appendStatusMessage(`No API key set for "${provider}". Open Settings to add one.`, 'error');
      return;
    }

    const attachmentsSnapshot = Array.from(attached.entries()).map(([path, meta]) => ({ path, rel: meta.rel }));
    const attachedContext = await buildAttachedContext(ctx);

    appendUserMessage(text, attachmentsSnapshot);
    const apiMessage = attachedContext
      ? `[Attached files]\n${attachedContext}\n\n[Question]\n${text}`
      : text;
    const messages = [...apiHistory, { role: 'user', content: apiMessage }];

    input.value = '';
    attached.clear();
    renderAttachments();
    autoGrow();

    const bubble = createAssistantBubble();
    const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const req = { id, text: '', toolCards: [], generation: historyGeneration, ...bubble };
    requests.set(id, req);
    activeRequestId = id;
    setSendButtonMode('stop');

    try {
      await window.ostro.ai.sendMessage({
        id,
        provider,
        baseUrl: cfg.baseUrl || '',
        apiKey,
        model: cfg.model,
        messages,
        systemPrompt: buildSystemPrompt(ctx, cfg),
        workspaceRoot: ctx.workspaceRoot,
        enableTools: !!ctx.workspaceRoot && cfg.enableTools !== false,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        thinkingBudget: cfg.thinkingBudget || 0,
        approvalMode: cfg.approvalMode || 'ask',
      });
    } catch (err) {
      appendStatusMessage(`⚠ ${err.message}`, 'error');
      finalizeRequest(id);
    }
  }

  function buildSystemPrompt(ctx, cfg) {
    const lines = [
      'You are Ostro, an AI pair-programmer embedded inside a code editor.',
      'Be concise. Use markdown for code blocks (with language fences) and lists.',
    ];
    if (ctx.workspaceRoot) lines.push(`Workspace root: ${ctx.workspaceRoot}`);
    if (ctx.activePath) lines.push(`User is currently looking at: ${ctx.activePath}`);
    if (cfg?.systemPrompt) lines.push('', '---', cfg.systemPrompt);
    return lines.join('\n');
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  // ---- Mention detection ----

  function getMentionAtCursor() {
    const cursorPos = input.selectionStart;
    const before = input.value.slice(0, cursorPos);
    const m = before.match(/(?:^|\s)@(\S*)$/);
    if (!m) return null;
    return { query: m[1], startIdx: cursorPos - m[1].length - 1, endIdx: cursorPos };
  }

  function maybeShowMention() {
    const m = getMentionAtCursor();
    if (!m) { hideMentionPicker(); return; }
    if (isMentionPickerOpen()) {
      updateMentionPicker(m.query);
    } else {
      showMentionPicker({
        anchor: input,
        query: m.query,
        onSelect: (file) => {
          input.value = input.value.slice(0, m.startIdx) + input.value.slice(m.endIdx);
          input.setSelectionRange(m.startIdx, m.startIdx);
          attachFile(file.path, file.rel);
          autoGrow();
          input.focus();
        },
      });
    }
  }

  // ---- Wiring ----

  sendBtn.addEventListener('click', send);
  input.addEventListener('input', () => { autoGrow(); maybeShowMention(); });
  input.addEventListener('click', maybeShowMention);
  input.addEventListener('blur', () => setTimeout(hideMentionPicker, 100));

  input.addEventListener('keydown', (e) => {
    if (isMentionPickerOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionPickerSelection(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveMentionPickerSelection(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (!commitMentionPickerSelection()) hideMentionPicker();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); hideMentionPicker(); return; }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      send();
    }
  });

  attachActiveBtn.addEventListener('click', () => {
    const ctx = getContext();
    if (!ctx.activePath) { appendStatusMessage('No file is active', 'info'); return; }
    const rel = ctx.workspaceRoot && ctx.activePath.startsWith(ctx.workspaceRoot)
      ? ctx.activePath.slice(ctx.workspaceRoot.length + 1).replace(/\\/g, '/')
      : ctx.activePath;
    attachFile(ctx.activePath, rel);
    input.focus();
  });

  clearBtn.addEventListener('click', () => {
    if (activeRequestId) window.ostro.ai.cancel(activeRequestId);
    historyGeneration += 1;
    apiHistory.length = 0;
    messagesEl.innerHTML = '';
    attached.clear();
    renderAttachments();
  });

  renderAttachments();
}
