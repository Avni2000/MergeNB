/**
 * @file WebConflictPanel.ts
 * @description Web-based conflict resolution panel that opens in the browser.
 * 
 * This is the web equivalent of UnifiedConflictPanel. Instead of creating a
 * VSCode webview panel, it:
 * 1. Generates HTML content for the conflict resolver UI
 * 2. Opens the browser via the web server
 * 3. Communicates with the browser via WebSocket
 * 4. Handles resolution messages and callbacks
 * 
 * The HTML/CSS/JS is largely ported from ConflictResolverPanel but adapted
 * to work in a standalone browser context using WebSocket instead of vscode.postMessage.
 */

import * as vscode from 'vscode';
import * as logger from '../logger';
import {
    NotebookConflict,
    CellConflict,
    ResolutionChoice,
    NotebookSemanticConflict,
    SemanticConflict,
    NotebookCell,
    Notebook,
    CellMapping
} from '../types';
import { AutoResolveResult } from '../conflictDetector';
import { computeLineDiff, DiffLine } from '../diffUtils';
import { sortByPosition } from '../cellMatcher';
import { getWebServer } from './webServer';
import { UnifiedConflict, UnifiedResolution } from '../webview/ConflictResolverPanel';

/**
 * Represents a row in the 3-way merge view
 */
interface MergeRow {
    type: 'identical' | 'conflict';
    baseCell?: NotebookCell;
    currentCell?: NotebookCell;
    incomingCell?: NotebookCell;
    baseCellIndex?: number;
    currentCellIndex?: number;
    incomingCellIndex?: number;
    conflictIndex?: number;
    conflictType?: string;
    isUnmatched?: boolean;
    unmatchedSides?: ('base' | 'current' | 'incoming')[];
    anchorPosition?: number;
}

