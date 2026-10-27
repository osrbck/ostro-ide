// Panel geometry model for the workbench.
//
// Pure and DOM-free so the clamping/drag math is unit-testable. The DOM
// layer (splitter.js) only translates pointer events into these calls.

const LIMITS = {
  sidebar: { min: 180, max: 480, def: 240 },
  chat: { min: 280, max: 760, def: 360 },
  terminal: { min: 80, max: 640, def: 200 },
};

const STORAGE_KEY = 'ostro.layout';

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampSidebar(v) { return clamp(v, LIMITS.sidebar.min, LIMITS.sidebar.max); }
function clampChat(v) { return clamp(v, LIMITS.chat.min, LIMITS.chat.max); }
function clampTerminal(v) { return clamp(v, LIMITS.terminal.min, LIMITS.terminal.max); }

// Drag deltas: the sidebar's splitter sits on its RIGHT edge, so growing
// it means moving right (positive dx). The chat panel's splitter sits on
// its LEFT edge, so growing it means moving LEFT (negative dx).
function resizeSidebar(startWidth, dx) {
  return clampSidebar(startWidth + dx);
}

function resizeChat(startWidth, dx) {
  return clampChat(startWidth - dx);
}

// The terminal's splitter sits on its TOP edge: dragging up (negative dy)
// grows the terminal.
function resizeTerminal(startHeight, dy) {
  return clampTerminal(startHeight - dy);
}

// A panel must never squeeze the editor below a usable width: when the
// viewport is narrow, available space for sidebar+chat is capped.
function fitToViewport({ sidebar, chat, viewportWidth, minEditor = 320 }) {
  const budget = Math.max(0, Number(viewportWidth) - minEditor);
  let s = clampSidebar(sidebar);
  let c = clampChat(chat);
  if (s + c <= budget) return { sidebar: s, chat: c };
  // Prefer shrinking the chat panel first, then the sidebar.
  const overflow = s + c - budget;
  const chatRoom = Math.max(0, c - LIMITS.chat.min);
  const takeFromChat = Math.min(overflow, chatRoom);
  c -= takeFromChat;
  const rest = overflow - takeFromChat;
  if (rest > 0) {
    s = clampSidebar(s - Math.min(rest, Math.max(0, s - LIMITS.sidebar.min)));
  }
  return { sidebar: s, chat: c };
}

function defaultLayout() {
  return {
    sidebar: LIMITS.sidebar.def,
    chat: LIMITS.chat.def,
    terminal: LIMITS.terminal.def,
  };
}

// Storage is untrusted (a user or another build may have written anything),
// so every field is clamped on read.
function loadLayout(storage) {
  const base = defaultLayout();
  try {
    const raw = storage?.getItem?.(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    return {
      sidebar: clampSidebar(parsed?.sidebar ?? base.sidebar),
      chat: clampChat(parsed?.chat ?? base.chat),
      terminal: clampTerminal(parsed?.terminal ?? base.terminal),
    };
  } catch {
    return base;
  }
}

function saveLayout(storage, layout) {
  try {
    storage?.setItem?.(STORAGE_KEY, JSON.stringify({
      sidebar: clampSidebar(layout.sidebar),
      chat: clampChat(layout.chat),
      terminal: clampTerminal(layout.terminal),
    }));
  } catch {
    // Storage may be unavailable/full — layout persistence is best-effort.
  }
}

export {
  LIMITS,
  STORAGE_KEY,
  clamp,
  clampSidebar,
  clampChat,
  clampTerminal,
  resizeSidebar,
  resizeChat,
  resizeTerminal,
  fitToViewport,
  defaultLayout,
  loadLayout,
  saveLayout,
};
