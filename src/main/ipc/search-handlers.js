// Find-in-Files / Replace-All IPC handlers for the global search UI.
//
// Reuses the agent's terminable search worker (src/main/agent/search-worker.js)
// with UI-appropriate limits: more matches, per-line match ranges for
// highlighting. Replace runs in the main process over ONLY the files the
// renderer names (i.e. files that already have visible matches), with every
// path containment-checked like the agent's own write tool.

const fs = require('fs/promises');
const path = require('path');

const { runSearchWorker, safeResolveReal } = require('../agent/tools');

const UI_SEARCH_LIMITS = {
  maxMatches: 500,
  maxPerLine: 20,
  maxFileBytes: 1024 * 1024,
  maxLine: 300,
  maxFiles: 10_000,
  ranges: true,
};
const UI_SEARCH_TIMEOUT_MS = 15_000;

// Build (and validate) the RegExp for a UI search. `regex: false` escapes
// the pattern so it is matched literally, like VS Code's plain-text mode.
function buildSearchRegex({ query, regex, caseSensitive, wholeWord }) {
  const pattern = String(query || '');
  if (!pattern) throw new Error('Empty search query');
  let source = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `\\b(?:${source})\\b`;
  const flags = caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new Error(`Invalid regular expression: ${err.message}`);
  }
}

// Pure: apply a global replace to one file's content. Returns the new
// content and how many matches were replaced (null content = unchanged).
function replaceAllInContent(content, re, replacement) {
  const count = (content.match(re) || []).length;
  if (count === 0) return { content: null, count: 0 };
  re.lastIndex = 0;
  const next = content.replace(re, replacement);
  return { content: next, count };
}

function registerSearchHandlers(ipcMain) {
  ipcMain.handle('search:find', async (_evt, { root, query, regex, caseSensitive, wholeWord, fileFilter }) => {
    if (!root) throw new Error('No workspace open');
    const re = buildSearchRegex({ query, regex, caseSensitive, wholeWord });
    const extFilter = fileFilter ? String(fileFilter).trim() || null : null;
    const result = await runSearchWorker(root, {
      pattern: re.source,
      flags: re.flags.replace('g', ''), // the worker manages global iteration itself
      extFilter,
      limits: UI_SEARCH_LIMITS,
      timeoutMs: UI_SEARCH_TIMEOUT_MS,
    });
    return { query: String(query), regex: !!regex, caseSensitive: !!caseSensitive, ...result };
  });

  // Replace every match in the given files (repo-relative paths that came
  // from a prior search:find). Containment is enforced per file, and each
  // write is re-validated exactly like the agent's write_file tool.
  ipcMain.handle('search:replaceAll', async (_evt, { root, query, regex, caseSensitive, wholeWord, replacement, paths }) => {
    if (!root) throw new Error('No workspace open');
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('No files selected for replacement');
    if (paths.length > 200) throw new Error('Too many files selected (max 200)');

    const re = buildSearchRegex({ query, regex, caseSensitive, wholeWord });
    if (!re.global) throw new Error('Replacement requires a global regex');

    const repl = String(replacement ?? '');
    const files = [];
    let total = 0;

    for (const rel of paths) {
      const abs = await safeResolveReal(root, rel); // containment + canonicalization
      let content;
      try {
        const buf = await fs.readFile(abs);
        if (buf.includes(0)) continue; // binary: never rewritten
        content = buf.toString('utf8');
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      const { content: next, count } = replaceAllInContent(content, re, repl);
      if (next === null) {
        files.push({ path: rel, count: 0, changed: false });
        continue;
      }
      await fs.writeFile(abs, next, 'utf8');
      files.push({ path: rel, count, changed: true });
      total += count;
    }

    return { files, totalReplacements: total };
  });
}

module.exports = { registerSearchHandlers, buildSearchRegex, replaceAllInContent, UI_SEARCH_LIMITS };
