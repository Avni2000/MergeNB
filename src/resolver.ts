import * as vscode from 'vscode';
import { analyzeNotebookConflicts, hasConflictMarkers, resolveAllConflicts, detectSemanticConflicts } from './conflictDetector';
import { parseNotebook, serializeNotebook, renumberExecutionCounts } from './notebookParser';
import { ConflictResolverPanel } from './webview/ConflictResolverPanel';
import { ResolutionChoice, NotebookSemanticConflict } from './types';
import * as gitIntegration from './gitIntegration';

/**
 * Main service for handling notebook merge conflict resolution.
 */
export class NotebookConflictResolver {
    constructor(private readonly extensionUri: vscode.Uri) {}

    /**
     * Check if a file has merge conflicts.
     */
    async hasConflicts(uri: vscode.Uri): Promise<boolean> {
        try {
            const content = await this.readFile(uri);
            return hasConflictMarkers(content);
        } catch {
            return false;
        }
    }

    /**
     * Check if a file has semantic conflicts (Git UU status without textual markers).
     */
    async hasSemanticConflicts(uri: vscode.Uri): Promise<boolean> {
        try {
            const isUnmerged = await gitIntegration.isUnmergedFile(uri.fsPath);
            if (!isUnmerged) return false;

            const content = await this.readFile(uri);
            return !hasConflictMarkers(content);
        } catch {
            return false;
        }
    }

    /**
     * Find all notebook files with conflicts in the workspace.
     */
    async findNotebooksWithConflicts(): Promise<vscode.Uri[]> {
        const notebooks = await vscode.workspace.findFiles('**/*.ipynb', '**/node_modules/**');
        const withConflicts: vscode.Uri[] = [];
        
        for (const uri of notebooks) {
            if (await this.hasConflicts(uri)) {
                withConflicts.push(uri);
            }
        }
        
        return withConflicts;
    }

    /**
     * Open the conflict resolver UI for a specific notebook.
     */
    async resolveConflicts(uri: vscode.Uri): Promise<void> {
        const content = await this.readFile(uri);
        
        if (!hasConflictMarkers(content)) {
            vscode.window.showInformationMessage('No merge conflicts found in this notebook.');
            return;
        }

        const conflict = analyzeNotebookConflicts(uri.fsPath, content);
        
        if (conflict.conflicts.length === 0 && conflict.metadataConflicts.length === 0) {
            vscode.window.showWarningMessage('Conflict markers found but could not be parsed. The notebook may be corrupted.');
            return;
        }

        ConflictResolverPanel.createOrShow(
            this.extensionUri,
            conflict,
            async (resolutions) => {
                await this.applyResolutions(uri, content, conflict, resolutions);
            }
        );
    }

    /**
     * Resolve semantic conflicts (Git UU status without textual markers).
     */
    async resolveSemanticConflicts(uri: vscode.Uri): Promise<void> {
        const semanticConflict = await detectSemanticConflicts(uri.fsPath);
        
        if (!semanticConflict) {
            vscode.window.showInformationMessage('No semantic conflicts detected.');
            return;
        }

        if (semanticConflict.semanticConflicts.length === 0) {
            vscode.window.showInformationMessage('Notebook is in unmerged state but no conflicts detected.');
            return;
        }

        // For now, show a summary of conflicts
        await this.showSemanticConflictSummary(semanticConflict);
    }

    /**
     * Show a summary of semantic conflicts to the user.
     */
    private async showSemanticConflictSummary(conflict: NotebookSemanticConflict): Promise<void> {
        const summary = this.generateConflictSummary(conflict);
        
        const action = await vscode.window.showInformationMessage(
            `Found ${conflict.semanticConflicts.length} semantic conflict(s) in notebook`,
            { modal: true, detail: summary },
            'Accept Local',
            'Accept Remote',
            'Cancel'
        );

        if (action === 'Accept Local' && conflict.local) {
            await this.saveResolvedNotebook(vscode.Uri.file(conflict.filePath), conflict.local);
            vscode.window.showInformationMessage('Accepted local version.');
        } else if (action === 'Accept Remote' && conflict.remote) {
            await this.saveResolvedNotebook(vscode.Uri.file(conflict.filePath), conflict.remote);
            vscode.window.showInformationMessage('Accepted remote version.');
        }
    }

