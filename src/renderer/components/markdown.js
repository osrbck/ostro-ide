// Minimal, safe-by-default markdown renderer.
// Escapes HTML, then applies block-level then inline-level transformations.

export function renderMarkdown(src) {
  if (!src) return '';
  // First split on fenced code blocks so their contents aren't touched by other rules
  const parts = [];
  const re = /```(\w+)?\n([\s\S]*?)```/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > lastIdx) parts.push({ type: 'text', value: src.slice(lastIdx, m.index) });
    parts.push({ type: 'code', lang: m[1] || '', value: m[2] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < src.length) parts.push({ type: 'text', value: src.slice(lastIdx) });

  return parts
    .map((p) => {
      if (p.type === 'code') {
        return `<pre class="md-code"><code class="lang-${escapeAttr(p.lang)}">${escapeHtml(p.value.replace(/\n$/, ''))}</code></pre>`;
      }
      return renderBlocks(p.value);
    })
    .join('');
}

function renderBlocks(text) {
  // Split into block segments by blank lines
  const blocks = text.split(/\n{2,}/);
  return blocks
    .map((b) => {
      const trimmed = b.trim();
      if (!trimmed) return '';
      // Headers
      const hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        return `<h${level} class="md-h md-h${level}">${renderInline(hMatch[2])}</h${level}>`;
      }
      // Bullet list
      if (/^\s*[-*]\s+/m.test(trimmed) && trimmed.split('\n').every((l) => /^\s*[-*]\s+/.test(l) || /^\s+/.test(l))) {
        const items = trimmed.split('\n').filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, ''));
        return `<ul class="md-ul">${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ul>`;
      }
      // Ordered list
      if (/^\s*\d+\.\s+/m.test(trimmed) && trimmed.split('\n').every((l) => /^\s*\d+\.\s+/.test(l) || /^\s+/.test(l))) {
        const items = trimmed.split('\n').filter((l) => /^\s*\d+\.\s+/.test(l)).map((l) => l.replace(/^\s*\d+\.\s+/, ''));
        return `<ol class="md-ol">${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ol>`;
      }
      // Blockquote
      if (/^>\s/.test(trimmed)) {
        const inner = trimmed.split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n');
        return `<blockquote class="md-quote">${renderInline(inner).replace(/\n/g, '<br>')}</blockquote>`;
      }
      // Paragraph
      return `<p class="md-p">${renderInline(trimmed).replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

function renderInline(text) {
  let out = escapeHtml(text);
  // Inline code first (highest precedence)
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code class="md-icode">${code}</code>`);
  // Links [text](url) — restrict to http(s) / file / mailto schemes.
  // NOTE: `out` was fully HTML-escaped above, so label and url are already
  // attribute-safe; escaping again would double-escape & as &amp;amp;.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, url) => {
    if (/^(https?:|file:|mailto:)/i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return whole;
  });
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
