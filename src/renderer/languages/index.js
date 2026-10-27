// Extension → Monaco language id map used when creating editor models.
//
// Monaco's `editor.main` bundle already registers ~80 languages with their
// tokenizers (loaded lazily on demand), so this registry's only job is to map
// a file path to the right language id. installAllLanguages() self-registers
// any mapped language that a custom Monaco build might be missing.

const LANGUAGES = [
  { id: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'] },
  { id: 'typescript', extensions: ['.ts', '.tsx'] },
  { id: 'python', extensions: ['.py', '.pyi', '.pyx'] },
  { id: 'c', extensions: ['.c', '.h'] },
  { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'] },
  { id: 'csharp', extensions: ['.cs'] },
  { id: 'go', extensions: ['.go'] },
  { id: 'rust', extensions: ['.rs'] },
  { id: 'java', extensions: ['.java'] },
  { id: 'kotlin', extensions: ['.kt', '.kts'] },
  { id: 'swift', extensions: ['.swift'] },
  { id: 'ruby', extensions: ['.rb'] },
  { id: 'php', extensions: ['.php'] },
  { id: 'shell', extensions: ['.sh', '.bash', '.zsh'] },
  { id: 'powershell', extensions: ['.ps1'] },
  { id: 'yaml', extensions: ['.yml', '.yaml'] },
  { id: 'xml', extensions: ['.xml', '.svg'] },
  { id: 'html', extensions: ['.html', '.htm'] },
  { id: 'css', extensions: ['.css'] },
  { id: 'scss', extensions: ['.scss'] },
  { id: 'less', extensions: ['.less'] },
  { id: 'json', extensions: ['.json'] },
  { id: 'markdown', extensions: ['.md', '.markdown'] },
  { id: 'sql', extensions: ['.sql'] },
  { id: 'lua', extensions: ['.lua'] },
  { id: 'graphql', extensions: ['.graphql', '.gql'] },
  { id: 'ini', extensions: ['.ini', '.toml', '.conf'] },
  { id: 'dockerfile', extensions: ['dockerfile'] }, // matched by filename
  { id: 'plaintext', extensions: ['.txt', '.log'] },
];

const REGISTRY = new Map(LANGUAGES.map((def) => [def.id, def]));

export function registerLanguage(def) {
  REGISTRY.set(def.id, def);
}

export function getLanguageById(id) {
  return REGISTRY.get(id);
}

export function detectLanguageFromPath(p) {
  const lower = String(p || '').toLowerCase();
  for (const def of REGISTRY.values()) {
    if (def.extensions?.some((ext) => lower.endsWith(ext))) return def.id;
  }
  return 'plaintext';
}

export async function installAllLanguages(monaco) {
  const registered = new Set(monaco.languages.getLanguages().map((l) => l.id));
  for (const def of REGISTRY.values()) {
    if (!registered.has(def.id)) {
      monaco.languages.register({ id: def.id, extensions: def.extensions });
    }
  }
}
