/**
 * @file resolver.ts
 * @description Main conflict resolution orchestrator for MergeNB.
 * 
 * The NotebookConflictResolver class coordinates the entire resolution workflow:
 * 1. Scans workspace for notebooks with conflicts (textual markers or Git UU status)
 * 2. Detects conflict type and retrieves base/local/remote versions from Git
 * 3. Applies auto-resolutions for trivial conflicts (execution counts, outputs)
 * 4. Opens the webview panel for manual resolution of remaining conflicts
 * 5. Applies user choices and writes the resolved notebook back to disk
 * 6. Stages the resolved file in Git
 */

import * as vscode from 'vscode';
import { analyzeNotebookConflicts, hasConflictMarkers, resolveAllConflicts, detectSemanticConflicts, applyAutoResolutions, AutoResolveResult, enrichTextualConflictsWithContext } from './conflictDetector';
import { parseNotebook, serializeNotebook, renumberExecutionCounts } from './notebookParser';
import { UnifiedConflictPanel, UnifiedConflict, UnifiedResolution } from './webview/ConflictResolverPanel';
import { ResolutionChoice, NotebookSemanticConflict, Notebook, NotebookCell } from './types';
import * as gitIntegration from './gitIntegration';
import { getSettings } from './settings';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const exec = promisify(execCallback);

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
     * Fast path: Only queries Git for unmerged files, no file scanning.
     */
    async findNotebooksWithConflicts(): Promise<ConflictedNotebook[]> {
        const withConflicts: ConflictedNotebook[] = [];
        
        // Fast path: Only get unmerged files from Git status
        const unmergedFiles = await gitIntegration.getUnmergedFiles();
        
        for (const file of unmergedFiles) {
            // Only process .ipynb files
            if (!file.path.endsWith('.ipynb')) {
                continue;
            }
            
            const uri = vscode.Uri.file(file.path);
            
            // Quick check if file has textual markers
            let hasTextual = false;
            try {
                const content = await this.readFile(uri);
                hasTextual = hasConflictMarkers(content);
            } catch {
                // File might not be readable, treat as semantic conflict
            }
            
            withConflicts.push({
                uri,
                hasTextualConflicts: hasTextual,
                hasSemanticConflicts: !hasTextual
            });
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
        let conflict = analyzeNotebookConflicts(uri.fsPath, content);

        if (conflict.conflicts.length === 0 && conflict.metadataConflicts.length === 0) {
            vscode.window.showWarningMessage('Conflict markers found but could not be parsed. The notebook may be corrupted.');
            return;
        }

        // Enrich with base/local/remote versions from Git to show full notebook context
        conflict = await enrichTextualConflictsWithContext(conflict);

        const settings = getSettings();

        const unifiedConflict: UnifiedConflict = {
            filePath: uri.fsPath,
            type: 'textual',
            textualConflict: conflict,
            hideNonConflictOutputs: settings.hideNonConflictOutputs
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
            autoResolveResult: autoResolveResult,
            hideNonConflictOutputs: settings.hideNonConflictOutputs
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
     * 
     * When conflicts are enriched with Git context (cellMappings), we build the
     * resolved notebook from the Git versions. Otherwise, we use textual marker
     * replacement on the original content.
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
        let resolvedContent: string;

        // If we have Git context (cellMappings), build notebook from chosen cells
        // This matches how the webview displays conflicts when enriched with context
        if (conflict.cellMappings && conflict.cellMappings.length > 0 && conflict.local) {
            const resolvedNotebook = this.buildResolvedNotebookFromChoices(
                conflict,
                resolutions
            );
            
            // Ask user if they want to renumber execution counts
            const renumber = await vscode.window.showQuickPick(
                ['Yes', 'No'],
                {
                    placeHolder: 'Renumber execution counts sequentially?',
                    title: 'Execution Counts'
                }
            );

            const finalNotebook = renumber === 'Yes' 
                ? renumberExecutionCounts(resolvedNotebook) 
                : resolvedNotebook;

            resolvedContent = serializeNotebook(finalNotebook);
        } else {
            // Fall back to textual marker replacement when no Git context
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

            resolvedContent = resolveAllConflicts(originalContent, resolutionArray);

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
        }

        // Write the resolved content
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(resolvedContent));

        // Mark as resolved with git add if requested
        if (resolution.markAsResolved) {
            await this.markFileAsResolved(uri);
        }

        vscode.window.showInformationMessage(`Resolved ${resolutions.size} conflict(s) in ${uri.fsPath}`);
    }

    /**
     * Build a resolved notebook from user choices when we have Git context.
     * This walks through cellMappings and picks cells based on user resolutions.
     */
    private buildResolvedNotebookFromChoices(
        conflict: ReturnType<typeof analyzeNotebookConflicts>,
        resolutions: Map<number, { choice: ResolutionChoice; customContent?: string }>
    ): Notebook {
        // Start with the local notebook as base (it has the structure we want)
        const localNotebook = conflict.local!;
        const remoteNotebook = conflict.remote;
        const baseNotebook = conflict.base;
        
        // Create a new notebook with the same metadata
        const resolvedNotebook: Notebook = {
            cells: [],
            metadata: JSON.parse(JSON.stringify(localNotebook.metadata)),
            nbformat: localNotebook.nbformat,
            nbformat_minor: localNotebook.nbformat_minor
        };

        // Track conflict index as we iterate through mappings
        let conflictIndex = 0;
        
        for (const mapping of conflict.cellMappings!) {
            const baseCell = mapping.baseIndex !== undefined && baseNotebook 
                ? baseNotebook.cells[mapping.baseIndex] : undefined;
            const localCell = mapping.localIndex !== undefined 
                ? localNotebook.cells[mapping.localIndex] : undefined;
            const remoteCell = mapping.remoteIndex !== undefined && remoteNotebook 
                ? remoteNotebook.cells[mapping.remoteIndex] : undefined;

            // Determine if this mapping represents a conflict (same logic as webview)
            let isConflict = false;
            
            if (localCell && !remoteCell && !baseCell) {
                isConflict = true; // Added in local only
            } else if (remoteCell && !localCell && !baseCell) {
                isConflict = true; // Added in remote only
            } else if (localCell && remoteCell) {
                const localSource = Array.isArray(localCell.source) ? localCell.source.join('') : localCell.source;
                const remoteSource = Array.isArray(remoteCell.source) ? remoteCell.source.join('') : remoteCell.source;
                if (localSource !== remoteSource) {
                    isConflict = true; // Content differs
                }
            } else if (baseCell && (!localCell || !remoteCell) && (localCell || remoteCell)) {
                isConflict = true; // Deleted in one branch
            }

            let cellToAdd: NotebookCell | undefined;

            if (isConflict) {
                // Get resolution for this conflict
                const res = resolutions.get(conflictIndex);
                // Choice could be 'local', 'remote', 'both', 'custom', or 'base' (from 3-way view)
                const choice = (res?.choice || 'local') as string;
                const customContent = res?.customContent;
                
                // Pick the cell based on choice
                if (choice === 'local' || choice === 'both') {
                    cellToAdd = localCell ? JSON.parse(JSON.stringify(localCell)) : undefined;
                } else if (choice === 'remote') {
                    cellToAdd = remoteCell ? JSON.parse(JSON.stringify(remoteCell)) : undefined;
                } else if (choice === 'base') {
                    cellToAdd = baseCell ? JSON.parse(JSON.stringify(baseCell)) : undefined;
                }

                // Apply custom content if provided (user edited the cell)
                if (customContent !== undefined && cellToAdd) {
                    if (Array.isArray(cellToAdd.source)) {
                        cellToAdd.source = customContent === '' ? [] : customContent.split(/(?<=\n)/);
                    } else {
                        cellToAdd.source = customContent;
                    }
                } else if (customContent !== undefined && !cellToAdd && customContent.trim().length > 0) {
                    // User added content to a deleted cell - create a new cell
                    // Use the cell type from the non-deleted side, or default to 'code'
                    const referenceCell = localCell || remoteCell || baseCell;
                    const cellType = referenceCell?.cell_type || 'code';
                    cellToAdd = {
                        cell_type: cellType,
                        metadata: referenceCell?.metadata || {},
                        source: customContent.split(/(?<=\n)/)
                    } as NotebookCell;
                    
                    // Add execution_count and outputs for code cells
                    if (cellType === 'code') {
                        (cellToAdd as any).execution_count = null;
                        (cellToAdd as any).outputs = [];
                    }
                }

                // For 'both', also add remote cell after local
                if (choice === 'both' && remoteCell && cellToAdd) {
                    resolvedNotebook.cells.push(cellToAdd);
                    cellToAdd = JSON.parse(JSON.stringify(remoteCell));
                }

                conflictIndex++;
            } else {
                // Not a conflict - use the available cell
                cellToAdd = localCell || remoteCell || baseCell;
                if (cellToAdd) {
                    cellToAdd = JSON.parse(JSON.stringify(cellToAdd));
                }
            }

            if (cellToAdd) {
                resolvedNotebook.cells.push(cellToAdd);
            }
        }

        return resolvedNotebook;
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
            const customContent = res.customContent;

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

            // If custom content was provided (user edited the result), apply it to the cell
            if (customContent !== undefined && cellToUse) {
                const editedCell: NotebookCell = JSON.parse(JSON.stringify(cellToUse));
                // Convert source to the same format (string or string[]) as original
                if (Array.isArray(editedCell.source)) {
                    // Split by newlines, preserving them at the end of each line
                    if (customContent === '') {
                        editedCell.source = [];
                    } else {
                        editedCell.source = customContent.split(/(?<=\n)/);
                    }
                } else {
                    editedCell.source = customContent;
                }
                cellToUse = editedCell;
            }

            // Apply the resolution based on conflict type
            if (conflict.type === 'cell-modified' || conflict.type === 'outputs-changed' || 
                conflict.type === 'execution-count-changed' || conflict.type === 'metadata-changed') {
                // Replace the cell at the local index with the chosen version
                if (conflict.localCellIndex !== undefined) {
                    if (cellToUse) {
                        // Replace with the chosen cell
                        resolvedNotebook.cells[conflict.localCellIndex] = JSON.parse(JSON.stringify(cellToUse));
                    } else {
                        // Chosen side has no cell - mark for deletion
                        cellsToRemove.add(conflict.localCellIndex);
                    }
                }
            } else if (conflict.type === 'cell-added') {
                // For added cells, handle all three choices
                if (choice === 'local' && conflict.localContent) {
                    // Keep local addition - already in resolvedNotebook
                    // No action needed
                } else if (choice === 'remote' && conflict.remoteContent) {
                    // Add remote cell
                    const insertIndex = conflict.remoteCellIndex ?? resolvedNotebook.cells.length;
                    resolvedNotebook.cells.splice(insertIndex, 0, JSON.parse(JSON.stringify(conflict.remoteContent)));
                } else if (choice === 'base') {
                    // Use base (which doesn't have this cell) - remove if exists locally
                    if (conflict.localCellIndex !== undefined) {
                        cellsToRemove.add(conflict.localCellIndex);
                    }
                }
            } else if (conflict.type === 'cell-deleted') {
                if (choice === 'local' && conflict.localContent) {
                    // Keep local version (reject deletion) - already in resolvedNotebook
                    // No action needed
                } else if (choice === 'remote' && conflict.localCellIndex !== undefined) {
                    // Accept remote deletion - mark for removal
                    cellsToRemove.add(conflict.localCellIndex);
                } else if (choice === 'base' && conflict.baseContent) {
                    // Restore base cell
                    const insertIndex = conflict.localCellIndex ?? conflict.remoteCellIndex ?? resolvedNotebook.cells.length;
                    resolvedNotebook.cells.splice(insertIndex, 0, JSON.parse(JSON.stringify(conflict.baseContent)));
                } else if (choice === 'base' && !conflict.baseContent && conflict.localCellIndex !== undefined) {
                    // Base has no cell either - delete it
                    cellsToRemove.add(conflict.localCellIndex);
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
        await this.saveResolvedNotebook(uri, resolvedNotebook, resolution.markAsResolved);
        vscode.window.showInformationMessage(`Resolved ${resolutions.size} semantic conflict(s) in ${uri.fsPath}`);
    }

    /**
     * Save a resolved notebook to disk.
     */
    private async saveResolvedNotebook(uri: vscode.Uri, notebook: Notebook, markAsResolved: boolean = false): Promise<void> {
        const content = serializeNotebook(notebook);
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
        
        // Mark as resolved with git add if requested
        if (markAsResolved) {
            await this.markFileAsResolved(uri);
        }
    }

    private async readFile(uri: vscode.Uri): Promise<string> {
        const data = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(data);
    }

    /**
     * Mark a file as resolved by staging it with git add.
     */
    private async markFileAsResolved(uri: vscode.Uri): Promise<void> {
        try {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!workspaceFolder) {
                vscode.window.showWarningMessage('Cannot mark file as resolved: not in a workspace');
                return;
            }
            
            const relativePath = vscode.workspace.asRelativePath(uri, false);
            await exec(`git add "${relativePath}"`, { cwd: workspaceFolder.uri.fsPath });
            vscode.window.showInformationMessage(`Marked ${relativePath} as resolved`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to mark file as resolved: ${error}`);
        }
    }
}
