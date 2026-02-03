/**
 * @file resolver.ts
 * @description Main conflict resolution orchestrator for MergeNB.
 * 
 * The NotebookConflictResolver class coordinates the entire resolution workflow:
 * 1. Scans workspace for notebooks with Git UU status
 * 2. Detects semantic conflicts and retrieves base/current/incoming versions from Git
 * 3. Applies auto-resolutions for trivial conflicts (execution counts, outputs)
 * 4. Opens the webview panel for manual resolution of remaining conflicts
 * 5. Applies user choices and writes the resolved notebook back to disk
 * 6. Stages the resolved file in Git
 */

import * as vscode from 'vscode';
import { detectSemanticConflicts, applyAutoResolutions, AutoResolveResult } from './conflictDetector';
import { serializeNotebook, renumberExecutionCounts } from './notebookParser';
import { WebConflictPanel } from './web/WebConflictPanel';
import { UnifiedConflict, UnifiedResolution } from './web/webTypes';
import { ResolutionChoice, NotebookSemanticConflict, Notebook, NotebookCell, SemanticConflict } from './types';
import * as gitIntegration from './gitIntegration';
import { getSettings } from './settings';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const exec = promisify(execCallback);

/**
 * Represents a notebook with semantic conflicts (Git UU status)
 */
export interface ConflictedNotebook {
    uri: vscode.Uri;
    hasSemanticConflicts: boolean;
}

/**
 * Main service for handling notebook merge conflict resolution.
 */
export class NotebookConflictResolver {
    constructor(private readonly extensionUri: vscode.Uri) {}

    /**
     * Check if a file has semantic conflicts (Git UU status).
     */
    async hasSemanticConflicts(uri: vscode.Uri): Promise<boolean> {
        try {
            return await gitIntegration.isUnmergedFile(uri.fsPath);
        } catch {
            return false;
        }
    }

