const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');

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
    name: 'search_files',
    description:
      'Search the contents of files in the workspace with a regular expression. Returns matching lines with file path and line number. Use this to find where something is defined or used before editing.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for (JavaScript syntax).' },
        glob: { type: 'string', description: 'Optional file-extension filter, e.g. ".js" or ".py".' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive matching. Defaults to false.' },
      },
      required: ['pattern'],
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
  const rootResolved = path.resolve(root);
  const full = path.resolve(rootResolved, p || '.');
  // Strict containment: full must equal root or live directly underneath it.
  // (A plain startsWith check would also admit sibling dirs like /root-evil.)
  // Drive roots ("/", "C:\") already end with a separator — appending another
  // would create a doubled separator that no child path can match.
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (full !== rootResolved && !full.startsWith(prefix)) {
    throw new Error(`Refused path outside workspace: ${p}`);
  }
  return full;
}

// Lexical + real-path containment: a symlink inside the workspace must not
// let the agent reach files outside it. Dangling symlink components are
// validated against their declared link target, because a write would
// follow it. Returns the validated path to use for the operation.
async function safeResolveReal(root, p, depth = 0) {
  if (depth > 8) throw new Error('Symlink chain too deep');
  const full = safeResolve(root, p);
  const realRoot = await fs.realpath(path.resolve(root));
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

  let real;
  try {
    real = await fs.realpath(full);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // The target does not exist yet. Walk up to the deepest existing
    // ancestor; every dangling symlink component on the way is validated
    // against where it points before mkdir/write can follow it.
    const tail = [];
    let dir = full;
    real = null;
    for (;;) {
      let st = null;
      try { st = await fs.lstat(dir); } catch { /* absent */ }
      if (st && st.isSymbolicLink()) {
        const target = await fs.readlink(dir);
        const resolved = path.resolve(path.dirname(dir), target);
        // Recurse against the CANONICAL root: the workspace folder itself
        // may legitimately be a symlink the user opened, and its resolved
        // target is by definition inside the workspace.
        dir = await safeResolveReal(realRoot, resolved, depth + 1);
        continue;
      }
      try {
        real = await fs.realpath(dir);
        break;
      } catch (err2) {
        if (err2.code !== 'ENOENT') throw err2;
        const parent = path.dirname(dir);
        if (parent === dir) break; // filesystem root: nothing further to resolve
        tail.unshift(path.basename(dir));
        dir = parent;
      }
    }
    real = real ? path.join(real, ...tail) : full;
  }

  if (real !== realRoot && !real.startsWith(prefix)) {
    throw new Error(`Refused path outside workspace: ${p}`);
  }
  // Return the canonical (symlink-resolved) path so that a lexical symlink
  // cannot be swapped between validation and the actual read/write.
  return real;
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
    const child = spawn(command, [], {
      cwd,
      shell: true,
      signal,
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group so we can tree-kill
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    // Kill the whole process group, not just the shell, so shell children
    // (build tools, test runners) do not outlive a timeout or cancellation.
    const killTree = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, COMMAND_TIMEOUT_MS);

    const onAbort = () => killTree();
    signal?.addEventListener('abort', onAbort, { once: true });

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
      signal?.removeEventListener('abort', onAbort);
      if (err.name === 'AbortError' || signal?.aborted) reject(new Error('Command cancelled'));
      else reject(err);
    });

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (timedOut) {
        resolve({ stdout, stderr, exitCode: code, truncated, timedOut: true });
      } else {
        resolve({ stdout, stderr, exitCode: code ?? (sig ? -1 : 0), truncated });
      }
    });
  });
}

const SEARCH_LIMITS = {
  maxMatches: 50,
  maxFileBytes: 1024 * 1024, // skip files > 1MB
  maxLine: 240,              // display truncation only — matching uses full lines
  maxFiles: 5000,            // total files scanned per search
};
const SEARCH_DEADLINE_MS = 10_000;

// Grep-like workspace search, executed in a terminable worker thread so a
// pathological regex can never freeze the Electron main process. Limits are
// caller-supplied: the agent caps at 50 compact matches, the Find-in-Files
// UI asks for more with per-line match ranges.
function runSearchWorker(root, { pattern, flags, extFilter, limits, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(path.join(__dirname, 'search-worker.js'), {
      workerData: { root, pattern, flags, extFilter, limits },
    });

    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error('Search timed out (pattern too complex or workspace too large)'));
    }, timeoutMs || SEARCH_DEADLINE_MS);

    worker.on('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      worker.terminate();
      if (msg.ok) resolve(msg);
      else reject(new Error(`Search failed: ${msg.error}`));
    });

    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(err);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new Error(`Search worker exited unexpectedly (code ${code})`));
    });
  });
}

async function executeTool(name, input, ctx) {
  const { workspaceRoot, requestApproval, toolUseId, signal } = ctx;
  if (!workspaceRoot) throw new Error('No workspace open');

  if (name === 'read_file') {
    const full = await safeResolveReal(workspaceRoot, input.path);
    const content = await fs.readFile(full, 'utf8');
    return { content };
  }

  if (name === 'write_file') {
    let full = await safeResolveReal(workspaceRoot, input.path);
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
      // Re-validate after the (potentially long) approval wait: a symlink
      // component may have been swapped while we were waiting.
      full = await safeResolveReal(workspaceRoot, input.path);
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
    const full = await safeResolveReal(workspaceRoot, input.path || '.');
    const entries = await fs.readdir(full, { withFileTypes: true });
    return {
      entries: entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })),
    };
  }

  if (name === 'search_files') {
    const pattern = String(input.pattern || '');
    if (!pattern) throw new Error('Empty search pattern');
    try {
      // Validate before dispatching to the worker.
      new RegExp(pattern, input.caseSensitive ? '' : 'i');
    } catch (err) {
      throw new Error(`Invalid regex: ${err.message}`);
    }
    const extFilter = input.glob ? String(input.glob) : null;
    const result = await runSearchWorker(workspaceRoot, {
      pattern,
      flags: input.caseSensitive ? '' : 'i',
      extFilter,
      limits: { ...SEARCH_LIMITS, ranges: false }, // compact: agent does not need spans
    });
    return {
      matches: result.matches.map((m) => `${m.rel}:${m.line}: ${m.text}`),
      truncated: result.truncated,
    };
  }

  if (name === 'run_command') {
    const command = String(input.command || '').trim();
    if (!command) throw new Error('Empty command');
    const cwd = input.cwd ? await safeResolveReal(workspaceRoot, input.cwd) : workspaceRoot;

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

module.exports = { TOOL_DEFINITIONS, executeTool, safeResolve, safeResolveReal, runSearchWorker, SEARCH_LIMITS };
