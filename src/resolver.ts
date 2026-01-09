import * as vscode from 'vscode';
import { analyzeNotebookConflicts, hasConflictMarkers, resolveAllConflicts, detectSemanticConflicts, applyAutoResolutions, AutoResolveResult } from './conflictDetector';
import { parseNotebook, serializeNotebook, renumberExecutionCounts } from './notebookParser';
import { UnifiedConflictPanel, UnifiedConflict, UnifiedResolution } from './webview/ConflictResolverPanel';
import { ResolutionChoice, NotebookSemanticConflict, Notebook, NotebookCell } from './types';
import * as gitIntegration from './gitIntegration';
import { getSettings } from './settings';

/**
 * Represents a notebook with any type of conflict (textual or semantic)
 */
export interface ConflictedNotebook {
    uri: vscode.Uri;
    hasTextualConflicts: boolean;
    hasSemanticConflicts: boolean;
}

/**
 * Main service for handling notebook merge conflict resolution.
 */
export class NotebookConflictResolver {
    constructor(private readonly extensionUri: vscode.Uri) {}

    /**
     * Check if a file has textual merge conflicts.
     */
    async hasTextualConflicts(uri: vscode.Uri): Promise<boolean> {
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
     * Check if a file has any type of conflict.
     */
    async hasAnyConflicts(uri: vscode.Uri): Promise<ConflictedNotebook | null> {
        try {
            const content = await this.readFile(uri);
            const hasTextual = hasConflictMarkers(content);
            
            // Check for semantic conflicts only if no textual markers
            let hasSemantic = false;
            if (!hasTextual) {
                const isUnmerged = await gitIntegration.isUnmergedFile(uri.fsPath);
                hasSemantic = isUnmerged;
            }

            if (hasTextual || hasSemantic) {
                return {
                    uri,
                    hasTextualConflicts: hasTextual,
                    hasSemanticConflicts: hasSemantic
                };
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Find all notebook files with any type of conflict in the workspace.
     * Checks both textual conflicts and Git unmerged status.
     */
    async findNotebooksWithConflicts(): Promise<ConflictedNotebook[]> {
        const withConflicts: ConflictedNotebook[] = [];
        
        // Get all notebooks in workspace
        const notebooks = await vscode.workspace.findFiles('**/*.ipynb', '**/node_modules/**');
        
        // Get unmerged files from Git
        const unmergedFiles = await gitIntegration.getUnmergedFiles();
        const unmergedPaths = new Set(unmergedFiles.map(f => f.path));
        
        for (const uri of notebooks) {
            const conflict = await this.hasAnyConflicts(uri);
            if (conflict) {
                withConflicts.push(conflict);
            } else if (unmergedPaths.has(uri.fsPath)) {
                // File is unmerged according to Git but might not have parsed yet
                withConflicts.push({
                    uri,
                    hasTextualConflicts: false,
                    hasSemanticConflicts: true
                });
            }
        }
        
        return withConflicts;
    }

    /**
     * Resolve conflicts in a notebook - handles both textual and semantic.
     */
    async resolveConflicts(uri: vscode.Uri): Promise<void> {
        const content = await this.readFile(uri);
        const hasTextual = hasConflictMarkers(content);
        
        if (hasTextual) {
            // Handle textual conflicts
            await this.resolveTextualConflicts(uri, content);
        } else {
            // Check for semantic conflicts
            const isUnmerged = await gitIntegration.isUnmergedFile(uri.fsPath);
            if (isUnmerged) {
                await this.resolveSemanticConflicts(uri);
            } else {
                vscode.window.showInformationMessage('No merge conflicts found in this notebook.');
            }
        }
    }

    /**
     * Resolve textual conflicts (<<<<<<< markers).
     */
    private async resolveTextualConflicts(uri: vscode.Uri, content: string): Promise<void> {
        const conflict = analyzeNotebookConflicts(uri.fsPath, content);

        if (conflict.conflicts.length === 0 && conflict.metadataConflicts.length === 0) {
            vscode.window.showWarningMessage('Conflict markers found but could not be parsed. The notebook may be corrupted.');
            return;
        }

        const unifiedConflict: UnifiedConflict = {
            filePath: uri.fsPath,
            type: 'textual',
            textualConflict: conflict
        };

        UnifiedConflictPanel.createOrShow(
            this.extensionUri,
            unifiedConflict,
            async (resolution) => {
                await this.applyTextualResolutions(uri, content, conflict, resolution);
            }
        );
    }

    /**
     * Resolve semantic conflicts (Git UU status without textual markers).
     * Auto-resolves execution count and kernel version differences based on settings.
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

        // Apply auto-resolutions based on settings
        const settings = getSettings();
        const autoResolveResult = applyAutoResolutions(semanticConflict, settings);

        // Show what was auto-resolved
        if (autoResolveResult.autoResolvedCount > 0) {
            const autoResolved = autoResolveResult.autoResolvedDescriptions.join(', ');
            vscode.window.showInformationMessage(`Auto-resolved: ${autoResolved}`);
        }

        // If all conflicts were auto-resolved, save and return
        if (autoResolveResult.remainingConflicts.length === 0) {
            // Ask user if they want to renumber execution counts
            const renumber = await vscode.window.showQuickPick(
                ['Yes', 'No'],
                {
                    placeHolder: 'Renumber execution counts sequentially?',
                    title: 'Execution Counts'
                }
            );

            let finalNotebook = autoResolveResult.resolvedNotebook;
            if (renumber === 'Yes') {
                finalNotebook = renumberExecutionCounts(finalNotebook);
            }

            await this.saveResolvedNotebook(uri, finalNotebook);
            vscode.window.showInformationMessage(
                `All ${semanticConflict.semanticConflicts.length} conflicts were auto-resolved.`
            );
            return;
        }

        // Create a modified semantic conflict with only remaining conflicts
        const filteredSemanticConflict: NotebookSemanticConflict = {
            ...semanticConflict,
            semanticConflicts: autoResolveResult.remainingConflicts
        };

        const unifiedConflict: UnifiedConflict = {
            filePath: uri.fsPath,
            type: 'semantic',
            semanticConflict: filteredSemanticConflict,
            autoResolveResult: autoResolveResult
        };

        UnifiedConflictPanel.createOrShow(
            this.extensionUri,
            unifiedConflict,
            async (resolution) => {
                await this.applySemanticResolutions(uri, filteredSemanticConflict, resolution, autoResolveResult);
            }
        );
    }

    /**
     * Apply textual conflict resolutions.
     */
    private async applyTextualResolutions(
        uri: vscode.Uri,
        originalContent: string,
        conflict: ReturnType<typeof analyzeNotebookConflicts>,
        resolution: UnifiedResolution
    ): Promise<void> {
        if (resolution.type !== 'textual' || !resolution.textualResolutions) {
            return;
        }

        const resolutions = resolution.textualResolutions;

        // Build resolution array with markers
        const allConflicts = [
            ...conflict.conflicts.map((c, i) => ({ marker: c.marker, index: i })),
            ...conflict.metadataConflicts.map((c, i) => ({ marker: c.marker, index: i + conflict.conflicts.length }))
        ];

        const resolutionArray = allConflicts.map(({ marker, index }) => {
            const res = resolutions.get(index) || { choice: 'local' as ResolutionChoice };
            return {
                marker,
                choice: res.choice === 'custom' ? 'local' : res.choice as 'local' | 'remote' | 'both',
                customContent: res.customContent
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

    /**
     * Apply semantic conflict resolutions.
     */
    private async applySemanticResolutions(
        uri: vscode.Uri,
        semanticConflict: NotebookSemanticConflict,
        resolution: UnifiedResolution,
        autoResolveResult?: AutoResolveResult
    ): Promise<void> {
        if (resolution.type !== 'semantic') {
            return;
        }

        const resolutions = resolution.semanticResolutions;
        if (!resolutions || resolutions.size === 0) {
            // If no manual resolutions but we have auto-resolutions, use those
            if (autoResolveResult) {
                let resolvedNotebook = autoResolveResult.resolvedNotebook;
                
                const renumber = await vscode.window.showQuickPick(
                    ['Yes', 'No'],
                    {
                        placeHolder: 'Renumber execution counts sequentially?',
                        title: 'Execution Counts'
                    }
                );

                if (renumber === 'Yes') {
                    resolvedNotebook = renumberExecutionCounts(resolvedNotebook);
                }

                await this.saveResolvedNotebook(uri, resolvedNotebook);
                vscode.window.showInformationMessage(`Resolved conflicts in ${uri.fsPath}`);
                return;
            }
            return;
        }

        // Build the resolved notebook by applying each resolution
        const localNotebook = semanticConflict.local;
        const remoteNotebook = semanticConflict.remote;

        if (!localNotebook && !remoteNotebook) {
            vscode.window.showErrorMessage('Cannot apply resolutions: no notebook versions available.');
            return;
        }

        // Start with auto-resolved notebook if available, otherwise local
        let resolvedNotebook: Notebook = autoResolveResult 
            ? JSON.parse(JSON.stringify(autoResolveResult.resolvedNotebook))
            : (localNotebook 
                ? JSON.parse(JSON.stringify(localNotebook)) 
                : JSON.parse(JSON.stringify(remoteNotebook!)));

        // Track which cells we've processed
        const cellsToRemove = new Set<number>();

        // Apply resolutions to each conflict
        for (const [index, res] of resolutions) {
            const conflict = semanticConflict.semanticConflicts[index];
            if (!conflict) continue;

            const choice = res.choice;

            // Get the cell to use based on choice
            let cellToUse: NotebookCell | undefined;

            switch (choice) {
                case 'base':
                    cellToUse = conflict.baseContent;
                    break;
                case 'local':
                    cellToUse = conflict.localContent;
                    break;
                case 'remote':
                    cellToUse = conflict.remoteContent;
                    break;
            }

            // Apply the resolution based on conflict type
            if (conflict.type === 'cell-modified' || conflict.type === 'outputs-changed' || 
                conflict.type === 'execution-count-changed' || conflict.type === 'metadata-changed') {
                // Replace the cell at the local index with the chosen version
                if (cellToUse && conflict.localCellIndex !== undefined) {
                    resolvedNotebook.cells[conflict.localCellIndex] = JSON.parse(JSON.stringify(cellToUse));
                }
            } else if (conflict.type === 'cell-added') {
                // For added cells, we might need to insert or skip
                if (choice === 'remote' && conflict.remoteContent && !conflict.localContent) {
                    // Add remote cell that doesn't exist locally
                    const insertIndex = conflict.remoteCellIndex ?? resolvedNotebook.cells.length;
                    resolvedNotebook.cells.splice(insertIndex, 0, JSON.parse(JSON.stringify(conflict.remoteContent)));
                }
            } else if (conflict.type === 'cell-deleted') {
                if (choice === 'remote' && conflict.localCellIndex !== undefined) {
                    // Accept remote deletion - mark for removal
                    cellsToRemove.add(conflict.localCellIndex);
                } else if (choice === 'base' && conflict.baseContent) {
                    // Restore base cell
                    const insertIndex = conflict.localCellIndex ?? conflict.remoteCellIndex ?? resolvedNotebook.cells.length;
                    resolvedNotebook.cells.splice(insertIndex, 0, JSON.parse(JSON.stringify(conflict.baseContent)));
                }
            }
        }

        // Remove any cells marked for deletion (in reverse order to preserve indices)
        const sortedIndices = Array.from(cellsToRemove).sort((a, b) => b - a);
        for (const idx of sortedIndices) {
            resolvedNotebook.cells.splice(idx, 1);
        }

        // Ask user if they want to renumber execution counts
        const renumber = await vscode.window.showQuickPick(
            ['Yes', 'No'],
            {
                placeHolder: 'Renumber execution counts sequentially?',
                title: 'Execution Counts'
            }
        );

        if (renumber === 'Yes') {
            resolvedNotebook = renumberExecutionCounts(resolvedNotebook);
        }

        // Save the resolved notebook
        await this.saveResolvedNotebook(uri, resolvedNotebook);
        vscode.window.showInformationMessage(`Resolved ${resolutions.size} semantic conflict(s) in ${uri.fsPath}`);
    }

    /**
     * Save a resolved notebook to disk.
     */
    private async saveResolvedNotebook(uri: vscode.Uri, notebook: Notebook): Promise<void> {
        const content = serializeNotebook(notebook);
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
    }

    private async readFile(uri: vscode.Uri): Promise<string> {
        const data = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(data);
    }
}
