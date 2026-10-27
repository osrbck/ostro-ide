const { createProvider, listModels } = require('../ai/providers');
const { autoDecision } = require('../ai/approval-policy');
const { runAgentLoop } = require('../agent/agent-loop');

const activeRuns = new Map(); // id -> { abort, pending: Map<tool_use_id, {resolve, reject}> }

function registerAiHandlers(ipcMain, { getMainWindow }) {
  ipcMain.handle('ai:sendMessage', async (_evt, payload) => {
    const {
      id, provider: providerId, apiKey, baseUrl, model, messages, systemPrompt,
      workspaceRoot, enableTools, maxTokens, temperature, thinkingBudget, approvalMode,
    } = payload;
    if (!apiKey) throw new Error('No API key provided');

    const provider = createProvider({ provider: providerId || 'anthropic', apiKey, baseUrl });

    const abort = new AbortController();
    const pending = new Map();
    activeRuns.set(id, { abort, pending });

    const win = getMainWindow();
    const emit = (channel, data) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, { id, ...data });
    };

    // Approval policy: 'ask' always asks; 'auto' auto-approves file writes;
    // 'bypass' auto-approves everything. Auto decisions are surfaced to the
    // renderer so the UI can show what happened without opening a modal.
    const requestApproval = (req) => {
      const auto = autoDecision(approvalMode, req);
      if (auto) {
        emit('ai:autoApproved', { request: req, mode: auto.mode });
        return Promise.resolve(auto);
      }
      return new Promise((resolve, reject) => {
        pending.set(req.tool_use_id, { resolve, reject });
        emit('ai:approvalRequest', { request: req });
      });
    };

    try {
      await runAgentLoop({
        provider,
        model,
        messages,
        systemPrompt,
        workspaceRoot,
        enableTools,
        maxTokens,
        temperature,
        // Extended thinking is Anthropic-specific; never forward it elsewhere.
        thinkingBudget: provider.id === 'anthropic' ? thinkingBudget : 0,
        signal: abort.signal,
        onChunk: (delta) => emit('ai:chunk', { delta }),
        onToolUse: (tool) => emit('ai:toolUse', { tool }),
        onToolResult: (result) => emit('ai:toolResult', { result }),
        onDone: (final) => emit('ai:done', { final }),
        requestApproval,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        // User cancellation: finalize the run cleanly so the UI unlocks.
        emit('ai:done', { final: { text: '', stopReason: 'aborted', conversation: messages } });
      } else {
        emit('ai:error', { message: err.message });
      }
    } finally {
      for (const { reject } of pending.values()) {
        reject(new Error('Run ended before approval'));
      }
      activeRuns.delete(id);
    }
    return { ok: true };
  });

  ipcMain.handle('ai:cancel', (_evt, id) => {
    const run = activeRuns.get(id);
    if (run) {
      run.abort.abort();
      for (const { reject } of run.pending.values()) {
        reject(new Error('Cancelled by user'));
      }
      run.pending.clear();
    }
    return true;
  });

  ipcMain.handle('ai:approvalResponse', (_evt, { id, tool_use_id, decision }) => {
    const run = activeRuns.get(id);
    if (!run) return false;
    const entry = run.pending.get(tool_use_id);
    if (!entry) return false;
    entry.resolve(decision);
    run.pending.delete(tool_use_id);
    return true;
  });

  // Settings "Test connection": validates the key + endpoint and returns
  // the model ids the provider advertises.
  ipcMain.handle('ai:testConnection', async (_evt, { provider: providerId, apiKey, baseUrl }) => {
    if (!apiKey) throw new Error('No API key provided');
    const models = await listModels({ provider: providerId || 'anthropic', apiKey, baseUrl });
    return { ok: true, models };
  });

  // Returns the approval policy modes so the renderer can render them
  // without duplicating the authoritative list.
  ipcMain.handle('ai:approvalModes', () => {
    const { MODES, describeMode } = require('../ai/approval-policy');
    return MODES.map((m) => ({ id: m, label: describeMode(m) }));
  });
}

module.exports = { registerAiHandlers };
