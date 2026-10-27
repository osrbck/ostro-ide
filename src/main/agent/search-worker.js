// Workspace content search executed in a worker thread.
//
// The regex comes from the AI agent (ultimately model output), so it can be
// pathological (catastrophic backtracking). Running it here lets the main
// process terminate the worker on a deadline instead of freezing the app.

const fs = require('fs/promises');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const SEARCH_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '.cache', '.venv',
  '__pycache__', 'target', '.idea', '.vscode', 'coverage', '.sass-cache',
]);

async function run() {
  const { root, pattern, flags, extFilter, limits } = workerData;
  const re = new RegExp(pattern, flags);
  // UI consumers need every match on a line with its exact span, so iterate
  // with a global copy. The agent's single-test fast path is preserved by
  // only computing ranges when the caller asks for them.
  const reGlobal = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
  const wantRanges = limits.ranges !== false;

  const matches = [];
  let truncated = false;
  let filesScanned = 0;

  // All match spans on one line, relative to the TRIMMED text we return.
  // Zero-length matches advance manually; per-line count is capped.
  function lineRanges(line, lead) {
    const out = [];
    reGlobal.lastIndex = 0;
    let m;
    while ((m = reGlobal.exec(line)) !== null) {
      if (m[0] === '') {
        reGlobal.lastIndex += 1;
        continue;
      }
      out.push([m.index - lead, m.index - lead + m[0].length]);
      if (out.length >= (limits.maxPerLine || 20)) break;
    }
    return out;
  }

  async function walk(dir) {
    if (filesScanned >= limits.maxFiles) { truncated = true; return; }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (filesScanned >= limits.maxFiles) { truncated = true; return; }
      if (truncated) return;
      if (e.name.startsWith('.') || SEARCH_IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        if (extFilter && !e.name.endsWith(extFilter)) continue;
        let stat;
        try { stat = await fs.stat(full); } catch { continue; }
        if (stat.size > limits.maxFileBytes) continue;
        filesScanned += 1;
        let content;
        try {
          const buf = await fs.readFile(full);
          if (buf.includes(0)) continue; // binary
          content = buf.toString('utf8');
        } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Match against the FULL line so anchored patterns and matches
          // beyond any truncation point stay correct. Pathological regexes
          // are bounded by the parent's worker deadline, not by truncating
          // input.
          if (!re.test(line)) continue;
          // Trim leading whitespace for display; ranges are reported
          // relative to the trimmed text so the UI can highlight directly.
          const lead = line.length - line.trimStart().length;
          const text = line.slice(lead).replace(/\s+$/, '').slice(0, limits.maxLine);
          matches.push({
            rel: path.relative(root, full),
            line: i + 1,
            text,
            ...(wantRanges ? { ranges: lineRanges(line, lead).filter((r) => r[1] <= limits.maxLine) } : {}),
          });
          if (matches.length >= limits.maxMatches) { truncated = true; return; }
        }
      }
    }
  }

  await walk(root);
  return { matches, truncated };
}

run()
  .then((result) => parentPort.postMessage({ ok: true, ...result }))
  .catch((err) => parentPort.postMessage({ ok: false, error: err.message }));
