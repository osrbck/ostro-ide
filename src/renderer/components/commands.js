const registered = [];

export function registerCommand(cmd) {
  registered.push(cmd);
}

export function getCommands() {
  return registered.slice();
}

export function searchCommands(query) {
  const q = query.toLowerCase();
  if (!q) return registered.slice();
  return registered.filter((c) => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
}
