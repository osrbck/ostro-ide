let currentMenu = null;

function closeMenu() {
  if (currentMenu) {
    currentMenu.remove();
    currentMenu = null;
    window.removeEventListener('click', closeMenu);
    window.removeEventListener('blur', closeMenu);
    window.removeEventListener('keydown', onKey);
  }
}

function onKey(e) {
  if (e.key === 'Escape') closeMenu();
}

export function showContextMenu(x, y, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const item of items) {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'ctx-row' + (item.danger ? ' ctx-danger' : '');
    row.innerHTML = `<span class="ctx-label">${item.label}</span>${item.shortcut ? `<span class="ctx-shortcut">${item.shortcut}</span>` : ''}`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      item.action?.();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  // Clamp to viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  currentMenu = menu;
  setTimeout(() => {
    window.addEventListener('click', closeMenu);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('keydown', onKey);
  }, 0);
}
