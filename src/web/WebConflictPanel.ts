/**
 * @file WebConflictPanel.ts
 * @description Web-based conflict resolution panel that opens in the browser.
 * 
 * This is a lightweight wrapper that:
 * 1. Opens the browser via the web server (which serves the React app)
 * 2. Sends conflict data via WebSocket once connected
 * 3. Handles resolution messages and callbacks
 * 
 * The actual UI is rendered by the React app in src/web/client/.
 */

import * as vscode from 'vscode';
import * as logger from '../logger';
import { ResolutionChoice } from '../types';
import { getWebServer } from './webServer';
import { UnifiedConflict, UnifiedResolution, ResolvedRow } from './webTypes';

/**
 * Web-based panel for resolving notebook conflicts in the browser.
 * 
 * Usage:
 * ```
 * await WebConflictPanel.createOrShow(extensionUri, conflict, (resolution) => {
 *     // Handle resolution
 * });
 * ```
 */
export class WebConflictPanel {
    public static currentPanel: WebConflictPanel | undefined;

    private readonly _extensionUri: vscode.Uri;
    private _conflict: UnifiedConflict | undefined;
    private _onResolutionComplete: ((resolution: UnifiedResolution) => Promise<void>) | undefined;
    private _sessionId: string | undefined;
    private _isDisposed: boolean = false;

    public static async createOrShow(
        extensionUri: vscode.Uri,
        conflict: UnifiedConflict,
        onResolutionComplete: (resolution: UnifiedResolution) => Promise<void>
    ): Promise<void> {
        // Close existing panel if any
        if (WebConflictPanel.currentPanel) {
            WebConflictPanel.currentPanel.dispose();
        }

        const panel = new WebConflictPanel(extensionUri, conflict, onResolutionComplete);
        WebConflictPanel.currentPanel = panel;

        await panel._openInBrowser();
    }

    private constructor(
        extensionUri: vscode.Uri,
        conflict: UnifiedConflict,
        onResolutionComplete: (resolution: UnifiedResolution) => Promise<void>
    ) {
        this._extensionUri = extensionUri;
        this._conflict = conflict;
        this._onResolutionComplete = onResolutionComplete;
    }

    public setConflict(
        conflict: UnifiedConflict,
        onResolutionComplete: (resolution: UnifiedResolution) => Promise<void>
    ): void {
        this._conflict = conflict;
        this._onResolutionComplete = onResolutionComplete;
    }

    private async _openInBrowser(): Promise<void> {
        console.log('[WebConflictPanel] Opening conflict resolver in browser...');
        const server = getWebServer();
        server.setExtensionUri(this._extensionUri);

        // Start server if not running
        if (!server.isRunning()) {
            console.log('[WebConflictPanel] Server not running, starting...');
            await server.start();
            console.log('[WebConflictPanel] Server started');
        } else {
            console.log('[WebConflictPanel] Server already running');
        }

        // Generate session ID
        this._sessionId = server.generateSessionId();

        // Open session in browser (we pass a placeholder for htmlContent since we use React now)
        // Do not await the WebSocket connection here to avoid deadlocking tests
        // that need to open the session after the command returns.
        void server.openSession(
            this._sessionId,
            '', // No HTML content needed - server generates shell
            (message: unknown) => this._handleMessage(message),
            this._conflict?.theme ?? 'light',
            this._conflict?.filePath
        ).then(() => {
            // Send conflict data to browser once connected
            this._sendConflictData();
            logger.info(`[WebConflictPanel] Opened conflict resolver in browser, session: ${this._sessionId}`);
        }).catch((error) => {
            logger.error('[WebConflictPanel] Failed to open browser session:', error);
            vscode.window.showErrorMessage(`Failed to open conflict resolver in browser: ${error}`);
        });
    }

