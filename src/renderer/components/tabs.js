export function mountTabs({ container, onSwitch, onClose }) {
  const tabs = new Map(); // path -> { el, dirty, nameEl, dotEl }
  const order = []; // ordered list of paths (insertion order)

  function basename(p) {
    return p.split(/[\\/]/).pop();
  }

  function add(filePath) {
    if (tabs.has(filePath)) {
      setActive(filePath);
      return;
    }
    const el = document.createElement('div');
    el.className = 'tab';
    el.innerHTML = `<span class="tab-dot"></span><span class="tab-name"></span><span class="tab-close" title="Close (Ctrl+W)">×</span>`;
    const nameEl = el.querySelector('.tab-name');
    const dotEl = el.querySelector('.tab-dot');
    nameEl.textContent = basename(filePath);
    el.title = filePath;

    nameEl.addEventListener('click', () => onSwitch(filePath));
    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      onClose(filePath);
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); onClose(filePath); } // middle-click closes
    });

    container.appendChild(el);
    tabs.set(filePath, { el, dirty: false, nameEl, dotEl });
    order.push(filePath);
    setActive(filePath);
  }

  function setActive(filePath) {
    for (const [p, t] of tabs) t.el.classList.toggle('active', p === filePath);
    const t = tabs.get(filePath);
    if (t) t.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  function setDirty(filePath, isDirty) {
    const t = tabs.get(filePath);
    if (!t) return;
    if (t.dirty === isDirty) return;
    t.dirty = isDirty;
    t.el.classList.toggle('dirty', isDirty);
  }

  function remove(filePath) {
    const t = tabs.get(filePath);
    if (!t) return;
    t.el.remove();
    tabs.delete(filePath);
    const idx = order.indexOf(filePath);
    if (idx >= 0) order.splice(idx, 1);
  }

  function isDirty(filePath) {
    return !!tabs.get(filePath)?.dirty;
  }

  function nextOf(filePath, dir) {
    if (order.length === 0) return null;
    const i = order.indexOf(filePath);
    if (i < 0) return order[0];
    return order[(i + dir + order.length) % order.length];
  }

  return { add, setActive, setDirty, remove, isDirty, nextOf, order: () => [...order] };
}
