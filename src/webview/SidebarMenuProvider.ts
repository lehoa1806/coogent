// ─────────────────────────────────────────────────────────────────────────────
// src/webview/SidebarMenuProvider.ts — Native sidebar with launcher + session history
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import type { SessionManager } from '../session/SessionManager.js';
import type { SessionSummary } from '../session/SessionManager.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Tree Item helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Sentinel value used as a group header for collapsible sections. */
const HISTORY_GROUP_ID = '__history_group__';

class LauncherItem extends vscode.TreeItem {
    constructor(label: string, tooltip: string, commandId: string, iconId: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = tooltip;
        this.iconPath = new vscode.ThemeIcon(iconId);
        this.command = { command: commandId, title: label };
        this.contextValue = 'launcher';
    }
}

class HistoryGroupItem extends vscode.TreeItem {
    constructor() {
        super('Session History', vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('history');
        this.contextValue = 'historyGroup';
        this.id = HISTORY_GROUP_ID;
    }
}

class SessionItem extends vscode.TreeItem {
    constructor(public readonly session: SessionSummary) {
        const label = session.projectId || session.firstPrompt?.slice(0, 40) || 'Untitled';
        super(label, vscode.TreeItemCollapsibleState.None);

        this.id = session.sessionId;
        this.contextValue = 'session';
        this.tooltip = new vscode.MarkdownString(
            `**${label}**\n\n` +
            `Status: \`${session.status}\`\n\n` +
            `Phases: ${session.completedPhases}/${session.phaseCount}\n\n` +
            `${formatRelativeTime(session.createdAt)}` +
            (session.firstPrompt ? `\n\n---\n\n${session.firstPrompt}` : ''),
        );
        this.description = formatRelativeTime(session.createdAt);

        // Status-based icon
        const iconMap: Record<string, string> = {
            completed: 'pass-filled',
            running: 'sync~spin',
            paused_error: 'error',
            idle: 'circle-outline',
        };
        this.iconPath = new vscode.ThemeIcon(iconMap[session.status] ?? 'circle-outline');

        // Click → load session
        this.command = {
            command: 'coogent.loadSession',
            title: 'Load Session',
            arguments: [session.sessionId],
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SidebarMenuProvider
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dynamic TreeDataProvider for the Coogent Activity Bar sidebar.
 *
 * Renders:
 *   - Launcher actions (open MC, new session)
 *   - Collapsible session history with live session items
 */
export class SidebarMenuProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** Cached session list — refreshed on demand. */
    private _sessions: SessionSummary[] = [];
    private _searchQuery = '';
    private _loading = false;

    constructor(private _sessionManager?: SessionManager) { }

    // ─── Public API ─────────────────────────────────────────────────────

    /** Update the SessionManager reference (e.g. after a session reset). */
    setSessionManager(mgr: SessionManager): void {
        this._sessionManager = mgr;
    }

    /** Refresh the entire tree (re-fetches session list). */
    refresh(): void {
        this._searchQuery = '';
        this._loading = true;
        this._onDidChangeTreeData.fire();
        this.fetchSessions();
    }

    /** Filter sessions by a search query. */
    async search(query: string): Promise<void> {
        this._searchQuery = query;
        await this.fetchSessions();
    }

    // ─── TreeDataProvider contract ──────────────────────────────────────

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] | Thenable<vscode.TreeItem[]> {
        // Root level: launcher items + history group
        if (!element) {
            return [
                new LauncherItem(
                    '🚀 Launch Mission Control',
                    'Open the full Mission Control panel',
                    'coogent.openMissionControl',
                    'rocket',
                ),
                new LauncherItem(
                    '➕ New Orchestration Session',
                    'Reset engine and start a fresh session',
                    'coogent.newSession',
                    'add',
                ),
                new HistoryGroupItem(),
            ];
        }

        // Children of the history group
        if (element.id === HISTORY_GROUP_ID) {
            if (this._loading) {
                const loadingItem = new vscode.TreeItem('Loading…');
                loadingItem.iconPath = new vscode.ThemeIcon('loading~spin');
                return [loadingItem];
            }
            if (this._sessions.length === 0) {
                const emptyItem = new vscode.TreeItem('No past sessions found');
                emptyItem.iconPath = new vscode.ThemeIcon('info');
                return [emptyItem];
            }
            return this._sessions.map(s => new SessionItem(s));
        }

        return [];
    }

    // ─── Internals ──────────────────────────────────────────────────────

    private async fetchSessions(): Promise<void> {
        if (!this._sessionManager) {
            this._sessions = [];
            this._loading = false;
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            this._sessions = this._searchQuery
                ? await this._sessionManager.searchSessions(this._searchQuery)
                : await this._sessionManager.listSessions();
        } catch {
            this._sessions = [];
        }

        this._loading = false;
        this._onDidChangeTreeData.fire();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function formatRelativeTime(timestamp: number): string {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
}