    /**
     * Send conflict data to the browser via WebSocket.
     */
    private _sendConflictData(): void {
        if (!this._sessionId || !this._conflict) return;

        const server = getWebServer();

        // Build the data payload for the React app
        const data = {
            filePath: this._conflict.filePath,
            type: this._conflict.type,
            semanticConflict: this._conflict.semanticConflict,
            autoResolveResult: this._conflict.autoResolveResult,
            hideNonConflictOutputs: this._conflict.hideNonConflictOutputs,
            enableUndoRedoHotkeys: this._conflict.enableUndoRedoHotkeys,
            showBaseColumn: this._conflict.showBaseColumn,
            theme: this._conflict.theme,
            currentBranch: this._conflict.semanticConflict?.currentBranch,
            incomingBranch: this._conflict.semanticConflict?.incomingBranch,
        };

        logger.debug(`[WebConflictPanel] Sending conflict data with showBaseColumn=${this._conflict.showBaseColumn}`);
        server.sendConflictData(this._sessionId, data);
    }

    private _handleMessage(message: unknown): void {
        if (this._isDisposed) return;

        const msg = message as {
            command?: string;
            type?: string;
            resolutions?: Array<{ index: number; choice: string; resolvedContent: string }>;
            resolvedRows?: ResolvedRow[];
            semanticChoice?: string;
            markAsResolved?: boolean
        };

        logger.debug('[WebConflictPanel] Received message:', msg.command || msg.type);

        switch (msg.command) {
            case 'resolve':
                // Fire and forget - errors are handled in _handleResolution
                void this._handleResolution(msg);
                break;
            case 'cancel':
                this.dispose();
                break;
            case 'ready':
                // Browser is ready, send conflict data
                this._sendConflictData();
                break;
        }
    }

    private async _handleResolution(message: {
        type?: string;
        resolutions?: Array<{ index: number; choice: string; resolvedContent: string }>;
        resolvedRows?: ResolvedRow[];
        semanticChoice?: string;
        markAsResolved?: boolean;
        renumberExecutionCounts?: boolean;
    }): Promise<void> {
        if (this._conflict?.type === 'semantic') {
            const semanticResolutionMap = new Map<number, { choice: 'base' | 'current' | 'incoming'; resolvedContent: string }>();
            for (const r of (message.resolutions || [])) {
                semanticResolutionMap.set(r.index, {
                    choice: r.choice as 'base' | 'current' | 'incoming',
                    resolvedContent: r.resolvedContent
                });
            }
            if (this._onResolutionComplete) {
                try {
                    await this._onResolutionComplete({
                        type: 'semantic',
                        semanticChoice: message.semanticChoice as 'current' | 'incoming' | undefined,
                        semanticResolutions: semanticResolutionMap,
                        resolvedRows: message.resolvedRows,
                        markAsResolved: message.markAsResolved ?? false,
                        renumberExecutionCounts: message.renumberExecutionCounts ?? false
                    });

                    // Send success message to browser
                    if (this._sessionId) {
                        const server = getWebServer();
                        server.sendMessage(this._sessionId, {
                            type: 'resolution-success',
                            message: 'Conflicts resolved successfully!'
                        });

                        // Wait to ensure message is delivered to browser
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                } catch (error) {
                    logger.error('[WebConflictPanel] Error applying semantic resolutions:', error);
                    vscode.window.showErrorMessage(`Failed to apply resolutions: ${error}`);

                    // Send error message to browser
                    if (this._sessionId) {
                        const server = getWebServer();
                        server.sendMessage(this._sessionId, {
                            type: 'resolution-error',
                            message: `Failed to apply resolutions: ${error}`
                        });
                    }
                    return; // Don't dispose on error so user can see the state
                }
            }
        }
        this.dispose();
    }

    public dispose(): void {
        if (this._isDisposed) return;
        this._isDisposed = true;

        WebConflictPanel.currentPanel = undefined;

        if (this._sessionId) {
            const server = getWebServer();
            server.closeSession(this._sessionId);
        }

        logger.debug('[WebConflictPanel] Disposed');
    }
}
