// Lightweight fuzzy matcher inspired by fzf scoring.
// Returns { score, positions } where positions are matched char indices in the target.

const BONUS_BOUNDARY = 30;       // start of word (after / \ . _ - or camelCase)
const BONUS_CAMEL = 20;
const BONUS_CONSECUTIVE = 15;
const PENALTY_GAP_START = -3;
const PENALTY_GAP_EXT = -1;

function isBoundary(prev) {
  return prev === undefined || /[\s\/\\._\-]/.test(prev);
}

function isCamel(prev, cur) {
  return prev && /[a-z]/.test(prev) && /[A-Z]/.test(cur);
}

export function fuzzyMatch(needle, haystack) {
  if (!needle) return { score: 0, positions: [] };
  if (!haystack) return null;

  const n = needle.toLowerCase();
  const h = haystack;
  const hLower = haystack.toLowerCase();

  let score = 0;
  let pos = [];
  let hi = 0;
  let lastMatch = -2;

  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni];
    let found = -1;
    while (hi < h.length) {
      if (hLower[hi] === c) { found = hi; break; }
      hi++;
    }
    if (found === -1) return null;

    let charScore = 1;
    const prev = found > 0 ? h[found - 1] : undefined;
    if (isBoundary(prev)) charScore += BONUS_BOUNDARY;
    else if (isCamel(prev, h[found])) charScore += BONUS_CAMEL;

    if (found === lastMatch + 1) charScore += BONUS_CONSECUTIVE;
    else if (lastMatch >= 0) {
      const gap = found - lastMatch - 1;
      charScore += PENALTY_GAP_START + PENALTY_GAP_EXT * (gap - 1);
    }

    score += charScore;
    pos.push(found);
    lastMatch = found;
    hi = found + 1;
  }

  // Boost matches in the filename portion (after last separator)
  const lastSep = Math.max(h.lastIndexOf('/'), h.lastIndexOf('\\'));
  if (pos[0] > lastSep) score += 10;

  return { score, positions: pos };
}

export function highlight(text, positions) {
  if (!positions || positions.length === 0) return escapeHtml(text);
  let out = '';
  let pi = 0;
  for (let i = 0; i < text.length; i++) {
    if (pi < positions.length && positions[pi] === i) {
      out += `<mark>${escapeHtml(text[i])}</mark>`;
      pi++;
    } else {
      out += escapeHtml(text[i]);
    }
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
