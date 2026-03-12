// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/vscode-shim.ts — Minimal vscode shim for standalone (non-VS Code) use
// ─────────────────────────────────────────────────────────────────────────────
// When running the CoogentMCPServer outside the VS Code extension host (e.g.,
// via the stdio transport), the `vscode` module is not available. This shim
// provides no-op stubs for the APIs used by ArtifactDB and PluginLoader so the
// server can start without errors.

/** Stub workspace configuration that returns defaults for all settings. */
const stubConfig = {
    get<T>(_key: string, defaultValue?: T): T | undefined {
        return defaultValue;
    },
    has(): boolean {
        return false;
    },
    inspect() {
        return undefined;
    },
    update() {
        return Promise.resolve();
    },
};

export const workspace = {
    getConfiguration(_section?: string) {
        return stubConfig;
    },
};

export const window = {
    showInformationMessage() {
        return Promise.resolve(undefined);
    },
    showWarningMessage() {
        return Promise.resolve(undefined);
    },
    showErrorMessage() {
        return Promise.resolve(undefined);
    },
};

export const Uri = {
    file(path: string) {
        return { fsPath: path, scheme: 'file', path };
    },
};
