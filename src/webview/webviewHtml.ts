// ─────────────────────────────────────────────────────────────────────────────
// src/webview/webviewHtml.ts — Shared HTML shell for Svelte webview rendering
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

/**
 * Generate the HTML shell that boots the Svelte/Vite bundled webview.
 *
 * Shared by both `MissionControlPanel` (editor tab) and
 * `MissionControlViewProvider` (Activity Bar sidebar) so the same
 * CSP, asset URIs, and mount strategy are used everywhere.
 */
export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = randomUUID();

    // Resolve URIs for the Svelte/Vite bundled webview assets
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist', 'assets', 'index.js')
    );
    const vendorMermaidUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist', 'assets', 'vendor-mermaid.js')
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist', 'assets', 'style.css')
    );

    // Minimal HTML shell — Svelte mounts itself to document.body and owns the entire DOM.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- W-8: 'unsafe-inline' is required for Svelte's compiled scoped <style> tags.
       Svelte does not yet support nonce-based CSS injection. This is a known
       trade-off. Revisit when Svelte adds nonce-based scoped CSS support. -->
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 font-src ${webview.cspSource} data:;
                 img-src ${webview.cspSource} data:;
                 script-src ${webview.cspSource} 'nonce-${nonce}';">
  <title>Mission Control</title>
  <link rel="stylesheet" href="${styleUri}">
  <link rel="modulepreload" href="${vendorMermaidUri}">
</head>
<body>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
