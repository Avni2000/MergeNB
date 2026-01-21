/**
 * @file ConflictResolverPanel.ts
 * @description 3-way split webview panel for notebook conflict resolution.
 * @import markdown-it for markdown rendering (VSCode native).
 * @import markdown-it-texmath for LaTeX support in markdown cells.
 * 
 * Displays the entire notebook in three synchronized columns (Base, Local, Remote)
 * with cells rendered properly (markdown/code/outputs). Conflicts are highlighted
 * inline within the notebook view, making it feel like viewing the file split into
 * three windows with differences highlighted.
 */


import * as vscode from 'vscode';
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
    semanticChoice?: 'local' | 'remote';
    semanticResolutions?: Map<number, { choice: 'base' | 'local' | 'remote'; customContent?: string }>;
    // Whether to mark file as resolved with git add
    markAsResolved: boolean;
}

/**
 * Represents a row in the 3-way merge view
 */
interface MergeRow {
    type: 'identical' | 'conflict';
    baseCell?: NotebookCell;
    localCell?: NotebookCell;
    remoteCell?: NotebookCell;
    baseCellIndex?: number;
    localCellIndex?: number;
    remoteCellIndex?: number;
    conflictIndex?: number; // Index into the semantic conflicts array
    conflictType?: string;
}

/**
 * Unified panel for resolving both textual and semantic notebook conflicts.
 * Shows a 3-way split view of the entire notebook.
 */
export class UnifiedConflictPanel {
    public static currentPanel: UnifiedConflictPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _conflict: UnifiedConflict | undefined;
    private _onResolutionComplete: ((resolution: UnifiedResolution) => void) | undefined;

    public static createOrShow(
        extensionUri: vscode.Uri,
        conflict: UnifiedConflict,
        onResolutionComplete: (resolution: UnifiedResolution) => void
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (UnifiedConflictPanel.currentPanel) {
            UnifiedConflictPanel.currentPanel._panel.reveal(column);
            UnifiedConflictPanel.currentPanel.setConflict(conflict, onResolutionComplete);
            return;
        }

        const fileName = conflict.filePath.split('/').pop() || 'notebook.ipynb';
        // Get the directory containing the notebook for loading relative images
        const notebookDir = vscode.Uri.file(conflict.filePath).with({ path: conflict.filePath.substring(0, conflict.filePath.lastIndexOf('/')) });
        const panel = vscode.window.createWebviewPanel(
            'mergeNbConflictResolver',
            `! ${fileName} (Resolving Conflicts)`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                enableFindWidget: true,
                localResourceRoots: [extensionUri, notebookDir],
                retainContextWhenHidden: true
            }
        );

        UnifiedConflictPanel.currentPanel = new UnifiedConflictPanel(panel, extensionUri, conflict, onResolutionComplete);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        conflict: UnifiedConflict,
        onResolutionComplete: (resolution: UnifiedResolution) => void
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._conflict = conflict;
        this._onResolutionComplete = onResolutionComplete;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'resolve':
                        this._handleResolution(message);
                        break;
                    case 'cancel':
                        this._panel.dispose();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public setConflict(
        conflict: UnifiedConflict,
        onResolutionComplete: (resolution: UnifiedResolution) => void
    ) {
        this._conflict = conflict;
        this._onResolutionComplete = onResolutionComplete;
        this._update();
    }

    private _handleResolution(message: { type: string; resolutions?: Array<{ index: number; choice: string; customContent?: string }>; semanticChoice?: string; markAsResolved?: boolean }) {
        if (this._conflict?.type === 'textual') {
            const resolutionMap = new Map<number, { choice: ResolutionChoice; customContent?: string }>();
            for (const r of (message.resolutions || [])) {
                resolutionMap.set(r.index, { choice: r.choice as ResolutionChoice, customContent: r.customContent });
            }
            if (this._onResolutionComplete) {
                this._onResolutionComplete({
                    type: 'textual',
                    textualResolutions: resolutionMap,
                    markAsResolved: message.markAsResolved ?? false
                });
            }
        } else if (this._conflict?.type === 'semantic') {
            const semanticResolutionMap = new Map<number, { choice: 'base' | 'local' | 'remote'; customContent?: string }>();
            for (const r of (message.resolutions || [])) {
                semanticResolutionMap.set(r.index, { 
                    choice: r.choice as 'base' | 'local' | 'remote',
                    customContent: r.customContent 
                });
            }
            if (this._onResolutionComplete) {
                this._onResolutionComplete({
                    type: 'semantic',
                    semanticChoice: message.semanticChoice as 'local' | 'remote' | undefined,
                    semanticResolutions: semanticResolutionMap,
                    markAsResolved: message.markAsResolved ?? false
                });
            }
        }
        this._panel.dispose();
    }

