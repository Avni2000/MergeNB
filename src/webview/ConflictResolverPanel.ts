/**
 * @file ConflictResolverPanel.ts
 * @description Browser-based 3-way split view for notebook conflict resolution.
 * 
 * Instead of a VSCode webview, this opens the conflict resolver in the user's
 * default web browser. Communication is handled via a local HTTP server.
 * 
 * Uses markdown-it for markdown rendering and KaTeX for LaTeX support.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import { NotebookConflict, CellConflict, NotebookSemanticConflict, SemanticConflict, NotebookCell, ResolutionChoice } from '../types';
import { computeLineDiff, DiffLine } from '../diffUtils';
import { AutoResolveResult } from '../conflictDetector';
import * as logger from '../logger';

/**
 * Unified type for conflicts from both textual and semantic sources
 */
export interface UnifiedConflict {
    filePath: string;
    type: 'textual' | 'semantic';
    textualConflict?: NotebookConflict;
    semanticConflict?: NotebookSemanticConflict;
    /** Result of auto-resolution, if any conflicts were auto-resolved */
    autoResolveResult?: AutoResolveResult;
    /** Whether to hide outputs for non-conflicted cells */
    hideNonConflictOutputs?: boolean;
}

/**
 * Resolution result from the panel
 */
export interface UnifiedResolution {
    type: 'textual' | 'semantic';
    // For textual conflicts
    textualResolutions?: Map<number, { choice: ResolutionChoice; customContent?: string }>;
    // For semantic conflicts
    semanticChoice?: 'current' | 'incoming';
    semanticResolutions?: Map<number, { choice: 'base' | 'current' | 'incoming'; customContent?: string }>;
    // Whether to mark file as resolved with git add
    markAsResolved: boolean;
}

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
 * HTTP server for handling browser-based conflict resolution.
 */
class ConflictResolverServer {
    private server: http.Server | null = null;
    private port: number = 0;
    private pendingResolutions: Map<string, {
        conflict: UnifiedConflict;
        onResolutionComplete: (resolution: UnifiedResolution) => void;
        html: string;
    }> = new Map();

    async start(): Promise<number> {
        if (this.server) {
            return this.port;
        }

        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this.handleRequest(req, res));
            
            this.server.listen(0, '127.0.0.1', () => {
                const address = this.server!.address();
                if (address && typeof address !== 'string') {
                    this.port = address.port;
                    logger.info(`Conflict resolver server started on port ${this.port}`);
                    resolve(this.port);
                } else {
                    reject(new Error('Failed to get server port'));
                }
            });

            this.server.on('error', (err) => {
                logger.error('Server error:', err);
                reject(err);
            });
        });
    }

    async stop(): Promise<void> {
        if (this.server) {
            return new Promise((resolve) => {
                this.server!.close(() => {
                    this.server = null;
                    this.port = 0;
                    resolve();
                });
            });
        }
    }

    registerConflict(
        sessionId: string,
        conflict: UnifiedConflict,
        html: string,
        onResolutionComplete: (resolution: UnifiedResolution) => void
    ): void {
        this.pendingResolutions.set(sessionId, { conflict, html, onResolutionComplete });
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        const sessionId = url.pathname.slice(1);
        
        if (req.method === 'GET') {
            this.handleGetRequest(sessionId, res);
        } else if (req.method === 'POST') {
            this.handlePostRequest(sessionId, req, res);
        } else {
            res.writeHead(405);
            res.end('Method not allowed');
        }
    }

    private handleGetRequest(sessionId: string, res: http.ServerResponse): void {
        const session = this.pendingResolutions.get(sessionId);
        
        if (!session) {
            res.writeHead(404);
            res.end(`
                <html>
                <head><title>Session Not Found</title></head>
                <body style="font-family: system-ui; padding: 40px; text-align: center;">
                    <h1>Session Not Found</h1>
                    <p>This conflict resolution session has expired or been completed.</p>
                    <p>Please start a new resolution from VS Code.</p>
                </body>
                </html>
            `);
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(session.html);
    }

    private handlePostRequest(sessionId: string, req: http.IncomingMessage, res: http.ServerResponse): void {
        const session = this.pendingResolutions.get(sessionId);
        
        if (!session) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Session not found' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            try {
                const message = JSON.parse(body);
                
                if (message.command === 'resolve') {
                    this.handleResolution(sessionId, session, message, res);
                } else if (message.command === 'cancel') {
                    this.pendingResolutions.delete(sessionId);
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, message: 'Cancelled' }));
                } else {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Unknown command' }));
                }
            } catch (err) {
                logger.error('Error parsing request:', err);
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    }

    private handleResolution(
        sessionId: string,
        session: { conflict: UnifiedConflict; onResolutionComplete: (resolution: UnifiedResolution) => void },
        message: any,
        res: http.ServerResponse
    ): void {
        const { conflict, onResolutionComplete } = session;

        if (conflict.type === 'textual') {
            const resolutions = new Map<number, { choice: ResolutionChoice; customContent?: string }>();
            for (const r of message.resolutions || []) {
                resolutions.set(r.index, { choice: r.choice as ResolutionChoice, customContent: r.customContent });
            }
            onResolutionComplete({
                type: 'textual',
                textualResolutions: resolutions,
                markAsResolved: message.markAsResolved ?? true
            });
        } else if (conflict.type === 'semantic') {
            const resolutions = new Map<number, { choice: 'base' | 'current' | 'incoming'; customContent?: string }>();
            for (const r of message.resolutions || []) {
                resolutions.set(r.index, { choice: r.choice as 'base' | 'current' | 'incoming', customContent: r.customContent });
            }
            onResolutionComplete({
                type: 'semantic',
                semanticChoice: message.semanticChoice,
                semanticResolutions: resolutions,
                markAsResolved: message.markAsResolved ?? true
            });
        }

        this.pendingResolutions.delete(sessionId);
        
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Resolution applied' }));
    }
}

