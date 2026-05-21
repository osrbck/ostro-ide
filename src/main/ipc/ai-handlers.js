const Anthropic = require('@anthropic-ai/sdk');
const { runAgentLoop } = require('../agent/agent-loop');

const activeRuns = new Map(); // id -> { abort, pending: Map<tool_use_id, {resolve, reject}> }

function registerAiHandlers(ipcMain, { getMainWindow }) {
  ipcMain.handle('ai:sendMessage', async (_evt, payload) => {
    const {
      id, apiKey, model, messages, systemPrompt, workspaceRoot, enableTools,
      maxTokens, temperature, thinkingBudget,
    } = payload;
    if (!apiKey) throw new Error('No API key provided');

    const client = new Anthropic({ apiKey });
    const abort = new AbortController();
    const pending = new Map();
    activeRuns.set(id, { abort, pending });

    const win = getMainWindow();
    const emit = (channel, data) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, { id, ...data });
    };

    const requestApproval = (req) =>
      new Promise((resolve, reject) => {
        pending.set(req.tool_use_id, { resolve, reject });
        emit('ai:approvalRequest', { request: req });
      });

    try {
      await runAgentLoop({
        client,
        model: model || 'claude-sonnet-4-6',
        messages,
        systemPrompt,
        workspaceRoot,
        enableTools,
        maxTokens,
        temperature,
        thinkingBudget,
        signal: abort.signal,
        onChunk: (delta) => emit('ai:chunk', { delta }),
        onToolUse: (tool) => emit('ai:toolUse', { tool }),
        onToolResult: (result) => emit('ai:toolResult', { result }),
        onDone: (final) => emit('ai:done', { final }),
        requestApproval,
      });
    } catch (err) {
      emit('ai:error', { message: err.message });
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
}

module.exports = { registerAiHandlers };