    public dispose() {
        UnifiedConflictPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _shouldShowCellHeaders(): boolean {
        const config = vscode.workspace.getConfiguration('mergeNB');
        return config.get<boolean>('ui.showCellHeaders', false);
    }

    private _getHtmlForWebview(): string {
        const conflict = this._conflict;
        if (!conflict) {
            return '<html><body><p>No conflicts to resolve.</p></body></html>';
        }

        if (conflict.type === 'textual' && conflict.textualConflict) {
            return this._getTextualConflictHtml(conflict.textualConflict);
        } else if (conflict.type === 'semantic' && conflict.semanticConflict) {
            return this._getSemanticConflictHtml(conflict.semanticConflict);
        }

        return '<html><body><p>Unknown conflict type.</p></body></html>';
    }

    /**
     * Build merge rows from cell mappings for 3-way view
     */
    private _buildMergeRows(semanticConflict: NotebookSemanticConflict): MergeRow[] {
        const rows: MergeRow[] = [];
        const conflictMap = new Map<string, { conflict: SemanticConflict; index: number }>();
        
        // Index conflicts by cell indices for quick lookup
        semanticConflict.semanticConflicts.forEach((c, i) => {
            const key = `${c.baseCellIndex ?? 'x'}-${c.localCellIndex ?? 'x'}-${c.remoteCellIndex ?? 'x'}`;
            conflictMap.set(key, { conflict: c, index: i });
        });

        // Use cell mappings to build rows
        for (const mapping of semanticConflict.cellMappings) {
            const baseCell = mapping.baseIndex !== undefined && semanticConflict.base 
                ? semanticConflict.base.cells[mapping.baseIndex] : undefined;
            const localCell = mapping.localIndex !== undefined && semanticConflict.local 
                ? semanticConflict.local.cells[mapping.localIndex] : undefined;
            const remoteCell = mapping.remoteIndex !== undefined && semanticConflict.remote 
                ? semanticConflict.remote.cells[mapping.remoteIndex] : undefined;
            
            const key = `${mapping.baseIndex ?? 'x'}-${mapping.localIndex ?? 'x'}-${mapping.remoteIndex ?? 'x'}`;
            const conflictInfo = conflictMap.get(key);

            rows.push({
                type: conflictInfo ? 'conflict' : 'identical',
                baseCell,
                localCell,
                remoteCell,
                baseCellIndex: mapping.baseIndex,
                localCellIndex: mapping.localIndex,
                remoteCellIndex: mapping.remoteIndex,
                conflictIndex: conflictInfo?.index,
                conflictType: conflictInfo?.conflict.type
            });
        }

        return rows;
    }

    private _getSemanticConflictHtml(conflict: NotebookSemanticConflict): string {
        const rows = this._buildMergeRows(conflict);
        const totalConflicts = conflict.semanticConflicts.length;
        
        // Build the notebook view with all cells
        let notebookHtml = '';
        for (const row of rows) {
            notebookHtml += this._renderMergeRow(row, conflict);
        }

        return this._wrapInFullHtml(
            conflict.filePath,
            notebookHtml,
            'semantic',
            totalConflicts,
            conflict.localBranch,
            conflict.remoteBranch,
            this._conflict?.autoResolveResult
        );
    }

    private _getTextualConflictHtml(conflict: NotebookConflict): string {
        // If we have cell mappings from Git, render like semantic conflicts with full context
        if (conflict.cellMappings && conflict.cellMappings.length > 0 && 
            (conflict.local || conflict.remote)) {
            return this._getTextualConflictWithContextHtml(conflict);
        }
        
        // Fall back to simple conflict-only rendering (when Git versions unavailable)
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

    /**
     * Render textual conflicts with full notebook context from Git versions.
     * Shows non-conflicted cells as unified rows and conflicts in 3-column view.
     */
    private _getTextualConflictWithContextHtml(conflict: NotebookConflict): string {
        const rows = this._buildMergeRowsForTextual(conflict);
        
        // Count conflicts from the rows (detected by comparing Git versions)
        const cellConflictCount = rows.filter(r => r.type === 'conflict').length;
        const totalConflicts = cellConflictCount + conflict.metadataConflicts.length;
        
        // Build the notebook view with all cells
        let notebookHtml = '';
        for (const row of rows) {
            notebookHtml += this._renderMergeRowForTextual(row, conflict);
        }
        
        // Add metadata conflicts at the end (their indices come after cell conflicts)
        const metadataConflictsHtml = conflict.metadataConflicts.map((c, i) =>
            this._renderMetadataConflictRow(c, cellConflictCount + i)
        ).join('');

        return this._wrapInFullHtml(
            conflict.filePath,
            notebookHtml + metadataConflictsHtml,
            'textual',
            totalConflicts,
            conflict.localBranch,
            conflict.remoteBranch
        );
    }

    /**
     * Build merge rows from cell mappings for textual conflicts with Git context.
     * Since textual conflicts are in the working copy (with markers), but Git staging
     * has clean local/remote versions, we detect conflicts by comparing local vs remote.
     */
    private _buildMergeRowsForTextual(conflict: NotebookConflict): MergeRow[] {
        const rows: MergeRow[] = [];
        
        if (!conflict.cellMappings) {
            return rows;
        }

        console.log('[MergeNB] Building merge rows for textual conflict');
        console.log('[MergeNB] base cells:', conflict.base?.cells?.length);
        console.log('[MergeNB] local cells:', conflict.local?.cells?.length);
        console.log('[MergeNB] remote cells:', conflict.remote?.cells?.length);
        console.log('[MergeNB] mappings count:', conflict.cellMappings.length);
        console.log('[MergeNB] original textual conflicts:', conflict.conflicts.length);

        // For textual conflicts, we detect conflicts by comparing local vs remote
        // from the Git staging areas (not from the working copy markers)
        let conflictIndex = 0;
        
        for (const mapping of conflict.cellMappings) {
            const baseCell = mapping.baseIndex !== undefined && conflict.base 
                ? conflict.base.cells[mapping.baseIndex] : undefined;
            const localCell = mapping.localIndex !== undefined && conflict.local 
                ? conflict.local.cells[mapping.localIndex] : undefined;
            const remoteCell = mapping.remoteIndex !== undefined && conflict.remote 
                ? conflict.remote.cells[mapping.remoteIndex] : undefined;

            // Determine if this is a conflict by comparing cells
            let isConflict = false;
            
            // Case 1: Cell exists in local only (added in local)
            if (localCell && !remoteCell && !baseCell) {
                isConflict = true;
            }
            // Case 2: Cell exists in remote only (added in remote)
            else if (remoteCell && !localCell && !baseCell) {
                isConflict = true;
            }
            // Case 3: Cell exists in both local and remote - check if they differ
            else if (localCell && remoteCell) {
                const localSource = Array.isArray(localCell.source) ? localCell.source.join('') : localCell.source;
                const remoteSource = Array.isArray(remoteCell.source) ? remoteCell.source.join('') : remoteCell.source;
                
                // Check source content
                if (localSource !== remoteSource) {
                    isConflict = true;
                }
                // Also check outputs for code cells
                else if (localCell.cell_type === 'code') {
                    const localOutputs = JSON.stringify(localCell.outputs || []);
                    const remoteOutputs = JSON.stringify(remoteCell.outputs || []);
                    if (localOutputs !== remoteOutputs) {
                        // Output difference - could be a conflict or just execution difference
                        // For now, mark as conflict only if source also differs slightly
                        // or execution_count differs
                        if (localCell.execution_count !== remoteCell.execution_count) {
                            // Minor difference - not a real conflict for textual resolution
                            isConflict = false;
                        }
                    }
                }
            }
            // Case 4: Cell deleted in one branch (exists in base but not local or remote)
            else if (baseCell && (!localCell || !remoteCell) && (localCell || remoteCell)) {
                isConflict = true;
            }

            const currentConflictIndex = isConflict ? conflictIndex++ : undefined;
            
            rows.push({
                type: isConflict ? 'conflict' : 'identical',
                baseCell,
                localCell,
                remoteCell,
                baseCellIndex: mapping.baseIndex,
                localCellIndex: mapping.localIndex,
                remoteCellIndex: mapping.remoteIndex,
                conflictIndex: currentConflictIndex,
                conflictType: isConflict ? 'textual' : undefined
            });
        }
        
        console.log('[MergeNB] Detected conflicts from Git comparison:', conflictIndex);

        return rows;
    }

    /**
     * Render a merge row for textual conflicts with context.
     * Similar to _renderMergeRow but adapted for textual conflict data.
     */
    private _renderMergeRowForTextual(row: MergeRow, conflict: NotebookConflict): string {
        const isConflict = row.type === 'conflict';
        const conflictClass = isConflict ? 'conflict-row' : '';
        const conflictAttr = row.conflictIndex !== undefined ? `data-conflict="${row.conflictIndex}"` : '';
        
        // Encode cell sources for JavaScript access (for editing)
        const baseSource = row.baseCell ? 
            (Array.isArray(row.baseCell.source) ? row.baseCell.source.join('') : row.baseCell.source) : '';
        const localSource = row.localCell ? 
            (Array.isArray(row.localCell.source) ? row.localCell.source.join('') : row.localCell.source) : '';
        const remoteSource = row.remoteCell ? 
            (Array.isArray(row.remoteCell.source) ? row.remoteCell.source.join('') : row.remoteCell.source) : '';
        
        // Store cell metadata for JS access
        const cellDataAttrs = isConflict ? `
            data-base-source="${encodeURIComponent(baseSource)}"
            data-local-source="${encodeURIComponent(localSource)}"
            data-remote-source="${encodeURIComponent(remoteSource)}"
            data-cell-type="${row.localCell?.cell_type || row.remoteCell?.cell_type || row.baseCell?.cell_type || 'code'}"
            data-has-base="${row.baseCell ? 'true' : 'false'}"
            data-has-local="${row.localCell ? 'true' : 'false'}"
            data-has-remote="${row.remoteCell ? 'true' : 'false'}"
        ` : '';
        
        // Encode outputs for editing view
        const baseOutputs = row.baseCell?.outputs ? encodeURIComponent(JSON.stringify(row.baseCell.outputs)) : '';
        const localOutputs = row.localCell?.outputs ? encodeURIComponent(JSON.stringify(row.localCell.outputs)) : '';
        const remoteOutputs = row.remoteCell?.outputs ? encodeURIComponent(JSON.stringify(row.remoteCell.outputs)) : '';
        
        const outputDataAttrs = isConflict ? `
            data-base-outputs="${baseOutputs}"
            data-local-outputs="${localOutputs}"
            data-remote-outputs="${remoteOutputs}"
        ` : '';
        
        // For identical rows (non-conflicts), render as a single unified cell
        if (!isConflict) {
            const displayCell = row.localCell || row.remoteCell || row.baseCell;
            const displayIndex = row.localCellIndex ?? row.remoteCellIndex ?? row.baseCellIndex;
            return `
<div class="merge-row unified-row">
    <div class="unified-cell-container">
        ${this._renderCellContentForTextual(displayCell, displayIndex, 'local', row, conflict, this._shouldShowCellHeaders())}
    </div>
</div>`;
        }
        
        // For conflicts, show all 3 columns
        // Determine conflict index - use existing or generate one for detected conflicts
        const effectiveConflictIndex = row.conflictIndex ?? -1;
        
        return `
<div class="merge-row ${conflictClass}" data-conflict="${effectiveConflictIndex}" ${cellDataAttrs} ${outputDataAttrs}>
    <div class="cell-columns-container">
        <div class="cell-column base-column">
            <div class="column-label">Base</div>
            ${this._renderCellContentForTextual(row.baseCell, row.baseCellIndex, 'base', row, conflict, this._shouldShowCellHeaders())}
        </div>
        <div class="cell-column local-column">
            <div class="column-label">Current</div>
            ${this._renderCellContentForTextual(row.localCell, row.localCellIndex, 'local', row, conflict, this._shouldShowCellHeaders())}
        </div>
        <div class="cell-column remote-column">
            <div class="column-label">Incoming</div>
            ${this._renderCellContentForTextual(row.remoteCell, row.remoteCellIndex, 'remote', row, conflict, this._shouldShowCellHeaders())}
        </div>
    </div>
    ${effectiveConflictIndex >= 0 ? this._renderResolutionBarForTextual(effectiveConflictIndex, row) : this._renderResolutionBarForDetectedConflict(row)}
</div>`;
    }

    /**
     * Render cell content for textual conflict with context view.
     */
    private _renderCellContentForTextual(
        cell: NotebookCell | undefined, 
        cellIndex: number | undefined,
        side: 'base' | 'local' | 'remote',
        row: MergeRow,
        conflict: NotebookConflict,
        showHeaders: boolean = false
    ): string {
        if (!cell) {
            return `<div class="cell-placeholder">
                <span class="placeholder-text">(not present)</span>
            </div>`;
        }

        const cellType = cell.cell_type;
        const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        
        // Determine if we should show diff highlighting
        let contentHtml: string;
        if (row.type === 'conflict' && cellType !== 'markdown') {
            // Show diff for conflicts
            const compareSource = side === 'local' 
                ? (row.remoteCell ? (Array.isArray(row.remoteCell.source) ? row.remoteCell.source.join('') : row.remoteCell.source) : '')
                : side === 'remote'
                    ? (row.localCell ? (Array.isArray(row.localCell.source) ? row.localCell.source.join('') : row.localCell.source) : '')
                    : (row.localCell ? (Array.isArray(row.localCell.source) ? row.localCell.source.join('') : row.localCell.source) : '');
            contentHtml = this._renderDiffContent(source, compareSource, side);
        } else if (cellType === 'markdown') {
            contentHtml = this._renderMarkdown(source);
        } else {
            contentHtml = `<pre class="code-content">${escapeHtml(source)}</pre>`;
        }

        // Render outputs for code cells (conditionally hide for non-conflicted cells)
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

    /**
     * Resolution bar for known textual conflicts (from conflict list)
     */
    private _renderResolutionBarForTextual(conflictIndex: number, row: MergeRow): string {
        return `
<div class="resolution-bar-row" data-conflict="${conflictIndex}">
    <div class="resolution-buttons">
        ${row.baseCell ? '<button class="btn-resolve btn-base" onclick="selectResolution(' + conflictIndex + ', \'base\')">Use Base</button>' : ''}
        <button class="btn-resolve btn-local" onclick="selectResolution(${conflictIndex}, 'local')">Use Current</button>
        <button class="btn-resolve btn-remote" onclick="selectResolution(${conflictIndex}, 'remote')">Use Incoming</button>
        <button class="btn-resolve btn-both" onclick="selectResolution(${conflictIndex}, 'both')">Use Both</button>
    </div>
</div>`;
    }

    /**
     * Resolution bar for detected conflicts (differences not in original conflict list)
     */
    private _renderResolutionBarForDetectedConflict(row: MergeRow): string {
        // These are conflicts detected by cell comparison but not in the original textual conflict list
        // Generate a unique identifier based on cell indices
        const conflictId = `detected-${row.localCellIndex ?? 'x'}-${row.remoteCellIndex ?? 'x'}`;
        return `
<div class="resolution-bar-row" data-conflict="${conflictId}">
    <div class="resolution-buttons">
        ${row.baseCell ? '<button class="btn-resolve btn-base" onclick="selectResolution(\'' + conflictId + '\', \'base\')">Use Base</button>' : ''}
        <button class="btn-resolve btn-local" onclick="selectResolution('${conflictId}', 'local')">Use Current</button>
        <button class="btn-resolve btn-remote" onclick="selectResolution('${conflictId}', 'remote')">Use Incoming</button>
    </div>
</div>`;
    }

    private _renderMergeRow(row: MergeRow, conflict: NotebookSemanticConflict): string {
        const isConflict = row.type === 'conflict';
        const conflictClass = isConflict ? 'conflict-row' : '';
        const conflictAttr = row.conflictIndex !== undefined ? `data-conflict="${row.conflictIndex}"` : '';
        
        // Encode cell sources for JavaScript access (for editing)
        const baseSource = row.baseCell ? 
            (Array.isArray(row.baseCell.source) ? row.baseCell.source.join('') : row.baseCell.source) : '';
        const localSource = row.localCell ? 
            (Array.isArray(row.localCell.source) ? row.localCell.source.join('') : row.localCell.source) : '';
        const remoteSource = row.remoteCell ? 
            (Array.isArray(row.remoteCell.source) ? row.remoteCell.source.join('') : row.remoteCell.source) : '';
        
        // Store cell metadata for JS access
        const cellDataAttrs = isConflict ? `
            data-base-source="${encodeURIComponent(baseSource)}"
            data-local-source="${encodeURIComponent(localSource)}"
            data-remote-source="${encodeURIComponent(remoteSource)}"
            data-cell-type="${row.localCell?.cell_type || row.remoteCell?.cell_type || row.baseCell?.cell_type || 'code'}"
            data-has-base="${row.baseCell ? 'true' : 'false'}"
            data-has-local="${row.localCell ? 'true' : 'false'}"
            data-has-remote="${row.remoteCell ? 'true' : 'false'}"
        ` : '';
        
        // Encode outputs for editing view
        const baseOutputs = row.baseCell?.outputs ? encodeURIComponent(JSON.stringify(row.baseCell.outputs)) : '';
        const localOutputs = row.localCell?.outputs ? encodeURIComponent(JSON.stringify(row.localCell.outputs)) : '';
        const remoteOutputs = row.remoteCell?.outputs ? encodeURIComponent(JSON.stringify(row.remoteCell.outputs)) : '';
        
        const outputDataAttrs = isConflict ? `
            data-base-outputs="${baseOutputs}"
            data-local-outputs="${localOutputs}"
            data-remote-outputs="${remoteOutputs}"
        ` : '';
        
        // For identical rows (non-conflicts), render as a single unified cell
        if (!isConflict) {
            const cell = row.localCell || row.baseCell || row.remoteCell;
            const cellIndex = row.localCellIndex ?? row.baseCellIndex ?? row.remoteCellIndex;
            return `
<div class="merge-row unified-row">
    <div class="unified-cell-container">
        ${this._renderCellContent(cell, cellIndex, 'local', row, conflict, this._shouldShowCellHeaders())}
    </div>
</div>`;
        }
        
        // For conflicts, show all 3 columns
        return `
<div class="merge-row ${conflictClass}" ${conflictAttr} ${cellDataAttrs} ${outputDataAttrs}>
    <div class="cell-columns-container">
        <div class="cell-column base-column">
            <div class="column-label">Base</div>
            ${this._renderCellContent(row.baseCell, row.baseCellIndex, 'base', row, conflict, this._shouldShowCellHeaders())}
        </div>
        <div class="cell-column local-column">
            <div class="column-label">Current</div>
            ${this._renderCellContent(row.localCell, row.localCellIndex, 'local', row, conflict, this._shouldShowCellHeaders())}
        </div>
        <div class="cell-column remote-column">
            <div class="column-label">Incoming</div>
            ${this._renderCellContent(row.remoteCell, row.remoteCellIndex, 'remote', row, conflict, this._shouldShowCellHeaders())}
        </div>
    </div>
    ${row.conflictIndex !== undefined ? this._renderResolutionBar(row.conflictIndex, row) : ''}
</div>`;
    }

    private _renderCellContent(
        cell: NotebookCell | undefined, 
        cellIndex: number | undefined,
        side: 'base' | 'local' | 'remote',
        row: MergeRow,
        conflict: NotebookSemanticConflict,
        showHeaders: boolean = false
    ): string {
        if (!cell) {
            // Check if this is a conflict where the cell doesn't exist on this side
            if (row.type === 'conflict') {
                return `<div class="cell-placeholder">
                    <span class="placeholder-text">(no cell)</span>
                </div>`;
            }
            return '<div class="cell-placeholder"></div>';
        }

        const cellType = cell.cell_type;
        const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        
        // Determine if we should show diff highlighting
        let contentHtml: string;
        if (row.type === 'conflict' && cellType !== 'markdown') {
            // Get comparison source for diff
            const compareCell = side === 'local' ? row.remoteCell : 
                               side === 'remote' ? row.localCell : 
                               (row.localCell || row.remoteCell);
            const compareSource = compareCell ? 
                (Array.isArray(compareCell.source) ? compareCell.source.join('') : compareCell.source) : '';
            
            contentHtml = this._renderDiffContent(source, compareSource, side);
        } else if (cellType === 'markdown') {
            contentHtml = this._renderMarkdown(source);
        } else {
            contentHtml = `<pre class="code-content">${escapeHtml(source)}</pre>`;
        }

        // Render outputs for code cells (conditionally hide for non-conflicted cells)
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
        // Get notebook directory for resolving relative image paths
        const notebookDir = this._conflict?.filePath 
            ? this._conflict.filePath.substring(0, this._conflict.filePath.lastIndexOf('/'))
            : '';
        
        // Pre-process: convert relative image paths to webview URIs
        // Handle both markdown images ![alt](src) and HTML <img> tags
        let processed = source;
        
        // Convert markdown image syntax
        processed = processed.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
            const webviewSrc = this._convertImagePath(src, notebookDir);
            return `![${alt}](${webviewSrc})`;
        });
        
        // Convert HTML img tags
        processed = processed.replace(/<img([^>]*)src=["']([^"']+)["']([^>]*)>/gi, (match, before, src, after) => {
            const webviewSrc = this._convertImagePath(src, notebookDir);
            return `<img${before}src="${webviewSrc}"${after}>`;
        });
        
        // Encode content for markdown-it renderer (will be parsed client-side)
        const encodedSource = encodeURIComponent(processed);
        
        return `<div class="markdown-content" data-markdown="${encodedSource}"></div>`;
    }

    /**
     * Convert an image path to a webview URI if it's a relative path
     */
    private _convertImagePath(src: string, notebookDir: string): string {
        // Skip if it's already an absolute URL (http, https, data:)
        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
            return src;
        }
        
        // Skip if it's already a vscode-webview-resource URI
        if (src.includes('vscode-webview-resource')) {
            return src;
        }
        
        // For relative paths, resolve against notebook directory
        if (notebookDir) {
            const absolutePath = src.startsWith('/') 
                ? src 
                : `${notebookDir}/${src}`;
            const fileUri = vscode.Uri.file(absolutePath);
            return this._panel.webview.asWebviewUri(fileUri).toString();
        }
        
        return src;
    }

