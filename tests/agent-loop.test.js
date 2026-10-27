const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runAgentLoop } = require('../src/main/agent/agent-loop');

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ostro-loop-'));
}

// A fake provider that replays scripted responses, one per call.
function scriptedProvider(responses) {
  let call = 0;
  const calls = [];
  return {
    id: 'test',
    calls,
    async stream(req) {
      // Snapshot the request (messages arrays are mutated by the loop later).
      calls.push(JSON.parse(JSON.stringify({ messages: req.messages, tools: req.tools, system: req.system })));
      const r = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (r.throw) throw new Error(r.throw);
      for (const block of r.content || []) {
        if (block.type === 'text' && req.onTextDelta) req.onTextDelta(block.text);
      }
      return { content: r.content || [], stopReason: r.stopReason || 'end_turn' };
    },
  };
}

test('agent loop executes tools and returns the full conversation', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'data.txt'), 'payload-123');

  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'data.txt' } }], stopReason: 'tool_use' },
    { content: [{ type: 'text', text: 'done reading' }], stopReason: 'end_turn' },
  ]);

  const events = { chunks: [], toolUses: [], toolResults: [], done: null };
  await runAgentLoop({
    provider,
    model: 'test-model',
    messages: [{ role: 'user', content: 'read the file' }],
    workspaceRoot: root,
    enableTools: true,
    onChunk: (t) => events.chunks.push(t),
    onToolUse: (tu) => events.toolUses.push(tu),
    onToolResult: (tr) => events.toolResults.push(tr),
    onDone: (final) => { events.done = final; },
  });

  assert.equal(events.toolUses.length, 1);
  assert.equal(events.toolUses[0].name, 'read_file');
  assert.equal(events.toolResults[0].ok, true);
  assert.equal(events.chunks.join(''), 'done reading');

  assert.ok(events.done, 'onDone must fire');
  assert.equal(events.done.stopReason, 'end_turn');
  assert.equal(events.done.text, 'done reading');

  // Conversation fidelity: user → assistant(tool_use) → user(tool_result) → assistant(text)
  const conv = events.done.conversation;
  assert.equal(conv.length, 4);
  assert.equal(conv[0].role, 'user');
  assert.equal(conv[1].role, 'assistant');
  assert.equal(conv[1].content[0].type, 'tool_use');
  assert.equal(conv[2].role, 'user');
  assert.equal(conv[2].content[0].type, 'tool_result');
  assert.equal(conv[2].content[0].tool_use_id, 'tu1');
  assert.equal(conv[3].role, 'assistant');
  assert.equal(conv[3].content[0].text, 'done reading');

  // The provider must receive the tool result turn on the second call.
  assert.equal(provider.calls[1].messages.length, 3);

  fs.rmSync(root, { recursive: true, force: true });
});

test('agent loop surfaces pre-abort as a clean done event, not silence', async () => {
  const provider = scriptedProvider([{ content: [{ type: 'text', text: 'should not run' }] }]);
  const controller = new AbortController();
  controller.abort();

  let done = null;
  await runAgentLoop({
    provider,
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    workspaceRoot: makeTempWorkspace(),
    enableTools: true,
    signal: controller.signal,
    onDone: (final) => { done = final; },
  });

  assert.ok(done, 'onDone must fire even when aborted before start');
  assert.equal(done.stopReason, 'aborted');
  assert.equal(provider.calls.length, 0, 'provider must not be called after abort');
});

test('agent loop converts a mid-stream abort into done, not an error', async () => {
  const controller = new AbortController();
  const provider = {
    id: 'test',
    async stream() {
      // Simulate an in-flight upstream request that fails after the user
      // has already pressed Stop.
      await new Promise((r) => setTimeout(r, 25));
      throw new Error('connection reset');
    },
  };
  setTimeout(() => controller.abort(), 5);

  let done = null;
  let errored = false;
  await runAgentLoop({
    provider,
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    workspaceRoot: makeTempWorkspace(),
    enableTools: false,
    signal: controller.signal,
    onDone: (final) => { done = final; },
  }).catch(() => { errored = true; });

  assert.equal(errored, false, 'abort must not reject');
  assert.equal(done.stopReason, 'aborted');
});

test('agent loop stops at max iterations', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'f.txt'), 'x');
  // Always requests another tool call.
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'tu', name: 'list_dir', input: { path: '.' } }], stopReason: 'tool_use' },
  ]);

  let done = null;
  await runAgentLoop({
    provider,
    model: 'm',
    messages: [{ role: 'user', content: 'loop' }],
    workspaceRoot: root,
    enableTools: true,
    onDone: (final) => { done = final; },
  });

  assert.equal(done.stopReason, 'max_iterations');
  assert.ok(provider.calls.length <= 10, 'must not exceed MAX_ITERATIONS');

  fs.rmSync(root, { recursive: true, force: true });
});

test('agent loop reports tool errors back to the provider as tool_result errors', async () => {
  const root = makeTempWorkspace();
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'missing.txt' } }], stopReason: 'tool_use' },
    { content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' },
  ]);

  let done = null;
  await runAgentLoop({
    provider,
    model: 'm',
    messages: [{ role: 'user', content: 'go' }],
    workspaceRoot: root,
    enableTools: true,
    onDone: (final) => { done = final; },
  });

  const toolResultTurn = done.conversation.find(
    (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
  );
  assert.equal(toolResultTurn.content[0].is_error, true);

  fs.rmSync(root, { recursive: true, force: true });
});
