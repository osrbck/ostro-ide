// DOM splitter layer: translates pointer drags into layout-model updates.
// Geometry math lives in layout.js (pure, unit-tested); this file only
// handles pointer capture, cursors, and applying sizes to the DOM.

import {
  resizeSidebar,
  resizeChat,
  resizeTerminal,
  loadLayout,
  saveLayout,
  fitToViewport,
} from './layout.js';

function clampCursor(el, cursor) {
  el.style.cursor = cursor;
}

// Creates a splitter element and wires drag behaviour.
//   axis: 'x' | 'y'
//   onDelta(startValue, delta) -> new size
//   getValue() -> current size at drag start
//   onApply(size) -> commit size to the DOM
function makeSplitter({ axis, className, label, getValue, onDelta, onApply, onEnd }) {
  const el = document.createElement('div');
  el.className = `splitter splitter-${axis} ${className || ''}`.trim();
  el.setAttribute('role', 'separator');
  el.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
  el.setAttribute('aria-label', label || 'Resize panel');
  el.tabIndex = 0;

  let dragging = false;
  let startValue = 0;
  let startPos = 0;

  const down = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startValue = getValue();
    startPos = axis === 'x' ? e.clientX : e.clientY;
    el.classList.add('dragging');
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const move = (e) => {
    if (!dragging) return;
    const pos = axis === 'x' ? e.clientX : e.clientY;
    onApply(onDelta(startValue, pos - startPos));
    e.preventDefault();
  };

  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    document.body.classList.remove('resizing-x', 'resizing-y');
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onEnd?.();
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  // Keyboard resizing (accessibility): arrows adjust by 10px, Shift for 40px.
  el.addEventListener('keydown', (e) => {
    const dec = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const inc = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    const step = e.shiftKey ? 40 : 10;
    // For the direction: dragging right/up. The model functions expect the
    // raw pointer delta, so translate the arrow into a virtual delta.
    const delta = e.key === inc ? step : -step;
    onApply(onDelta(getValue(), delta));
    onEnd?.();
  });

  // Double-click restores the panel's default size.
  el.addEventListener('dblclick', () => {
    el.dispatchEvent(new CustomEvent('splitter-reset', { bubbles: true }));
    onEnd?.();
  });

  clampCursor(el, axis === 'x' ? 'col-resize' : 'row-resize');
  return el;
}

export function mountSplitters({ workbench, sidebar, chat, editorZone, terminalHost, onTerminalResize }) {
  let layout = loadLayout(window.localStorage);

  function apply() {
    const fitted = fitToViewport({
      sidebar: layout.sidebar,
      chat: layout.chat,
      viewportWidth: window.innerWidth,
    });
    // CSS variables drive the GRID TRACKS exclusively. Never write inline
    // widths on the panels themselves: inline styles outrank the
    // `.chat-collapsed { width: 0 }` rule and resurrect a hidden panel.
    workbench.style.setProperty('--sidebar-w', `${fitted.sidebar}px`);
    workbench.style.setProperty('--chat-w', `${fitted.chat}px`);
    terminalHost.style.height = `${layout.terminal}px`;
    onTerminalResize?.();
  }

  function persist() {
    saveLayout(window.localStorage, layout);
  }

  const sidebarSplitter = makeSplitter({
    axis: 'x',
    className: 'splitter-sidebar',
    label: 'Resize sidebar',
    getValue: () => layout.sidebar,
    onDelta: resizeSidebar,
    onApply: (v) => { layout.sidebar = v; apply(); },
    onEnd: persist,
  });
  sidebar.addEventListener('splitter-reset', () => {
    layout = { ...layout, sidebar: 240 };
    apply();
    persist();
  });

  const chatSplitter = makeSplitter({
    axis: 'x',
    className: 'splitter-chat',
    label: 'Resize AI panel',
    getValue: () => layout.chat,
    onDelta: resizeChat,
    onApply: (v) => { layout.chat = v; apply(); },
    onEnd: persist,
  });
  chat.addEventListener('splitter-reset', () => {
    layout = { ...layout, chat: 360 };
    apply();
    persist();
  });

  // The terminal splitter only exists while the terminal is visible.
  const terminalSplitter = makeSplitter({
    axis: 'y',
    className: 'splitter-terminal',
    label: 'Resize terminal',
    getValue: () => layout.terminal,
    onDelta: resizeTerminal,
    onApply: (v) => { layout.terminal = v; apply(); },
    onEnd: persist,
  });
  terminalHost.addEventListener('splitter-reset', () => {
    layout = { ...layout, terminal: 200 };
    apply();
    persist();
  });

  // Insert splitters into the grid: sidebar | splitter | editor | splitter | chat
  sidebar.after(sidebarSplitter);
  chat.before(chatSplitter);
  // Vertical splitter lives directly above the terminal inside the editor zone.
  editorZone.insertBefore(terminalSplitter, terminalHost);

  apply();
  window.addEventListener('resize', apply);

  return {
    setTerminalVisible(visible) {
      terminalSplitter.classList.toggle('hidden', !visible);
    },
    apply,
    getLayout: () => ({ ...layout }),
  };
}