// Singleton server instance
let serverInstance: ConflictResolverServer | null = null;

async function getServer(): Promise<ConflictResolverServer> {
    if (!serverInstance) {
        serverInstance = new ConflictResolverServer();
        await serverInstance.start();
    }
    return serverInstance;
}

/**
 * Unified panel for resolving both textual and semantic notebook conflicts.
 * Opens the conflict resolution UI in the user's default web browser.
 */
export class UnifiedConflictPanel {
    public static currentPanel: UnifiedConflictPanel | undefined;
    private _conflict: UnifiedConflict | undefined;
    private _sessionId: string;

    public static async createOrShow(
        extensionUri: vscode.Uri,
        conflict: UnifiedConflict,
        onResolutionComplete: (resolution: UnifiedResolution) => void
    ): Promise<void> {
        const sessionId = `merge-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        
        const panel = new UnifiedConflictPanel(sessionId, conflict);
        UnifiedConflictPanel.currentPanel = panel;
        
        const html = panel._getHtmlForBrowser();
        
        const server = await getServer();
        const port = await server.start();
        server.registerConflict(sessionId, conflict, html, onResolutionComplete);
        
        const url = vscode.Uri.parse(`http://127.0.0.1:${port}/${sessionId}`);
        await vscode.env.openExternal(url);
        
        vscode.window.showInformationMessage(
            'Conflict resolver opened in your browser. Complete the resolution there and click "Apply & Save".'
        );
    }

    private constructor(sessionId: string, conflict: UnifiedConflict) {
        this._sessionId = sessionId;
        this._conflict = conflict;
    }

    public dispose(): void {
        UnifiedConflictPanel.currentPanel = undefined;
    }

    private _shouldShowCellHeaders(): boolean {
        const config = vscode.workspace.getConfiguration('mergeNB');
        return config.get<boolean>('ui.showCellHeaders', false);
    }

    private _getHtmlForBrowser(): string {
        const conflict = this._conflict;
        if (!conflict) {
            return '<html><body><p>No conflict data.</p></body></html>';
        }

        if (conflict.type === 'textual' && conflict.textualConflict) {
            return this._getTextualConflictHtml(conflict.textualConflict);
        } else if (conflict.type === 'semantic' && conflict.semanticConflict) {
            return this._getSemanticConflictHtml(conflict.semanticConflict);
        }

        return '<html><body><p>Unknown conflict type.</p></body></html>';
    }

    private _buildMergeRows(semanticConflict: NotebookSemanticConflict): MergeRow[] {
        const rows: MergeRow[] = [];
        const conflictMap = new Map<string, { conflict: SemanticConflict; index: number }>();
        
        semanticConflict.semanticConflicts.forEach((c, i) => {
            const key = `${c.baseCellIndex ?? 'x'}-${c.currentCellIndex ?? 'x'}-${c.incomingCellIndex ?? 'x'}`;
            conflictMap.set(key, { conflict: c, index: i });
        });

        for (const mapping of semanticConflict.cellMappings) {
            const baseIdx = mapping.baseIndex;
            const currentIdx = mapping.currentIndex;
            const incomingIdx = mapping.incomingIndex;
            
            const key = `${baseIdx ?? 'x'}-${currentIdx ?? 'x'}-${incomingIdx ?? 'x'}`;
            const conflictInfo = conflictMap.get(key);
            
            let anchorSum = 0;
            let anchorCount = 0;
            if (baseIdx !== undefined) { anchorSum += baseIdx * 1.0; anchorCount += 1.0; }
            if (currentIdx !== undefined) { anchorSum += currentIdx * 1.1; anchorCount += 1.1; }
            if (incomingIdx !== undefined) { anchorSum += incomingIdx * 0.9; anchorCount += 0.9; }
            const anchorPosition = anchorCount > 0 ? anchorSum / anchorCount : 0;
            
            const hasSides: ('base' | 'current' | 'incoming')[] = [];
            if (baseIdx !== undefined) hasSides.push('base');
            if (currentIdx !== undefined) hasSides.push('current');
            if (incomingIdx !== undefined) hasSides.push('incoming');
            const isUnmatched = hasSides.length < 3 && hasSides.length > 0;
            
            rows.push({
                type: conflictInfo ? 'conflict' : 'identical',
                baseCell: baseIdx !== undefined ? semanticConflict.base?.cells[baseIdx] : undefined,
                currentCell: currentIdx !== undefined ? semanticConflict.current?.cells[currentIdx] : undefined,
                incomingCell: incomingIdx !== undefined ? semanticConflict.incoming?.cells[incomingIdx] : undefined,
                baseCellIndex: baseIdx,
                currentCellIndex: currentIdx,
                incomingCellIndex: incomingIdx,
                conflictIndex: conflictInfo?.index,
                conflictType: conflictInfo?.conflict.type,
                isUnmatched,
                unmatchedSides: isUnmatched ? hasSides : undefined,
                anchorPosition
            });
        }

        return this._sortRowsByPosition(rows);
    }

