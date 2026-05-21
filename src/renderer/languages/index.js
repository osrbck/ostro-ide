const REGISTRY = new Map();

export function registerLanguage(def) {
  REGISTRY.set(def.id, def);
}

export function getLanguageById(id) {
  return REGISTRY.get(id);
}

export function detectLanguageFromPath(p) {
  const lower = p.toLowerCase();
  for (const def of REGISTRY.values()) {
    if (def.extensions?.some((ext) => lower.endsWith(ext))) return def.id;
  }
  return 'plaintext';
}

export async function installAllLanguages(monaco) {
  const modules = await Promise.all([
    import('./javascript.js'),
    import('./python.js'),
    import('./c.js'),
  ]);
  for (const mod of modules) {
    const def = mod.default;
    registerLanguage(def);
    monaco.languages.register({ id: def.id, extensions: def.extensions });
    if (def.tokensProvider) monaco.languages.setMonarchTokensProvider(def.id, def.tokensProvider);
    if (def.configuration) monaco.languages.setLanguageConfiguration(def.id, def.configuration);
  }
}
