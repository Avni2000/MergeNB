/**
 * @file ConflictResolverPanel.ts
 * @description 3-way split webview panel for notebook conflict resolution.
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

        // Debug: Log notebook version info
        console.log('[MergeNB] Building merge rows');
        console.log('[MergeNB] base cells:', semanticConflict.base?.cells?.length);
        console.log('[MergeNB] local cells:', semanticConflict.local?.cells?.length);
        console.log('[MergeNB] remote cells:', semanticConflict.remote?.cells?.length);
        console.log('[MergeNB] mappings count:', semanticConflict.cellMappings.length);

        // Use cell mappings to build rows
        for (const mapping of semanticConflict.cellMappings) {
            const baseCell = mapping.baseIndex !== undefined && semanticConflict.base 
                ? semanticConflict.base.cells[mapping.baseIndex] : undefined;
            const localCell = mapping.localIndex !== undefined && semanticConflict.local 
                ? semanticConflict.local.cells[mapping.localIndex] : undefined;
            const remoteCell = mapping.remoteIndex !== undefined && semanticConflict.remote 
                ? semanticConflict.remote.cells[mapping.remoteIndex] : undefined;
            
            // Debug: Log Lego cell specifically
            const baseSource = baseCell ? (Array.isArray(baseCell.source) ? baseCell.source.join('') : baseCell.source) : '';
            const localSource = localCell ? (Array.isArray(localCell.source) ? localCell.source.join('') : localCell.source) : '';
            const remoteSource = remoteCell ? (Array.isArray(remoteCell.source) ? remoteCell.source.join('') : remoteCell.source) : '';
            
            if (baseSource.includes('2.3 The Lego Analogy')) {
                console.log('[MergeNB] LEGO CELL FOUND:');
                console.log('[MergeNB] - mapping:', JSON.stringify({baseIndex: mapping.baseIndex, localIndex: mapping.localIndex, remoteIndex: mapping.remoteIndex}));
                console.log('[MergeNB] - base has "Key insight":', baseSource.includes('Key insight'));
                console.log('[MergeNB] - local has "Key insight":', localSource.includes('Key insight'));
                console.log('[MergeNB] - remote has "Key insight":', remoteSource.includes('Key insight'));
                console.log('[MergeNB] - base === local:', baseSource === localSource);
                console.log('[MergeNB] - base === remote:', baseSource === remoteSource);
                console.log('[MergeNB] - local === remote:', localSource === remoteSource);
            }

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
        // For textual conflicts, we don't have the full notebook structure
        // Render conflicts as standalone items
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
        
        return `
<div class="merge-row ${conflictClass}" ${conflictAttr} ${cellDataAttrs} ${outputDataAttrs}>
    <div class="cell-column base-column">
        ${this._renderCellContent(row.baseCell, row.baseCellIndex, 'base', row, conflict)}
    </div>
    <div class="cell-column local-column">
        ${this._renderCellContent(row.localCell, row.localCellIndex, 'local', row, conflict)}
    </div>
    <div class="cell-column remote-column">
        ${this._renderCellContent(row.remoteCell, row.remoteCellIndex, 'remote', row, conflict)}
    </div>
    ${isConflict && row.conflictIndex !== undefined ? this._renderResolutionBar(row.conflictIndex, row) : ''}
</div>`;
    }

    private _renderCellContent(
        cell: NotebookCell | undefined, 
        cellIndex: number | undefined,
        side: 'base' | 'local' | 'remote',
        row: MergeRow,
        conflict: NotebookSemanticConflict
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

        return `
<div class="notebook-cell ${cellType}-cell ${row.type === 'conflict' ? 'has-conflict' : ''}">
    <div class="cell-header">
        <span class="cell-type-badge ${cellType}">${cellType}</span>
        ${cellType === 'code' ? `<span class="execution-count">${executionCount}</span>` : ''}
        <span class="cell-index">${cellIndex !== undefined ? `Cell ${cellIndex + 1}` : ''}</span>
    </div>
    <div class="cell-content">
        ${contentHtml}
    </div>
    ${outputsHtml}
</div>`;
    }

    private _renderMarkdown(source: string): string {
        // Markdown rendering that preserves HTML tags
        // First, extract and preserve HTML tags, then escape the rest
        // Also convert image paths to webview URIs
        const htmlTagPlaceholders: { placeholder: string; tag: string }[] = [];
        let placeholderIndex = 0;
        
        // Get notebook directory for resolving relative image paths
        const notebookDir = this._conflict?.filePath 
            ? this._conflict.filePath.substring(0, this._conflict.filePath.lastIndexOf('/'))
            : '';
        
        // Preserve HTML tags (including self-closing like <br/>, <br />, <img .../>)
        // Also convert image src attributes to webview URIs
        let processed = source.replace(/<[^>]+>/g, (match) => {
            // If this is an img tag, convert the src to a webview URI
            let processedTag = match;
            if (match.toLowerCase().startsWith('<img')) {
                processedTag = this._convertImageSrc(match, notebookDir);
            }
            const placeholder = `__HTML_TAG_${placeholderIndex}__`;
            htmlTagPlaceholders.push({ placeholder, tag: processedTag });
            placeholderIndex++;
            return placeholder;
        });
        
        // Now escape the remaining content
        let html = escapeHtml(processed);
        
        // Restore HTML tags
        for (const { placeholder, tag } of htmlTagPlaceholders) {
            html = html.replace(placeholder, tag);
        }
        
        // Headers (process from most specific to least to avoid partial matches)
        html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
        html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
        html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
        
        // Horizontal rules (---, ***, ___)
        html = html.replace(/^[-*_]{3,}$/gm, '<hr>');
        
        // Images: ![alt](src) - handle before links, convert paths to webview URIs
        html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
            const webviewSrc = this._convertImagePath(src, notebookDir);
            return `<img src="${webviewSrc}" alt="${alt}" style="max-width: 100%;">`;
        });
        
        // Links: [text](url)
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        
        // Bold and italic
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        
        // Code blocks (triple backticks)
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        
        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // Tables
        html = this._renderMarkdownTables(html);
        
        // Line breaks (but not inside pre/code blocks or after block elements)
        // First, protect content inside <pre> tags
        const preBlocks: { placeholder: string; content: string }[] = [];
        let preIndex = 0;
        html = html.replace(/<pre>[\s\S]*?<\/pre>/g, (match) => {
            const placeholder = `__PRE_BLOCK_${preIndex}__`;
            preBlocks.push({ placeholder, content: match });
            preIndex++;
            return placeholder;
        });
        
        // Convert newlines to <br> (except after block elements)
        html = html.replace(/\n/g, '<br>\n');
        
        // Clean up extra <br> after block elements
        html = html.replace(/(<\/h[1-6]>)<br>/g, '$1');
        html = html.replace(/(<hr>)<br>/g, '$1');
        html = html.replace(/(<\/table>)<br>/g, '$1');
        html = html.replace(/(<\/pre>)<br>/g, '$1');
        
        // Restore pre blocks
        for (const { placeholder, content } of preBlocks) {
            html = html.replace(placeholder, content);
        }
        
        return `<div class="markdown-content">${html}</div>`;
    }

    private _renderMarkdownTables(html: string): string {
        // Simple table rendering: detect lines that look like table rows
        const lines = html.split('\n');
        let inTable = false;
        let tableHtml = '';
        const result: string[] = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Check if this is a table row (starts and ends with |, or has | in the middle)
            const isTableRow = line.startsWith('|') && line.endsWith('|');
            const isSeparatorRow = /^\|[-:\s|]+\|$/.test(line);
            
            if (isTableRow || isSeparatorRow) {
                if (!inTable) {
                    inTable = true;
                    tableHtml = '<table class="markdown-table">';
                }
                
                if (isSeparatorRow) {
                    // Skip separator row (it's just for alignment)
                    continue;
                }
                
                // Parse table cells
                const cells = line.slice(1, -1).split('|').map(c => c.trim());
                const isHeader = i === 0 || (i > 0 && /^\|[-:\s|]+\|$/.test(lines[i - 1]?.trim() || ''));
                const cellTag = inTable && result.length === 0 ? 'th' : 'td';
                
                // Check if this is the header row (first row of a table)
                const nextLine = lines[i + 1]?.trim() || '';
                const isHeaderRow = /^\|[-:\s|]+\|$/.test(nextLine);
                
                tableHtml += '<tr>';
                for (const cell of cells) {
                    tableHtml += isHeaderRow ? `<th>${cell}</th>` : `<td>${cell}</td>`;
                }
                tableHtml += '</tr>';
            } else {
                if (inTable) {
                    tableHtml += '</table>';
                    result.push(tableHtml);
                    tableHtml = '';
                    inTable = false;
                }
                result.push(lines[i]);
            }
        }
        
        if (inTable) {
            tableHtml += '</table>';
            result.push(tableHtml);
        }
        
        return result.join('\n');
    }

    /**
     * Convert an image src attribute in an HTML img tag to a webview URI
     */
    private _convertImageSrc(imgTag: string, notebookDir: string): string {
        // Extract the src attribute
        const srcMatch = imgTag.match(/src=["']([^"']+)["']/i);
        if (!srcMatch) {
            return imgTag;
        }
        
        const originalSrc = srcMatch[1];
        const webviewSrc = this._convertImagePath(originalSrc, notebookDir);
        
        // Replace the src in the tag
        return imgTag.replace(srcMatch[0], `src="${webviewSrc}"`);
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
<div class="resolution-bar" data-conflict="${conflictIndex}">
    <button class="btn-resolve btn-base" onclick="selectResolution(${conflictIndex}, 'base')">Use Base</button>
    <button class="btn-resolve btn-local" onclick="selectResolution(${conflictIndex}, 'local')">Use Local</button>
    <button class="btn-resolve btn-remote" onclick="selectResolution(${conflictIndex}, 'remote')">Use Remote</button>
</div>`;
    }

    private _renderTextualConflictRow(conflict: CellConflict, index: number): string {
        const hasLocal = conflict.localContent.trim().length > 0;
        const hasRemote = conflict.remoteContent.trim().length > 0;
        
        return `
<div class="merge-row conflict-row" data-conflict="${index}">
    <div class="cell-column base-column">
        <div class="cell-placeholder">
            <span class="placeholder-text">(textual conflict)</span>
        </div>
    </div>
    <div class="cell-column local-column">
        ${hasLocal ? `
        <div class="notebook-cell code-cell has-conflict">
            <div class="cell-header">
                <span class="cell-type-badge code">${conflict.cellType || 'code'}</span>
                <span class="cell-index">Cell ${(conflict.localCellIndex ?? conflict.cellIndex) + 1}</span>
            </div>
            <div class="cell-content">
                ${this._renderDiffContent(conflict.localContent, conflict.remoteContent, 'local')}
            </div>
        </div>` : `<div class="cell-placeholder"><span class="placeholder-text">(not present)</span></div>`}
    </div>
    <div class="cell-column remote-column">
        ${hasRemote ? `
        <div class="notebook-cell code-cell has-conflict">
            <div class="cell-header">
                <span class="cell-type-badge code">${conflict.cellType || 'code'}</span>
                <span class="cell-index">Cell ${(conflict.remoteCellIndex ?? conflict.cellIndex) + 1}</span>
            </div>
            <div class="cell-content">
                ${this._renderDiffContent(conflict.remoteContent, conflict.localContent, 'remote')}
            </div>
        </div>` : `<div class="cell-placeholder"><span class="placeholder-text">(not present)</span></div>`}
    </div>
    <div class="resolution-bar" data-conflict="${index}">
        <button class="btn-resolve btn-local" onclick="selectResolution(${index}, 'local')">Use Local</button>
        <button class="btn-resolve btn-remote" onclick="selectResolution(${index}, 'remote')">Use Remote</button>
        <button class="btn-resolve btn-both" onclick="selectResolution(${index}, 'both')">Use Both</button>
    </div>
</div>`;
    }

    private _renderMetadataConflictRow(
        conflict: { field: string; localContent: string; remoteContent: string },
        index: number
    ): string {
        return `
<div class="merge-row conflict-row metadata-conflict" data-conflict="${index}">
    <div class="cell-column base-column">
        <div class="cell-placeholder">
            <span class="placeholder-text">Metadata: ${escapeHtml(conflict.field)}</span>
        </div>
    </div>
    <div class="cell-column local-column">
        <div class="metadata-cell">
            <pre class="code-content">${escapeHtml(conflict.localContent)}</pre>
        </div>
    </div>
    <div class="cell-column remote-column">
        <div class="metadata-cell">
            <pre class="code-content">${escapeHtml(conflict.remoteContent)}</pre>
        </div>
    </div>
    <div class="resolution-bar" data-conflict="${index}">
        <button class="btn-resolve btn-local" onclick="selectResolution(${index}, 'local')">Use Local</button>
        <button class="btn-resolve btn-remote" onclick="selectResolution(${index}, 'remote')">Use Remote</button>
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
            --conflict-bg: rgba(255, 200, 0, 0.08);
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
        
        /* Floating action buttons */
        .floating-actions {
            position: fixed;
            top: 12px;
            right: 16px;
            display: flex;
            gap: 8px;
            z-index: 1000;
        }
        
        .btn {
            padding: 6px 14px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-family: inherit;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .btn-primary:hover {
            opacity: 0.9;
        }
        
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .btn-secondary:hover {
            opacity: 0.9;
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
        
        /* Column headers */
        .column-headers {
            display: grid;
            grid-template-columns: var(--col-base, 1fr) var(--col-local, 1fr) var(--col-remote, 1fr);
            border-bottom: 1px solid var(--border-color);
            flex-shrink: 0;
        }
        
        .column-header {
            padding: 10px 16px;
            font-weight: 600;
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            overflow: hidden;
        }
        
        .column-header.base { 
            color: var(--base-accent); 
            background: rgba(106, 115, 125, 0.1); 
        }
        .column-header.local { 
            color: var(--local-accent); 
            background: rgba(34, 134, 58, 0.1); 
        }
        .column-header.remote { 
            color: var(--remote-accent); 
            background: rgba(3, 102, 214, 0.1); 
        }
        
        /* Main content area */
        .merge-container {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
        }
        
        /* Merge rows */
        .merge-row {
            display: grid;
            grid-template-columns: var(--col-base, 1fr) var(--col-local, 1fr) var(--col-remote, 1fr);
            border-bottom: 1px solid var(--border-color);
            position: relative;
        }
        
        .merge-row.conflict-row {
            background: var(--conflict-bg);
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
        
        /* Resize handles between columns */
        .col-resize-handle {
            position: absolute;
            right: -3px;
            top: 0;
            bottom: 0;
            width: 6px;
            cursor: col-resize;
            background: transparent;
            z-index: 100;
        }
        
        .col-resize-handle:hover,
        .col-resize-handle.active {
            background: var(--vscode-focusBorder);
        }
        
        /* Notebook cells */
        .notebook-cell {
            padding: 12px;
        }
        
        .notebook-cell.has-conflict {
            border-left: 3px solid #f0ad4e;
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
            padding: 12px;
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
        
        /* Resolution bar */
        .resolution-bar {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            display: flex;
            justify-content: center;
            gap: 8px;
            padding: 8px;
            background: linear-gradient(transparent, var(--vscode-editor-background));
        }
        
        .btn-resolve {
            padding: 4px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            opacity: 0.9;
            transition: opacity 0.2s, transform 0.1s;
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
        
        /* Editor view for resolved conflicts */
        .merge-row.resolved-editing {
            background: rgba(40, 167, 69, 0.06);
        }
        
        .merge-row.resolved-editing .cell-column {
            background: transparent;
        }
        
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
        
        /* Hide original columns when in editing mode */
        .merge-row.resolved-editing .cell-column {
            display: none;
        }
        
        .merge-row.resolved-editing .resolution-bar {
            position: relative;
            background: transparent;
            padding: 12px 16px;
            justify-content: flex-start;
        }
        
        /* Markdown preview in editor */
        .result-markdown-preview {
            padding: 12px;
            background: var(--vscode-editor-background);
            border-top: 1px solid var(--border-color);
        }
        
        .preview-toggle {
            padding: 4px 8px;
            font-size: 11px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            margin-left: auto;
        }
        
        .preview-toggle:hover {
            opacity: 0.9;
        }
    </style>
</head>
<body>
    <div class="floating-actions">
        <button class="btn btn-secondary" onclick="cancel()">Cancel</button>
        <button class="btn btn-primary" onclick="applyResolutions()">Apply & Save</button>
    </div>
    
    ${autoResolveInfo}
    
    <div class="column-headers">
        <div class="column-header base">Base (Ancestor)</div>
        <div class="column-header local">Local${localBranch ? ` (${escapeHtml(localBranch)})` : ''}</div>
        <div class="column-header remote">Remote${remoteBranch ? ` (${escapeHtml(remoteBranch)})` : ''}</div>
    </div>
    
    <div class="merge-container">
        ${contentHtml}
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const resolutions = {};
        const totalConflicts = ${totalConflicts};
        const conflictType = '${conflictType}';
        
        // Column resizing - attach handles to first row's columns
        let isResizing = false;
        let currentColumn = null;
        let startX = 0;
        let colWidths = [0, 0, 0];
        
        function initResizeHandles() {
            const firstRow = document.querySelector('.merge-row');
            if (!firstRow) return;
            
            // Set initial pixel widths based on rendered layout
            const cols = firstRow.querySelectorAll('.cell-column');
            colWidths = Array.from(cols).map(c => c.offsetWidth);
            document.documentElement.style.setProperty('--col-base', colWidths[0] + 'px');
            document.documentElement.style.setProperty('--col-local', colWidths[1] + 'px');
            document.documentElement.style.setProperty('--col-remote', colWidths[2] + 'px');
            
            cols.forEach((col, i) => {
                if (i < 2) { // Only first two columns get resize handles
                    const handle = document.createElement('div');
                    handle.className = 'col-resize-handle';
                    handle.dataset.col = i;
                    col.appendChild(handle);
                    
                    handle.addEventListener('mousedown', (e) => {
                        isResizing = true;
                        currentColumn = i;
                        startX = e.clientX;
                        handle.classList.add('active');
                        
                        // Get current widths
                        const allCols = firstRow.querySelectorAll('.cell-column');
                        colWidths = Array.from(allCols).map(c => c.offsetWidth);
                        
                        e.preventDefault();
                        e.stopPropagation();
                    });
                }
            });
        }
        
        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            
            const delta = e.clientX - startX;
            const minWidth = 50;
            
            let newWidths = [...colWidths];
            newWidths[currentColumn] = Math.max(minWidth, colWidths[currentColumn] + delta);
            newWidths[currentColumn + 1] = Math.max(minWidth, colWidths[currentColumn + 1] - delta);
            
            document.documentElement.style.setProperty('--col-base', newWidths[0] + 'px');
            document.documentElement.style.setProperty('--col-local', newWidths[1] + 'px');
            document.documentElement.style.setProperty('--col-remote', newWidths[2] + 'px');
        });
        
        document.addEventListener('mouseup', () => {
            if (isResizing) {
                document.querySelectorAll('.col-resize-handle').forEach(h => h.classList.remove('active'));
                isResizing = false;
                currentColumn = null;
            }
        });
        
        // Initialize resize handles after DOM loads
        initResizeHandles();
        
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
            
            // Get source content based on choice
            const sourceAttr = \`data-\${choice}-source\`;
            const source = decodeURIComponent(row.getAttribute(sourceAttr) || '');
            const cellType = row.getAttribute('data-cell-type') || 'code';
            
            // Get outputs for the chosen side
            const outputsAttr = \`data-\${choice}-outputs\`;
            const outputsJson = row.getAttribute(outputsAttr);
            
            // Store the initial choice and content
            resolutions[index] = { 
                choice, 
                customContent: source,
                originalChoice: choice
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
                row.classList.add('resolved-editing');
            }
            
            // Build editor HTML
            const outputsHtml = renderOutputsFromData(outputsJson);
            const editorId = \`editor-\${index}\`;
            
            editorContainer.innerHTML = \`
                <div class="result-editor-header">
                    <span class="badge \${choice}">Using \${choice.toUpperCase()}</span>
                    <span class="edit-hint">Edit the result below (source only, outputs are preserved)</span>
                </div>
                <div class="result-editor-wrapper">
                    <textarea 
                        id="\${editorId}" 
                        class="result-editor" 
                        data-conflict="\${index}"
                        spellcheck="false"
                    >\${escapeHtmlInJs(source)}</textarea>
                </div>
                \${outputsHtml}
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
                    
                    // Auto-resize
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.max(120, e.target.scrollHeight) + 'px';
                });
            }
        }

        function applyResolutions() {
            const resolved = Object.keys(resolutions).length;
            if (resolved < totalConflicts) {
                if (!confirm(\`You have resolved \${resolved} of \${totalConflicts} conflicts. Unresolved conflicts will use LOCAL. Continue?\`)) {
                    return;
                }
                for (let i = 0; i < totalConflicts; i++) {
                    if (!resolutions[i]) {
                        // Default to local, get the source
                        const row = document.querySelector(\`.merge-row[data-conflict="\${i}"]\`);
                        const localSource = row ? decodeURIComponent(row.getAttribute('data-local-source') || '') : '';
                        resolutions[i] = { choice: 'local', customContent: localSource };
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
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Only trigger save if not focused on textarea
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.tagName !== 'TEXTAREA') {
                applyResolutions();
            } else if (e.key === 'Escape') {
                cancel();
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
