// Approval policy for agent tool calls.
//
// Three modes:
//   ask    — every write and command waits for an explicit user decision
//   auto   — file writes are auto-approved; shell commands still ask
//   bypass — everything is auto-approved (dangerous; opt-in)
//
// This module is pure and dependency-free so the policy can be unit-tested
// without Electron or the agent loop.

const MODES = ['ask', 'auto', 'bypass'];
const DEFAULT_MODE = 'ask';

function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

// Returns the automatic decision for a request, or null when the user must
// be asked. Requests are the same shapes the diff/command modals receive:
//   { kind: 'write', path, current, proposed, isNew }
//   { kind: 'command', command, cwd }
function autoDecision(mode, request) {
  const m = normalizeMode(mode);
  if (m === 'bypass') return { action: 'accept', automatic: true, mode: m };
  if (m === 'auto' && request?.kind === 'write') return { action: 'accept', automatic: true, mode: m };
  return null;
}

// Human-readable label for the chat header / settings.
function describeMode(mode) {
  switch (normalizeMode(mode)) {
    case 'bypass': return 'Bypass — auto-approving everything';
    case 'auto': return 'Auto — writes auto-approved, commands ask';
    default: return 'Ask — every action needs approval';
  }
}

module.exports = { MODES, DEFAULT_MODE, normalizeMode, autoDecision, describeMode };
