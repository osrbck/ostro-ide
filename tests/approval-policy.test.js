const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MODES,
  DEFAULT_MODE,
  normalizeMode,
  autoDecision,
  describeMode,
} = require('../src/main/ai/approval-policy');

const writeReq = { kind: 'write', path: 'a.txt', current: '', proposed: 'x', isNew: true };
const cmdReq = { kind: 'command', command: 'npm test', cwd: '.' };

test('normalizeMode falls back to ask for unknown values', () => {
  assert.equal(DEFAULT_MODE, 'ask');
  assert.deepEqual(MODES, ['ask', 'auto', 'bypass']);
  assert.equal(normalizeMode('bypass'), 'bypass');
  assert.equal(normalizeMode('nonsense'), 'ask');
  assert.equal(normalizeMode(undefined), 'ask');
});

test('ask mode never auto-resolves anything', () => {
  assert.equal(autoDecision('ask', writeReq), null);
  assert.equal(autoDecision('ask', cmdReq), null);
});

test('auto mode approves writes but still asks for commands', () => {
  const w = autoDecision('auto', writeReq);
  assert.equal(w.action, 'accept');
  assert.equal(w.automatic, true);
  assert.equal(autoDecision('auto', cmdReq), null, 'commands must always ask in auto mode');
});

test('bypass mode auto-approves writes and commands', () => {
  assert.equal(autoDecision('bypass', writeReq).action, 'accept');
  assert.equal(autoDecision('bypass', cmdReq).action, 'accept');
});

test('unknown modes are treated as ask (fail safe)', () => {
  assert.equal(autoDecision('yolo', writeReq), null);
  assert.equal(autoDecision(undefined, cmdReq), null);
});

test('describeMode produces distinct human-readable labels', () => {
  assert.match(describeMode('ask'), /Ask/i);
  assert.match(describeMode('auto'), /writes auto-approved/i);
  assert.match(describeMode('bypass'), /auto-approving everything/i);
  assert.equal(new Set(MODES.map(describeMode)).size, 3);
});
