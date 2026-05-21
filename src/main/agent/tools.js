const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to workspace root' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace with the provided content. The user must approve the change before it is persisted.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List entries in a directory in the workspace.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the workspace and return its stdout, stderr, and exit code. The user must approve every command before it executes. Use for build/test/git/package-manager commands. Do not use for long-running servers.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: { type: 'string', description: 'Optional working directory relative to workspace root.' },
      },
      required: ['command'],
    },
  },
];

function safeResolve(root, p) {
  const full = path.resolve(root, p);
  if (!full.startsWith(path.resolve(root))) {
    throw new Error(`Refused path outside workspace: ${p}`);
  }
  return full;
}

async function readIfExists(full) {
  try {
    return await fs.readFile(full, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const MAX_OUTPUT = 50_000;
const COMMAND_TIMEOUT_MS = 120_000;

function runShell({ command, cwd, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { cwd, shell: true, signal, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, COMMAND_TIMEOUT_MS);

    const append = (key, chunk) => {
      const s = chunk.toString('utf8');
      if (key === 'stdout') {
        if (stdout.length + s.length > MAX_OUTPUT) { stdout = (stdout + s).slice(0, MAX_OUTPUT); truncated = true; }
        else stdout += s;
      } else {
        if (stderr.length + s.length > MAX_OUTPUT) { stderr = (stderr + s).slice(0, MAX_OUTPUT); truncated = true; }
        else stderr += s;
      }
    };

    child.stdout.on('data', (d) => append('stdout', d));
    child.stderr.on('data', (d) => append('stderr', d));

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.name === 'AbortError') reject(new Error('Command cancelled'));
      else reject(err);
    });

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ stdout, stderr, exitCode: code, truncated, timedOut: true });
      } else {
        resolve({ stdout, stderr, exitCode: code ?? (sig ? -1 : 0), truncated });
      }
    });
  });
}

async function executeTool(name, input, ctx) {
  const { workspaceRoot, requestApproval, toolUseId, signal } = ctx;
  if (!workspaceRoot) throw new Error('No workspace open');

  if (name === 'read_file') {
    const full = safeResolve(workspaceRoot, input.path);
    const content = await fs.readFile(full, 'utf8');
    return { content };
  }

  if (name === 'write_file') {
    const full = safeResolve(workspaceRoot, input.path);
    const current = await readIfExists(full);
    const proposed = input.content ?? '';

    if (current === proposed) {
      return { ok: true, unchanged: true };
    }

    if (typeof requestApproval === 'function') {
      const decision = await requestApproval({
        kind: 'write',
        tool_use_id: toolUseId,
        path: input.path,
        current: current ?? '',
        proposed,
        isNew: current === null,
      });
      if (decision?.action === 'reject') {
        throw new Error('User rejected the proposed write.');
      }
      if (decision?.action === 'edit' && typeof decision.content === 'string') {
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, decision.content, 'utf8');
        return { ok: true, edited: true };
      }
    }

    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, proposed, 'utf8');
    return { ok: true };
  }

  if (name === 'list_dir') {
    const full = safeResolve(workspaceRoot, input.path || '.');
    const entries = await fs.readdir(full, { withFileTypes: true });
    return {
      entries: entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })),
    };
  }

  if (name === 'run_command') {
    const command = String(input.command || '').trim();
    if (!command) throw new Error('Empty command');
    const cwd = input.cwd ? safeResolve(workspaceRoot, input.cwd) : workspaceRoot;

    if (typeof requestApproval === 'function') {
      const decision = await requestApproval({
        kind: 'command',
        tool_use_id: toolUseId,
        command,
        cwd: input.cwd || '.',
      });
      if (decision?.action === 'reject') {
        throw new Error('User rejected the command.');
      }
      // Allow the user to amend the command before running.
      const finalCommand = decision?.action === 'edit' && typeof decision.command === 'string'
        ? decision.command
        : command;
      const result = await runShell({ command: finalCommand, cwd, signal });
      return result;
    }

    return runShell({ command, cwd, signal });
  }

  throw new Error(`Unknown tool: ${name}`);
}

module.exports = { TOOL_DEFINITIONS, executeTool };
