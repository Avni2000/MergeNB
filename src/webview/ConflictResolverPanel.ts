import * as vscode from 'vscode';
import { NotebookConflict, CellConflict, ResolutionChoice } from '../types';

export class ConflictResolverPanel {
    public static currentPanel: ConflictResolverPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _conflict: NotebookConflict | undefined;
    private _onResolutionComplete: ((resolutions: Map<number, { choice: ResolutionChoice; customContent?: string }>) => void) | undefined;

    public static createOrShow(
        extensionUri: vscode.Uri, 
        conflict: NotebookConflict,
        onResolutionComplete: (resolutions: Map<number, { choice: ResolutionChoice; customContent?: string }>) => void
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ConflictResolverPanel.currentPanel) {
            ConflictResolverPanel.currentPanel._panel.reveal(column);
            ConflictResolverPanel.currentPanel.setConflict(conflict, onResolutionComplete);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'mergeNbConflictResolver',
            'Notebook Merge Conflicts',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        ConflictResolverPanel.currentPanel = new ConflictResolverPanel(panel, extensionUri, conflict, onResolutionComplete);
    }

    private constructor(
        panel: vscode.WebviewPanel, 
        extensionUri: vscode.Uri,
        conflict: NotebookConflict,
        onResolutionComplete: (resolutions: Map<number, { choice: ResolutionChoice; customContent?: string }>) => void
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
                        this._handleResolution(message.resolutions);
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
        conflict: NotebookConflict,
        onResolutionComplete: (resolutions: Map<number, { choice: ResolutionChoice; customContent?: string }>) => void
    ) {
        this._conflict = conflict;
        this._onResolutionComplete = onResolutionComplete;
        this._update();
    }

    private _handleResolution(resolutions: Array<{ index: number; choice: ResolutionChoice; customContent?: string }>) {
        const resolutionMap = new Map<number, { choice: ResolutionChoice; customContent?: string }>();
        for (const r of resolutions) {
            resolutionMap.set(r.index, { choice: r.choice, customContent: r.customContent });
        }
        if (this._onResolutionComplete) {
            this._onResolutionComplete(resolutionMap);
        }
        this._panel.dispose();
    }

    public dispose() {
        ConflictResolverPanel.currentPanel = undefined;
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

        const conflictsHtml = conflict.conflicts.map((c, i) => this._renderConflict(c, i)).join('');
        const metadataConflictsHtml = conflict.metadataConflicts.map((c, i) => 
            this._renderMetadataConflict(c, i + conflict.conflicts.length)
        ).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Notebook Merge Conflicts</title>
    <style>
        :root {
            --vscode-bg: var(--vscode-editor-background);
            --vscode-fg: var(--vscode-editor-foreground);
            --local-bg: rgba(0, 128, 0, 0.15);
            --remote-bg: rgba(0, 100, 255, 0.15);
            --local-border: #22863a;
            --remote-border: #0366d6;
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
        .conflict-side {
            padding: 15px;
        }
        .conflict-local {
            background: var(--local-bg);
            border-right: 2px solid var(--vscode-panel-border);
        }
        .conflict-remote {
            background: var(--remote-bg);
        }
        .side-label {
            font-size: 0.8em;
            font-weight: bold;
            margin-bottom: 10px;
            text-transform: uppercase;
        }
        .local-label { color: var(--local-border); }
        .remote-label { color: var(--remote-border); }
        pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 0.85em;
            margin: 0;
            white-space: pre-wrap;
            word-break: break-word;
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
    </style>
</head>
<body>
    <h1>🔀 Notebook Merge Conflicts</h1>
    <div class="file-path">${escapeHtml(conflict.filePath)}</div>
    
    <p>Found <strong>${conflict.conflicts.length + conflict.metadataConflicts.length}</strong> conflict(s). Choose how to resolve each one:</p>
    
    ${conflictsHtml}
    ${metadataConflictsHtml}
    
    <div class="actions">
        <button class="btn-primary" onclick="cancel()">Cancel</button>
        <button class="btn-primary" onclick="applyResolutions()">Apply Resolutions</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const resolutions = {};
        const totalConflicts = ${conflict.conflicts.length + conflict.metadataConflicts.length};

        function selectResolution(index, choice) {
            resolutions[index] = { choice };
            
            // Update button states
            document.querySelectorAll(\`.conflict-\${index} button\`).forEach(btn => {
                btn.classList.remove('btn-selected');
            });
            document.querySelector(\`.conflict-\${index} .btn-\${choice}\`).classList.add('btn-selected');
        }

        function applyResolutions() {
            const resolved = Object.keys(resolutions).length;
            if (resolved < totalConflicts) {
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
            
            vscode.postMessage({ command: 'resolve', resolutions: resolutionArray });
        }

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }
    </script>
</body>
</html>`;
    }

    private _renderConflict(conflict: CellConflict, index: number): string {
        const isOutputConflict = conflict.field === 'outputs';
        // Cell-level conflicts have marker.start > 0 (cell index of start marker)
        const isCellLevelConflict = conflict.marker.start > 0 || (conflict.marker.middle > 0);
        
        const outputNote = isOutputConflict 
            ? '<p style="color: var(--vscode-editorWarning-foreground); font-size: 0.85em; margin-top: 10px;">⚠️ Output conflicts will clear the cell outputs. Re-run the cell after resolving.</p>'
            : '';
        
        const cellLevelNote = isCellLevelConflict
            ? '<p style="color: var(--vscode-textLink-foreground); font-size: 0.85em; margin-top: 5px; margin-bottom: 10px;">📝 Cell-level conflict: entire cells differ between branches. Choosing "Accept Local" or "Accept Remote" will keep only those cells.</p>'
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
            <div class="side-label local-label">⬅ Local (${conflict.marker.localBranch || 'Current'})</div>
            <pre>${escapeHtml(conflict.localContent)}</pre>
        </div>
        <div class="conflict-side conflict-remote">
            <div class="side-label remote-label">➡ Remote (${conflict.marker.remoteBranch || 'Incoming'})</div>
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
        <span>Notebook Metadata - <span class="badge">${conflict.field}</span></span>
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
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
