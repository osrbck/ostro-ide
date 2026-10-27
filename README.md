# Ostro IDE

A lightweight, AI-native code editor — VSCode-like workbench (Monaco editor, file tree, tabs, quick open, command palette, integrated terminal) with a built-in agentic AI harness that can read, search, write, and run code in your workspace.

## Quick start

```bash
npm install
npm start
```

Open **Settings** and choose your AI provider (see below). API keys are encrypted with the OS-level keychain (`safeStorage`) and never written in plaintext.

## Connecting any AI provider

Ostro ships two provider adapters, which together cover essentially every AI API:

| Provider setting | Use for |
|---|---|
| **Anthropic (Claude)** | Claude models with native extended thinking and tool use |
| **OpenAI-compatible** | OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together, xAI, Google Gemini (OpenAI-compat endpoint), Ollama, LM Studio, vLLM, llama.cpp — any endpoint that speaks the `/chat/completions` protocol |

For OpenAI-compatible providers set the **Base URL** (e.g. `https://api.openai.com/v1`, `http://localhost:11434/v1` for Ollama) and type any model name — the model field is free text, so any current or future model works. Use **Test connection** in Settings to validate the key and endpoint before saving.

Extended thinking is an Anthropic feature and is ignored by other providers.

## The agent harness

With a workspace open, the AI chat becomes an agent harness with five tools:

- `read_file` / `write_file` — read and edit workspace files (writes are shown as a reviewable diff before they are applied)
- `list_dir` — explore the workspace
- `search_files` — regex content search across the workspace (runs in a sandboxed worker with a hard deadline)
- `run_command` — run shell commands (each command requires your approval, and can be edited before running)

The file tools are containment-checked (including symlinks) so `read_file`, `write_file`, `list_dir` and `search_files` cannot touch anything outside your workspace. `run_command` commands run with your normal shell permissions — each one requires your explicit approval, and they can access paths outside the workspace like any terminal command you run yourself. Tool results and reasoning are preserved across turns, so multi-step tasks keep their context.

## Workbench

- Monaco editor with syntax highlighting for 80+ languages
- File tree with create/rename/delete, live refresh on disk changes
- **Resizable panels** — drag the splitters to size the sidebar, AI panel and
  terminal; double-click a splitter (or press an arrow key on it) to reset;
  sizes persist across sessions, and the layout stacks automatically on
  narrow windows
- Tabs with dirty-state indicators, Ctrl+Tab cycling, middle-click close
- Quick Open (Ctrl+P) and Command Palette (Ctrl+Shift+P)
- Integrated terminal (Ctrl+`) via xterm.js + node-pty
- AI panel (Ctrl+J) with @-file attachments, streaming responses, tool cards, and diff approval

## Global search & replace

**Ctrl+Shift+F** (or the **Search** sidebar tab) opens Find in Files:

- Searches file **contents** across the workspace, powered by the same
  terminable worker thread the agent's `search_files` tool uses — a
  pathological regex can never freeze the UI (15s deadline, 500-match cap)
- Toggle **regular expressions**, **match case** and **whole word**; optionally
  restrict by file extension (e.g. `.js`)
- Results are grouped per file with **inline match highlighting**; clicking a
  row opens the file and jumps the editor to that line and match
- **Replace All** rewrites every match in the listed files after a
  confirmation, then re-runs the search. Every path is containment-checked
  (same rules as the agent's write tool) and binary files are skipped

## Source Control

The **Source Control** view (sidebar tab, or the branch indicator in the title
bar) shows the current branch with ahead/behind counts, staged and unstaged
changes, and per-file status badges in the explorer tree. From there you can
stage/unstage files, discard changes (with confirmation), and commit — with
Ctrl+Enter in the message box. A folder without a repository offers a one-click
**Initialize Repository**. Status refreshes automatically when files change.

## Agent autonomy

Settings → **Agent Autonomy** controls how much the agent may do without asking:

| Mode | Behaviour |
|---|---|
| **Ask** (default) | Every file write and shell command waits for your approval |
| **Auto** | File writes are auto-approved; shell commands still ask |
| **Bypass** | Everything is auto-approved — only for trusted, disposable workspaces |

The active mode is shown in the AI panel header, and every auto-approved action
is still reported inline so you can see what happened.

## Extensions

Ostro loads **local extensions** from your user-data folder:

```
<userData>/extensions/<name>/
  package.json   # { "name", "version", "description", "main": "index.js" }
  index.js       # module.exports = { activate(api), deactivate() }
```

Each extension receives a small API:

```js
module.exports = {
  activate(api) {
    api.registerCommand('hello', 'Say Hello', () => { /* ... */ }); // → Command Palette
    const item = api.createStatusBarItem('My Ext', 'tooltip');       // → title bar
    api.onFileOpen((path) => api.log('opened', path));
    api.onWorkspaceOpen(({ root }) => api.log('workspace', root));
    api.onFileSave((path) => api.log('saved', path));
    return; // deactivate() is optional
  },
};
```

Extensions run in the main process and are **isolated**: an extension that
throws during activation is marked failed (with its error shown in Settings),
its partial contributions are rolled back, and every other extension keeps
working. Settings → Extensions lists load state per extension and has a
**Reload extensions** button.

Not supported yet, by design: marketplace install, activation events beyond the
four hooks above, webviews, and language servers.

> **Terminal note:** `node-pty` is an optional dependency. If it fails to build on your platform, the terminal shows setup instructions instead of crashing; everything else works normally.

## Development

```bash
npm test       # zero-dependency test suite (node --test) — 84 tests
npm start      # run the app
npm run build  # package installers (electron-builder)
```

Layout geometry, the git status parser, the approval policy and the extension
host are pure modules covered by tests, so their logic can be verified without
launching Electron.

## Stack

- Electron (strict contextIsolation, no nodeIntegration)
- Monaco Editor
- xterm.js + node-pty
- Anthropic SDK + OpenAI-compatible streaming (no extra AI SDKs)