    /**
     * Check if a file has conflicts (Git UU status).
     */
    async hasAnyConflicts(uri: vscode.Uri): Promise<ConflictedNotebook | null> {
        try {
            const isUnmerged = await gitIntegration.isUnmergedFile(uri.fsPath);
            
            if (isUnmerged) {
                return {
                    uri,
                    hasSemanticConflicts: true
                };
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Find all notebook files with conflicts (Git UU status) in the workspace.
     * Only queries Git for unmerged files, no file scanning.
     */
    async findNotebooksWithConflicts(): Promise<ConflictedNotebook[]> {
        const withConflicts: ConflictedNotebook[] = [];
        
        // Get unmerged files from Git status
        const unmergedFiles = await gitIntegration.getUnmergedFiles();
        
        for (const file of unmergedFiles) {
            // Only process .ipynb files
            if (!file.path.endsWith('.ipynb')) {
                continue;
            }
            
            const uri = vscode.Uri.file(file.path);
            
            withConflicts.push({
                uri,
                hasSemanticConflicts: true
            });
        }
        
        return withConflicts;
    }

    /**
     * Resolve semantic conflicts in a notebook.
     */
    async resolveConflicts(uri: vscode.Uri): Promise<void> {
        // Check for semantic conflicts (Git UU status)
        const isUnmerged = await gitIntegration.isUnmergedFile(uri.fsPath);
        if (isUnmerged) {
            await this.resolveSemanticConflicts(uri);
        } else {
            vscode.window.showInformationMessage('No merge conflicts found in this notebook.');
        }
    }

    /**
     * Resolve semantic conflicts (Git UU status).
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

        const resolutionCallback = async (resolution: UnifiedResolution): Promise<void> => {
            await this.applySemanticResolutions(uri, filteredSemanticConflict, resolution, autoResolveResult);
        };

        // Open conflict resolver in browser
        await WebConflictPanel.createOrShow(
            this.extensionUri,
            unifiedConflict,
            resolutionCallback
        );
    }

    /**
     * Apply semantic conflict resolutions.
     * 
     * IMPORTANT: This method builds a new notebook from scratch using cellMappings,
     * rather than trying to patch an existing notebook. This avoids index corruption
     * when cells are added, deleted, or reordered.
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

        const baseNotebook = semanticConflict.base;
        const currentNotebook = semanticConflict.current;
        const incomingNotebook = semanticConflict.incoming;
        // Auto-resolved notebook contains cells with auto-resolutions applied (e.g., outputs cleared)
        const autoResolvedNotebook = autoResolveResult?.resolvedNotebook;

        if (!currentNotebook && !incomingNotebook) {
            vscode.window.showErrorMessage('Cannot apply resolutions: no notebook versions available.');
            return;
        }

        // Build a conflict lookup map: key = "baseIdx-currentIdx-incomingIdx" -> {conflict, index}
        // Note: semanticConflict.semanticConflicts is the FILTERED list (only user-resolvable conflicts)
        const conflictMap = new Map<string, { conflict: SemanticConflict; index: number }>();
        semanticConflict.semanticConflicts.forEach((c, i) => {
            const key = `${c.baseCellIndex ?? 'x'}-${c.currentCellIndex ?? 'x'}-${c.incomingCellIndex ?? 'x'}`;
            conflictMap.set(key, { conflict: c, index: i });
        });

        // Build the resolved notebook cells from scratch by iterating cellMappings in order
        const resolvedCells: NotebookCell[] = [];

        for (const mapping of semanticConflict.cellMappings) {
            const key = `${mapping.baseIndex ?? 'x'}-${mapping.currentIndex ?? 'x'}-${mapping.incomingIndex ?? 'x'}`;
            const conflictInfo = conflictMap.get(key);

            // Get cells from each version
            const baseCell = mapping.baseIndex !== undefined && baseNotebook 
                ? baseNotebook.cells[mapping.baseIndex] : undefined;
            const currentCell = mapping.currentIndex !== undefined && currentNotebook 
                ? currentNotebook.cells[mapping.currentIndex] : undefined;
            const incomingCell = mapping.incomingIndex !== undefined && incomingNotebook 
                ? incomingNotebook.cells[mapping.incomingIndex] : undefined;
            // Get the auto-resolved version of this cell (if auto-resolutions were applied)
            const autoResolvedCell = mapping.currentIndex !== undefined && autoResolvedNotebook
                ? autoResolvedNotebook.cells[mapping.currentIndex] : undefined;

            let cellToUse: NotebookCell | undefined;
            let isDeleted = false;

            if (conflictInfo) {
                // This mapping corresponds to a conflict - check if user resolved it
                const res = resolutions.get(conflictInfo.index);
                
                if (res) {
                    // User provided a resolution
                    const choice = res.choice;
                    // resolvedContent is the source of truth from the editable text area
                    const resolvedContent = res.resolvedContent;

                    // Determine the reference cell for metadata (cell_type, outputs, etc.)
                    // Priority: chosen side > any available cell
                    let referenceCell: NotebookCell | undefined;
                    switch (choice) {
                        case 'base':
                            referenceCell = baseCell || currentCell || incomingCell;
                            break;
                        case 'current':
                            referenceCell = currentCell || incomingCell || baseCell;
                            break;
                        case 'incoming':
                            referenceCell = incomingCell || currentCell || baseCell;
                            break;
                    }

                    // Check if this is a deletion (empty content)
                    if (resolvedContent !== undefined && resolvedContent === '') {
                        isDeleted = true;
                    } else if (resolvedContent !== undefined && resolvedContent.length > 0) {
                        // Use resolvedContent as the source of truth (editable text area content)
                        const cellType = referenceCell?.cell_type || 'code';
                        cellToUse = {
                            cell_type: cellType,
                            metadata: referenceCell?.metadata ? JSON.parse(JSON.stringify(referenceCell.metadata)) : {},
                            source: resolvedContent.split(/(?<=\n)/)
                        } as NotebookCell;
                        
                        // Add execution_count and outputs for code cells
                        if (cellType === 'code') {
                            (cellToUse as any).execution_count = null;
                            (cellToUse as any).outputs = [];
                        }
                    } else {
                        // No resolvedContent provided - use the cell from the chosen side
                        switch (choice) {
                            case 'base':
                                cellToUse = baseCell;
                                break;
                            case 'current':
                                cellToUse = currentCell;
                                break;
                            case 'incoming':
                                cellToUse = incomingCell;
                                break;
                        }
                        
                        // If the chosen cell doesn't exist, mark as deleted
                        if (!cellToUse) {
                            isDeleted = true;
                        }
                    }
                } else {
                    // No resolution provided - default to current
                    cellToUse = currentCell;
                    if (!cellToUse) {
                        isDeleted = true;
                    }
                }
            } else {
                // No conflict in the filtered list - this is either:
                // 1. An identical cell across versions, or
                // 2. A cell that was auto-resolved
                // 
                // Use auto-resolved version if available (preserves auto-resolutions like cleared outputs),
                // otherwise use current, fallback to incoming, fallback to base
                cellToUse = autoResolvedCell || currentCell || incomingCell || baseCell;
            }

            // Add the cell to resolved cells if not deleted
            if (!isDeleted && cellToUse) {
                resolvedCells.push(JSON.parse(JSON.stringify(cellToUse)));
            }
        }

        // Build the final notebook
        // Use auto-resolved notebook metadata if available (preserves kernel auto-resolution)
        const metadataSource = autoResolvedNotebook || currentNotebook || incomingNotebook || baseNotebook;
        const templateNotebook = currentNotebook || incomingNotebook || baseNotebook;
        let resolvedNotebook: Notebook = {
            nbformat: templateNotebook!.nbformat,
            nbformat_minor: templateNotebook!.nbformat_minor,
            metadata: JSON.parse(JSON.stringify(metadataSource!.metadata)),
            cells: resolvedCells
        };

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
