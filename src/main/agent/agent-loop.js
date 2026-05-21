const { TOOL_DEFINITIONS, executeTool } = require('./tools');

const MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOKENS = 4096;

function thinkingSupported(model) {
  // Extended thinking supported on Claude 4+ Sonnet and Opus, not Haiku.
  return /claude-(opus|sonnet)-4/i.test(model || '');
}

async function runAgentLoop({
  client,
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

  const useThinking = thinkingBudget > 0 && thinkingSupported(model);
  const max_tokens = Math.max(maxTokens || DEFAULT_MAX_TOKENS, useThinking ? thinkingBudget + 1024 : 1024);
  // Claude API requires temperature=1 when extended thinking is enabled.
  const temp = useThinking ? 1 : (typeof temperature === 'number' ? temperature : 1);

  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) return;
    iterations += 1;

    const req = {
      model,
      max_tokens,
      temperature: temp,
      system: systemPrompt || 'You are Ostro, an AI coding assistant inside a code editor.',
      messages: conversation,
      tools: enableTools ? TOOL_DEFINITIONS : undefined,
    };
    if (useThinking) {
      req.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    }

    const stream = client.messages.stream(req, { signal });

    let textBuffer = '';
    // Manually accumulate thinking content because some SDK versions do not
    // populate thinking blocks in finalMessage when tool_use also occurs.
    const thinkingAccum = {}; // block_index -> { thinking, signature }

    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        thinkingAccum[event.index] = { thinking: '', signature: '' };
      } else if (event.type === 'content_block_delta') {
        const d = event.delta;
        if (d.type === 'text_delta') {
          textBuffer += d.text;
          onChunk?.(d.text);
        } else if (d.type === 'thinking_delta') {
          if (thinkingAccum[event.index]) thinkingAccum[event.index].thinking += d.thinking || '';
        } else if (d.type === 'signature_delta') {
          if (thinkingAccum[event.index]) thinkingAccum[event.index].signature = d.signature || '';
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    const assistantBlocks = finalMessage.content.map((b, i) => {
      if (b.type === 'thinking') {
        const acc = thinkingAccum[i] || {};
        const thinking = b.thinking || acc.thinking || '';
        const signature = b.signature || acc.signature || '';
        if (!thinking) return null; // drop empty thinking blocks that the API will reject
        return { type: 'thinking', thinking, ...(signature ? { signature } : {}) };
      }
      return b;
    }).filter(Boolean);
    conversation.push({ role: 'assistant', content: assistantBlocks });

    const toolUses = assistantBlocks.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      onDone?.({ text: textBuffer, stopReason: finalMessage.stop_reason });
      return;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      onToolUse?.({ tool_use_id: tu.id, name: tu.name, input: tu.input });
      try {
        const result = await executeTool(tu.name, tu.input, {
          workspaceRoot,
          requestApproval,
          toolUseId: tu.id,
          signal,
        });
        const preview = tu.name === 'run_command'
          ? { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, truncated: result.truncated, timedOut: result.timedOut }
          : null;
        onToolResult?.({ tool_use_id: tu.id, ok: true, preview });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
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

  onDone?.({ text: '[agent loop reached max iterations]', stopReason: 'max_iterations' });
}

module.exports = { runAgentLoop };