    private _sortRowsByPosition(rows: MergeRow[]): MergeRow[] {
        return rows.sort((a, b) => {
            const posA = a.anchorPosition ?? 0;
            const posB = b.anchorPosition ?? 0;
            if (posA !== posB) return posA - posB;
            
            const currentA = a.currentCellIndex ?? a.baseCellIndex ?? a.incomingCellIndex ?? 0;
            const currentB = b.currentCellIndex ?? b.baseCellIndex ?? b.incomingCellIndex ?? 0;
            return currentA - currentB;
        });
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
            const baseIdx = mapping.baseIndex;
            const currentIdx = mapping.currentIndex;
            const incomingIdx = mapping.incomingIndex;
            
            const baseCell = baseIdx !== undefined ? conflict.base?.cells[baseIdx] : undefined;
            const currentCell = currentIdx !== undefined ? conflict.current?.cells[currentIdx] : undefined;
            const incomingCell = incomingIdx !== undefined ? conflict.incoming?.cells[incomingIdx] : undefined;
            
            let anchorSum = 0;
            let anchorCount = 0;
            if (baseIdx !== undefined) { anchorSum += baseIdx * 1.0; anchorCount += 1.0; }
            if (currentIdx !== undefined) { anchorSum += currentIdx * 1.1; anchorCount += 1.1; }
            if (incomingIdx !== undefined) { anchorSum += incomingIdx * 0.9; anchorCount += 0.9; }
            const anchorPosition = anchorCount > 0 ? anchorSum / anchorCount : 0;
            
            const currentSource = currentCell ? 
                (Array.isArray(currentCell.source) ? currentCell.source.join('') : currentCell.source) : '';
            const incomingSource = incomingCell ? 
                (Array.isArray(incomingCell.source) ? incomingCell.source.join('') : incomingCell.source) : '';
            
            const hasCurrentAndIncoming = currentCell && incomingCell;
            const sourceDiffers = currentSource !== incomingSource;
            const cellMissing = (!currentCell && incomingCell) || (currentCell && !incomingCell);
            const typeDiffers = hasCurrentAndIncoming && currentCell.cell_type !== incomingCell.cell_type;
            
            const isConflict = sourceDiffers || cellMissing || typeDiffers;
            
            const hasSides: ('base' | 'current' | 'incoming')[] = [];
            if (baseCell) hasSides.push('base');
            if (currentCell) hasSides.push('current');
            if (incomingCell) hasSides.push('incoming');
            const isUnmatched = hasSides.length < 3 && hasSides.length > 0;
            
            const row: MergeRow = {
                type: isConflict ? 'conflict' : 'identical',
                baseCell,
                currentCell,
                incomingCell,
                baseCellIndex: baseIdx,
                currentCellIndex: currentIdx,
                incomingCellIndex: incomingIdx,
                conflictIndex: isConflict ? conflictIndex : undefined,
                isUnmatched,
                unmatchedSides: isUnmatched ? hasSides : undefined,
                anchorPosition
            };
            
            if (isConflict) {
                conflictIndex++;
            }
            
            rows.push(row);
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
            const cell = row.currentCell || row.incomingCell || row.baseCell;
            return `
<div class="merge-row unified-row">
    <div class="unified-cell-container">
        ${this._renderCellContentForTextual(cell, row.currentCellIndex ?? row.incomingCellIndex ?? row.baseCellIndex, 'current', row, conflict, this._shouldShowCellHeaders())}
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
            const isDeleted = row.isUnmatched && row.unmatchedSides && !row.unmatchedSides.includes(side);
            return `
<div class="cell-placeholder ${isDeleted ? 'cell-deleted' : ''}">
    <span class="placeholder-text">${isDeleted ? '(deleted in this version)' : '(not present)'}</span>
</div>`;
        }

        const cellType = cell.cell_type;
        const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        
        let contentHtml: string;
        if (row.type === 'conflict' && cellType !== 'markdown') {
            const otherSource = side === 'current' 
                ? (row.incomingCell ? (Array.isArray(row.incomingCell.source) ? row.incomingCell.source.join('') : row.incomingCell.source) : '')
                : (row.currentCell ? (Array.isArray(row.currentCell.source) ? row.currentCell.source.join('') : row.currentCell.source) : '');
            contentHtml = this._renderDiffContent(source, otherSource, side);
        } else if (cellType === 'markdown') {
            contentHtml = this._renderMarkdown(source);
        } else {
            contentHtml = `<pre class="code-content">${escapeHtml(source)}</pre>`;
        }

        let outputsHtml = '';
        const hideNonConflict = this._conflict?.hideNonConflictOutputs ?? true;
        if (cellType === 'code' && cell.outputs && cell.outputs.length > 0) {
            if (!hideNonConflict || row.type === 'conflict') {
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
            const cell = row.currentCell || row.incomingCell || row.baseCell;
            return `
<div class="merge-row unified-row">
    <div class="unified-cell-container">
        ${this._renderCellContent(cell, row.currentCellIndex ?? row.incomingCellIndex ?? row.baseCellIndex, 'current', row, conflict, this._shouldShowCellHeaders())}
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
            const isDeleted = row.isUnmatched && row.unmatchedSides && !row.unmatchedSides.includes(side);
            return `
<div class="cell-placeholder ${isDeleted ? 'cell-deleted' : ''}">
    <span class="placeholder-text">${isDeleted ? '(deleted in this version)' : '(not present)'}</span>
</div>`;
        }