    private _renderOutputs(outputs: any[]): string {
        let html = '<div class="cell-outputs">';
        
        for (const output of outputs) {
            if (output.output_type === 'stream') {
                const text = Array.isArray(output.text) ? output.text.join('') : (output.text || '');
                const streamClass = output.name === 'stderr' ? 'stderr' : 'stdout';
                html += `<pre class="output-stream ${streamClass}">${escapeHtml(text)}</pre>`;
            } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
                if (output.data) {
                    if (output.data['text/html']) {
                        const htmlContent = Array.isArray(output.data['text/html']) 
                            ? output.data['text/html'].join('') 
                            : output.data['text/html'];
                        // Sanitize HTML output - for now just show placeholder
                        html += `<div class="output-html">[HTML Output]</div>`;
                    } else if (output.data['image/png']) {
                        html += `<img class="output-image" src="data:image/png;base64,${output.data['image/png']}" />`;
                    } else if (output.data['text/plain']) {
                        const text = Array.isArray(output.data['text/plain']) 
                            ? output.data['text/plain'].join('') 
                            : output.data['text/plain'];
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
        const hasBase = !!row.baseCell;
        const hasLocal = !!row.localCell;
        const hasRemote = !!row.remoteCell;
        
        return `
<div class="resolution-bar-row" data-conflict="${conflictIndex}">
    <div class="resolution-buttons">
        <button class="btn-resolve btn-base" onclick="selectResolution(${conflictIndex}, 'base')">Use Base</button>
        <button class="btn-resolve btn-local" onclick="selectResolution(${conflictIndex}, 'local')">Use Current</button>
        <button class="btn-resolve btn-remote" onclick="selectResolution(${conflictIndex}, 'remote')">Use Incoming</button>
    </div>
</div>`;
    }


    private _renderTextualConflictRow(conflict: CellConflict, index: number): string {
        const hasLocal = conflict.localContent.trim().length > 0;
        const hasRemote = conflict.remoteContent.trim().length > 0;
        
        // Store data attributes for JS access
        const cellDataAttrs = `
            data-base-source=""
            data-local-source="${encodeURIComponent(conflict.localContent)}"
            data-remote-source="${encodeURIComponent(conflict.remoteContent)}"
            data-cell-type="${conflict.cellType || 'code'}"
            data-has-base="false"
            data-has-local="${hasLocal}"
            data-has-remote="${hasRemote}"
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
        <div class="cell-column local-column">
            <div class="column-label">Current</div>
            ${hasLocal ? `
            <div class="notebook-cell code-cell has-conflict">
                <div class="cell-content">
                    ${this._renderDiffContent(conflict.localContent, conflict.remoteContent, 'local')}
                </div>
            </div>` : `<div class="cell-placeholder"><span class="placeholder-text">(not present)</span></div>`}
        </div>
        <div class="cell-column remote-column">
            <div class="column-label">Incoming</div>
            ${hasRemote ? `
            <div class="notebook-cell code-cell has-conflict">
                <div class="cell-content">
                    ${this._renderDiffContent(conflict.remoteContent, conflict.localContent, 'remote')}
                </div>
            </div>` : `<div class="cell-placeholder"><span class="placeholder-text">(not present)</span></div>`}
        </div>
    </div>
    <div class="resolution-bar-row" data-conflict="${index}">
        <div class="resolution-buttons">
            <button class="btn-resolve btn-local" onclick="selectResolution(${index}, 'local')">Use Current</button>
            <button class="btn-resolve btn-remote" onclick="selectResolution(${index}, 'remote')">Use Incoming</button>
            <button class="btn-resolve btn-both" onclick="selectResolution(${index}, 'both')">Use Both</button>
        </div>
    </div>
</div>`;
    }

    private _renderMetadataConflictRow(
        conflict: { field: string; localContent: string; remoteContent: string },
        index: number
    ): string {
        // Store data attributes for JS access
        const cellDataAttrs = `
            data-base-source=""
            data-local-source="${encodeURIComponent(conflict.localContent)}"
            data-remote-source="${encodeURIComponent(conflict.remoteContent)}"
            data-cell-type="metadata"
            data-has-base="false"
            data-has-local="true"
            data-has-remote="true"
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
        <div class="cell-column local-column">
            <div class="column-label">Current</div>
            <div class="metadata-cell">
                <pre class="code-content">${escapeHtml(conflict.localContent)}</pre>
            </div>
        </div>
        <div class="cell-column remote-column">
            <div class="column-label">Incoming</div>
            <div class="metadata-cell">
                <pre class="code-content">${escapeHtml(conflict.remoteContent)}</pre>
            </div>
        </div>
    </div>
    <div class="resolution-bar-row" data-conflict="${index}">
        <div class="resolution-buttons">
            <button class="btn-resolve btn-local" onclick="selectResolution(${index}, 'local')">Use Current</button>
            <button class="btn-resolve btn-remote" onclick="selectResolution(${index}, 'remote')">Use Incoming</button>
        </div>
    </div>
</div>`;
    }

    private _renderDiffContent(sourceText: string, compareText: string, side: 'base' | 'local' | 'remote'): string {
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

    private _getDiffLineClass(line: DiffLine, side: 'base' | 'local' | 'remote'): string {
        switch (line.type) {
            case 'unchanged': return 'diff-line-unchanged';
            case 'added': return 'diff-line-added';
            case 'removed': return 'diff-line-removed';
            case 'modified': return side === 'base' ? 'diff-line-modified-old' : 'diff-line-modified-new';
            default: return '';
        }
    }

    private _getInlineChangeClass(type: 'unchanged' | 'added' | 'removed', side: 'base' | 'local' | 'remote'): string {
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
        localBranch?: string,
        remoteBranch?: string,
        autoResolveResult?: AutoResolveResult
    ): string {
        const fileName = filePath.split('/').pop() || filePath;
        
        let autoResolveInfo = '';
        // if (autoResolveResult && autoResolveResult.autoResolvedCount > 0) {
        //     const items = autoResolveResult.autoResolvedDescriptions.map(d => `<li>${escapeHtml(d)}</li>`).join('');
        //     autoResolveInfo = `<div class="auto-resolve-banner">
        //         <span class="auto-resolve-icon">✓</span>
        //         <span>Auto-resolved ${autoResolveResult.autoResolvedCount} conflict(s)</span>
        //         <ul>${items}</ul>
        //     </div>`;
        // }

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
            --vscode-bg: var(--vscode-editor-background);
            --vscode-fg: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --cell-bg: var(--vscode-editor-background);
            --header-bg: var(--vscode-titleBar-activeBackground);
            --local-accent: #22863a;
            --remote-accent: #0366d6;
            --base-accent: #6a737d;
            --conflict-bg: rgba(255, 0, 0, 0.05);
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-bg);
            color: var(--vscode-fg);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
        }
        
        /* Bottom action bar */
        .bottom-actions {
            position: sticky;
            bottom: 0;
            left: 0;
            right: 0;
            background: var(--vscode-editor-background);
            border-top: 1px solid var(--border-color);
            padding: 12px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            z-index: 1000;
            box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
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
            border: 1px solid var(--vscode-button-border, transparent);
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .btn-accept-all:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .progress-info {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        
        .progress-count {
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        
        .error-message {
            color: var(--vscode-errorForeground);
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
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .btn-primary:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
        }
        
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .btn-secondary:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        // /* Auto-resolve banner */
        // .auto-resolve-banner {
        //     background: rgba(40, 167, 69, 0.15);
        //     border-bottom: 1px solid #28a745;
        //     padding: 8px 16px;
        //     font-size: 13px;
        //     display: flex;
        //     align-items: center;
        //     gap: 8px;
        //     flex-wrap: wrap;
        // }
        
        // .auto-resolve-banner ul {
        //     display: flex;
        //     gap: 16px;
        //     list-style: none;
        //     margin-left: 8px;
        // }
        
        /* Main content area */
        .merge-container {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            padding-bottom: 16px;
        }
        
        /* Merge rows */
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
        
        /* Unified row for identical cells */
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
        
        /* Container for the three columns (only for conflicts) */
        .cell-columns-container {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
        }
        
        /* Cell columns */
        .cell-column {
            border-right: 1px solid var(--border-color);
            min-height: 60px;
            position: relative;
        }
        
        .cell-column:last-child { border-right: none; }
        
        .cell-column.base-column { 
            background: rgba(106, 115, 125, 0.03); 
        }
        .cell-column.local-column { 
            background: rgba(34, 134, 58, 0.03); 
        }
        .cell-column.remote-column { 
            background: rgba(3, 102, 214, 0.03); 
        }
        
        /* Column labels for conflict rows */
        .column-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 4px 8px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--border-color);
            background: var(--vscode-editorWidget-background);
        }
        
        .base-column .column-label {
            color: var(--base-accent);
        }
        
        .local-column .column-label {
            color: var(--local-accent);
        }
        
        .remote-column .column-label {
            color: var(--remote-accent);
        }
        
        /* Notebook cells */
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
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family, monospace);
        }
        
        .cell-index {
            color: var(--vscode-descriptionForeground);
            margin-left: auto;
        }
        
        .cell-content {
            background: var(--vscode-textCodeBlock-background);
            border-radius: 4px;
            overflow: hidden;
            padding: 8px;
        }
        
        .code-content, .diff-content {
            font-family: var(--vscode-editor-font-family, monospace);
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
        .markdown-content h6 { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
        
        .markdown-content hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
            margin: 1em 0;
        }
        
        .markdown-content img {
            max-width: 100%;
            height: auto;
        }
        
        .markdown-content a {
            color: var(--vscode-textLink-foreground);
        }
        
        .markdown-content a:hover {
            color: var(--vscode-textLink-activeForeground);
        }
        
        .markdown-table {
            border-collapse: collapse;
            margin: 1em 0;
            width: auto;
        }
        
        .markdown-table th,
        .markdown-table td {
            border: 1px solid var(--vscode-panel-border);
            padding: 8px 12px;
            text-align: left;
        }
        
        .markdown-table th {
            background: var(--vscode-editor-selectionBackground);
            font-weight: bold;
        }
        
        .markdown-table tr:nth-child(even) {
            background: rgba(128, 128, 128, 0.05);
        }
        
        .markdown-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
        }
        
        .markdown-content pre code {
            background: none;
            padding: 0;
        }
        
        .markdown-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        
        /* Diff highlighting */
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
        
        /* Cell outputs */
        .cell-outputs {
            margin-top: 8px;
            border-top: 1px dashed var(--border-color);
            padding-top: 8px;
        }
        
        .output-stream, .output-text {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            padding: 8px;
            background: var(--vscode-textCodeBlock-background);
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
            font-family: var(--vscode-editor-font-family, monospace);
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
            background: var(--vscode-textCodeBlock-background);
            border-radius: 4px;
            font-style: italic;
            color: var(--vscode-descriptionForeground);
        }
        
        /* Placeholders */
        .cell-placeholder {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 60px;
            padding: 16px;
        }
        
        .placeholder-text {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 13px;
        }
        
        /* Resolution bar - full width row */
        .resolution-bar-row {
            display: flex;
            justify-content: center;
            padding: 8px;
            background: var(--vscode-editor-background);
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
        
        .btn-resolve.btn-local {
            background: var(--local-accent);
            color: white;
        }
        
        .btn-resolve.btn-remote {
            background: var(--remote-accent);
            color: white;
        }
        
        .btn-resolve.btn-both {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .btn-resolve.selected {
            outline: 3px solid var(--vscode-focusBorder);
            opacity: 1;
        }
        
        /* Metadata conflict */
        .metadata-cell {
            padding: 12px;
        }
        
        .metadata-conflict .cell-placeholder {
            font-weight: 500;
        }
        
        /* Editor view below conflict row */
        .result-editor-container {
            grid-column: 1 / -1;
            padding: 16px;
            border-top: 2px solid var(--vscode-focusBorder);
            background: var(--vscode-editor-background);
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
        
        .result-editor-header .badge.local {
            background: var(--local-accent);
            color: white;
        }
        
        .result-editor-header .badge.remote {
            background: var(--remote-accent);
            color: white;
        }
        
        .result-editor-header .edit-hint {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            font-style: italic;
        }
        
        .result-editor-wrapper {
            border: 1px solid var(--border-color);
            border-radius: 4px;
            overflow: hidden;
        }
        
        .result-editor-wrapper.deleted-cell-editor {
            background: var(--vscode-input-background);
            opacity: 0.8;
        }
        
        .result-editor {
            width: 100%;
            min-height: 120px;
            padding: 12px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 13px;
            line-height: 1.5;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: none;
            resize: vertical;
            outline: none;
        }
        
        .result-editor::placeholder {
            color: var(--vscode-input-placeholderForeground);
            opacity: 0.6;
            font-style: italic;
        }
        
        .result-editor:focus {
            box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
        }
        
        .result-outputs {
            padding: 12px;
            background: var(--vscode-textCodeBlock-background);
            border-top: 1px dashed var(--border-color);
        }
        
        .result-outputs-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .result-outputs .output-stream,
        .result-outputs .output-text {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            padding: 8px;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 4px;
            margin: 4px 0;
            white-space: pre-wrap;
            max-height: 200px;
            overflow-y: auto;
        }
        
        /* Editor footer with apply button */
        .result-editor-footer {
            display: flex;
            justify-content: flex-end;
            align-items: center;
            gap: 12px;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
            background: var(--vscode-editor-background);
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
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            box-shadow: none !important;
        }
        

        .apply-single:hover {
            opacity: 0.9;
        }
        
        .clear-single {
            padding: 6px 12px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .clear-single:hover {
            background: rgba(255, 255, 255, 0.05);
            color: var(--vscode-foreground);
        }
        
        /* Resolved state styling */
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
            color: var(--vscode-textLink-foreground);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .resolved-result-header .btn-change:hover {
            background: rgba(255, 255, 255, 0.05);
        }
        
        .resolved-result-content {
            background: var(--vscode-editor-background);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            overflow: hidden;
        }
        
        .resolved-result-content.deleted-cell pre {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            text-align: center;
            padding: 30px 12px;
            opacity: 0.8;
        }
        
        .resolved-result-content pre {
            font-family: var(--vscode-editor-font-family, monospace);
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
            color: var(--vscode-descriptionForeground);
            margin-bottom: 6px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
    </style>
</head>
<body>
    ${autoResolveInfo}
    
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
        const vscode = acquireVsCodeApi();
        const resolutions = {};
        const totalConflicts = ${totalConflicts};
        const conflictType = '${conflictType}';
        
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
                        html += \`<div class="output-stream \${streamClass}">\${escapeHtmlInJs(text)}</div>\`;
                    } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
                        if (output.data) {
                            if (output.data['image/png']) {
                                html += \`<img class="output-image" src="data:image/png;base64,\${output.data['image/png']}" />\`;
                            } else if (output.data['text/html']) {
                                const textHtml = Array.isArray(output.data['text/html']) 
                                    ? output.data['text/html'].join('') 
                                    : output.data['text/html'];
                                html += \`<div class="output-html">\${textHtml}</div>\`;
                            } else if (output.data['text/plain']) {
                                const text = Array.isArray(output.data['text/plain']) 
                                    ? output.data['text/plain'].join('') 
                                    : output.data['text/plain'];
                                html += \`<div class="output-text">\${escapeHtmlInJs(text)}</div>\`;
                            }
                        }
                    } else if (output.output_type === 'error') {
                        const traceback = output.traceback ? output.traceback.join('\\n') : \`\${output.ename}: \${output.evalue}\`;
                        html += \`<div class="output-error">\${escapeHtmlInJs(traceback)}</div>\`;
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
            const row = document.querySelector(\`.merge-row[data-conflict="\${index}"]\`);
            if (!row) return;
            
            // If already resolved, need to unresolve first
            if (row.classList.contains('is-resolved')) {
                unresolveConflict(index);
            }
            
            // Check if the chosen side exists (detect deleted cells)
            const hasAttr = \`data-has-\${choice}\`;
            const hasCell = row.getAttribute(hasAttr) === 'true';
            
            // Get source content based on choice
            const sourceAttr = \`data-\${choice}-source\`;
            const source = decodeURIComponent(row.getAttribute(sourceAttr) || '');
            const cellType = row.getAttribute('data-cell-type') || 'code';
            
            // Get outputs for the chosen side
            const outputsAttr = \`data-\${choice}-outputs\`;
            const outputsJson = row.getAttribute(outputsAttr);
            
            // Store the choice and content (not yet applied)
            resolutions[index] = { 
                choice, 
                customContent: source,
                originalContent: source,
                originalChoice: choice,
                applied: false,
                isDeleted: !hasCell
            };
            
            // Update button states
            document.querySelectorAll(\`[data-conflict="\${index}"] .btn-resolve\`).forEach(btn => {
                btn.classList.remove('selected');
            });
            const selectedBtn = document.querySelector(\`[data-conflict="\${index}"] .btn-\${choice}\`);
            if (selectedBtn) {
                selectedBtn.classList.add('selected');
            }
            
            // Check if editor already exists
            let editorContainer = row.querySelector('.result-editor-container');
            
            if (!editorContainer) {
                // Create the editor container
                editorContainer = document.createElement('div');
                editorContainer.className = 'result-editor-container';
                row.appendChild(editorContainer);
            }
            
            // Check if this is a deleted cell
            const isDeleted = !hasCell;
            
            // Build editor HTML with Apply button
            const outputsHtml = renderOutputsFromData(outputsJson);
            const editorId = \`editor-\${index}\`;
            
            // Always show editable textarea, but with different hints for deleted cells
            editorContainer.innerHTML = \`
                <div class="result-editor-header">
                    <span class="badge \${choice}">Using \${choice === 'local' ? 'CURRENT' : choice === 'remote' ? 'INCOMING' : choice.toUpperCase()}</span>
                    <span class="edit-hint">\${isDeleted ? 'Cell will be deleted (or add content to restore)' : 'Edit the result below, then click Apply to confirm'}</span>
                </div>
                <div class="result-editor-wrapper \${isDeleted ? 'deleted-cell-editor' : ''}">
                    <textarea 
                        id="\${editorId}" 
                        class="result-editor" 
                        data-conflict="\${index}"
                        spellcheck="false"
                        placeholder="\${isDeleted ? '(cell deleted - add content here to restore it)' : ''}"
                    >\${escapeHtmlInJs(source)}</textarea>
                </div>
                \${isDeleted ? '' : outputsHtml}
                <div class="result-editor-footer">
                    <button class="btn clear-single" onclick="clearSelection(\${index})">Cancel</button>
                    <button class="btn apply-single" onclick="applySingleResolution(\${index})">Apply This Resolution</button>
                </div>
            \`;
            
            // Set up editor change listener
            const editor = document.getElementById(editorId);
            if (editor) {
                // Auto-resize textarea
                editor.style.height = 'auto';
                editor.style.height = Math.max(120, editor.scrollHeight) + 'px';
                
                editor.addEventListener('input', (e) => {
                    // Update custom content
                    resolutions[index].customContent = e.target.value;
                    
                    // Update deleted state based on content (regardless of original state)
                    const hasContent = e.target.value.trim().length > 0;
                    resolutions[index].isDeleted = !hasContent;
                    
                    // Update the hint text dynamically
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
                    
                    // Auto-resize
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.max(120, e.target.scrollHeight) + 'px';
                });
            }
        }
        
        function applySingleResolution(index) {
            const row = document.querySelector(\`.merge-row[data-conflict="\${index}"]\`);
            if (!row || !resolutions[index]) return;
            
            console.log('[MergeNB] Applying resolution for conflict', index, ':', {
                choice: resolutions[index].choice,
                isDeleted: resolutions[index].isDeleted,
                contentLength: resolutions[index].customContent?.length ?? 0,
                contentPreview: resolutions[index].customContent ?? ''
            });
            
            // Mark as applied
            resolutions[index].applied = true;
            
            // Update UI to show resolved state
            row.classList.add('is-resolved');
            
            // Remove the editor container
            const editorContainer = row.querySelector('.result-editor-container');
            if (editorContainer) {
                editorContainer.remove();
            }
            
            // Get the resolved content and outputs
            const resolvedContent = resolutions[index].customContent ?? '';
            const isDeleted = resolutions[index].isDeleted ?? false;
            const choice = resolutions[index].choice;
            const outputsAttr = \`data-\${choice}-outputs\`;
            const outputsJson = row.getAttribute(outputsAttr);
            const outputsHtml = renderOutputsFromData(outputsJson);
            
            // Create resolved result container showing just the final result
            const resultContainer = document.createElement('div');
            resultContainer.className = 'resolved-result-container';
            
            // Build outputs HTML for resolved view
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
                                resolvedOutputsHtml += \`<div class="output-stream \${streamClass}">\${escapeHtmlInJs(text)}</div>\`;
                            } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
                                if (output.data) {
                                    if (output.data['image/png']) {
                                        resolvedOutputsHtml += \`<img class="output-image" src="data:image/png;base64,\${output.data['image/png']}" />\`;
                                    } else if (output.data['text/html']) {
                                        const textHtml = Array.isArray(output.data['text/html']) 
                                            ? output.data['text/html'].join('') 
                                            : output.data['text/html'];
                                        resolvedOutputsHtml += \`<div class="output-html">\${textHtml}</div>\`;
                                    } else if (output.data['text/plain']) {
                                        const text = Array.isArray(output.data['text/plain']) 
                                            ? output.data['text/plain'].join('') 
                                            : output.data['text/plain'];
                                        resolvedOutputsHtml += \`<div class="output-text">\${escapeHtmlInJs(text)}</div>\`;
                                    }
                                }
                            } else if (output.output_type === 'error') {
                                const traceback = output.traceback ? output.traceback.join('\\n') : \`\${output.ename}: \${output.evalue}\`;
                                resolvedOutputsHtml += \`<div class="output-error">\${escapeHtmlInJs(traceback)}</div>\`;
                            }
                        }
                        resolvedOutputsHtml += '</div>';
                    }
                } catch (e) {
                    console.error('Error parsing outputs:', e);
                }
            }
            
            resultContainer.innerHTML = \`
                <div class="resolved-result-header">
                    <div class="resolved-badge">
                        <span class="checkmark">✓</span>
                        <span>Resolved</span>
                    </div>
                    <button class="btn-change" onclick="unresolveConflict(\${index})">Change</button>
                </div>
                <div class="resolved-result-content \${isDeleted ? 'deleted-cell' : ''}">
                    <pre>\${isDeleted ? '(cell deleted)' : escapeHtmlInJs(resolvedContent)}</pre>
                </div>
                \${isDeleted ? '' : resolvedOutputsHtml}
            \`;
            row.appendChild(resultContainer);
            
            // Scroll the resolved cell into view smoothly
            setTimeout(() => {
                row.scrollIntoView({ 
                    behavior: 'smooth', 
                    block: 'center',
                    inline: 'nearest'
                });
            }, 100);
            
            // Update progress indicator
            updateProgressIndicator();
        }
        
        function unresolveConflict(index) {
            const row = document.querySelector(\`.merge-row[data-conflict="\${index}"]\`);
            if (!row) return;
            
            // Remove resolved state
            row.classList.remove('is-resolved');
            
            // Remove resolved result container
            const resultContainer = row.querySelector('.resolved-result-container');
            if (resultContainer) {
                resultContainer.remove();
            }
            
            // Clear button selection
            document.querySelectorAll(\`[data-conflict="\${index}"] .btn-resolve\`).forEach(btn => {
                btn.classList.remove('selected');
            });
            
            // Mark as not applied (but keep the data in case they want to re-apply)
            if (resolutions[index]) {
                resolutions[index].applied = false;
            }
            
            // Update progress indicator
            updateProgressIndicator();
        }
        
        function clearSelection(index) {
            const row = document.querySelector(\`.merge-row[data-conflict="\${index}"]\`);
            if (!row) return;
            
            // Remove editor container
            const editorContainer = row.querySelector('.result-editor-container');
            if (editorContainer) {
                editorContainer.remove();
            }
            
            // Clear button selection
            document.querySelectorAll(\`[data-conflict="\${index}"] .btn-resolve\`).forEach(btn => {
                btn.classList.remove('selected');
            });
            
            // Remove from resolutions
            delete resolutions[index];
        }
        
        function acceptAllCurrent() {
            // Select and apply 'local' (current) for all unresolved conflicts
            for (let i = 0; i < totalConflicts; i++) {
                // Skip if already resolved
                if (resolutions[i]?.applied) {
                    continue;
                }
                selectResolution(i, 'local');
                applySingleResolution(i);
            }
        }
        
        function acceptAllIncoming() {
            // Select and apply 'remote' (incoming) for all unresolved conflicts
            for (let i = 0; i < totalConflicts; i++) {
                // Skip if already resolved
                if (resolutions[i]?.applied) {
                    continue;
                }
                selectResolution(i, 'remote');
                applySingleResolution(i);
            }
        }
        
        function updateProgressIndicator() {
            const appliedCount = Object.values(resolutions).filter(r => r.applied).length;
            const progressCount = document.getElementById('progress-count');
            const applyBtn = document.getElementById('apply-btn');
            const errorMessage = document.getElementById('error-message');
            
            if (progressCount) {
                progressCount.textContent = \`\${appliedCount} / \${totalConflicts}\`;
            }
            
            // Enable/disable button based on whether all conflicts are resolved
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
                        errorMessage.innerHTML = \`<span class="error-icon">⚠</span> \${totalConflicts - appliedCount} conflict(s) unresolved - will default to CURRENT\`;
                        errorMessage.style.display = 'flex';
                    }
                } else {
                    applyBtn.disabled = false;
                    if (errorMessage) {
                        errorMessage.style.display = 'none';
                    }
                }
            }
            
            console.log(\`Progress: \${appliedCount}/\${totalConflicts} resolved\`);
        }

        function applyResolutions() {
            const appliedCount = Object.values(resolutions).filter(r => r.applied).length;
            const errorMessage = document.getElementById('error-message');
            
            // Check if any conflicts are resolved
            if (appliedCount === 0) {
                if (errorMessage) {
                    errorMessage.innerHTML = '<span class="error-icon">✗</span> No conflicts resolved. Please resolve at least one conflict before applying.';
                    errorMessage.style.display = 'flex';
                }
                return;
            }
            
            // Check if all conflicts are resolved
            if (appliedCount < totalConflicts) {
                const unresolvedCount = totalConflicts - appliedCount;
                const unappliedSelections = Object.entries(resolutions).filter(([_, r]) => !r.applied).length;
                
                let message = \`\${appliedCount} of \${totalConflicts} conflicts resolved.\\n\`;
                if (unappliedSelections > 0) {
                    message += \`\${unappliedSelections} selection(s) not yet applied.\\n\`;
                }
                message += \`\\n\${unresolvedCount} unresolved conflict(s) will default to CURRENT version.\\n\\nContinue?\`;
                
                if (!confirm(message)) {
                    return;
                }
                
                // Apply defaults for unresolved conflicts
                for (let i = 0; i < totalConflicts; i++) {
                    if (!resolutions[i] || !resolutions[i].applied) {
                        const row = document.querySelector(\`.merge-row[data-conflict="\${i}"]\`);
                        const localSource = row ? decodeURIComponent(row.getAttribute('data-local-source') || '') : '';
                        const hasLocal = row ? row.getAttribute('data-has-local') === 'true' : false;
                        resolutions[i] = { choice: 'local', customContent: localSource, applied: true, isDeleted: !hasLocal };
                    }
                }
            }
            
            try {
                const resolutionArray = Object.entries(resolutions).map(([index, data]) => ({
                    index: parseInt(index),
                    choice: data.choice,
                    customContent: data.customContent
                }));
                
                console.log('[MergeNB] Sending resolutions to backend:', resolutionArray.map(r => ({
                    index: r.index,
                    choice: r.choice,
                    contentLength: r.customContent?.length ?? 0,
                    contentPreview: r.customContent ?? ''
                })));
                
                vscode.postMessage({ 
                    command: 'resolve', 
                    type: conflictType,
                    resolutions: resolutionArray 
                });
            } catch (error) {
                if (errorMessage) {
                    errorMessage.innerHTML = \`<span class="error-icon">✗</span> Error applying resolutions: \${error.message}\`;
                    errorMessage.style.display = 'flex';
                }
                console.error('Error applying resolutions:', error);
            }
        }

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Only trigger save if not focused on textarea
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.tagName !== 'TEXTAREA') {
                applyResolutions();
            } else if (e.key === 'Escape') {
                cancel();
            }
        });
        
        // Initialize progress indicator on page load
        updateProgressIndicator();
        
        // Render markdown content using markdown-it library (VSCode native)
        const md = window.markdownit({
            html: true,
            breaks: true,
            linkify: true,
            typographer: true
        }).use(texmath, {
            engine: katex,
            delimiters: 'dollars',
            katexOptions: { macros: { "\\RR": "\\mathbb{R}" } }
        });
        
        document.querySelectorAll('.markdown-content[data-markdown]').forEach(el => {
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
