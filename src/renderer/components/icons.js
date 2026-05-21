const FILE_SVG = (color) =>
  `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 1.5h5l3 3V12a.5.5 0 01-.5.5h-7.5A.5.5 0 012.5 12V2a.5.5 0 01.5-.5z" fill="${color}" opacity=".85"/><path d="M8 1.5V4a.5.5 0 00.5.5H11" stroke="${color}" stroke-width="1" fill="none" opacity=".55"/></svg>`;

const EXT_COLOR = {
  js: '#ffd166', mjs: '#ffd166', cjs: '#ffd166', jsx: '#ffd166',
  ts: '#7ad0ff', tsx: '#7ad0ff',
  py: '#9ee493', pyi: '#9ee493',
  c: '#c08bff', h: '#c08bff', cpp: '#c08bff', hpp: '#c08bff', cc: '#c08bff',
  json: '#ffb86b',
  md: '#b6bcc7',
  html: '#ff8fa3', css: '#7ad0ff',
  yml: '#ffb86b', yaml: '#ffb86b',
  toml: '#ffb86b',
  rs: '#ff8fa3', go: '#7ad0ff',
  sh: '#9ee493',
  default: '#7a8392',
};

export function iconForFile(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : 'default';
  const color = EXT_COLOR[ext] || EXT_COLOR.default;
  return FILE_SVG(color);
}