        const cellType = cell.cell_type;
        const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        
        let contentHtml: string;
        if (row.type === 'conflict' && cellType !== 'markdown') {
            const otherSource = side === 'current' 
                ? (row.incomingCell ? (Array.isArray(row.incomingCell.source) ? row.incomingCell.source.join('') : row.incomingCell.source) : '')
                : (row.currentCell ? (Array.isArray(row.currentCell.source) ? row.currentCell.source.join('') : row.currentCell.source) : '');
            contentHtml = this._renderDiffContent(source, otherSource, side);
        } else if (cellType === 'markdown') {
            contentHtml = this._renderMarkdown(source);
        } else {
            contentHtml = `<pre class="code-content">${escapeHtml(source)}</pre>`;
        }

        let outputsHtml = '';
        const hideNonConflict = this._conflict?.hideNonConflictOutputs ?? true;
        if (cellType === 'code' && cell.outputs && cell.outputs.length > 0) {
            if (!hideNonConflict || row.type === 'conflict') {
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
        const encodedSource = encodeURIComponent(source);
        return `<div class="markdown-content" data-markdown="${encodedSource}"></div>`;
    }

    private _renderOutputs(outputs: any[]): string {
        let html = '<div class="cell-outputs">';
        
        for (const output of outputs) {
            if (output.output_type === 'stream') {
                const text = Array.isArray(output.text) ? output.text.join('') : (output.text || '');
                const streamClass = output.name === 'stderr' ? 'stderr' : '';
                html += `<div class="output-stream ${streamClass}">${escapeHtml(text)}</div>`;
            } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
                if (output.data) {
                    if (output.data['image/png']) {
                        html += `<img class="output-image" src="data:image/png;base64,${output.data['image/png']}" />`;
                    } else if (output.data['text/html']) {
                        const textHtml = Array.isArray(output.data['text/html']) 
                            ? output.data['text/html'].join('') 
                            : output.data['text/html'];
                        html += `<div class="output-html">${textHtml}</div>`;
                    } else if (output.data['text/plain']) {
                        const text = Array.isArray(output.data['text/plain']) 
                            ? output.data['text/plain'].join('') 
                            : output.data['text/plain'];
                        html += `<div class="output-text">${escapeHtml(text)}</div>`;
                    }
                }
            } else if (output.output_type === 'error') {
                const traceback = output.traceback ? output.traceback.join('\n') : `${output.ename}: ${output.evalue}`;
                html += `<div class="output-error">${escapeHtml(traceback)}</div>`;
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
                <span class="placeholder-text">(no base version)</span>
            </div>
        </div>
        <div class="cell-column current-column">
            <div class="column-label">Current</div>
            <div class="metadata-cell">
                <div class="cell-content">
                    <pre class="code-content">${escapeHtml(conflict.currentContent)}</pre>
                </div>
            </div>
        </div>
        <div class="cell-column incoming-column">
            <div class="column-label">Incoming</div>
            <div class="metadata-cell">
                <div class="cell-content">
                    <pre class="code-content">${escapeHtml(conflict.incomingContent)}</pre>
                </div>
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
        const diffResult = computeLineDiff(sourceText, compareText);
        // Use left side for 'current'/'base', right side for 'incoming'
        const diffLines = side === 'incoming' ? diffResult.right : diffResult.left;
        
        let html = '<div class="diff-content">';
        for (const line of diffLines) {
            const lineClass = this._getDiffLineClass(line, side);
            
            if (line.inlineChanges && line.inlineChanges.length > 0) {
                let lineHtml = '';
                for (const change of line.inlineChanges) {
                    const changeClass = this._getInlineChangeClass(change.type, side);
                    lineHtml += `<span class="${changeClass}">${escapeHtml(change.text)}</span>`;
                }
                html += `<div class="diff-line ${lineClass}">${lineHtml}</div>`;
            } else {
                html += `<div class="diff-line ${lineClass}">${escapeHtml(line.content)}</div>`;
            }
        }
        html += '</div>';
        
        return html;
    }

    private _getDiffLineClass(line: DiffLine, side: 'base' | 'current' | 'incoming'): string {
        if (line.type === 'unchanged') return 'diff-line-unchanged';
        if (line.type === 'added') return side === 'current' ? 'diff-line-added' : 'diff-line-empty';
        if (line.type === 'removed') return side === 'incoming' ? 'diff-line-removed' : 'diff-line-empty';
        return '';
    }

    private _getInlineChangeClass(type: 'unchanged' | 'added' | 'removed', side: 'base' | 'current' | 'incoming'): string {
        if (type === 'unchanged') return '';
        if (type === 'added') return side === 'current' ? 'diff-inline-added' : '';
        if (type === 'removed') return side === 'incoming' ? 'diff-inline-removed' : '';
        return '';
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

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Merge: ${escapeHtml(fileName)}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/markdown-it-texmath@1.0.0/texmath.min.js"></script>
    <style>
        :root {
            --bg: #1e1e1e;
            --fg: #d4d4d4;
            --border-color: #3c3c3c;
            --cell-bg: #1e1e1e;
            --header-bg: #252526;
            --current-accent: #22863a;
            --incoming-accent: #0366d6;
            --base-accent: #6a737d;
            --conflict-bg: rgba(255, 0, 0, 0.05);
            --button-bg: #0e639c;
            --button-fg: white;
            --button-hover: #1177bb;
            --button-secondary-bg: #3a3d41;
            --button-secondary-fg: #cccccc;
            --input-bg: #3c3c3c;
            --input-fg: #cccccc;
            --focus-border: #007fd4;
            --error-fg: #f48771;
            --success-color: #28a745;
        }
        
        @media (prefers-color-scheme: light) {
            :root {
                --bg: #ffffff;
                --fg: #333333;
                --border-color: #e0e0e0;
                --cell-bg: #ffffff;
                --header-bg: #f5f5f5;
                --conflict-bg: rgba(255, 0, 0, 0.03);
                --button-secondary-bg: #e0e0e0;
                --button-secondary-fg: #333333;
                --input-bg: #ffffff;
                --input-fg: #333333;
            }
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: var(--bg);
            color: var(--fg);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        .header {
            background: var(--header-bg);
            border-bottom: 1px solid var(--border-color);
            padding: 12px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .header-title { font-size: 16px; font-weight: 600; }
        .header-info { font-size: 13px; color: var(--base-accent); }
        
        .bottom-actions {
            position: sticky;
            bottom: 0;
            background: var(--bg);
            border-top: 1px solid var(--border-color);
            padding: 12px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            z-index: 1000;
            box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.2);
        }
        
        .action-left { display: flex; align-items: center; gap: 12px; flex: 1; }
        .action-center { display: flex; gap: 8px; }
        .action-right { display: flex; gap: 8px; }
        
        .btn-accept-all {
            padding: 6px 12px;
            font-size: 12px;
            border-radius: 4px;
            cursor: pointer;
            border: 1px solid var(--border-color);
            background: var(--button-secondary-bg);
            color: var(--button-secondary-fg);
        }
        
        .progress-info { font-size: 13px; color: var(--base-accent); }
        .progress-count { font-weight: 600; color: var(--fg); }
        .error-message { color: var(--error-fg); font-size: 12px; display: flex; align-items: center; gap: 6px; }
        
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
        }
        
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-primary { background: var(--button-bg); color: var(--button-fg); }
        .btn-primary:hover:not(:disabled) { background: var(--button-hover); }
        .btn-secondary { background: var(--button-secondary-bg); color: var(--button-secondary-fg); }
        
        .merge-container { flex: 1; overflow-y: auto; overflow-x: hidden; padding-bottom: 16px; }
        
        .merge-row { display: flex; flex-direction: column; border-bottom: 1px solid var(--border-color); }
        .merge-row.conflict-row { background: var(--conflict-bg); border-left: 4px solid #e74c3c; margin: 8px 0; border-radius: 4px; }
        .merge-row.unmatched-row { background: rgba(255, 193, 7, 0.08); border-left: 4px solid #ffc107; margin: 8px 0; border-radius: 4px; }
        .merge-row.unified-row { background: transparent; border-bottom: none; }
        
        .unified-cell-container { padding: 4px 16px; }
        .cell-columns-container { display: grid; grid-template-columns: 1fr 1fr 1fr; }
        
        .cell-column { border-right: 1px solid var(--border-color); min-height: 60px; }
        .cell-column:last-child { border-right: none; }
        .cell-column.base-column { background: rgba(106, 115, 125, 0.03); }
        .cell-column.current-column { background: rgba(34, 134, 58, 0.03); }
        .cell-column.incoming-column { background: rgba(3, 102, 214, 0.03); }
        
        .column-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            padding: 4px 8px;
            color: var(--base-accent);
            border-bottom: 1px solid var(--border-color);
            background: var(--header-bg);
        }
        
        .base-column .column-label { color: var(--base-accent); }
        .current-column .column-label { color: var(--current-accent); }
        .incoming-column .column-label { color: var(--incoming-accent); }
        
        .notebook-cell { padding: 8px; }
        .cell-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; }
        .cell-type-badge { padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 500; }
        .cell-type-badge.code { background: rgba(3, 102, 214, 0.15); color: #0366d6; }
        .cell-type-badge.markdown { background: rgba(111, 66, 193, 0.15); color: #6f42c1; }
        .execution-count { color: var(--base-accent); font-family: monospace; }
        .cell-index { color: var(--base-accent); margin-left: auto; }
        
        .cell-content { background: var(--cell-bg); border-radius: 4px; overflow: hidden; padding: 8px; border: 1px solid var(--border-color); }
        .code-content, .diff-content { font-family: 'Consolas', 'Monaco', monospace; font-size: 13px; line-height: 1.5; padding: 8px 12px; margin: 0; white-space: pre-wrap; word-break: break-word; }
        .markdown-content { padding: 12px; line-height: 1.6; }
        .markdown-content h1, .markdown-content h2, .markdown-content h3 { margin: 0.5em 0; }
        .markdown-content img { max-width: 100%; height: auto; }
        .markdown-content pre { background: var(--header-bg); padding: 12px; border-radius: 4px; overflow-x: auto; }
        .markdown-content code { background: var(--header-bg); padding: 2px 4px; border-radius: 3px; font-family: monospace; }
        
        .diff-line { padding: 0 12px; min-height: 1.5em; }
        .diff-line-added { background: rgba(0, 255, 0, 0.15); }
        .diff-line-removed { background: rgba(255, 0, 0, 0.15); }
        .diff-line-empty { background: rgba(128, 128, 128, 0.05); }
        .diff-inline-added { background: rgba(0, 255, 0, 0.3); }
        .diff-inline-removed { background: rgba(255, 0, 0, 0.3); }
        
        .cell-outputs { margin-top: 8px; border-top: 1px dashed var(--border-color); padding-top: 8px; }
        .output-stream, .output-text { font-family: monospace; font-size: 12px; padding: 8px; background: var(--header-bg); border-radius: 4px; margin: 4px 0; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
        .output-stream.stderr { color: #d73a49; }
        .output-error { font-family: monospace; font-size: 12px; padding: 8px; background: rgba(255, 0, 0, 0.1); border-radius: 4px; color: #d73a49; white-space: pre-wrap; }
        .output-image { max-width: 100%; height: auto; border-radius: 4px; }
        .output-html { padding: 8px; background: var(--header-bg); border-radius: 4px; }
        
        .cell-placeholder { display: flex; align-items: center; justify-content: center; min-height: 60px; padding: 16px; }
        .cell-placeholder.cell-deleted { background: rgba(128, 128, 128, 0.08); border: 1px dashed var(--border-color); border-radius: 4px; margin: 8px; }
        .placeholder-text { color: var(--base-accent); font-style: italic; font-size: 13px; }
        
        .resolution-bar-row { display: flex; justify-content: center; padding: 8px; background: var(--bg); border-top: 1px solid var(--border-color); }
        .resolution-buttons { display: flex; justify-content: center; gap: 12px; }
        
        .btn-resolve { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; min-width: 100px; }
        .btn-resolve:hover { opacity: 0.9; transform: translateY(-1px); }
        .btn-resolve.btn-base { background: var(--base-accent); color: white; }
        .btn-resolve.btn-current { background: var(--current-accent); color: white; }
        .btn-resolve.btn-incoming { background: var(--incoming-accent); color: white; }
        .btn-resolve.btn-both { background: var(--button-secondary-bg); color: var(--button-secondary-fg); }
        .btn-resolve.selected { outline: 3px solid var(--focus-border); }
        
        .result-editor-container { padding: 16px; border-top: 2px solid var(--focus-border); background: var(--bg); }
        .result-editor-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .result-editor-header .badge { padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
        .result-editor-header .badge.base { background: var(--base-accent); color: white; }
        .result-editor-header .badge.current { background: var(--current-accent); color: white; }
        .result-editor-header .badge.incoming { background: var(--incoming-accent); color: white; }
        .result-editor-header .edit-hint { color: var(--base-accent); font-size: 12px; font-style: italic; }
        
        .result-editor-wrapper { border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden; }
        .result-editor-wrapper.deleted-cell-editor { background: var(--input-bg); opacity: 0.8; }
        .result-editor { width: 100%; min-height: 120px; padding: 12px; font-family: monospace; font-size: 13px; line-height: 1.5; background: var(--input-bg); color: var(--input-fg); border: none; resize: vertical; outline: none; }
        .result-editor:focus { box-shadow: inset 0 0 0 1px var(--focus-border); }
        
        .result-editor-footer { display: flex; justify-content: flex-end; align-items: center; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color); }
        .apply-single { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; background: var(--button-bg); color: var(--button-fg); }
        .clear-single { padding: 6px 12px; background: transparent; color: var(--base-accent); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer; font-size: 12px; }
        
        .merge-row.is-resolved { background: rgba(40, 167, 69, 0.06); }
        .merge-row.is-resolved .cell-column { display: none; }
        .merge-row.is-resolved .resolution-bar-row { display: none; }
        
        .resolved-result-container { padding: 16px; background: rgba(40, 167, 69, 0.08); border-left: 4px solid var(--success-color); }
        .resolved-result-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        .resolved-result-header .resolved-badge { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: var(--success-color); }
        .resolved-result-header .resolved-badge .checkmark { width: 18px; height: 18px; background: var(--success-color); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; }
        .resolved-result-header .btn-change { padding: 4px 10px; background: transparent; color: var(--incoming-accent); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer; font-size: 12px; }
        .resolved-result-content { background: var(--bg); border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden; }
        .resolved-result-content.deleted-cell pre { color: var(--base-accent); font-style: italic; text-align: center; padding: 30px 12px; opacity: 0.8; }
        .resolved-result-content pre { font-family: monospace; font-size: 13px; line-height: 1.5; padding: 12px; margin: 0; white-space: pre-wrap; word-break: break-word; }
        
        .status-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.7); display: flex; align-items: center; justify-content: center; z-index: 2000; }
        .status-message { background: var(--bg); padding: 32px; border-radius: 8px; text-align: center; max-width: 400px; }
        .status-message h2 { margin-bottom: 16px; }
        .status-message p { color: var(--base-accent); }
    </style>
</head>
<body>
    <div class="header">
        <span class="header-title">Merge Conflicts: ${escapeHtml(fileName)}</span>
        <span class="header-info">${currentBranch || 'current'} ← ${incomingBranch || 'incoming'}</span>
    </div>
    
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
        const SERVER_URL = window.location.href;
        const resolutions = {};
        const totalConflicts = ${totalConflicts};
        const conflictType = '${conflictType}';
        
        function escapeHtmlInJs(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function selectResolution(index, choice) {
            const row = document.querySelector('.merge-row[data-conflict="' + index + '"]');
            if (!row) return;
            
            if (row.classList.contains('is-resolved')) unresolveConflict(index);
            
            const hasCell = row.getAttribute('data-has-' + choice) === 'true';
            const source = decodeURIComponent(row.getAttribute('data-' + choice + '-source') || '');
            const outputsJson = row.getAttribute('data-' + choice + '-outputs');
            
            resolutions[index] = { choice, customContent: source, applied: false, isDeleted: !hasCell };
            
            document.querySelectorAll('[data-conflict="' + index + '"] .btn-resolve').forEach(btn => btn.classList.remove('selected'));
            const selectedBtn = document.querySelector('[data-conflict="' + index + '"] .btn-' + choice);
            if (selectedBtn) selectedBtn.classList.add('selected');
            
            let editorContainer = row.querySelector('.result-editor-container');
            if (!editorContainer) {
                editorContainer = document.createElement('div');
                editorContainer.className = 'result-editor-container';
                row.appendChild(editorContainer);
            }
            
            const isDeleted = !hasCell;
            const editorId = 'editor-' + index;
            
            editorContainer.innerHTML = 
                '<div class="result-editor-header">' +
                    '<span class="badge ' + choice + '">Using ' + choice.toUpperCase() + '</span>' +
                    '<span class="edit-hint">' + (isDeleted ? 'Cell will be deleted' : 'Edit below, then click Apply') + '</span>' +
                '</div>' +
                '<div class="result-editor-wrapper ' + (isDeleted ? 'deleted-cell-editor' : '') + '">' +
                    '<textarea id="' + editorId + '" class="result-editor" spellcheck="false">' + escapeHtmlInJs(source) + '</textarea>' +
                '</div>' +
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
                    resolutions[index].isDeleted = e.target.value.length === 0;
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
            if (editorContainer) editorContainer.remove();
            
            const resolvedContent = resolutions[index].customContent || '';
            const isDeleted = resolutions[index].isDeleted || false;
            
            const resultContainer = document.createElement('div');
            resultContainer.className = 'resolved-result-container';
            resultContainer.innerHTML = 
                '<div class="resolved-result-header">' +
                    '<div class="resolved-badge"><span class="checkmark">✓</span><span>Resolved</span></div>' +
                    '<button class="btn-change" onclick="unresolveConflict(' + index + ')">Change</button>' +
                '</div>' +
                '<div class="resolved-result-content ' + (isDeleted ? 'deleted-cell' : '') + '">' +
                    '<pre>' + (isDeleted ? '(cell deleted)' : escapeHtmlInJs(resolvedContent)) + '</pre>' +
                '</div>';
            row.appendChild(resultContainer);
            
            updateProgressIndicator();
        }
        
        function unresolveConflict(index) {
            const row = document.querySelector('.merge-row[data-conflict="' + index + '"]');
            if (!row) return;
            
            row.classList.remove('is-resolved');
            const resultContainer = row.querySelector('.resolved-result-container');
            if (resultContainer) resultContainer.remove();
            
            document.querySelectorAll('[data-conflict="' + index + '"] .btn-resolve').forEach(btn => btn.classList.remove('selected'));
            if (resolutions[index]) resolutions[index].applied = false;
            
            updateProgressIndicator();
        }
        
        function clearSelection(index) {
            const row = document.querySelector('.merge-row[data-conflict="' + index + '"]');
            if (!row) return;
            
            const editorContainer = row.querySelector('.result-editor-container');
            if (editorContainer) editorContainer.remove();
            
            document.querySelectorAll('[data-conflict="' + index + '"] .btn-resolve').forEach(btn => btn.classList.remove('selected'));
            delete resolutions[index];
        }
        
        function acceptAllCurrent() {
            for (let i = 0; i < totalConflicts; i++) {
                if (resolutions[i] && resolutions[i].applied) continue;
                selectResolution(i, 'current');
                applySingleResolution(i);
            }
        }
        
        function acceptAllIncoming() {
            for (let i = 0; i < totalConflicts; i++) {
                if (resolutions[i] && resolutions[i].applied) continue;
                selectResolution(i, 'incoming');
                applySingleResolution(i);
            }
        }
        
        function updateProgressIndicator() {
            const appliedCount = Object.values(resolutions).filter(r => r.applied).length;
            const progressCount = document.getElementById('progress-count');
            const applyBtn = document.getElementById('apply-btn');
            const errorMessage = document.getElementById('error-message');
            
            if (progressCount) progressCount.textContent = appliedCount + ' / ' + totalConflicts;
            
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
                    if (errorMessage) errorMessage.style.display = 'none';
                }
            }
        }
        
        async function applyResolutions() {
            const appliedCount = Object.values(resolutions).filter(r => r.applied).length;
            const errorMessage = document.getElementById('error-message');
            
            if (appliedCount === 0) {
                if (errorMessage) {
                    errorMessage.innerHTML = '<span class="error-icon">✗</span> No conflicts resolved.';
                    errorMessage.style.display = 'flex';
                }
                return;
            }
            
            if (appliedCount < totalConflicts) {
                if (!confirm(appliedCount + ' of ' + totalConflicts + ' conflicts resolved. Unresolved will default to CURRENT. Continue?')) return;
                
                for (let i = 0; i < totalConflicts; i++) {
                    if (!resolutions[i] || !resolutions[i].applied) {
                        const row = document.querySelector('.merge-row[data-conflict="' + i + '"]');
                        const currentSource = row ? decodeURIComponent(row.getAttribute('data-current-source') || '') : '';
                        const hasCurrent = row ? row.getAttribute('data-has-current') === 'true' : false;
                        resolutions[i] = { choice: 'current', customContent: currentSource, applied: true, isDeleted: !hasCurrent };
                    }
                }
            }
            
            const overlay = document.createElement('div');
            overlay.className = 'status-overlay';
            overlay.innerHTML = '<div class="status-message"><h2>Applying changes...</h2><p>Please wait while VS Code processes your resolutions.</p></div>';
            document.body.appendChild(overlay);
            
            try {
                const resolutionArray = Object.entries(resolutions).map(function(entry) {
                    return { index: parseInt(entry[0]), choice: entry[1].choice, customContent: entry[1].customContent };
                });
                
                const response = await fetch(SERVER_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: 'resolve', type: conflictType, resolutions: resolutionArray })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    overlay.innerHTML = '<div class="status-message"><h2>✓ Success!</h2><p>Conflicts resolved. You can close this tab.</p></div>';
                } else {
                    throw new Error(result.error || 'Unknown error');
                }
            } catch (error) {
                overlay.remove();
                if (errorMessage) {
                    errorMessage.innerHTML = '<span class="error-icon">✗</span> Error: ' + error.message;
                    errorMessage.style.display = 'flex';
                }
            }
        }
        
        async function cancel() {
            try {
                await fetch(SERVER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'cancel' }) });
            } catch (e) {}
            window.close();
        }
        
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.tagName !== 'TEXTAREA') applyResolutions();
            else if (e.key === 'Escape') cancel();
        });
        
        updateProgressIndicator();
        
        // Render markdown
        if (window.markdownit && window.texmath && window.katex) {
            var md = window.markdownit({ html: true, breaks: true, linkify: true }).use(texmath, { engine: katex, delimiters: 'dollars' });
            document.querySelectorAll('.markdown-content[data-markdown]').forEach(function(el) {
                var encodedMarkdown = el.getAttribute('data-markdown');
                if (encodedMarkdown) {
                    try {
                        el.innerHTML = md.render(decodeURIComponent(encodedMarkdown));
                    } catch (e) {
                        el.textContent = decodeURIComponent(encodedMarkdown);
                    }
                }
            });
        }
    </script>
</body>
</html>`;
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

/**
 * Stop the server when extension deactivates
 */
export async function deactivateServer(): Promise<void> {
    if (serverInstance) {
        await serverInstance.stop();
        serverInstance = null;
    }
}
