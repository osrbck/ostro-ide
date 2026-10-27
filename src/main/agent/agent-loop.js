const { TOOL_DEFINITIONS, executeTool } = require('./tools');

const MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_SYSTEM = 'You are Ostro, an AI coding assistant inside a code editor.';

function thinkingSupported(model) {
  // Extended thinking supported on Claude 4+ Sonnet and Opus, not Haiku.
  return /claude-(opus|sonnet)-4/i.test(model || '');
}

async function runAgentLoop({
  provider,
  model,
  messages,
  systemPrompt,
  workspaceRoot,
  enableTools,
  maxTokens,
  temperature,
  thinkingBudget,
  signal,
  onChunk,
  onToolUse,
  onToolResult,
  onDone,
  requestApproval,
}) {
  let conversation = [...messages];
  let iterations = 0;
  let textSoFar = '';

  const isAnthropic = provider.id === 'anthropic';
  const useThinking = isAnthropic && thinkingBudget > 0 && thinkingSupported(model);
  const max_tokens = Math.max(maxTokens || DEFAULT_MAX_TOKENS, useThinking ? thinkingBudget + 1024 : 1024);
  // Claude API requires temperature=1 when extended thinking is enabled.
  const temp = useThinking ? 1 : (typeof temperature === 'number' ? temperature : 1);

  const finish = (stopReason) => {
    onDone?.({ text: textSoFar, stopReason, conversation });
  };

  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) {
      finish('aborted');
      return;
    }
    iterations += 1;

    let result;
    try {
      result = await provider.stream({
        model,
        system: systemPrompt || DEFAULT_SYSTEM,
        messages: conversation,
        tools: enableTools ? TOOL_DEFINITIONS : undefined,
        maxTokens: max_tokens,
        temperature: temp,
        thinking: useThinking ? { type: 'enabled', budget_tokens: thinkingBudget } : undefined,
        signal,
        onTextDelta: (t) => { textSoFar += t; onChunk?.(t); },
      });
    } catch (err) {
      // A user cancellation aborts the upstream request; surface it as a clean
      // stop instead of an error so the UI does not get stuck in Stop mode.
      if (signal?.aborted) {
        finish('aborted');
        return;
      }
      throw err;
    }
    if (signal?.aborted) {
      finish('aborted');
      return;
    }

    conversation.push({ role: 'assistant', content: result.content });

    const toolUses = result.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      finish(result.stopReason || 'end_turn');
      return;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      onToolUse?.({ tool_use_id: tu.id, name: tu.name, input: tu.input });
      try {
        const result2 = await executeTool(tu.name, tu.input, {
          workspaceRoot,
          requestApproval,
          toolUseId: tu.id,
          signal,
        });
        const preview = tu.name === 'run_command'
          ? { stdout: result2.stdout, stderr: result2.stderr, exitCode: result2.exitCode, truncated: result2.truncated, timedOut: result2.timedOut }
          : null;
        onToolResult?.({ tool_use_id: tu.id, ok: true, preview });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result2),
        });
      } catch (err) {
        onToolResult?.({ tool_use_id: tu.id, ok: false, error: err.message });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: err.message,
        });
      }
    }

    conversation.push({ role: 'user', content: toolResults });
  }

  finish('max_iterations');
}

module.exports = { runAgentLoop };
