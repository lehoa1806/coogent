// ─────────────────────────────────────────────────────────────────────────────
// main.ts — Svelte webview entry point
//
// Bootstraps the Svelte app, initializes the IPC message handler, and
// requests the initial state snapshot from the Extension Host.
// ─────────────────────────────────────────────────────────────────────────────

import './styles/global.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { initMessageHandler } from './stores/messageHandler.js';
import { postMessage } from './stores/vscode.js';

try {
  // 1. Register the global message handler (Extension Host → Webview)
  initMessageHandler();

  // 2. Mount the Svelte app using Svelte 5's mount() API
  //    (replaces the deprecated `new App({ target })` constructor)
  mount(App, { target: document.body });

  // 3. Request initial state snapshot so the UI hydrates from the Extension Host
  postMessage({ type: 'CMD_REQUEST_STATE' });
} catch (err: unknown) {
  // Display the error directly in the DOM so it's never a blank page
  const msg = err instanceof Error ? `${err.message}\n\n${err.stack}` : String(err);
  console.error('[Coogent] Fatal bootstrap error:', err);
  document.body.innerHTML = `
    <div style="padding:24px;font-family:monospace;color:#f85149;background:#1e1e1e;white-space:pre-wrap;font-size:12px;">
      <h2 style="color:#d29922;margin-bottom:12px;">⚠ Coogent Mission Control — Bootstrap Error</h2>
      <pre style="color:#ccc;">${msg}</pre>
    </div>`;
}
