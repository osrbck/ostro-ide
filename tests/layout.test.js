const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  LIMITS,
  clamp,
  clampSidebar,
  clampChat,
  clampTerminal,
  resizeSidebar,
  resizeChat,
  resizeTerminal,
  fitToViewport,
  defaultLayout,
  loadLayout,
  saveLayout,
  STORAGE_KEY,
} = require('../src/renderer/components/layout');

test('clamp bounds values and rejects non-numeric input', () => {
  assert.equal(clamp(250, 180, 480), 250);
  assert.equal(clamp(100, 180, 480), 180);
  assert.equal(clamp(900, 180, 480), 480);
  assert.equal(clamp('abc', 180, 480), 180);
  assert.equal(clamp(undefined, 180, 480), 180);
  assert.equal(clamp(250.7, 180, 480), 251, 'sizes are rounded to whole pixels');
});

test('per-panel clamps use their own limits', () => {
  assert.equal(clampSidebar(100), LIMITS.sidebar.min);
  assert.equal(clampChat(5000), LIMITS.chat.max);
  assert.equal(clampTerminal(10), LIMITS.terminal.min);
});

test('sidebar grows with rightward drag; chat grows with leftward drag', () => {
  assert.equal(resizeSidebar(240, 40), 280);
  assert.equal(resizeSidebar(240, -40), 200);
  assert.equal(resizeChat(360, -40), 400, 'dragging the chat splitter left widens the chat');
  assert.equal(resizeChat(360, 40), 320);
});

test('terminal grows with upward drag', () => {
  assert.equal(resizeTerminal(200, -60), 260);
  assert.equal(resizeTerminal(200, 60), 140);
});

test('drag past a limit clamps instead of inverting', () => {
  assert.equal(resizeSidebar(240, -1000), LIMITS.sidebar.min);
  assert.equal(resizeChat(360, 1000), LIMITS.chat.min);
  assert.equal(resizeTerminal(200, 1000), LIMITS.terminal.min);
  assert.equal(resizeTerminal(200, -1000), LIMITS.terminal.max);
});

test('fitToViewport keeps room for the editor on narrow windows', () => {
  const wide = fitToViewport({ sidebar: 240, chat: 360, viewportWidth: 1440 });
  assert.deepEqual(wide, { sidebar: 240, chat: 360 });

  const narrow = fitToViewport({ sidebar: 480, chat: 760, viewportWidth: 900, minEditor: 320 });
  assert.ok(narrow.sidebar + narrow.chat <= 900 - 320, `got ${JSON.stringify(narrow)}`);
  assert.ok(narrow.chat >= LIMITS.chat.min);
  assert.ok(narrow.sidebar >= LIMITS.sidebar.min);
});

test('fitToViewport shrinks the chat before the sidebar', () => {
  const r = fitToViewport({ sidebar: 240, chat: 600, viewportWidth: 800, minEditor: 320 });
  // budget = 800 - 320 = 480. Chat alone can absorb 600-280 = 320 of the
  // 360 overflow, so it lands on its minimum and the sidebar gives the rest.
  assert.equal(r.chat, LIMITS.chat.min, 'chat shrinks to its minimum first');
  assert.equal(r.sidebar, 200, 'the remaining 40px comes off the sidebar');
  assert.equal(r.sidebar + r.chat, 480, 'the budget is exactly satisfied');
});

test('defaultLayout returns the declared defaults', () => {
  assert.deepEqual(defaultLayout(), { sidebar: 240, chat: 360, terminal: 200 });
});

test('loadLayout falls back to defaults on missing or corrupt storage', () => {
  assert.deepEqual(loadLayout({ getItem: () => null }), defaultLayout());
  assert.deepEqual(loadLayout({ getItem: () => '{not json' }), defaultLayout());
  assert.deepEqual(loadLayout(undefined), defaultLayout());
});

test('loadLayout clamps tampered values from storage', () => {
  const stored = JSON.stringify({ sidebar: 9999, chat: -50, terminal: 'huge' });
  const l = loadLayout({ getItem: () => stored });
  assert.equal(l.sidebar, LIMITS.sidebar.max);
  assert.equal(l.chat, LIMITS.chat.min);
  assert.equal(l.terminal, LIMITS.terminal.min);
});

test('saveLayout persists clamped values under the expected key', () => {
  const writes = [];
  saveLayout({ setItem: (k, v) => writes.push([k, v]) }, { sidebar: 9999, chat: 300, terminal: 100 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], STORAGE_KEY);
  const parsed = JSON.parse(writes[0][1]);
  assert.equal(parsed.sidebar, LIMITS.sidebar.max);
  assert.equal(parsed.chat, 300);
  assert.equal(parsed.terminal, 100);
});

test('saveLayout tolerates storage failures (quota, privacy mode)', () => {
  assert.doesNotThrow(() => saveLayout({ setItem: () => { throw new Error('QuotaExceeded'); } }, defaultLayout()));
});
