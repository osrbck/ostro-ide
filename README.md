# Ostro

A lightweight, AI-native code editor.

## Quick start

```bash
npm install
npm start
```

Open Settings (top bar) and paste your Anthropic API key — it is encrypted with the OS-level keychain (`safeStorage`) and never written in plaintext.

## Stack
- Electron (strict contextIsolation, no nodeIntegration)
- Monaco Editor
- xterm.js + node-pty
- Anthropic SDK (agent loop with tool use)