/**
 * Web-based panel for resolving notebook conflicts in the browser.
 * 
 * Usage is similar to UnifiedConflictPanel:
 * ```
 * WebConflictPanel.createOrShow(extensionUri, conflict, (resolution) => {
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
        // Note: In web mode, we'd need to send updated conflict data via WebSocket
        // For now, this requires opening a new browser session
    }

    private async _openInBrowser(): Promise<void> {
        const server = getWebServer();
        
        // Start server if not running
        if (!server.isRunning()) {
            await server.start();
        }

        // Generate session ID and HTML content
        this._sessionId = server.generateSessionId();
        const htmlContent = this._getHtmlForBrowser();

        // Open session in browser
        try {
            await server.openSession(
                this._sessionId,
                htmlContent,
                (message: unknown) => this._handleMessage(message)
            );
            
            logger.info(`[WebConflictPanel] Opened conflict resolver in browser, session: ${this._sessionId}`);
        } catch (error) {
            logger.error('[WebConflictPanel] Failed to open browser session:', error);
            vscode.window.showErrorMessage(`Failed to open conflict resolver in browser: ${error}`);
        }
    }

    private _handleMessage(message: unknown): void {
        if (this._isDisposed) return;
        
        const msg = message as { command?: string; type?: string; resolutions?: unknown[]; semanticChoice?: string; markAsResolved?: boolean };
        
        logger.debug('[WebConflictPanel] Received message:', msg.command || msg.type);

        switch (msg.command) {
            case 'resolve':
                this._handleResolution(msg as {
                    type: string;
                    resolutions?: Array<{ index: number; choice: string; customContent?: string }>;
                    semanticChoice?: string;
                    markAsResolved?: boolean;
                });
                break;
            case 'cancel':
                this.dispose();
                break;
            case 'ready':
                // Browser is ready, could send additional data if needed
                logger.debug('[WebConflictPanel] Browser is ready');
                break;
        }
    }

    private _handleResolution(message: { 
        type: string; 
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

    private _shouldShowCellHeaders(): boolean {
        const config = vscode.workspace.getConfiguration('mergeNB');
        return config.get<boolean>('ui.showCellHeaders', false);
    }

    private _getHtmlForBrowser(): string {
        const conflict = this._conflict;
        if (!conflict) {
            return this._getErrorHtml('No conflicts to resolve.');
        }

        if (conflict.type === 'textual' && conflict.textualConflict) {
            return this._getTextualConflictHtml(conflict.textualConflict);
        } else if (conflict.type === 'semantic' && conflict.semanticConflict) {
            return this._getSemanticConflictHtml(conflict.semanticConflict);
        }

        return this._getErrorHtml('Unknown conflict type.');
    }

    private _getErrorHtml(message: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MergeNB - Error</title>
    <style>
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: #1e1e1e;
            color: #d4d4d4;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }
        .error-box {
            text-align: center;
            padding: 40px;
            background: #252526;
            border-radius: 8px;
            border: 1px solid #3c3c3c;
        }
        h1 { color: #f14c4c; }
    </style>
</head>
<body>
    <div class="error-box">
        <h1>Error</h1>
        <p>${escapeHtml(message)}</p>
    </div>
</body>
</html>`;
    }

    /**
     * Build merge rows from cell mappings for 3-way view.
     */
    private _buildMergeRows(semanticConflict: NotebookSemanticConflict): MergeRow[] {
        const rows: MergeRow[] = [];
        const conflictMap = new Map<string, { conflict: SemanticConflict; index: number }>();

        semanticConflict.semanticConflicts.forEach((c, i) => {
            const key = `${c.baseCellIndex ?? 'x'}-${c.currentCellIndex ?? 'x'}-${c.incomingCellIndex ?? 'x'}`;
            conflictMap.set(key, { conflict: c, index: i });
        });

        for (const mapping of semanticConflict.cellMappings) {
            const baseCell = mapping.baseIndex !== undefined && semanticConflict.base
                ? semanticConflict.base.cells[mapping.baseIndex] : undefined;
            const currentCell = mapping.currentIndex !== undefined && semanticConflict.current
                ? semanticConflict.current.cells[mapping.currentIndex] : undefined;
            const incomingCell = mapping.incomingIndex !== undefined && semanticConflict.incoming
                ? semanticConflict.incoming.cells[mapping.incomingIndex] : undefined;

            const key = `${mapping.baseIndex ?? 'x'}-${mapping.currentIndex ?? 'x'}-${mapping.incomingIndex ?? 'x'}`;
            const conflictInfo = conflictMap.get(key);

            const presentSides: ('base' | 'current' | 'incoming')[] = [];
            if (baseCell) presentSides.push('base');
            if (currentCell) presentSides.push('current');
            if (incomingCell) presentSides.push('incoming');

            const isUnmatched = presentSides.length < 3 && presentSides.length > 0;
            const anchorPosition = mapping.baseIndex ?? mapping.currentIndex ?? mapping.incomingIndex ?? 0;

            rows.push({
                type: conflictInfo ? 'conflict' : 'identical',
                baseCell,
                currentCell,
                incomingCell,
                baseCellIndex: mapping.baseIndex,
                currentCellIndex: mapping.currentIndex,
                incomingCellIndex: mapping.incomingIndex,
                conflictIndex: conflictInfo?.index,
                conflictType: conflictInfo?.conflict.type,
                isUnmatched,
                unmatchedSides: isUnmatched ? presentSides : undefined,
                anchorPosition
            });
        }

        return this._sortRowsByPosition(rows);
    }

    private _sortRowsByPosition(rows: MergeRow[]): MergeRow[] {
        return sortByPosition(rows, (r) => ({
            anchor: r.anchorPosition ?? 0,
            incoming: r.incomingCellIndex,
            current: r.currentCellIndex,
            base: r.baseCellIndex
        }));
    }

    private _getSemanticConflictHtml(conflict: NotebookSemanticConflict): string {
        const rows = this._buildMergeRows(conflict);
        const totalConflicts = conflict.semanticConflicts.length;

        let notebookHtml = '';
        for (const row of rows) {
            notebookHtml += this._renderMergeRow(row, conflict);
        }

        return this._wrapInFullHtml(
            conflict.filePath,
            notebookHtml,
            'semantic',
            totalConflicts,
            conflict.currentBranch,
            conflict.incomingBranch,
            this._conflict?.autoResolveResult
        );
    }

    private _getTextualConflictHtml(conflict: NotebookConflict): string {
        if (conflict.cellMappings && conflict.cellMappings.length > 0 &&
            (conflict.current || conflict.incoming)) {
            return this._getTextualConflictWithContextHtml(conflict);
        }

        const conflictsHtml = conflict.conflicts.map((c, i) =>
            this._renderTextualConflictRow(c, i)
        ).join('');

        const metadataConflictsHtml = conflict.metadataConflicts.map((c, i) =>
            this._renderMetadataConflictRow(c, i + conflict.conflicts.length)
        ).join('');

        return this._wrapInFullHtml(
            conflict.filePath,
            conflictsHtml + metadataConflictsHtml,
            'textual',
            conflict.conflicts.length + conflict.metadataConflicts.length
        );
    }

    private _getTextualConflictWithContextHtml(conflict: NotebookConflict): string {
        const rows = this._buildMergeRowsForTextual(conflict);
        const cellConflictCount = rows.filter(r => r.type === 'conflict').length;
        const totalConflicts = cellConflictCount + conflict.metadataConflicts.length;

        let notebookHtml = '';
        for (const row of rows) {
            notebookHtml += this._renderMergeRowForTextual(row, conflict);
        }

        const metadataConflictsHtml = conflict.metadataConflicts.map((c, i) =>
            this._renderMetadataConflictRow(c, cellConflictCount + i)
        ).join('');

        return this._wrapInFullHtml(
            conflict.filePath,
            notebookHtml + metadataConflictsHtml,
            'textual',
            totalConflicts,
            conflict.currentBranch,
            conflict.incomingBranch
        );
    }

    private _buildMergeRowsForTextual(conflict: NotebookConflict): MergeRow[] {
        const rows: MergeRow[] = [];

        if (!conflict.cellMappings) {
            return rows;
        }

        let conflictIndex = 0;

        for (const mapping of conflict.cellMappings) {
            const baseCell = mapping.baseIndex !== undefined && conflict.base
                ? conflict.base.cells[mapping.baseIndex] : undefined;
            const currentCell = mapping.currentIndex !== undefined && conflict.current
                ? conflict.current.cells[mapping.currentIndex] : undefined;
            const incomingCell = mapping.incomingIndex !== undefined && conflict.incoming
                ? conflict.incoming.cells[mapping.incomingIndex] : undefined;

            let isConflict = false;

            if (currentCell && !incomingCell && !baseCell) {
                isConflict = true;
            } else if (incomingCell && !currentCell && !baseCell) {
                isConflict = true;
            } else if (currentCell && incomingCell) {
                const currentSource = Array.isArray(currentCell.source) ? currentCell.source.join('') : currentCell.source;
                const incomingSource = Array.isArray(incomingCell.source) ? incomingCell.source.join('') : incomingCell.source;

                if (currentSource !== incomingSource) {
                    isConflict = true;
                } else if (currentCell.cell_type === 'code') {
                    const currentOutputs = JSON.stringify(currentCell.outputs || []);
                    const incomingOutputs = JSON.stringify(incomingCell.outputs || []);
                    if (currentOutputs !== incomingOutputs) {
                        if (currentCell.execution_count !== incomingCell.execution_count) {
                            isConflict = false;
                        }
                    }
                }
            } else if (baseCell && (!currentCell || !incomingCell) && (currentCell || incomingCell)) {
                isConflict = true;
            }

            const currentConflictIndex = isConflict ? conflictIndex++ : undefined;

            const presentSides: ('base' | 'current' | 'incoming')[] = [];
            if (baseCell) presentSides.push('base');
            if (currentCell) presentSides.push('current');
            if (incomingCell) presentSides.push('incoming');

            const isUnmatched = presentSides.length < 3 && presentSides.length > 0;
            const anchorPosition = mapping.baseIndex ?? mapping.currentIndex ?? mapping.incomingIndex ?? 0;

            rows.push({
                type: isConflict ? 'conflict' : 'identical',
                baseCell,
                currentCell,
                incomingCell,
                baseCellIndex: mapping.baseIndex,
                currentCellIndex: mapping.currentIndex,
                incomingCellIndex: mapping.incomingIndex,
                conflictIndex: currentConflictIndex,
                conflictType: isConflict ? 'textual' : undefined,
                isUnmatched,
                unmatchedSides: isUnmatched ? presentSides : undefined,
                anchorPosition
            });
        }

        return this._sortRowsByPosition(rows);
    }

    private _renderMergeRowForTextual(row: MergeRow, conflict: NotebookConflict): string {
        const isConflict = row.type === 'conflict';
        const conflictClass = isConflict ? 'conflict-row' : '';

        const baseSource = row.baseCell ?
            (Array.isArray(row.baseCell.source) ? row.baseCell.source.join('') : row.baseCell.source) : '';
        const currentSource = row.currentCell ?
            (Array.isArray(row.currentCell.source) ? row.currentCell.source.join('') : row.currentCell.source) : '';
        const incomingSource = row.incomingCell ?
            (Array.isArray(row.incomingCell.source) ? row.incomingCell.source.join('') : row.incomingCell.source) : '';

        const cellDataAttrs = isConflict ? `
            data-base-source="${encodeURIComponent(baseSource)}"
            data-current-source="${encodeURIComponent(currentSource)}"
            data-incoming-source="${encodeURIComponent(incomingSource)}"
            data-cell-type="${row.currentCell?.cell_type || row.incomingCell?.cell_type || row.baseCell?.cell_type || 'code'}"
            data-has-base="${row.baseCell ? 'true' : 'false'}"
            data-has-current="${row.currentCell ? 'true' : 'false'}"
            data-has-incoming="${row.incomingCell ? 'true' : 'false'}"
        ` : '';

        const baseOutputs = row.baseCell?.outputs ? encodeURIComponent(JSON.stringify(row.baseCell.outputs)) : '';
        const currentOutputs = row.currentCell?.outputs ? encodeURIComponent(JSON.stringify(row.currentCell.outputs)) : '';
        const incomingOutputs = row.incomingCell?.outputs ? encodeURIComponent(JSON.stringify(row.incomingCell.outputs)) : '';

        const outputDataAttrs = isConflict ? `
            data-base-outputs="${baseOutputs}"
            data-current-outputs="${currentOutputs}"
            data-incoming-outputs="${incomingOutputs}"
        ` : '';

        if (!isConflict) {
            const displayCell = row.currentCell || row.incomingCell || row.baseCell;
            const displayIndex = row.currentCellIndex ?? row.incomingCellIndex ?? row.baseCellIndex;
            return `
<div class="merge-row unified-row">
    <div class="unified-cell-container">
        ${this._renderCellContentForTextual(displayCell, displayIndex, 'current', row, conflict, this._shouldShowCellHeaders())}
    </div>
</div>`;
        }

        const effectiveConflictIndex = row.conflictIndex ?? -1;
        const unmatchedClass = row.isUnmatched ? 'unmatched-row' : '';
        const rowClasses = `merge-row ${conflictClass} ${unmatchedClass}`.trim();

        return `
<div class="${rowClasses}" data-conflict="${effectiveConflictIndex}" ${cellDataAttrs} ${outputDataAttrs} data-is-unmatched="${row.isUnmatched || false}">
    <div class="cell-columns-container">
        <div class="cell-column base-column">
            <div class="column-label">Base</div>
            ${this._renderCellContentForTextual(row.baseCell, row.baseCellIndex, 'base', row, conflict, this._shouldShowCellHeaders())}
        </div>
        <div class="cell-column current-column">
            <div class="column-label">Current</div>
            ${this._renderCellContentForTextual(row.currentCell, row.currentCellIndex, 'current', row, conflict, this._shouldShowCellHeaders())}
        </div>
        <div class="cell-column incoming-column">
            <div class="column-label">Incoming</div>
            ${this._renderCellContentForTextual(row.incomingCell, row.incomingCellIndex, 'incoming', row, conflict, this._shouldShowCellHeaders())}
        </div>
    </div>
    ${effectiveConflictIndex >= 0 ? this._renderResolutionBarForTextual(effectiveConflictIndex, row) : this._renderResolutionBarForDetectedConflict(row)}
</div>`;
    }

    private _renderCellContentForTextual(
        cell: NotebookCell | undefined,
        cellIndex: number | undefined,
        side: 'base' | 'current' | 'incoming',
        row: MergeRow,
        conflict: NotebookConflict,
        showHeaders: boolean = false
    ): string {
        if (!cell) {
            let placeholderText = '(cell deleted)';
            if (row.isUnmatched && row.unmatchedSides && !row.unmatchedSides.includes(side)) {
                placeholderText = '(unmatched cell)';
            }
            return `<div class="cell-placeholder cell-deleted">
                <span class="placeholder-text">${placeholderText}</span>
            </div>`;
        }

        const cellType = cell.cell_type;
        const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;

        let contentHtml: string;
        if (row.type === 'conflict' && cellType !== 'markdown') {
            const compareSource = side === 'current'
                ? (row.incomingCell ? (Array.isArray(row.incomingCell.source) ? row.incomingCell.source.join('') : row.incomingCell.source) : '')
                : side === 'incoming'
                    ? (row.currentCell ? (Array.isArray(row.currentCell.source) ? row.currentCell.source.join('') : row.currentCell.source) : '')
                    : (row.currentCell ? (Array.isArray(row.currentCell.source) ? row.currentCell.source.join('') : row.currentCell.source) : '');
            contentHtml = this._renderDiffContent(source, compareSource, side);
        } else if (cellType === 'markdown') {
            contentHtml = this._renderMarkdown(source);
        } else {
            contentHtml = `<pre class="code-content">${escapeHtml(source)}</pre>`;
        }

        let outputsHtml = '';
        const hideNonConflict = this._conflict?.hideNonConflictOutputs ?? true;
        if (cellType === 'code' && cell.outputs && cell.outputs.length > 0) {
            if (row.type === 'conflict' || !hideNonConflict) {
                outputsHtml = this._renderOutputs(cell.outputs);
            }
        }

        const executionCount = cell.execution_count !== null && cell.execution_count !== undefined
            ? `[${cell.execution_count}]` : '[ ]';

        const headerHtml = showHeaders ? `
    <div class="cell-header">
        <span class="cell-type-badge ${cellType}">${cellType}</span>
        ${cellType === 'code' ? `<span class="execution-count">${executionCount}</span>` : ''}
        <span class="cell-index">${cellIndex !== undefined ? `Cell ${cellIndex + 1}` : ''}</span>
    </div>` : '';

        return `
<div class="notebook-cell ${cellType}-cell ${row.type === 'conflict' ? 'has-conflict' : ''}">
    ${headerHtml}
    <div class="cell-content">
        ${contentHtml}
    </div>
    ${outputsHtml}
</div>`;
    }

    private _renderResolutionBarForTextual(conflictIndex: number, row: MergeRow): string {
        return `
<div class="resolution-bar-row" data-conflict="${conflictIndex}">
    <div class="resolution-buttons">
        ${row.baseCell ? '<button class="btn-resolve btn-base" onclick="selectResolution(' + conflictIndex + ', \'base\')">Use Base</button>' : ''}
        <button class="btn-resolve btn-current" onclick="selectResolution(${conflictIndex}, 'current')">Use Current</button>
        <button class="btn-resolve btn-incoming" onclick="selectResolution(${conflictIndex}, 'incoming')">Use Incoming</button>
        <button class="btn-resolve btn-both" onclick="selectResolution(${conflictIndex}, 'both')">Use Both</button>
    </div>
</div>`;
    }

    private _renderResolutionBarForDetectedConflict(row: MergeRow): string {
        const conflictId = `detected-${row.currentCellIndex ?? 'x'}-${row.incomingCellIndex ?? 'x'}`;
        return `
<div class="resolution-bar-row" data-conflict="${conflictId}">
    <div class="resolution-buttons">
        ${row.baseCell ? '<button class="btn-resolve btn-base" onclick="selectResolution(\'' + conflictId + '\', \'base\')">Use Base</button>' : ''}
        <button class="btn-resolve btn-current" onclick="selectResolution('${conflictId}', 'current')">Use Current</button>
        <button class="btn-resolve btn-incoming" onclick="selectResolution('${conflictId}', 'incoming')">Use Incoming</button>
    </div>
</div>`;
    }

    private _renderMergeRow(row: MergeRow, conflict: NotebookSemanticConflict): string {
        const isConflict = row.type === 'conflict';
        const conflictClass = isConflict ? 'conflict-row' : '';
        const conflictAttr = row.conflictIndex !== undefined ? `data-conflict="${row.conflictIndex}"` : '';

        const baseSource = row.baseCell ?
            (Array.isArray(row.baseCell.source) ? row.baseCell.source.join('') : row.baseCell.source) : '';
        const currentSource = row.currentCell ?
            (Array.isArray(row.currentCell.source) ? row.currentCell.source.join('') : row.currentCell.source) : '';
        const incomingSource = row.incomingCell ?
            (Array.isArray(row.incomingCell.source) ? row.incomingCell.source.join('') : row.incomingCell.source) : '';

        const cellDataAttrs = isConflict ? `
            data-base-source="${encodeURIComponent(baseSource)}"
            data-current-source="${encodeURIComponent(currentSource)}"
            data-incoming-source="${encodeURIComponent(incomingSource)}"
            data-cell-type="${row.currentCell?.cell_type || row.incomingCell?.cell_type || row.baseCell?.cell_type || 'code'}"
            data-has-base="${row.baseCell ? 'true' : 'false'}"
            data-has-current="${row.currentCell ? 'true' : 'false'}"
            data-has-incoming="${row.incomingCell ? 'true' : 'false'}"
        ` : '';

        const baseOutputs = row.baseCell?.outputs ? encodeURIComponent(JSON.stringify(row.baseCell.outputs)) : '';
        const currentOutputs = row.currentCell?.outputs ? encodeURIComponent(JSON.stringify(row.currentCell.outputs)) : '';
        const incomingOutputs = row.incomingCell?.outputs ? encodeURIComponent(JSON.stringify(row.incomingCell.outputs)) : '';

        const outputDataAttrs = isConflict ? `
            data-base-outputs="${baseOutputs}"
            data-current-outputs="${currentOutputs}"
            data-incoming-outputs="${incomingOutputs}"
        ` : '';

        if (!isConflict) {
            const cell = row.currentCell || row.baseCell || row.incomingCell;
            const cellIndex = row.currentCellIndex ?? row.baseCellIndex ?? row.incomingCellIndex;
            return `
<div class="merge-row unified-row">
    <div class="unified-cell-container">
        ${this._renderCellContent(cell, cellIndex, 'current', row, conflict, this._shouldShowCellHeaders())}
    </div>
</div>`;
        }

        const unmatchedClass = row.isUnmatched ? 'unmatched-row' : '';
        const rowClasses = `merge-row ${conflictClass} ${unmatchedClass}`.trim();

        return `
<div class="${rowClasses}" ${conflictAttr} ${cellDataAttrs} ${outputDataAttrs} data-is-unmatched="${row.isUnmatched || false}">
    <div class="cell-columns-container">
        <div class="cell-column base-column">
            <div class="column-label">Base</div>
            ${this._renderCellContent(row.baseCell, row.baseCellIndex, 'base', row, conflict, this._shouldShowCellHeaders())}
        </div>
        <div class="cell-column current-column">
            <div class="column-label">Current</div>
            ${this._renderCellContent(row.currentCell, row.currentCellIndex, 'current', row, conflict, this._shouldShowCellHeaders())}
        </div>
        <div class="cell-column incoming-column">
            <div class="column-label">Incoming</div>
            ${this._renderCellContent(row.incomingCell, row.incomingCellIndex, 'incoming', row, conflict, this._shouldShowCellHeaders())}
        </div>
    </div>
    ${row.conflictIndex !== undefined ? this._renderResolutionBar(row.conflictIndex, row) : ''}
</div>`;
    }

    private _renderCellContent(
        cell: NotebookCell | undefined,
        cellIndex: number | undefined,
        side: 'base' | 'current' | 'incoming',
        row: MergeRow,
        conflict: NotebookSemanticConflict,
        showHeaders: boolean = false
    ): string {
        if (!cell) {
            if (row.type === 'conflict' || row.isUnmatched) {
                let placeholderText = '(cell deleted)';
                if (row.isUnmatched && row.unmatchedSides && !row.unmatchedSides.includes(side)) {
                    placeholderText = '(unmatched cell)';
                }
                return `<div class="cell-placeholder cell-deleted">
                    <span class="placeholder-text">${placeholderText}</span>
                </div>`;
            }
            return '<div class="cell-placeholder"></div>';
        }

        const cellType = cell.cell_type;
        const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;

        let contentHtml: string;
        if (row.type === 'conflict' && cellType !== 'markdown') {
            const compareCell = side === 'current' ? row.incomingCell :
                side === 'incoming' ? row.currentCell :
                    (row.currentCell || row.incomingCell);
            const compareSource = compareCell ?
                (Array.isArray(compareCell.source) ? compareCell.source.join('') : compareCell.source) : '';

            contentHtml = this._renderDiffContent(source, compareSource, side);
        } else if (cellType === 'markdown') {
            contentHtml = this._renderMarkdown(source);
        } else {
            contentHtml = `<pre class="code-content">${escapeHtml(source)}</pre>`;
        }

        let outputsHtml = '';
        const hideNonConflict = this._conflict?.hideNonConflictOutputs ?? true;
        if (cellType === 'code' && cell.outputs && cell.outputs.length > 0) {
            const shouldShowOutputs = row.type === 'conflict' || !hideNonConflict;
            if (shouldShowOutputs) {
                outputsHtml = this._renderOutputs(cell.outputs);
            }
        }

        const executionCount = cell.execution_count !== null && cell.execution_count !== undefined
            ? `[${cell.execution_count}]` : '[ ]';

        const headerHtml = showHeaders ? `
    <div class="cell-header">
        <span class="cell-type-badge ${cellType}">${cellType}</span>
        ${cellType === 'code' ? `<span class="execution-count">${executionCount}</span>` : ''}
        <span class="cell-index">${cellIndex !== undefined ? `Cell ${cellIndex + 1}` : ''}</span>
    </div>` : '';

        return `
<div class="notebook-cell ${cellType}-cell ${row.type === 'conflict' ? 'has-conflict' : ''}">
    ${headerHtml}
    <div class="cell-content">
        ${contentHtml}
    </div>
    ${outputsHtml}
</div>`;
    }

    private _renderMarkdown(source: string): string {
        // For web version, we use the client-side markdown-it renderer
        // The data-markdown attribute will be processed by JavaScript on the client
        const encodedSource = encodeURIComponent(source);
        return `<div class="markdown-content" data-markdown="${encodedSource}"></div>`;
    }

    private _renderOutputs(outputs: unknown[]): string {
        let html = '<div class="cell-outputs">';

        for (const output of outputs as Array<{
            output_type: string;
            text?: string | string[];
            name?: string;
            data?: Record<string, unknown>;
            traceback?: string[];
        }>) {
            if (output.output_type === 'stream') {
                const text = Array.isArray(output.text) ? output.text.join('') : (output.text || '');
                const streamClass = output.name === 'stderr' ? 'stderr' : 'stdout';
                html += `<pre class="output-stream ${streamClass}">${escapeHtml(text)}</pre>`;
            } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
                if (output.data) {
                    if (output.data['text/html']) {
                        html += `<div class="output-html">[HTML Output]</div>`;
                    } else if (output.data['image/png']) {
                        html += `<img class="output-image" src="data:image/png;base64,${output.data['image/png']}" />`;
                    } else if (output.data['text/plain']) {
                        const text = Array.isArray(output.data['text/plain'])
                            ? (output.data['text/plain'] as string[]).join('')
                            : output.data['text/plain'] as string;
                        html += `<pre class="output-text">${escapeHtml(text)}</pre>`;
                    }
                }
            } else if (output.output_type === 'error') {
                const traceback = output.traceback ? output.traceback.join('\n') : '';
                html += `<pre class="output-error">${escapeHtml(traceback)}</pre>`;
            }
        }

        html += '</div>';
        return html;
    }

    private _renderResolutionBar(conflictIndex: number, row: MergeRow): string {
        return `
<div class="resolution-bar-row" data-conflict="${conflictIndex}">
    <div class="resolution-buttons">
        <button class="btn-resolve btn-base" onclick="selectResolution(${conflictIndex}, 'base')">Use Base</button>
        <button class="btn-resolve btn-current" onclick="selectResolution(${conflictIndex}, 'current')">Use Current</button>
        <button class="btn-resolve btn-incoming" onclick="selectResolution(${conflictIndex}, 'incoming')">Use Incoming</button>
    </div>
</div>`;
    }

    private _renderTextualConflictRow(conflict: CellConflict, index: number): string {
        const hascurrent = conflict.currentContent.trim().length > 0;
        const hasincoming = conflict.incomingContent.trim().length > 0;

        const cellDataAttrs = `
            data-base-source=""
            data-current-source="${encodeURIComponent(conflict.currentContent)}"
            data-incoming-source="${encodeURIComponent(conflict.incomingContent)}"
            data-cell-type="${conflict.cellType || 'code'}"
            data-has-base="false"
            data-has-current="${hascurrent}"
            data-has-incoming="${hasincoming}"
        `;

        return `
<div class="merge-row conflict-row" data-conflict="${index}" ${cellDataAttrs}>
    <div class="cell-columns-container">
        <div class="cell-column base-column">
            <div class="column-label">Base</div>
            <div class="cell-placeholder">
                <span class="placeholder-text">(no base version)</span>
            </div>
        </div>
        <div class="cell-column current-column">
            <div class="column-label">Current</div>
            ${hascurrent ? `
            <div class="notebook-cell code-cell has-conflict">
                <div class="cell-content">
                    ${this._renderDiffContent(conflict.currentContent, conflict.incomingContent, 'current')}
                </div>
            </div>` : `<div class="cell-placeholder"><span class="placeholder-text">(not present)</span></div>`}
        </div>
        <div class="cell-column incoming-column">
            <div class="column-label">Incoming</div>
            ${hasincoming ? `
            <div class="notebook-cell code-cell has-conflict">
                <div class="cell-content">
                    ${this._renderDiffContent(conflict.incomingContent, conflict.currentContent, 'incoming')}
                </div>
            </div>` : `<div class="cell-placeholder"><span class="placeholder-text">(not present)</span></div>`}
        </div>
    </div>
    <div class="resolution-bar-row" data-conflict="${index}">
        <div class="resolution-buttons">
            <button class="btn-resolve btn-current" onclick="selectResolution(${index}, 'current')">Use Current</button>
            <button class="btn-resolve btn-incoming" onclick="selectResolution(${index}, 'incoming')">Use Incoming</button>
            <button class="btn-resolve btn-both" onclick="selectResolution(${index}, 'both')">Use Both</button>
        </div>
    </div>
</div>`;
    }

    private _renderMetadataConflictRow(
        conflict: { field: string; currentContent: string; incomingContent: string },
        index: number
    ): string {
        const cellDataAttrs = `
            data-base-source=""
            data-current-source="${encodeURIComponent(conflict.currentContent)}"
            data-incoming-source="${encodeURIComponent(conflict.incomingContent)}"
            data-cell-type="metadata"
            data-has-base="false"
            data-has-current="true"
            data-has-incoming="true"
        `;

        return `
<div class="merge-row conflict-row metadata-conflict" data-conflict="${index}" ${cellDataAttrs}>
    <div class="cell-columns-container">
        <div class="cell-column base-column">
            <div class="column-label">Base</div>
            <div class="cell-placeholder">
                <span class="placeholder-text">Metadata: ${escapeHtml(conflict.field)}</span>
            </div>
        </div>
        <div class="cell-column current-column">
            <div class="column-label">Current</div>
            <div class="metadata-cell">
                <pre class="code-content">${escapeHtml(conflict.currentContent)}</pre>
            </div>
        </div>
        <div class="cell-column incoming-column">
            <div class="column-label">Incoming</div>
            <div class="metadata-cell">
                <pre class="code-content">${escapeHtml(conflict.incomingContent)}</pre>
            </div>
        </div>
    </div>
    <div class="resolution-bar-row" data-conflict="${index}">
        <div class="resolution-buttons">
            <button class="btn-resolve btn-current" onclick="selectResolution(${index}, 'current')">Use Current</button>
            <button class="btn-resolve btn-incoming" onclick="selectResolution(${index}, 'incoming')">Use Incoming</button>
        </div>
    </div>
</div>`;
    }

    private _renderDiffContent(sourceText: string, compareText: string, side: 'base' | 'current' | 'incoming'): string {
        if (!compareText || sourceText === compareText) {
            return `<pre class="code-content">${escapeHtml(sourceText)}</pre>`;
        }

        const diff = computeLineDiff(compareText, sourceText);
        const lines = diff.right;

        let html = '<div class="diff-content">';
        for (const line of lines) {
            const cssClass = this._getDiffLineClass(line, side);

            if (line.content === '' && line.type === 'unchanged') {
                html += `<div class="diff-line diff-line-empty">&nbsp;</div>`;
                continue;
            }
            
            if (line.inlineChanges && line.inlineChanges.length > 0) {
                const content = line.inlineChanges.map(change => {
                    const cls = this._getInlineChangeClass(change.type, side);
                    return `<span class="${cls}">${escapeHtml(change.text)}</span>`;
                }).join('');
                html += `<div class="diff-line ${cssClass}">${content || '&nbsp;'}</div>`;
            } else {
                html += `<div class="diff-line ${cssClass}">${escapeHtml(line.content) || '&nbsp;'}</div>`;
            }
        }
        html += '</div>';
        return html;
    }

    private _getDiffLineClass(line: DiffLine, side: 'base' | 'current' | 'incoming'): string {
        switch (line.type) {
            case 'unchanged': return 'diff-line-unchanged';
            case 'added': return 'diff-line-added';
            case 'removed': return 'diff-line-removed';
            case 'modified': return side === 'base' ? 'diff-line-modified-old' : 'diff-line-modified-new';
            default: return '';
        }
    }

    private _getInlineChangeClass(type: 'unchanged' | 'added' | 'removed', side: 'base' | 'current' | 'incoming'): string {
        switch (type) {
            case 'unchanged': return 'diff-inline-unchanged';
            case 'added': return 'diff-inline-added';
            case 'removed': return 'diff-inline-removed';
            default: return '';
        }
    }

    private _wrapInFullHtml(
        filePath: string,
        contentHtml: string,
        conflictType: 'textual' | 'semantic',
        totalConflicts: number,
        currentBranch?: string,
        incomingBranch?: string,
        autoResolveResult?: AutoResolveResult
    ): string {
        const fileName = filePath.split('/').pop() || filePath;
        const sessionId = this._sessionId || '';

        // The main difference from the VSCode webview version is:
        // 1. No acquireVsCodeApi() - we use WebSocket instead
        // 2. WebSocket connection setup for communication
        // 3. Window close behavior

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MergeNB: ${escapeHtml(fileName)}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/markdown-it-texmath@1.0.0/texmath.min.js"></script>
    <style>
${this._getStyles()}
    </style>
</head>
<body>
    <div class="merge-container">
        ${contentHtml}
    </div>
    
    <div class="bottom-actions">
        <div class="action-left">
            <div class="progress-info">
                <span class="progress-count" id="progress-count">0 / ${totalConflicts}</span> conflicts resolved
            </div>
            <div class="error-message" id="error-message" style="display: none;"></div>
        </div>
        <div class="action-center">
            <button class="btn btn-accept-all" onclick="acceptAllCurrent()">Accept All Current</button>
            <button class="btn btn-accept-all" onclick="acceptAllIncoming()">Accept All Incoming</button>
        </div>
        <div class="action-right">
            <button class="btn btn-secondary" onclick="cancel()">Cancel</button>
            <button class="btn btn-primary" id="apply-btn" onclick="applyResolutions()">Apply & Save</button>
        </div>
    </div>

    <script>
${this._getClientScript(sessionId, conflictType, totalConflicts)}
    </script>
</body>
</html>`;
    }

    private _getStyles(): string {
        // Return the CSS styles - same as the webview version but with browser-compatible values
        return `
        :root {
            --vscode-bg: #1e1e1e;
            --vscode-fg: #d4d4d4;
            --border-color: #3c3c3c;
            --cell-bg: #1e1e1e;
            --header-bg: #252526;
            --current-accent: #22863a;
            --incoming-accent: #0366d6;
            --base-accent: #6a737d;
            --conflict-bg: rgba(255, 0, 0, 0.05);
            --button-bg: #0e639c;
            --button-fg: #ffffff;
            --button-hover-bg: #1177bb;
            --button-secondary-bg: #3c3c3c;
            --button-secondary-fg: #cccccc;
            --input-bg: #3c3c3c;
            --input-fg: #cccccc;
            --focus-border: #007fd4;
            --text-link: #3794ff;
            --description-fg: #858585;
            --error-fg: #f14c4c;
            --code-block-bg: #2d2d2d;
            --selection-bg: #264f78;
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: var(--vscode-bg);
            color: var(--vscode-fg);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
        }
        
        .bottom-actions {
            position: sticky;
            bottom: 0;
            left: 0;
            right: 0;
            background: var(--vscode-bg);
            border-top: 1px solid var(--border-color);
            padding: 12px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            z-index: 1000;
            box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.3);
        }
        
        .action-left {
            display: flex;
            align-items: center;
            gap: 12px;
            flex: 1;
        }
        
        .action-center {
            display: flex;
            gap: 8px;
        }
        
        .action-right {
            display: flex;
            gap: 8px;
        }
        
        .btn-accept-all {
            padding: 6px 12px;
            font-size: 12px;
            border-radius: 4px;
            cursor: pointer;
            border: 1px solid var(--border-color);
            background: var(--button-secondary-bg);
            color: var(--button-secondary-fg);
        }
        
        .btn-accept-all:hover {
            background: #4c4c4c;
        }
        
        .progress-info {
            font-size: 13px;
            color: var(--description-fg);
        }
        
        .progress-count {
            font-weight: 600;
            color: var(--vscode-fg);
        }
        
        .error-message {
            color: var(--error-fg);
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .error-icon {
            font-size: 16px;
        }
        
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 13px;
            font-family: inherit;
            font-weight: 500;
            transition: background-color 0.1s;
        }
        
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .btn-primary {
            background: var(--button-bg);
            color: var(--button-fg);
        }
        
        .btn-primary:hover:not(:disabled) {
            background: var(--button-hover-bg);
        }
        
        .btn-secondary {
            background: var(--button-secondary-bg);
            color: var(--button-secondary-fg);
        }
        
        .btn-secondary:hover:not(:disabled) {
            background: #4c4c4c;
        }
        
        .merge-container {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            padding-bottom: 16px;
        }
        
        .merge-row {
            display: flex;
            flex-direction: column;
            border-bottom: 1px solid var(--border-color);
            position: relative;
        }
        
        .merge-row.conflict-row {
            background: var(--conflict-bg);
            border-left: 4px solid #e74c3c;
            margin: 8px 0;
            border-radius: 4px;
        }
        
        .merge-row.unmatched-row {
            background: rgba(255, 193, 7, 0.08);
            border-left: 4px solid #ffc107;
            margin: 8px 0;
            border-radius: 4px;
        }
        
        .merge-row.unmatched-row .column-label::after {
            content: ' (unmatched)';
            font-size: 10px;
            opacity: 0.7;
        }
        
        .merge-row.conflict-row.unmatched-row {
            border-left-color: #ff9800;
            background: rgba(255, 152, 0, 0.08);
        }
        
        .merge-row.unified-row {
            background: transparent;
            border-bottom: none;
        }
        
        .unified-cell-container {
            padding: 4px 16px;
        }
        
        .unified-cell-container .notebook-cell {
            background: transparent;
            border: none;
        }
        
        .cell-columns-container {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
        }
        
        .cell-column {
            border-right: 1px solid var(--border-color);
            min-height: 60px;
            position: relative;
        }
        
        .cell-column:last-child { border-right: none; }
        
        .cell-column.base-column { 
            background: rgba(106, 115, 125, 0.03); 
        }
        .cell-column.current-column { 
            background: rgba(34, 134, 58, 0.03); 
        }
        .cell-column.incoming-column { 
            background: rgba(3, 102, 214, 0.03); 
        }
        
        .column-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 4px 8px;
            color: var(--description-fg);
            border-bottom: 1px solid var(--border-color);
            background: var(--header-bg);
        }
        
        .base-column .column-label {
            color: var(--base-accent);
        }
        
        .current-column .column-label {
            color: var(--current-accent);
        }
        
        .incoming-column .column-label {
            color: var(--incoming-accent);
        }
        
        .notebook-cell {
            padding: 8px;
        }
        
        .cell-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            font-size: 12px;
        }
        
        .cell-type-badge {
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 500;
        }
        
        .cell-type-badge.code {
            background: rgba(3, 102, 214, 0.15);
            color: #0366d6;
        }
        
        .cell-type-badge.markdown {
            background: rgba(111, 66, 193, 0.15);
            color: #6f42c1;
        }
        
        .execution-count {
            color: var(--description-fg);
            font-family: 'SF Mono', Monaco, Consolas, monospace;
        }
        
        .cell-index {
            color: var(--description-fg);
            margin-left: auto;
        }
        
        .cell-content {
            background: var(--code-block-bg);
            border-radius: 4px;
            overflow: hidden;
            padding: 8px;
        }
        
        .code-content, .diff-content {
            font-family: 'SF Mono', Monaco, Consolas, 'Liberation Mono', monospace;
            font-size: 13px;
            line-height: 1.5;
            padding: 8px 12px;
            margin: 0;
            white-space: pre-wrap;
            word-break: break-word;
            overflow-x: auto;
        }
        
        .markdown-content {
            padding: 12px 12px 12px 20px;
            line-height: 1.6;
        }
        
        .markdown-content h1, .markdown-content h2, .markdown-content h3,
        .markdown-content h4, .markdown-content h5, .markdown-content h6 {
            margin: 0.5em 0;
        }
        
        .markdown-content h4 { font-size: 1.1em; }
        .markdown-content h5 { font-size: 1em; }
        .markdown-content h6 { font-size: 0.9em; color: var(--description-fg); }
        
        .markdown-content hr {
            border: none;
            border-top: 1px solid var(--border-color);
            margin: 1em 0;
        }
        
        .markdown-content img {
            max-width: 100%;
            height: auto;
        }
        
        .markdown-content a {
            color: var(--text-link);
        }
        
        .markdown-content a:hover {
            text-decoration: underline;
        }
        
        .markdown-content table {
            border-collapse: collapse;
            margin: 1em 0;
            width: auto;
        }

        .markdown-content th,
        .markdown-content td {
            border: 1px solid var(--border-color);
            padding: 8px 12px;
            text-align: left;
        }

        .markdown-content th {
            background: var(--selection-bg);
            font-weight: bold;
        }

        .markdown-content tr:nth-child(even) {
            background: rgba(128, 128, 128, 0.05);
        }
        
        .markdown-content pre {
            background: var(--code-block-bg);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
        }
        
        .markdown-content pre code {
            background: none;
            padding: 0;
        }
        
        .markdown-content code {
            background: var(--code-block-bg);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: 'SF Mono', Monaco, Consolas, monospace;
        }
        
        .diff-line {
            padding: 0 12px;
            min-height: 1.5em;
        }
        
        .diff-line-unchanged { }
        .diff-line-added { background: rgba(0, 255, 0, 0.15); }
        .diff-line-removed { background: rgba(255, 0, 0, 0.15); }
        .diff-line-modified-old { background: rgba(255, 0, 0, 0.1); }
        .diff-line-modified-new { background: rgba(0, 255, 0, 0.1); }
        .diff-line-empty { background: rgba(128, 128, 128, 0.05); }
        
        .diff-inline-added { background: rgba(0, 255, 0, 0.3); }
        .diff-inline-removed { background: rgba(255, 0, 0, 0.3); }
        
        .cell-outputs {
            margin-top: 8px;
            border-top: 1px dashed var(--border-color);
            padding-top: 8px;
        }
        
        .output-stream, .output-text {
            font-family: 'SF Mono', Monaco, Consolas, monospace;
            font-size: 12px;
            padding: 8px;
            background: var(--code-block-bg);
            border-radius: 4px;
            margin: 4px 0;
            white-space: pre-wrap;
            max-height: 200px;
            overflow-y: auto;
        }
        
        .output-stream.stderr {
            color: #d73a49;
        }
        
        .output-error {
            font-family: 'SF Mono', Monaco, Consolas, monospace;
            font-size: 12px;
            padding: 8px;
            background: rgba(255, 0, 0, 0.1);
            border-radius: 4px;
            color: #d73a49;
            white-space: pre-wrap;
        }
        
        .output-image {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
        }
        
        .output-html {
            padding: 8px;
            background: var(--code-block-bg);
            border-radius: 4px;
            font-style: italic;
            color: var(--description-fg);
        }
        
        .cell-placeholder {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 60px;
            padding: 16px;
        }
        
        .cell-placeholder.cell-deleted {
            background: rgba(128, 128, 128, 0.08);
            border: 1px dashed var(--border-color);
            border-radius: 4px;
            margin: 8px;
        }
        
        .placeholder-text {
            color: var(--description-fg);
            font-style: italic;
            font-size: 13px;
        }
        
        .cell-deleted .placeholder-text {
            color: #cca700;
        }
        
        .resolution-bar-row {
            display: flex;
            justify-content: center;
            padding: 8px;
            background: var(--vscode-bg);
            border-top: 1px solid var(--border-color);
        }
        
        .resolution-buttons {
            display: flex;
            justify-content: center;
            gap: 12px;
        }
        
        .btn-resolve {
            padding: 6px 16px;
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            opacity: 0.9;
            transition: opacity 0.2s, transform 0.1s;
            min-width: 100px;
        }
        
        .btn-resolve:hover {
            opacity: 1;
            transform: translateY(-1px);
        }
        
        .btn-resolve.btn-base {
            background: var(--base-accent);
            color: white;
        }
        
        .btn-resolve.btn-current {
            background: var(--current-accent);
            color: white;
        }
        
        .btn-resolve.btn-incoming {
            background: var(--incoming-accent);
            color: white;
        }
        
        .btn-resolve.btn-both {
            background: var(--button-secondary-bg);
            color: var(--button-secondary-fg);
        }
        
        .btn-resolve.selected {
            outline: 3px solid var(--focus-border);
            opacity: 1;
        }
        
        .metadata-cell {
            padding: 12px;
        }
        
        .metadata-conflict .cell-placeholder {
            font-weight: 500;
        }
        
        .result-editor-container {
            grid-column: 1 / -1;
            padding: 16px;
            border-top: 2px solid var(--focus-border);
            background: var(--vscode-bg);
        }
        
        .result-editor-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 12px;
        }
        
        .result-editor-header .badge {
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }
        
        .result-editor-header .badge.base {
            background: var(--base-accent);
            color: white;
        }
        
        .result-editor-header .badge.current {
            background: var(--current-accent);
            color: white;
        }
        
        .result-editor-header .badge.incoming {
            background: var(--incoming-accent);
            color: white;
        }
        
        .result-editor-header .edit-hint {
            color: var(--description-fg);
            font-size: 12px;
            font-style: italic;
        }
        
        .result-editor-wrapper {
            border: 1px solid var(--border-color);
            border-radius: 4px;
            overflow: hidden;
        }
        
        .result-editor-wrapper.deleted-cell-editor {
            background: var(--input-bg);
            opacity: 0.8;
        }
        
        .result-editor {
            width: 100%;
            min-height: 120px;
            padding: 12px;
            font-family: 'SF Mono', Monaco, Consolas, monospace;
            font-size: 13px;
            line-height: 1.5;
            background: var(--input-bg);
            color: var(--input-fg);
            border: none;
            resize: vertical;
            outline: none;
        }
        
        .result-editor::placeholder {
            color: var(--description-fg);
            opacity: 0.6;
            font-style: italic;
        }
        
        .result-editor:focus {
            box-shadow: inset 0 0 0 1px var(--focus-border);
        }
        
        .result-outputs {
            padding: 12px;
            background: var(--code-block-bg);
            border-top: 1px dashed var(--border-color);
        }
        
        .result-outputs-label {
            font-size: 11px;
            color: var(--description-fg);
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .result-editor-footer {
            display: flex;
            justify-content: flex-end;
            align-items: center;
            gap: 12px;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
            background: var(--vscode-bg);
            position: relative;
            z-index: 1;
        }
        
        .apply-single {
            padding: 6px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-family: inherit;
            background: var(--button-bg);
            color: var(--button-fg);
        }
        
        .apply-single:hover {
            opacity: 0.9;
        }
        
        .clear-single {
            padding: 6px 12px;
            background: transparent;
            color: var(--description-fg);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .clear-single:hover {
            background: rgba(255, 255, 255, 0.05);
            color: var(--vscode-fg);
        }
        
        .merge-row.is-resolved {
            background: rgba(40, 167, 69, 0.06);
            position: relative;
        }
        
        .merge-row.is-resolved .cell-column {
            display: none;
        }
        
        .merge-row.is-resolved .resolution-bar {
            display: none;
        }
        
        .resolved-result-container {
            grid-column: 1 / -1;
            padding: 16px;
            background: rgba(40, 167, 69, 0.08);
            border-left: 4px solid #28a745;
        }
        
        .resolved-result-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
        }
        
        .resolved-result-header .resolved-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            font-weight: 500;
            color: #28a745;
        }
        
        .resolved-result-header .resolved-badge .checkmark {
            width: 18px;
            height: 18px;
            background: #28a745;
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
        }
        
        .resolved-result-header .btn-change {
            padding: 4px 10px;
            background: transparent;
            color: var(--text-link);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .resolved-result-header .btn-change:hover {
            background: rgba(255, 255, 255, 0.05);
        }
        
        .resolved-result-content {
            background: var(--vscode-bg);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            overflow: hidden;
        }
        
        .resolved-result-content.deleted-cell pre {
            color: var(--description-fg);
            font-style: italic;
            text-align: center;
            padding: 30px 12px;
            opacity: 0.8;
        }
        
        .resolved-result-content pre {
            font-family: 'SF Mono', Monaco, Consolas, monospace;
            font-size: 13px;
            line-height: 1.5;
            padding: 12px;
            margin: 0;
            white-space: pre-wrap;
            word-break: break-word;
        }
        
        .resolved-result-outputs {
            margin-top: 8px;
            border-top: 1px dashed var(--border-color);
            padding-top: 8px;
        }
        
        .resolved-result-outputs .outputs-label {
            font-size: 11px;
            color: var(--description-fg);
            margin-bottom: 6px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        `;
    }

    private _getClientScript(sessionId: string, conflictType: string, totalConflicts: number): string {
        // This is the client-side JavaScript that runs in the browser
        // Key difference from webview: uses WebSocket instead of vscode.postMessage
        return `
        // WebSocket connection for communication with VSCode
        let ws = null;
        const sessionId = '${sessionId}';
        const conflictType = '${conflictType}';
        const totalConflicts = ${totalConflicts};
        const resolutions = {};
        
        // Connect to WebSocket
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = protocol + '//' + window.location.host + '/?session=' + encodeURIComponent(sessionId);
            
            ws = new WebSocket(wsUrl);
            
            ws.onopen = function() {
                console.log('[MergeNB] WebSocket connected');
                ws.send(JSON.stringify({ command: 'ready' }));
            };
            
            ws.onmessage = function(event) {
                try {
                    const message = JSON.parse(event.data);
                    console.log('[MergeNB] Received:', message.type);
                    
                    if (message.type === 'close') {
                        window.close();
                    }
                } catch (e) {
                    console.error('[MergeNB] Error parsing message:', e);
                }
            };
            
            ws.onclose = function() {
                console.log('[MergeNB] WebSocket closed');
            };
            
            ws.onerror = function(error) {
                console.error('[MergeNB] WebSocket error:', error);
            };
        }
        
        // Send message to VSCode extension
        function sendMessage(message) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(message));
            } else {
                console.error('[MergeNB] WebSocket not connected');
            }
        }
        
        // Initialize WebSocket on page load
        connectWebSocket();
        
        // Render outputs from JSON data
        function renderOutputsFromData(outputsJson) {
            if (!outputsJson) return '';
            
            try {
                const outputs = JSON.parse(decodeURIComponent(outputsJson));
                if (!outputs || outputs.length === 0) return '';
                
                let html = '<div class="result-outputs"><div class="result-outputs-label">Output (read-only)</div>';
                
                for (const output of outputs) {
                    if (output.output_type === 'stream') {
                        const text = Array.isArray(output.text) ? output.text.join('') : (output.text || '');
                        const streamClass = output.name === 'stderr' ? 'stderr' : '';
                        html += '<div class="output-stream ' + streamClass + '">' + escapeHtmlInJs(text) + '</div>';
                    } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
                        if (output.data) {
                            if (output.data['image/png']) {
                                html += '<img class="output-image" src="data:image/png;base64,' + output.data['image/png'] + '" />';
                            } else if (output.data['text/html']) {
                                const textHtml = Array.isArray(output.data['text/html']) 
                                    ? output.data['text/html'].join('') 
                                    : output.data['text/html'];
                                html += '<div class="output-html">' + textHtml + '</div>';
                            } else if (output.data['text/plain']) {
                                const text = Array.isArray(output.data['text/plain']) 
                                    ? output.data['text/plain'].join('') 
                                    : output.data['text/plain'];
                                html += '<div class="output-text">' + escapeHtmlInJs(text) + '</div>';
                            }
                        }
                    } else if (output.output_type === 'error') {
                        const traceback = output.traceback ? output.traceback.join('\\n') : (output.ename + ': ' + output.evalue);
                        html += '<div class="output-error">' + escapeHtmlInJs(traceback) + '</div>';
                    }
                }
                
                html += '</div>';
                return html;
            } catch (e) {
                console.error('Error parsing outputs:', e);
                return '';
            }
        }
        
        function escapeHtmlInJs(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function selectResolution(index, choice) {
            const row = document.querySelector('.merge-row[data-conflict="' + index + '"]');
            if (!row) return;
            
            if (row.classList.contains('is-resolved')) {
                unresolveConflict(index);
            }
            
            const hasAttr = 'data-has-' + choice;
            const hasCell = row.getAttribute(hasAttr) === 'true';
            
            const sourceAttr = 'data-' + choice + '-source';
            const source = decodeURIComponent(row.getAttribute(sourceAttr) || '');
            const cellType = row.getAttribute('data-cell-type') || 'code';
            
            const outputsAttr = 'data-' + choice + '-outputs';
            const outputsJson = row.getAttribute(outputsAttr);
            
            resolutions[index] = { 
                choice: choice, 
                customContent: source,
                originalContent: source,
                originalChoice: choice,
                applied: false,
                isDeleted: !hasCell
            };
            
            document.querySelectorAll('[data-conflict="' + index + '"] .btn-resolve').forEach(function(btn) {
                btn.classList.remove('selected');
            });
            const selectedBtn = document.querySelector('[data-conflict="' + index + '"] .btn-' + choice);
            if (selectedBtn) {
                selectedBtn.classList.add('selected');
            }
            
            let editorContainer = row.querySelector('.result-editor-container');
            
            if (!editorContainer) {
                editorContainer = document.createElement('div');
                editorContainer.className = 'result-editor-container';
                row.appendChild(editorContainer);
            }
            
            const isDeleted = !hasCell;
            const outputsHtml = renderOutputsFromData(outputsJson);
            const editorId = 'editor-' + index;
            
            editorContainer.innerHTML = 
                '<div class="result-editor-header">' +
                    '<span class="badge ' + choice + '">Using ' + (choice === 'current' ? 'CURRENT' : choice === 'incoming' ? 'INCOMING' : choice.toUpperCase()) + '</span>' +
                    '<span class="edit-hint">' + (isDeleted ? 'Cell will be deleted (or add content to restore)' : 'Edit the result below, then click Apply to confirm') + '</span>' +
                '</div>' +
                '<div class="result-editor-wrapper ' + (isDeleted ? 'deleted-cell-editor' : '') + '">' +
                    '<textarea ' +
                        'id="' + editorId + '" ' +
                        'class="result-editor" ' +
                        'data-conflict="' + index + '" ' +
                        'spellcheck="false" ' +
                        'placeholder="' + (isDeleted ? '(cell deleted - add content here to restore it)' : '') + '"' +
                    '>' + escapeHtmlInJs(source) + '</textarea>' +
                '</div>' +
                (isDeleted ? '' : outputsHtml) +
                '<div class="result-editor-footer">' +
                    '<button class="btn clear-single" onclick="clearSelection(' + index + ')">Cancel</button>' +
                    '<button class="btn apply-single" onclick="applySingleResolution(' + index + ')">Apply This Resolution</button>' +
                '</div>';
            
            const editor = document.getElementById(editorId);
            if (editor) {
                editor.style.height = 'auto';
                editor.style.height = Math.max(120, editor.scrollHeight) + 'px';
                
                editor.addEventListener('input', function(e) {
                    resolutions[index].customContent = e.target.value;
                    
                    const hasContent = e.target.value.length > 0;
                    resolutions[index].isDeleted = !hasContent;
                    
                    const hintElement = editorContainer.querySelector('.edit-hint');
                    const wrapperElement = editorContainer.querySelector('.result-editor-wrapper');
                    if (hintElement && wrapperElement) {
                        if (!hasContent) {
                            hintElement.textContent = 'Cell will be deleted (or add content to restore)';
                            wrapperElement.classList.add('deleted-cell-editor');
                            e.target.placeholder = '(cell deleted - add content here to restore it)';
                        } else {
                            hintElement.textContent = 'Edit the result below, then click Apply to confirm';
                            wrapperElement.classList.remove('deleted-cell-editor');
                            e.target.placeholder = '';
                        }
                    }
                    
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.max(120, e.target.scrollHeight) + 'px';
                });
            }
        }
        
        function applySingleResolution(index) {
            const row = document.querySelector('.merge-row[data-conflict="' + index + '"]');
            if (!row || !resolutions[index]) return;
            
            resolutions[index].applied = true;
            row.classList.add('is-resolved');
            
            const editorContainer = row.querySelector('.result-editor-container');
            if (editorContainer) {
                editorContainer.remove();
            }
            
            const resolvedContent = resolutions[index].customContent || '';
            const isDeleted = resolutions[index].isDeleted || false;
            const choice = resolutions[index].choice;
            const outputsAttr = 'data-' + choice + '-outputs';
            const outputsJson = row.getAttribute(outputsAttr);
            
            let resolvedOutputsHtml = '';
            if (outputsJson && !isDeleted) {
                try {
                    const outputs = JSON.parse(decodeURIComponent(outputsJson));
                    if (outputs && outputs.length > 0) {
                        resolvedOutputsHtml = '<div class="resolved-result-outputs"><div class="outputs-label">Output</div>';
                        for (const output of outputs) {
                            if (output.output_type === 'stream') {
                                const text = Array.isArray(output.text) ? output.text.join('') : (output.text || '');
                                const streamClass = output.name === 'stderr' ? 'stderr' : '';
                                resolvedOutputsHtml += '<div class="output-stream ' + streamClass + '">' + escapeHtmlInJs(text) + '</div>';
                            } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
                                if (output.data) {
                                    if (output.data['image/png']) {
                                        resolvedOutputsHtml += '<img class="output-image" src="data:image/png;base64,' + output.data['image/png'] + '" />';
                                    } else if (output.data['text/html']) {
                                        const textHtml = Array.isArray(output.data['text/html']) 
                                            ? output.data['text/html'].join('') 
                                            : output.data['text/html'];
                                        resolvedOutputsHtml += '<div class="output-html">' + textHtml + '</div>';
                                    } else if (output.data['text/plain']) {
                                        const text = Array.isArray(output.data['text/plain']) 
                                            ? output.data['text/plain'].join('') 
                                            : output.data['text/plain'];
                                        resolvedOutputsHtml += '<div class="output-text">' + escapeHtmlInJs(text) + '</div>';
                                    }
                                }
                            } else if (output.output_type === 'error') {
                                const traceback = output.traceback ? output.traceback.join('\\n') : (output.ename + ': ' + output.evalue);
                                resolvedOutputsHtml += '<div class="output-error">' + escapeHtmlInJs(traceback) + '</div>';
                            }
                        }
                        resolvedOutputsHtml += '</div>';
                    }
                } catch (e) {
                    console.error('Error parsing outputs:', e);
                }
            }
            
            const resultContainer = document.createElement('div');
            resultContainer.className = 'resolved-result-container';
            resultContainer.innerHTML = 
                '<div class="resolved-result-header">' +
                    '<div class="resolved-badge">' +
                        '<span class="checkmark">✓</span>' +
                        '<span>Resolved</span>' +
                    '</div>' +
                    '<button class="btn-change" onclick="unresolveConflict(' + index + ')">Change</button>' +
                '</div>' +
                '<div class="resolved-result-content ' + (isDeleted ? 'deleted-cell' : '') + '">' +
                    '<pre>' + (isDeleted ? '(cell deleted)' : escapeHtmlInJs(resolvedContent)) + '</pre>' +
                '</div>' +
                (isDeleted ? '' : resolvedOutputsHtml);
            row.appendChild(resultContainer);
            
            setTimeout(function() {
                row.scrollIntoView({ 
                    behavior: 'smooth', 
                    block: 'center',
                    inline: 'nearest'
                });
            }, 100);
            
            updateProgressIndicator();
        }
        
        function unresolveConflict(index) {
            const row = document.querySelector('.merge-row[data-conflict="' + index + '"]');
            if (!row) return;
            
            row.classList.remove('is-resolved');
            
            const resultContainer = row.querySelector('.resolved-result-container');
            if (resultContainer) {
                resultContainer.remove();
            }
            
            document.querySelectorAll('[data-conflict="' + index + '"] .btn-resolve').forEach(function(btn) {
                btn.classList.remove('selected');
            });
            
            if (resolutions[index]) {
                resolutions[index].applied = false;
            }
            
            updateProgressIndicator();
        }
        
        function clearSelection(index) {
            const row = document.querySelector('.merge-row[data-conflict="' + index + '"]');
            if (!row) return;
            
            const editorContainer = row.querySelector('.result-editor-container');
            if (editorContainer) {
                editorContainer.remove();
            }
            
            document.querySelectorAll('[data-conflict="' + index + '"] .btn-resolve').forEach(function(btn) {
                btn.classList.remove('selected');
            });
            
            delete resolutions[index];
        }
        
        function acceptAllCurrent() {
            for (let i = 0; i < totalConflicts; i++) {
                if (resolutions[i] && resolutions[i].applied) {
                    continue;
                }
                selectResolution(i, 'current');
                applySingleResolution(i);
            }
        }
        
        function acceptAllIncoming() {
            for (let i = 0; i < totalConflicts; i++) {
                if (resolutions[i] && resolutions[i].applied) {
                    continue;
                }
                selectResolution(i, 'incoming');
                applySingleResolution(i);
            }
        }
        
        function updateProgressIndicator() {
            let appliedCount = 0;
            for (const key in resolutions) {
                if (resolutions[key].applied) {
                    appliedCount++;
                }
            }
            
            const progressCount = document.getElementById('progress-count');
            const applyBtn = document.getElementById('apply-btn');
            const errorMessage = document.getElementById('error-message');
            
            if (progressCount) {
                progressCount.textContent = appliedCount + ' / ' + totalConflicts;
            }
            
            if (applyBtn) {
                if (appliedCount === 0) {
                    applyBtn.disabled = true;
                    if (errorMessage) {
                        errorMessage.innerHTML = '<span class="error-icon">⚠</span> Please resolve at least one conflict';
                        errorMessage.style.display = 'flex';
                    }
                } else if (appliedCount < totalConflicts) {
                    applyBtn.disabled = false;
                    if (errorMessage) {
                        errorMessage.innerHTML = '<span class="error-icon">⚠</span> ' + (totalConflicts - appliedCount) + ' conflict(s) unresolved - will default to CURRENT';
                        errorMessage.style.display = 'flex';
                    }
                } else {
                    applyBtn.disabled = false;
                    if (errorMessage) {
                        errorMessage.style.display = 'none';
                    }
                }
            }
        }

        function applyResolutions() {
            let appliedCount = 0;
            for (const key in resolutions) {
                if (resolutions[key].applied) {
                    appliedCount++;
                }
            }
            
            const errorMessage = document.getElementById('error-message');
            
            if (appliedCount === 0) {
                if (errorMessage) {
                    errorMessage.innerHTML = '<span class="error-icon">✗</span> No conflicts resolved. Please resolve at least one conflict before applying.';
                    errorMessage.style.display = 'flex';
                }
                return;
            }
            
            if (appliedCount < totalConflicts) {
                const unresolvedCount = totalConflicts - appliedCount;
                let unappliedSelections = 0;
                for (const key in resolutions) {
                    if (!resolutions[key].applied) {
                        unappliedSelections++;
                    }
                }
                
                let message = appliedCount + ' of ' + totalConflicts + ' conflicts resolved.\\n';
                if (unappliedSelections > 0) {
                    message += unappliedSelections + ' selection(s) not yet applied.\\n';
                }
                message += '\\n' + unresolvedCount + ' unresolved conflict(s) will default to CURRENT version.\\n\\nContinue?';
                
                if (!confirm(message)) {
                    return;
                }
                
                for (let i = 0; i < totalConflicts; i++) {
                    if (!resolutions[i] || !resolutions[i].applied) {
                        const row = document.querySelector('.merge-row[data-conflict="' + i + '"]');
                        const currentSource = row ? decodeURIComponent(row.getAttribute('data-current-source') || '') : '';
                        const hascurrent = row ? row.getAttribute('data-has-current') === 'true' : false;
                        resolutions[i] = { choice: 'current', customContent: currentSource, applied: true, isDeleted: !hascurrent };
                    }
                }
            }
            
            try {
                const resolutionArray = [];
                for (const index in resolutions) {
                    resolutionArray.push({
                        index: parseInt(index),
                        choice: resolutions[index].choice,
                        customContent: resolutions[index].customContent
                    });
                }
                
                sendMessage({ 
                    command: 'resolve', 
                    type: conflictType,
                    resolutions: resolutionArray 
                });
            } catch (error) {
                if (errorMessage) {
                    errorMessage.innerHTML = '<span class="error-icon">✗</span> Error applying resolutions: ' + error.message;
                    errorMessage.style.display = 'flex';
                }
                console.error('Error applying resolutions:', error);
            }
        }

        function cancel() {
            sendMessage({ command: 'cancel' });
            window.close();
        }
        
        // Keyboard shortcuts
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.tagName !== 'TEXTAREA') {
                applyResolutions();
            } else if (e.key === 'Escape') {
                cancel();
            }
        });
        
        // Initialize progress indicator on page load
        updateProgressIndicator();
        
        // Render markdown content using markdown-it library
        if (typeof markdownit !== 'undefined') {
            const md = markdownit({
                html: true,
                breaks: true,
                linkify: true,
                typographer: true
            });
            
            if (typeof texmath !== 'undefined' && typeof katex !== 'undefined') {
                md.use(texmath, {
                    engine: katex,
                    delimiters: 'dollars',
                    katexOptions: { macros: { "\\\\RR": "\\\\mathbb{R}" } }
                });
            }
            
            document.querySelectorAll('.markdown-content[data-markdown]').forEach(function(el) {
                const encodedMarkdown = el.getAttribute('data-markdown');
                if (encodedMarkdown) {
                    try {
                        const markdown = decodeURIComponent(encodedMarkdown);
                        el.innerHTML = md.render(markdown);
                    } catch (e) {
                        console.error('Error rendering markdown:', e);
                        el.textContent = decodeURIComponent(encodedMarkdown);
                    }
                }
            });
        }
        `;
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
