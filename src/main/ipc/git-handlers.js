// Git integration IPC handlers.
//
// All git operations spawn `git` WITHOUT a shell (argument arrays are passed
// verbatim — no injection surface) with a hard timeout, and every path that
// reaches the filesystem is containment-checked against the workspace root.

const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const { safeResolveReal } = require('../agent/tools');

const GIT_TIMEOUT_MS = 15_000;

function runGit(root, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`git is not available: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('git command timed out'));
      if (code !== 0) return reject(new Error(stderr.trim() || `git exited with code ${code}`));
      resolve(stdout);
    });
  });
}

const NOT_A_REPO_RE = /not a git repository|must be run in a work tree/i;

// Repo detection must not depend on git's localized stderr text — the
// exit code of `rev-parse --show-toplevel` is locale-independent.
async function isRepo(root) {
  try {
    await runGit(root, ['rev-parse', '--show-toplevel']);
    return true;
  } catch {
    return false;
  }
}

// Parse `git status --porcelain=v1 -z --branch` output.
//
// -z format notes: records are NUL-separated and, for renames/copies, the
// ORIGINAL path arrives as the NEXT NUL-separated record verbatim (there is
// no "old -> new" arrow in -z mode). Skipping that record would misparse the
// old path as a status line.
function parseStatus(out) {
  const branch = { name: null, ahead: 0, behind: 0, initial: false, detached: false };
  const entries = [];

  const recs = String(out).split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    if (rec.startsWith('## ')) {
      const head = rec.slice(3);
      const bracket = head.match(/\[([^\]]*)\]\s*$/);
      if (bracket) {
        for (const part of bracket[1].split(',').map((s) => s.trim())) {
          const am = part.match(/^ahead (\d+)$/);
          if (am) branch.ahead = Number(am[1]);
          const bm = part.match(/^behind (\d+)$/);
          if (bm) branch.behind = Number(bm[1]);
        }
      }
      const base = head.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
      if (base.startsWith('No commits yet on ')) {
        branch.initial = true;
        branch.name = base.slice('No commits yet on '.length);
      } else if (base === 'HEAD (no branch)') {
        branch.detached = true;
        branch.name = 'HEAD';
      } else {
        branch.name = base.split('...')[0].trim();
      }
      continue;
    }

    // "XY PATH" (XY is 2 status letters, then one space)
    const xy = rec.slice(0, 2);
    const entryPath = rec.slice(3);
    const x = xy[0];
    const y = xy[1];
    let renamedFrom = null;

    // Rename (R) and copy (C) carry the original path in the following record.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const next = recs[i + 1];
      if (next) {
        renamedFrom = next;
        i += 1;
      }
    }

    entries.push({
      path: entryPath,
      renamedFrom,
      x,
      y,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' && y !== '?',
      untracked: x === '?' && y === '?',
    });
  }

  return { branch, entries };
}

// Split status entries into discard categories.
//  - modified:      tracked, safe to restore via `git checkout --`
//  - added:         staged-new files; unstage + delete
//  - deletedStaged: staged deletions; unstage, then checkout to restore
//  - untracked:     not in git at all; delete
// Self-contained: derives classification from x/y codes only.
function categorizeForDiscard(entries) {
  const modified = [];
  const added = [];
  const untracked = [];
  const deletedStaged = [];
  for (const e of entries) {
    const x = e.x ?? ' ';
    const y = e.y ?? ' ';
    if (x === '?' || y === '?') untracked.push(e.path);
    else if (x === 'A' || x === 'R') added.push(e.path);
    else if (x === 'D') deletedStaged.push(e.path);
    else modified.push(e.path);
  }
  return { modified, added, untracked, deletedStaged };
}

function validateCommitMessage(message) {
  const msg = String(message || '').trim();
  if (!msg) throw new Error('Commit message is required');
  if (msg.length > 500) throw new Error('Commit message is too long (max 500 chars)');
  return msg;
}

// Resolve repo-relative paths to safe absolute paths under root (parallel).
async function resolveAll(root, paths) {
  const out = [];
  for (const p of paths || []) {
    out.push(await safeResolveReal(root, p));
  }
  return out;
}

function registerGitHandlers(ipcMain) {
  ipcMain.handle('git:status', async (_evt, root) => {
    if (!root) return { repo: false };
    // Locale-independent repo check (never match localized stderr text).
    if (!(await isRepo(root))) return { repo: false };
    const out = await runGit(root, ['status', '--porcelain=v1', '-z', '--branch']);
    const { branch, entries } = parseStatus(out);
    return { repo: true, branch, entries };
  });

  ipcMain.handle('git:init', async (_evt, root) => {
    if (!root) throw new Error('No workspace open');
    await runGit(root, ['init']);
    return true;
  });

  ipcMain.handle('git:stage', async (_evt, { root, paths }) => {
    if (!root || !paths?.length) return false;
    const abs = await resolveAll(root, paths);
    await runGit(root, ['add', '--', ...abs.map((p) => path.relative(root, p))]);
    return true;
  });

  ipcMain.handle('git:stageAll', async (_evt, root) => {
    if (!root) return false;
    await runGit(root, ['add', '-A']);
    return true;
  });

  ipcMain.handle('git:unstage', async (_evt, { root, paths }) => {
    if (!root || !paths?.length) return false;
    const rel = (await resolveAll(root, paths)).map((p) => path.relative(root, p));
    try {
      await runGit(root, ['reset', '--', ...rel]);
    } catch (err) {
      // Before the first commit `reset` has no HEAD to reset against —
      // unstage new files by removing them from the index instead.
      if (/ambiguous argument 'HEAD'|unknown revision/i.test(err.message)) {
        await runGit(root, ['rm', '--cached', '-r', '--', ...rel]);
      } else {
        throw err;
      }
    }
    return true;
  });

  ipcMain.handle('git:discard', async (_evt, { root, items }) => {
    if (!root || !items?.length) return false;
    const cats = categorizeForDiscard(items);

    if (cats.modified.length) {
      const rel = (await resolveAll(root, cats.modified)).map((p) => path.relative(root, p));
      await runGit(root, ['checkout', '--', ...rel]);
    }
    // Staged deletions: unstage first so checkout can restore the file.
    if (cats.deletedStaged.length) {
      const rel = (await resolveAll(root, cats.deletedStaged)).map((p) => path.relative(root, p));
      try {
        await runGit(root, ['reset', '--', ...rel]);
      } catch {
        // pre-initial-commit repository — nothing to reset
      }
      await runGit(root, ['checkout', '--', ...rel]);
    }
    // Staged-new files: unstage first, then delete the working file.
    if (cats.added.length) {
      const rel = (await resolveAll(root, cats.added)).map((p) => path.relative(root, p));
      try {
        await runGit(root, ['reset', '--', ...rel]);
      } catch {
        // pre-initial-commit repository — nothing to reset
      }
    }
    for (const p of [...cats.added, ...cats.untracked]) {
      const abs = await safeResolveReal(root, p);
      await fs.rm(abs, { force: true });
    }
    return true;
  });

  ipcMain.handle('git:commit', async (_evt, { root, message, stageAll }) => {
    if (!root) throw new Error('No workspace open');
    const msg = validateCommitMessage(message);
    if (stageAll) await runGit(root, ['add', '-A']);
    await runGit(root, ['commit', '-m', msg]);
    return true;
  });
}

module.exports = { registerGitHandlers, parseStatus, categorizeForDiscard, validateCommitMessage };
