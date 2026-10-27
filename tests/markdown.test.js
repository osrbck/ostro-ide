const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdown } = require('../src/renderer/components/markdown.js');

test('escapes HTML in plain text (XSS guard)', () => {
  const out = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!out.includes('<script'), 'script tag must not survive');
  assert.ok(out.includes('&lt;script&gt;'));
});

test('escapes HTML inside code fences and inline code', () => {
  const out = renderMarkdown('```\n<img src=x onerror=alert(1)>\n```');
  assert.ok(!out.includes('<img'));
  const out2 = renderMarkdown('`<b>bold</b>`');
  assert.ok(!out2.includes('<b>'));
  assert.ok(out2.includes('&lt;b&gt;'));
});

test('renders fenced code blocks with language class', () => {
  const out = renderMarkdown('```js\nconst x = 1;\n```');
  assert.ok(out.includes('<pre class="md-code">'));
  assert.ok(out.includes('class="lang-js"'));
  assert.ok(out.includes('const x = 1;'));
});

test('renders headers, lists, bold and italic', () => {
  const out = renderMarkdown('## Title\n\n- item **bold**\n');
  assert.ok(out.includes('<h2'));
  assert.ok(out.includes('<ul'));
  assert.ok(out.includes('<strong>bold</strong>'));

  const it = renderMarkdown('some *italic* text');
  assert.ok(it.includes('<em>italic</em>'));
});

test('allows only http(s)/file/mailto link schemes', () => {
  const ok = renderMarkdown('[site](https://example.com/?a=1&b=2)');
  assert.ok(ok.includes('href="https://example.com/?a=1&amp;b=2"'));

  const bad = renderMarkdown('[evil](javascript:alert(1))');
  assert.ok(!bad.includes('href="javascript'), 'javascript: URLs must not become links');
  assert.ok(bad.includes('[evil]'));
});

test('does not double-escape ampersands in link URLs', () => {
  const out = renderMarkdown('[x](https://a.com/?p=1&q=2)');
  assert.ok(out.includes('?p=1&amp;q=2'));
  assert.ok(!out.includes('&amp;amp;'));
});

test('blockquotes become blockquote elements', () => {
  const out = renderMarkdown('> quoted text');
  assert.ok(out.includes('<blockquote'));
});
