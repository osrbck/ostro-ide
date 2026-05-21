import { fuzzyMatch } from './fuzzy.js';

let files = [];      // [{ path, name, rel }]
let unsubWatcher = null;

export async function buildIndex(root) {
  files = await window.ostro.fs.indexWorkspace(root);
  if (unsubWatcher) unsubWatcher();
  unsubWatcher = window.ostro.workspace.onEvent(({ event, path: p }) => {
    if (event === 'add') {
      const rel = relPath(p, root);
      const name = p.split(/[\\/]/).pop();
      files.push({ path: p, name, rel });
    } else if (event === 'unlink') {
      const idx = files.findIndex((f) => f.path === p);
      if (idx >= 0) files.splice(idx, 1);
    }
  });
}

function relPath(p, root) {
  return p.startsWith(root) ? p.slice(root.length + 1) : p;
}

export function searchFiles(query, limit = 50) {
  if (!query) return files.slice(0, limit).map((f) => ({ ...f, score: 0, positions: [] }));
  const results = [];
  for (const f of files) {
    const m = fuzzyMatch(query, f.rel);
    if (m) results.push({ ...f, score: m.score, positions: m.positions });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export function getIndexSize() {
  return files.length;
}

export function destroyIndex() {
  if (unsubWatcher) { unsubWatcher(); unsubWatcher = null; }
  files = [];
}
