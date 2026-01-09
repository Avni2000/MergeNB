import * as vscode from 'vscode';
import { 
    NotebookConflict, 
    CellConflict, 
    ResolutionChoice,
    NotebookSemanticConflict,
    SemanticConflict,
    NotebookCell
} from '../types';

/**
 * Unified type for conflicts from both textual and semantic sources
 */
export interface UnifiedConflict {
    filePath: string;
    type: 'textual' | 'semantic';
    textualConflict?: NotebookConflict;
    semanticConflict?: NotebookSemanticConflict;
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
    semanticResolutions?: Map<number, { choice: 'base' | 'local' | 'remote' }>;
}

/**
 * Unified panel for resolving both textual and semantic notebook conflicts.
 * Provides a side-by-side diff view for all conflict types.
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

        const panel = vscode.window.createWebviewPanel(
            'mergeNbUnifiedConflictResolver',
            'Notebook Merge Conflicts',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
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

    private _handleResolution(message: { type: string; resolutions?: Array<{ index: number; choice: string; customContent?: string }>; semanticChoice?: string }) {
        if (this._conflict?.type === 'textual') {
            const resolutionMap = new Map<number, { choice: ResolutionChoice; customContent?: string }>();
            for (const r of (message.resolutions || [])) {
                resolutionMap.set(r.index, { choice: r.choice as ResolutionChoice, customContent: r.customContent });
            }
            if (this._onResolutionComplete) {
                this._onResolutionComplete({
                    type: 'textual',
                    textualResolutions: resolutionMap
                });
            }
        } else if (this._conflict?.type === 'semantic') {
            // Handle semantic resolutions
            const semanticResolutionMap = new Map<number, { choice: 'base' | 'local' | 'remote' }>();
            for (const r of (message.resolutions || [])) {
                semanticResolutionMap.set(r.index, { choice: r.choice as 'base' | 'local' | 'remote' });
            }
            if (this._onResolutionComplete) {
                this._onResolutionComplete({
                    type: 'semantic',
                    semanticChoice: message.semanticChoice as 'local' | 'remote' | undefined,
                    semanticResolutions: semanticResolutionMap
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

    private _getTextualConflictHtml(conflict: NotebookConflict): string {
        const conflictsHtml = conflict.conflicts.map((c, i) => this._renderTextualConflict(c, i)).join('');
        const metadataConflictsHtml = conflict.metadataConflicts.map((c, i) =>
            this._renderMetadataConflict(c, i + conflict.conflicts.length)
        ).join('');

        return this._wrapInHtml(
            'Textual Merge Conflicts',
            conflict.filePath,
            `Found <strong>${conflict.conflicts.length + conflict.metadataConflicts.length}</strong> textual conflict(s). Choose how to resolve each one:`,
            conflictsHtml + metadataConflictsHtml,
            'textual',
            conflict.conflicts.length + conflict.metadataConflicts.length
        );
    }

    private _getSemanticConflictHtml(conflict: NotebookSemanticConflict): string {
        // Group conflicts by type for better organization
        const conflictsByType = new Map<string, SemanticConflict[]>();
        for (const c of conflict.semanticConflicts) {
            const list = conflictsByType.get(c.type) || [];
            list.push(c);
            conflictsByType.set(c.type, list);
        }

        // Branch info header
        let branchInfo = '';
        if (conflict.localBranch || conflict.remoteBranch) {
            branchInfo = `<div class="branch-info">
                <span class="branch local-branch">⬅ Local: <strong>${escapeHtml(conflict.localBranch || 'Current')}</strong></span>
                <span class="merge-arrow">⟷</span>
                <span class="branch remote-branch">➡ Remote: <strong>${escapeHtml(conflict.remoteBranch || 'Incoming')}</strong></span>
            </div>`;
        }

        // Cell counts summary
        const cellCountsHtml = `<div class="cell-counts">
            <span>Base: ${conflict.base?.cells.length || 0} cells</span>
            <span>Local: ${conflict.local?.cells.length || 0} cells</span>
            <span>Remote: ${conflict.remote?.cells.length || 0} cells</span>
        </div>`;

        // Render each semantic conflict
        let conflictsHtml = '';
        let index = 0;
        for (const c of conflict.semanticConflicts) {
            conflictsHtml += this._renderSemanticConflict(c, index, conflict);
            index++;
        }

        const totalConflicts = conflict.semanticConflicts.length;
        return this._wrapInHtml(
            'Semantic Merge Conflicts',
            conflict.filePath,
            branchInfo + cellCountsHtml + `<p>Found <strong>${totalConflicts}</strong> semantic conflict(s). These are differences in execution state, outputs, or cell structure:</p>`,
            conflictsHtml,
            'semantic',
            totalConflicts
        );
    }

    private _wrapInHtml(
        title: string,
        filePath: string,
        description: string,
        conflictsHtml: string,
        conflictType: 'textual' | 'semantic',
        totalConflicts: number
    ): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        :root {
            --vscode-bg: var(--vscode-editor-background);
            --vscode-fg: var(--vscode-editor-foreground);
            --local-bg: rgba(0, 128, 0, 0.15);
            --remote-bg: rgba(0, 100, 255, 0.15);
            --base-bg: rgba(128, 128, 128, 0.15);
            --local-border: #22863a;
            --remote-border: #0366d6;
            --base-border: #6a737d;
        }
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-fg);
            background: var(--vscode-bg);
        }
        h1 {
            font-size: 1.5em;
            margin-bottom: 10px;
        }
        .file-path {
            color: var(--vscode-textLink-foreground);
            margin-bottom: 20px;
            font-size: 0.9em;
        }
        .branch-info {
            display: flex;
            gap: 20px;
            align-items: center;
            margin-bottom: 15px;
            padding: 10px;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 6px;
        }
        .branch {
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .local-branch { color: var(--local-border); }
        .remote-branch { color: var(--remote-border); }
        .merge-arrow { color: var(--vscode-descriptionForeground); font-size: 1.2em; }
        .cell-counts {
            display: flex;
            gap: 20px;
            margin-bottom: 15px;
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
        }
        .conflict {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            margin-bottom: 20px;
            overflow: hidden;
        }
        .conflict-header {
            background: var(--vscode-titleBar-activeBackground);
            padding: 10px 15px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .conflict-body {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0;
        }
        .conflict-body.three-way {
            grid-template-columns: 1fr 1fr 1fr;
        }
        .conflict-side {
            padding: 15px;
            min-height: 60px;
        }
        .conflict-local {
            background: var(--local-bg);
            border-right: 1px solid var(--vscode-panel-border);
        }
        .conflict-remote {
            background: var(--remote-bg);
        }
        .conflict-base {
            background: var(--base-bg);
            border-right: 1px solid var(--vscode-panel-border);
        }
        .side-label {
            font-size: 0.8em;
            font-weight: bold;
            margin-bottom: 10px;
            text-transform: uppercase;
        }
        .local-label { color: var(--local-border); }
        .remote-label { color: var(--remote-border); }
        .base-label { color: var(--base-border); }
        pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 0.85em;
            margin: 0;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 300px;
            overflow-y: auto;
        }
        .empty-content {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .resolution-buttons {
            display: flex;
            gap: 10px;
            padding: 10px 15px;
            background: var(--vscode-titleBar-activeBackground);
            border-top: 1px solid var(--vscode-panel-border);
        }
        button {
            padding: 6px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
        }
        .btn-local {
            background: var(--local-border);
            color: white;
        }
        .btn-remote {
            background: var(--remote-border);
            color: white;
        }
        .btn-base {
            background: var(--base-border);
            color: white;
        }
        .btn-both {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-selected {
            outline: 3px solid var(--vscode-focusBorder);
        }
        .actions {
            margin-top: 30px;
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }
        .badge {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 0.8em;
        }
        .badge-type {
            background: var(--vscode-editorInfo-background, rgba(0, 122, 204, 0.2));
            color: var(--vscode-editorInfo-foreground, #007acc);
        }
        .conflict-description {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            padding: 5px 15px;
            background: var(--vscode-titleBar-activeBackground);
        }
        .cell-type-badge {
            font-size: 0.75em;
            padding: 2px 6px;
            border-radius: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            margin-left: 8px;
        }
        .output-section {
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px dashed var(--vscode-panel-border);
        }
        .output-label {
            font-size: 0.75em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 5px;
        }
    </style>
</head>
<body>
    <h1>${escapeHtml(title)}</h1>
    <div class="file-path">${escapeHtml(filePath)}</div>
    
    ${description}
    
    ${conflictsHtml}
    
    <div class="actions">
        <button class="btn-primary" onclick="cancel()">Cancel</button>
        <button class="btn-primary" onclick="applyResolutions()">Apply Resolutions</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const resolutions = {};
        const totalConflicts = ${totalConflicts};
        const conflictType = '${conflictType}';

        function selectResolution(index, choice) {
            resolutions[index] = { choice };
            
            // Update button states
            document.querySelectorAll(\`.conflict-\${index} button\`).forEach(btn => {
                btn.classList.remove('btn-selected');
            });
            const selectedBtn = document.querySelector(\`.conflict-\${index} .btn-\${choice}\`);
            if (selectedBtn) {
                selectedBtn.classList.add('btn-selected');
            }
        }

        function applyResolutions() {
            const resolved = Object.keys(resolutions).length;
            if (resolved < totalConflicts) {
                const defaultChoice = conflictType === 'semantic' ? 'local' : 'local';
                if (!confirm(\`You have only resolved \${resolved} of \${totalConflicts} conflicts. Unresolved conflicts will use the LOCAL version. Continue?\`)) {
                    return;
                }
                // Default unresolved to local
                for (let i = 0; i < totalConflicts; i++) {
                    if (!resolutions[i]) {
                        resolutions[i] = { choice: 'local' };
                    }
                }
            }
            
            const resolutionArray = Object.entries(resolutions).map(([index, data]) => ({
                index: parseInt(index),
                choice: data.choice,
                customContent: data.customContent
            }));
            
            vscode.postMessage({ 
                command: 'resolve', 
                type: conflictType,
                resolutions: resolutionArray 
            });
        }

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }
    </script>
</body>
</html>`;
    }

    private _renderTextualConflict(conflict: CellConflict, index: number): string {
        const isOutputConflict = conflict.field === 'outputs';
        const isCellLevelConflict = conflict.marker.start > 0 || (conflict.marker.middle > 0);

        const outputNote = isOutputConflict
            ? '<p style="color: var(--vscode-editorWarning-foreground); font-size: 0.85em; margin-top: 10px;">⚠️ Output conflicts will clear the cell outputs. Re-run the cell after resolving.</p>'
            : '';

        const cellLevelNote = isCellLevelConflict
            ? '<p style="color: var(--vscode-textLink-foreground); font-size: 0.85em; margin-top: 5px; margin-bottom: 10px;">📝 Cell-level conflict: entire cells differ between branches.</p>'
            : '';

        const headerLabel = isCellLevelConflict
            ? `Cell Block (${conflict.marker.start + 1} → ${conflict.marker.end + 1})`
            : `Cell ${conflict.cellIndex + 1}`;

        return `
<div class="conflict conflict-${index}">
    <div class="conflict-header">
        <span>${headerLabel} - <span class="badge">${isCellLevelConflict ? 'cell-level' : conflict.field}</span></span>
    </div>
    ${cellLevelNote}
    <div class="conflict-body">
        <div class="conflict-side conflict-local">
            <div class="side-label local-label">⬅ Local (${escapeHtml(conflict.marker.localBranch || 'Current')})</div>
            <pre>${escapeHtml(conflict.localContent)}</pre>
        </div>
        <div class="conflict-side conflict-remote">
            <div class="side-label remote-label">➡ Remote (${escapeHtml(conflict.marker.remoteBranch || 'Incoming')})</div>
            <pre>${escapeHtml(conflict.remoteContent)}</pre>
        </div>
    </div>
    ${outputNote}
    <div class="resolution-buttons">
        ${isOutputConflict
            ? '<button class="btn-local btn-selected" onclick="selectResolution(' + index + ', \'local\')">Clear Outputs</button>'
            : `<button class="btn-local" onclick="selectResolution(${index}, 'local')">Accept Local</button>
        <button class="btn-remote" onclick="selectResolution(${index}, 'remote')">Accept Remote</button>
        <button class="btn-both" onclick="selectResolution(${index}, 'both')">Accept Both</button>`
        }
    </div>
</div>`;
    }

    private _renderMetadataConflict(
        conflict: { field: string; localContent: string; remoteContent: string },
        index: number
    ): string {
        return `
<div class="conflict conflict-${index}">
    <div class="conflict-header">
        <span>Notebook Metadata - <span class="badge">${escapeHtml(conflict.field)}</span></span>
    </div>
    <div class="conflict-body">
        <div class="conflict-side conflict-local">
            <div class="side-label local-label">⬅ Local (Current)</div>
            <pre>${escapeHtml(conflict.localContent)}</pre>
        </div>
        <div class="conflict-side conflict-remote">
            <div class="side-label remote-label">➡ Remote (Incoming)</div>
            <pre>${escapeHtml(conflict.remoteContent)}</pre>
        </div>
    </div>
    <div class="resolution-buttons">
        <button class="btn-local" onclick="selectResolution(${index}, 'local')">Accept Local</button>
        <button class="btn-remote" onclick="selectResolution(${index}, 'remote')">Accept Remote</button>
        <button class="btn-both" onclick="selectResolution(${index}, 'both')">Accept Both</button>
    </div>
</div>`;
    }

    private _renderSemanticConflict(
        conflict: SemanticConflict,
        index: number,
        fullConflict: NotebookSemanticConflict
    ): string {
        const typeLabels: Record<string, string> = {
            'cell-added': 'Cell Added',
            'cell-deleted': 'Cell Deleted',
            'cell-modified': 'Cell Modified',
            'cell-reordered': 'Cells Reordered',
            'metadata-changed': 'Metadata Changed',
            'outputs-changed': 'Outputs Changed',
            'execution-count-changed': 'Execution Count Changed'
        };

        const typeLabel = typeLabels[conflict.type] || conflict.type;
        const description = conflict.description || '';
        
        // Determine what cells to show
        const hasBase = !!conflict.baseContent;
        const hasLocal = !!conflict.localContent;
        const hasRemote = !!conflict.remoteContent;
        const isThreeWay = hasBase && (hasLocal || hasRemote);

        // Get cell content strings
        const baseSource = hasBase ? this._getCellDisplayContent(conflict.baseContent!) : '';
        const localSource = hasLocal ? this._getCellDisplayContent(conflict.localContent!) : '';
        const remoteSource = hasRemote ? this._getCellDisplayContent(conflict.remoteContent!) : '';

        // For outputs-changed, also show output info
        const baseOutputs = hasBase ? this._getCellOutputSummary(conflict.baseContent!) : '';
        const localOutputs = hasLocal ? this._getCellOutputSummary(conflict.localContent!) : '';
        const remoteOutputs = hasRemote ? this._getCellOutputSummary(conflict.remoteContent!) : '';

        // Cell indices for header
        const cellIndices: string[] = [];
        if (conflict.baseCellIndex !== undefined) cellIndices.push(`Base: ${conflict.baseCellIndex + 1}`);
        if (conflict.localCellIndex !== undefined) cellIndices.push(`Local: ${conflict.localCellIndex + 1}`);
        if (conflict.remoteCellIndex !== undefined) cellIndices.push(`Remote: ${conflict.remoteCellIndex + 1}`);
        const cellIndexStr = cellIndices.length > 0 ? ` (${cellIndices.join(', ')})` : '';

        // Get cell type badge
        const cellType = conflict.localContent?.cell_type || conflict.remoteContent?.cell_type || conflict.baseContent?.cell_type || 'code';
        const cellTypeBadge = `<span class="cell-type-badge">${cellType}</span>`;

        if (isThreeWay) {
            // Three-way diff view
            return `
<div class="conflict conflict-${index}">
    <div class="conflict-header">
        <span>${typeLabel}${cellIndexStr} ${cellTypeBadge} <span class="badge badge-type">${conflict.type}</span></span>
    </div>
    ${description ? `<div class="conflict-description">${escapeHtml(description)}</div>` : ''}
    <div class="conflict-body three-way">
        <div class="conflict-side conflict-base">
            <div class="side-label base-label">📄 Base (Ancestor)</div>
            ${hasBase ? `<pre>${escapeHtml(baseSource)}</pre>` : '<div class="empty-content">(not present)</div>'}
            ${baseOutputs ? `<div class="output-section"><div class="output-label">Outputs:</div><pre>${escapeHtml(baseOutputs)}</pre></div>` : ''}
        </div>
        <div class="conflict-side conflict-local">
            <div class="side-label local-label">⬅ Local (${escapeHtml(fullConflict.localBranch || 'Current')})</div>
            ${hasLocal ? `<pre>${escapeHtml(localSource)}</pre>` : '<div class="empty-content">(not present)</div>'}
            ${localOutputs ? `<div class="output-section"><div class="output-label">Outputs:</div><pre>${escapeHtml(localOutputs)}</pre></div>` : ''}
        </div>
        <div class="conflict-side conflict-remote">
            <div class="side-label remote-label">➡ Remote (${escapeHtml(fullConflict.remoteBranch || 'Incoming')})</div>
            ${hasRemote ? `<pre>${escapeHtml(remoteSource)}</pre>` : '<div class="empty-content">(not present)</div>'}
            ${remoteOutputs ? `<div class="output-section"><div class="output-label">Outputs:</div><pre>${escapeHtml(remoteOutputs)}</pre></div>` : ''}
        </div>
    </div>
    <div class="resolution-buttons">
        ${hasBase ? `<button class="btn-base" onclick="selectResolution(${index}, 'base')">Keep Base</button>` : ''}
        ${hasLocal ? `<button class="btn-local" onclick="selectResolution(${index}, 'local')">Accept Local</button>` : ''}
        ${hasRemote ? `<button class="btn-remote" onclick="selectResolution(${index}, 'remote')">Accept Remote</button>` : ''}
    </div>
</div>`;
        } else {
            // Two-way diff view (no base, or only one version exists)
            return `
<div class="conflict conflict-${index}">
    <div class="conflict-header">
        <span>${typeLabel}${cellIndexStr} ${cellTypeBadge} <span class="badge badge-type">${conflict.type}</span></span>
    </div>
    ${description ? `<div class="conflict-description">${escapeHtml(description)}</div>` : ''}
    <div class="conflict-body">
        <div class="conflict-side conflict-local">
            <div class="side-label local-label">⬅ Local (${escapeHtml(fullConflict.localBranch || 'Current')})</div>
            ${hasLocal ? `<pre>${escapeHtml(localSource)}</pre>` : '<div class="empty-content">(not present)</div>'}
            ${localOutputs ? `<div class="output-section"><div class="output-label">Outputs:</div><pre>${escapeHtml(localOutputs)}</pre></div>` : ''}
        </div>
        <div class="conflict-side conflict-remote">
            <div class="side-label remote-label">➡ Remote (${escapeHtml(fullConflict.remoteBranch || 'Incoming')})</div>
            ${hasRemote ? `<pre>${escapeHtml(remoteSource)}</pre>` : '<div class="empty-content">(not present)</div>'}
            ${remoteOutputs ? `<div class="output-section"><div class="output-label">Outputs:</div><pre>${escapeHtml(remoteOutputs)}</pre></div>` : ''}
        </div>
    </div>
    <div class="resolution-buttons">
        ${hasLocal ? `<button class="btn-local" onclick="selectResolution(${index}, 'local')">Accept Local</button>` : ''}
        ${hasRemote ? `<button class="btn-remote" onclick="selectResolution(${index}, 'remote')">Accept Remote</button>` : ''}
    </div>
</div>`;
        }
    }

    private _getCellDisplayContent(cell: NotebookCell): string {
        const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        return source;
    }

    private _getCellOutputSummary(cell: NotebookCell): string {
        if (!cell.outputs || cell.outputs.length === 0) {
            return '';
        }

        const summaries: string[] = [];
        for (const output of cell.outputs) {
            if (output.text) {
                const text = Array.isArray(output.text) ? output.text.join('') : output.text;
                // Truncate long outputs
                const truncated = text.length > 500 ? text.substring(0, 500) + '\n... (truncated)' : text;
                summaries.push(truncated);
            } else if (output.data) {
                // Show data types available
                const dataTypes = Object.keys(output.data).join(', ');
                summaries.push(`[${output.output_type}: ${dataTypes}]`);
            } else {
                summaries.push(`[${output.output_type}]`);
            }
        }
        return summaries.join('\n');
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