    /**
     * Generate a human-readable summary of semantic conflicts.
     */
    private generateConflictSummary(conflict: NotebookSemanticConflict): string {
        const lines: string[] = [];
        
        if (conflict.localBranch && conflict.remoteBranch) {
            lines.push(`Merging: ${conflict.localBranch} ← ${conflict.remoteBranch}\n`);
        }

        const cellCounts = [
            `Base: ${conflict.base?.cells.length || 0} cells`,
            `Local: ${conflict.local?.cells.length || 0} cells`,
            `Remote: ${conflict.remote?.cells.length || 0} cells`
        ];
        lines.push(cellCounts.join(', ') + '\n');

        const conflictTypes = new Map<string, number>();
        for (const c of conflict.semanticConflicts) {
            conflictTypes.set(c.type, (conflictTypes.get(c.type) || 0) + 1);
        }

        lines.push('Conflicts detected:');
        for (const [type, count] of conflictTypes) {
            lines.push(`  • ${count}× ${type.replace(/-/g, ' ')}`);
        }

        return lines.join('\n');
    }

    /**
     * Save a resolved notebook to disk.
     */
    private async saveResolvedNotebook(uri: vscode.Uri, notebook: any): Promise<void> {
        const content = serializeNotebook(notebook);
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
    }

    /**
     * Apply user's conflict resolutions and save the file.
     */
    private async applyResolutions(
        uri: vscode.Uri,
        originalContent: string,
        conflict: ReturnType<typeof analyzeNotebookConflicts>,
        resolutions: Map<number, { choice: ResolutionChoice; customContent?: string }>
    ): Promise<void> {
        // Build resolution array with markers
        const allConflicts = [
            ...conflict.conflicts.map((c, i) => ({ marker: c.marker, index: i })),
            ...conflict.metadataConflicts.map((c, i) => ({ marker: c.marker, index: i + conflict.conflicts.length }))
        ];

        const resolutionArray = allConflicts.map(({ marker, index }) => {
            const resolution = resolutions.get(index) || { choice: 'local' as ResolutionChoice };
            return {
                marker,
                choice: resolution.choice === 'custom' ? 'local' : resolution.choice as 'local' | 'remote' | 'both',
                customContent: resolution.customContent
            };
        });

        let resolvedContent = resolveAllConflicts(originalContent, resolutionArray);

        // Try to parse and validate the resolved notebook
        try {
            let notebook = parseNotebook(resolvedContent);
            
            // Ask user if they want to renumber execution counts
            const renumber = await vscode.window.showQuickPick(
                ['Yes', 'No'],
                { 
                    placeHolder: 'Renumber execution counts sequentially?',
                    title: 'Execution Counts'
                }
            );
            
            if (renumber === 'Yes') {
                notebook = renumberExecutionCounts(notebook);
            }
            
            resolvedContent = serializeNotebook(notebook);
        } catch (err) {
            const proceed = await vscode.window.showWarningMessage(
                'The resolved notebook has JSON errors. Save anyway?',
                'Save', 'Cancel'
            );
            if (proceed !== 'Save') {
                return;
            }
        }

        // Write the resolved content
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(resolvedContent));
        
        vscode.window.showInformationMessage(`Resolved ${resolutions.size} conflict(s) in ${uri.fsPath}`);
    }

    private async readFile(uri: vscode.Uri): Promise<string> {
        const data = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(data);
    }
}

/**
 * Quick resolve all conflicts in a notebook using a single strategy.
 */
export async function quickResolveAll(
    uri: vscode.Uri, 
    strategy: 'local' | 'remote'
): Promise<void> {
    const data = await vscode.workspace.fs.readFile(uri);
    const content = new TextDecoder().decode(data);
    
    if (!hasConflictMarkers(content)) {
        vscode.window.showInformationMessage('No merge conflicts found.');
        return;
    }

    const conflict = analyzeNotebookConflicts(uri.fsPath, content);
    const allMarkers = [
        ...conflict.conflicts.map(c => c.marker),
        ...conflict.metadataConflicts.map(c => c.marker)
    ];

    const resolutions = allMarkers.map(marker => ({
        marker,
        choice: strategy as 'local' | 'remote' | 'both'
    }));

    let resolvedContent = resolveAllConflicts(content, resolutions);
    
    try {
        const notebook = parseNotebook(resolvedContent);
        resolvedContent = serializeNotebook(notebook);
    } catch {
        // Keep as-is if parsing fails
    }

    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(resolvedContent));
    
    vscode.window.showInformationMessage(
        `Resolved all conflicts using ${strategy.toUpperCase()} version.`
    );
}
