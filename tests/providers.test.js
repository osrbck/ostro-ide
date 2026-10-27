const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createProvider,
  listModels,
  toOpenAIMessages,
  REASONING_MODEL_RE,
} = require('../src/main/ai/providers');

// ---------------------------------------------------------------------------
// Message conversion (internal Anthropic-block format -> OpenAI chat format)
// ---------------------------------------------------------------------------

test('toOpenAIMessages converts system + plain turns', () => {
  const out = toOpenAIMessages('be terse', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  ]);
  assert.deepEqual(out, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('toOpenAIMessages converts tool_use and tool_result turns', () => {
  const out = toOpenAIMessages(null, [
    { role: 'user', content: 'list files' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' }, // must be dropped
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'call_1', name: 'list_dir', input: { path: '.' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"entries":[]}' }],
    },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'list files' },
    {
      role: 'assistant',
      content: 'checking',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"entries":[]}' },
  ]);
});

// ---------------------------------------------------------------------------
// OpenAI-compatible streaming (mocked fetch + SSE)
// ---------------------------------------------------------------------------

function sseResponse(events, { status = 200, chunks } = {}) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      if (status === 200) {
        for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
  return new Response(status === 200 ? stream : null, {
    status,
    headers: { 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' },
  });
}

test('openai provider streams text deltas and parses tool calls', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return sseResponse([
      { choices: [{ delta: { role: 'assistant', content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'write_file', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt","content":"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
  };

  try {
    const provider = createProvider({ provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1' });
    const deltas = [];
    const result = await provider.stream({
      model: 'gpt-4o',
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'write_file', description: 'd', input_schema: { type: 'object' } }],
      maxTokens: 512,
      temperature: 0.5,
      onTextDelta: (t) => deltas.push(t),
    });

    assert.equal(deltas.join(''), 'Hello world');
    assert.equal(result.text, 'Hello world');
    assert.equal(result.stopReason, 'tool_use');
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'Hello world');
    assert.equal(result.content[1].type, 'tool_use');
    assert.equal(result.content[1].id, 'call_9');
    assert.equal(result.content[1].name, 'write_file');
    assert.deepEqual(result.content[1].input, { path: 'a.txt', content: 'x' });

    // Request shape
    assert.equal(requests[0].url, 'https://api.example.com/v1/chat/completions');
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].body.max_tokens, 512);
    assert.equal(requests[0].body.temperature, 0.5);
    assert.equal(requests[0].body.tools[0].function.name, 'write_file');
    assert.equal(requests[0].body.messages[0].role, 'system');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai provider uses max_completion_tokens and skips temperature for reasoning models', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ body: JSON.parse(init.body) });
    return sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
  };

  try {
    const provider = createProvider({ provider: 'openai', apiKey: 'k', baseUrl: 'https://api.example.com/v1' });
    await provider.stream({ model: 'o3-mini', system: '', messages: [], maxTokens: 1000, temperature: 0.2 });
    assert.equal(requests[0].body.max_completion_tokens, 1000);
    assert.equal(requests[0].body.max_tokens, undefined);
    assert.equal(requests[0].body.temperature, undefined);
    assert.ok(REASONING_MODEL_RE.test('o3-mini'));
    assert.ok(!REASONING_MODEL_RE.test('gpt-4o'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai provider surfaces HTTP errors with provider detail', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 });

  try {
    const provider = createProvider({ provider: 'openai', apiKey: 'bad', baseUrl: 'https://api.example.com/v1' });
    await assert.rejects(
      provider.stream({ model: 'm', system: '', messages: [] }),
      /HTTP 401.*Invalid API key/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai provider rejects invalid base URLs and unknown providers', () => {
  assert.throws(() => createProvider({ provider: 'openai', apiKey: 'k', baseUrl: 'ftp://x' }), /Invalid base URL/);
  assert.throws(() => createProvider({ provider: 'wechat', apiKey: 'k' }), /Unsupported AI provider/);
});

// ---------------------------------------------------------------------------
// listModels (connection test)
// ---------------------------------------------------------------------------

test('listModels fetches and normalizes OpenAI-compatible model lists', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://api.example.com/v1/models');
    return new Response(JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }, { id: 'm1' }] }), { status: 200 });
  };
  try {
    const models = await listModels({ provider: 'openai', apiKey: 'k', baseUrl: 'https://api.example.com/v1' });
    assert.deepEqual(models, ['m1', 'm2']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listModels reports HTTP failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 403 });
  try {
    await assert.rejects(
      listModels({ provider: 'openai', apiKey: 'k', baseUrl: 'https://api.example.com/v1' }),
      /HTTP 403/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
