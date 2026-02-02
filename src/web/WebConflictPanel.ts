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
import { UnifiedConflict, UnifiedResolution } from './webTypes';

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
    private _onResolutionComplete: ((resolution: UnifiedResolution) => void) | undefined;
    private _sessionId: string | undefined;
    private _isDisposed: boolean = false;

    public static async createOrShow(
        extensionUri: vscode.Uri,
        conflict: UnifiedConflict,
        onResolutionComplete: (resolution: UnifiedResolution) => void
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
        onResolutionComplete: (resolution: UnifiedResolution) => void
    ) {
        this._extensionUri = extensionUri;
        this._conflict = conflict;
        this._onResolutionComplete = onResolutionComplete;
    }

    public setConflict(
        conflict: UnifiedConflict,
        onResolutionComplete: (resolution: UnifiedResolution) => void
    ): void {
        this._conflict = conflict;
        this._onResolutionComplete = onResolutionComplete;
    }

    private async _openInBrowser(): Promise<void> {
        const server = getWebServer();
        server.setExtensionUri(this._extensionUri);
        
        // Start server if not running
        if (!server.isRunning()) {
            await server.start();
        }

        // Generate session ID
        this._sessionId = server.generateSessionId();

        // Open session in browser (we pass a placeholder for htmlContent since we use React now)
        try {
            const ws = await server.openSession(
                this._sessionId,
                '', // No HTML content needed - server generates shell
                (message: unknown) => this._handleMessage(message)
            );
            
            // Send conflict data to browser once connected
            this._sendConflictData();
            
            logger.info(`[WebConflictPanel] Opened conflict resolver in browser, session: ${this._sessionId}`);
        } catch (error) {
            logger.error('[WebConflictPanel] Failed to open browser session:', error);
            vscode.window.showErrorMessage(`Failed to open conflict resolver in browser: ${error}`);
        }
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
            textualConflict: this._conflict.textualConflict,
            semanticConflict: this._conflict.semanticConflict,
            autoResolveResult: this._conflict.autoResolveResult,
            hideNonConflictOutputs: this._conflict.hideNonConflictOutputs,
            currentBranch: this._conflict.textualConflict?.currentBranch || this._conflict.semanticConflict?.currentBranch,
            incomingBranch: this._conflict.textualConflict?.incomingBranch || this._conflict.semanticConflict?.incomingBranch,
        };

        server.sendConflictData(this._sessionId, data);
    }

    private _handleMessage(message: unknown): void {
        if (this._isDisposed) return;
        
        const msg = message as { 
            command?: string; 
            type?: string; 
            resolutions?: Array<{ index: number; choice: string; customContent?: string }>; 
            semanticChoice?: string; 
            markAsResolved?: boolean 
        };
        
        logger.debug('[WebConflictPanel] Received message:', msg.command || msg.type);

        switch (msg.command) {
            case 'resolve':
                this._handleResolution(msg);
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

    private _handleResolution(message: { 
        type?: string; 
        resolutions?: Array<{ index: number; choice: string; customContent?: string }>; 
        semanticChoice?: string; 
        markAsResolved?: boolean 
    }): void {
        if (this._conflict?.type === 'textual') {
            const resolutionMap = new Map<number, { choice: ResolutionChoice; customContent?: string }>();
            for (const r of (message.resolutions || [])) {
                resolutionMap.set(r.index, { 
                    choice: r.choice as ResolutionChoice, 
                    customContent: r.customContent 
                });
            }
            if (this._onResolutionComplete) {
                this._onResolutionComplete({
                    type: 'textual',
                    textualResolutions: resolutionMap,
                    markAsResolved: message.markAsResolved ?? false
                });
            }
        } else if (this._conflict?.type === 'semantic') {
            const semanticResolutionMap = new Map<number, { choice: 'base' | 'current' | 'incoming'; customContent?: string }>();
            for (const r of (message.resolutions || [])) {
                semanticResolutionMap.set(r.index, {
                    choice: r.choice as 'base' | 'current' | 'incoming',
                    customContent: r.customContent
                });
            }
            if (this._onResolutionComplete) {
                this._onResolutionComplete({
                    type: 'semantic',
                    semanticChoice: message.semanticChoice as 'current' | 'incoming' | undefined,
                    semanticResolutions: semanticResolutionMap,
                    markAsResolved: message.markAsResolved ?? false
                });
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
