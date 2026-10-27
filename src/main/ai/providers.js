// Provider abstraction for the Ostro agent loop.
//
// The agent loop speaks ONE internal wire format (Anthropic content blocks):
//   user message:      { role: 'user', content: string | ToolResultBlock[] }
//   assistant message: { role: 'assistant', content: (Text|Thinking|ToolUse)[] }
//   tools:             [{ name, description, input_schema }]
//
// Each adapter converts that format to/from its native API and exposes:
//   provider.stream({ model, system, messages, tools, maxTokens, temperature,
//                      thinking?, signal, onTextDelta })
//     -> { content: Block[], stopReason, usage? }
//
// Adapters:
//   - anthropic : native @anthropic-ai/sdk (keeps extended thinking + tool_use fidelity)
//   - openai    : any OpenAI-compatible /chat/completions endpoint via fetch
//                 (OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together, xAI,
//                  Google Gemini compat endpoint, Ollama, LM Studio, vLLM, ...)

const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

// Reasoning-style models reject `temperature` and `max_tokens`;
// they require `max_completion_tokens` instead.
const REASONING_MODEL_RE = /^(o\d|gpt-5|gpt-oss|gpt-4\.1-|chatgpt-4o-latest)/i;

function createProvider({ provider, apiKey, baseUrl }) {
  if (provider === 'anthropic') return createAnthropicProvider({ apiKey });
  if (provider === 'openai') return createOpenAIProvider({ apiKey, baseUrl });
  throw new Error(`Unsupported AI provider: "${provider}". Use "anthropic" or "openai" (OpenAI-compatible).`);
}

// ---------------------------------------------------------------------------
// Anthropic (native SDK)
// ---------------------------------------------------------------------------

function createAnthropicProvider({ apiKey }) {
  const client = new Anthropic({ apiKey });
  return {
    id: 'anthropic',

    async stream({ model, system, messages, tools, maxTokens, temperature, thinking, signal, onTextDelta }) {
      const req = {
        model,
        max_tokens: maxTokens,
        system,
        messages,
      };
      if (tools?.length) req.tools = tools;
      if (thinking) {
        req.thinking = thinking;
        req.temperature = 1; // API requirement when extended thinking is enabled
      } else if (typeof temperature === 'number') {
        req.temperature = temperature;
      }

      const stream = client.messages.stream(req, { signal });

      let text = '';
      // Manually accumulate thinking content because some SDK versions do not
      // populate thinking blocks in finalMessage when tool_use also occurs.
      const thinkingAccum = {}; // block_index -> { thinking, signature }

      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
          thinkingAccum[event.index] = { thinking: '', signature: '' };
        } else if (event.type === 'content_block_delta') {
          const d = event.delta;
          if (d.type === 'text_delta') {
            text += d.text;
            onTextDelta?.(d.text);
          } else if (d.type === 'thinking_delta') {
            if (thinkingAccum[event.index]) thinkingAccum[event.index].thinking += d.thinking || '';
          } else if (d.type === 'signature_delta') {
            if (thinkingAccum[event.index]) thinkingAccum[event.index].signature = d.signature || '';
          }
        }
      }

      const final = await stream.finalMessage();
      const content = (final.content || [])
        .map((b, i) => {
          if (b.type === 'thinking') {
            const acc = thinkingAccum[i] || {};
            const t = b.thinking || acc.thinking || '';
            const sig = b.signature || acc.signature || '';
            if (!t) return null; // drop empty thinking blocks the API would reject
            return { type: 'thinking', thinking: t, ...(sig ? { signature: sig } : {}) };
          }
          return b;
        })
        .filter(Boolean);

      return { content, stopReason: final.stop_reason, usage: final.usage, text };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (fetch + SSE)
// ---------------------------------------------------------------------------

function createOpenAIProvider({ apiKey, baseUrl }) {
  const base = String(baseUrl || DEFAULT_OPENAI_BASE).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`Invalid base URL: "${base}" (must start with http:// or https://)`);
  }

  return {
    id: 'openai',

    async stream({ model, system, messages, tools, maxTokens, temperature, signal, onTextDelta }) {
      const body = {
        model,
        stream: true,
        messages: toOpenAIMessages(system, messages),
      };
      if (tools?.length) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }));
      }
      const isReasoning = REASONING_MODEL_RE.test(model);
      if (maxTokens) {
        if (isReasoning) body.max_completion_tokens = maxTokens;
        else body.max_tokens = maxTokens;
      }
      if (!isReasoning && typeof temperature === 'number') body.temperature = temperature;

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        let detail = '';
        try {
          const j = await res.json();
          detail = j?.error?.message || j?.message || JSON.stringify(j);
        } catch {
          try { detail = await res.text(); } catch { /* body already consumed */ }
        }
        throw new Error(`Provider error (HTTP ${res.status}): ${String(detail).slice(0, 500)}`);
      }
      if (!res.body) throw new Error('Provider returned an empty response body');

      return parseOpenAISSE(res.body, { onTextDelta });
    },
  };
}

// Convert internal (Anthropic-block) messages to OpenAI chat format.
function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });

  for (const msg of messages || []) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'tool_result') {
            out.push({
              role: 'tool',
              tool_call_id: b.tool_use_id,
              content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
            });
          } else if (b.type === 'text') {
            out.push({ role: 'user', content: b.text });
          }
        }
      }
    } else if (msg.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const b of msg.content || []) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
        // thinking blocks are Anthropic-specific: not forwarded
      }
      const m = { role: 'assistant', content: textParts.join('\n\n') || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
    }
  }
  return out;
}

// Parse an OpenAI-compatible SSE stream into internal blocks.
async function parseOpenAISSE(streamBody, { onTextDelta }) {
  const reader = streamBody.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const toolAcc = new Map(); // delta index -> { id, name, args }
  let finishReason = null;

  const handleEvent = (data) => {
    if (!data || data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (ev.error) {
      const msg = ev.error.message || JSON.stringify(ev.error);
      throw new Error(`Provider stream error: ${String(msg).slice(0, 300)}`);
    }
    const choice = ev.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onTextDelta?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        if (!toolAcc.has(i)) toolAcc.set(i, { id: '', name: '', args: '' });
        const acc = toolAcc.get(i);
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
    }
  }
  if (buf.startsWith('data:')) handleEvent(buf.slice(5).trim());

  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!acc.name) continue;
    let input = {};
    if (acc.args) {
      try { input = JSON.parse(acc.args); } catch { input = { _raw_arguments: acc.args }; }
    }
    blocks.push({ type: 'tool_use', id: acc.id || `call_${Date.now()}`, name: acc.name, input });
  }

  const stopReason =
    finishReason === 'tool_calls' ? 'tool_use'
    : finishReason === 'length' ? 'max_tokens'
    : 'end_turn';

  return { content: blocks, stopReason, text };
}

// ---------------------------------------------------------------------------
// Connection test (used by the Settings "Test connection" button)
// ---------------------------------------------------------------------------

async function listModels({ provider, apiKey, baseUrl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey });
      const page = await client.models.list({ limit: 20 }, { signal: controller.signal });
      return (page.data || []).map((m) => m.id);
    }
    const base = String(baseUrl || DEFAULT_OPENAI_BASE).trim().replace(/\/+$/, '');
    const res = await fetch(`${base}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const j = await res.json();
    const models = [...new Set(
      (j.data || j.models || [])
        .map((m) => m.id || m.name)
        .filter(Boolean)
    )].sort();
    return models.slice(0, 100);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  createProvider,
  listModels,
  toOpenAIMessages, // exported for tests
  REASONING_MODEL_RE,
};
