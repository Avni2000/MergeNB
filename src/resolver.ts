/**
 * @file resolver.ts
 * @description Main conflict resolution orchestrator for MergeNB.
 * 
 * The NotebookConflictResolver class coordinates the entire resolution workflow:
 * 1. Scans workspace for notebooks with Git UU status
 * 2. Detects semantic conflicts and retrieves base/current/incoming versions from Git
 * 3. Applies auto-resolutions for trivial conflicts (execution counts, outputs)
 * 4. Opens the browser-based UI for manual resolution of remaining conflicts
 * 5. Applies user choices and writes the resolved notebook back to disk
 * 6. Stages the resolved file in Git
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { detectSemanticConflicts, applyAutoResolutions, AutoResolveResult } from './conflictDetector';
import { serializeNotebook, renumberExecutionCounts } from './notebookParser';
import { selectNonConflictMergedCell } from './notebookUtils';
import { WebConflictPanel } from './web/WebConflictPanel';
import { UnifiedConflict, UnifiedResolution } from './web/webTypes';
import { ResolutionChoice, NotebookSemanticConflict, Notebook, NotebookCell } from './types';
import * as gitIntegration from './gitIntegration';
import { getSettings } from './settings';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const exec = promisify(execCallback);

function stableStringify(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(value);

    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }

    if (t === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
    }

    return JSON.stringify(String(value));
}

function chooseMetadataValue(
    baseValue: unknown,
    currentValue: unknown,
    incomingValue: unknown
): unknown {
    const baseStr = stableStringify(baseValue);
    const currentStr = stableStringify(currentValue);
    const incomingStr = stableStringify(incomingValue);

    if (currentStr === incomingStr) return currentValue;
    if (currentStr === baseStr) return incomingValue;
    if (incomingStr === baseStr) return currentValue;
    return currentValue;
}

function mergeNotebookMetadata(
    baseMetadata: Record<string, unknown> | undefined,
    currentMetadata: Record<string, unknown> | undefined,
    incomingMetadata: Record<string, unknown> | undefined,
    options: {
        preferKernelFromCurrent: boolean;
    }
): Record<string, unknown> {
    const base = baseMetadata ?? {};
    const current = currentMetadata ?? {};
    const incoming = incomingMetadata ?? {};

    const keys = new Set<string>([
        ...Object.keys(base),
        ...Object.keys(current),
        ...Object.keys(incoming),
    ]);

    const merged: Record<string, unknown> = {};
    for (const key of keys) {
        if (options.preferKernelFromCurrent && (key === 'kernelspec' || key === 'language_info')) {
            if (key in current) merged[key] = current[key];
            else if (key in incoming) merged[key] = incoming[key];
            else if (key in base) merged[key] = base[key];
            continue;
        }

        merged[key] = chooseMetadataValue(base[key], current[key], incoming[key]);
    }

    return merged;
}

/**
 * Event fired when a notebook conflict is successfully resolved.
 */
export const onDidResolveConflict = new vscode.EventEmitter<vscode.Uri>();

/**
 * Detailed event fired when a notebook conflict is successfully resolved.
 * Useful for tests to verify what was written to disk.
 */
export interface ResolvedConflictDetails {
    uri: vscode.Uri;
    resolvedNotebook: Notebook;
    resolvedRows?: import('./web/webTypes').ResolvedRow[];
    markAsResolved: boolean;
    renumberExecutionCounts: boolean;
}

export const onDidResolveConflictWithDetails = new vscode.EventEmitter<ResolvedConflictDetails>();

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
    constructor(private readonly extensionUri: vscode.Uri) { }

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
        console.log('[Resolver] findNotebooksWithConflicts: scanning for unmerged files');
        const withConflicts: ConflictedNotebook[] = [];

        // Get unmerged files from Git status
        const unmergedFiles = await gitIntegration.getUnmergedFiles();
        console.log(`[Resolver] findNotebooksWithConflicts: found ${unmergedFiles.length} unmerged file(s)`);

        for (const file of unmergedFiles) {
            console.log(`[Resolver] Checking unmerged file: ${file.path}`);
            // Only process .ipynb files
            if (!file.path.endsWith('.ipynb')) {
                console.log(`[Resolver] Skipping non-ipynb: ${file.path}`);
                continue;
            }

            console.log(`[Resolver] Found conflicted notebook: ${file.path}`);
            const uri = vscode.Uri.file(file.path);

            withConflicts.push({
                uri,
                hasSemanticConflicts: true
            });
        }

        console.log(`[Resolver] findNotebooksWithConflicts: returning ${withConflicts.length} notebook(s)`);
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
            onDidResolveConflictWithDetails.fire({
                uri,
                resolvedNotebook: finalNotebook,
                resolvedRows: [],
                markAsResolved: false,
                renumberExecutionCounts: renumber === 'Yes'
            });
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
            hideNonConflictOutputs: settings.hideNonConflictOutputs,
            showCellHeaders: settings.showCellHeaders,
            enableUndoRedoHotkeys: settings.enableUndoRedoHotkeys,
            showBaseColumn: settings.showBaseColumn,
            theme: settings.theme
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
     * Rebuilds notebook from resolvedRows sent by the UI.
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

        const resolvedRows = resolution.resolvedRows;

        if (!resolvedRows || resolvedRows.length === 0) {
            // No resolutions provided
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
                onDidResolveConflictWithDetails.fire({
                    uri,
                    resolvedNotebook,
                    resolvedRows: [],
                    markAsResolved: false,
                    renumberExecutionCounts: renumber === 'Yes'
                });
                vscode.window.showInformationMessage(`Resolved conflicts in ${uri.fsPath}`);
            }
            return;
        }

        await this.applySemanticResolutionsFromRows(
            uri,
            semanticConflict,
            resolvedRows,
            resolution.markAsResolved,
            resolution.renumberExecutionCounts,
            autoResolveResult
        );
    }

    /**
     * Apply resolutions using resolvedRows from the UI.
     */
    private async applySemanticResolutionsFromRows(
        uri: vscode.Uri,
        semanticConflict: NotebookSemanticConflict,
        resolvedRows: import('./web/webTypes').ResolvedRow[],
        markAsResolved: boolean,
        shouldRenumber: boolean,
        autoResolveResult?: AutoResolveResult
    ): Promise<void> {
        const baseNotebook = semanticConflict.base;
        const currentNotebook = semanticConflict.current;
        const incomingNotebook = semanticConflict.incoming;
        const autoResolvedNotebook = autoResolveResult?.resolvedNotebook;
        const settings = getSettings();

        if (!currentNotebook && !incomingNotebook) {
            vscode.window.showErrorMessage('Cannot apply resolutions: no notebook versions available.');
            return;
        }

        const resolvedCells: NotebookCell[] = [];

        // Detect a uniform "take all" action (e.g. all base/current/incoming).
        // If all non-delete choices are the same side, prefer that side for ordering
        // and for unmatched non-conflict rows.
        const nonDeleteChoices = resolvedRows
            .map(r => r.resolution?.choice)
            .filter((c): c is 'base' | 'current' | 'incoming' => !!c && c !== 'delete');

        const uniqueChoices = new Set(nonDeleteChoices);
        const preferredSide = (uniqueChoices.size === 1
            ? [...uniqueChoices][0]
            : undefined) as ('base' | 'current' | 'incoming' | undefined);

        let rowsForResolution = resolvedRows;
        if (preferredSide === 'base' || preferredSide === 'current' || preferredSide === 'incoming') {
            const indexKey = preferredSide === 'base'
                ? 'baseCellIndex'
                : preferredSide === 'current'
                    ? 'currentCellIndex'
                    : 'incomingCellIndex';

            const withIndex = resolvedRows
                .filter(r => (r as any)[indexKey] !== undefined)
                .sort((a, b) => (a as any)[indexKey] - (b as any)[indexKey]);
            const withoutIndex = resolvedRows.filter(r => (r as any)[indexKey] === undefined);
            rowsForResolution = [...withIndex, ...withoutIndex];
        }

        for (const row of rowsForResolution) {
            const { baseCell, currentCell, incomingCell, resolution: res } = row;

            // If auto-resolve ran, treat its current-side cell as source-of-truth for
            // outputs/execution_count stripping (and other auto-resolve edits).
            const currentCellFromAutoResolve = (
                row.currentCellIndex !== undefined &&
                autoResolvedNotebook?.cells?.[row.currentCellIndex]
            ) ? autoResolvedNotebook.cells[row.currentCellIndex] : undefined;
            const currentCellForFallback = currentCellFromAutoResolve || currentCell;

            let cellToUse: NotebookCell | undefined;

            if (res) {
                const choice = res.choice;
                const resolvedContent = res.resolvedContent;

                let referenceCell: NotebookCell | undefined;
                switch (choice) {
                    case 'base':
                        referenceCell = baseCell || currentCell || incomingCell;
                        break;
                    case 'current':
                        referenceCell = currentCellForFallback || incomingCell || baseCell;
                        break;
                    case 'incoming':
                        referenceCell = incomingCell || currentCell || baseCell;
                        break;
                    case 'delete':
                        continue;
                }

                const cellType = referenceCell?.cell_type || 'code';
                cellToUse = {
                    cell_type: cellType,
                    metadata: referenceCell?.metadata ? JSON.parse(JSON.stringify(referenceCell.metadata)) : {},
                    source: resolvedContent.split(/(?<=\n)/)
                } as NotebookCell;

                if (cellType === 'code') {
                    (cellToUse as any).execution_count = null;
                    (cellToUse as any).outputs = [];
                }
            } else if (preferredSide === 'base' || preferredSide === 'current' || preferredSide === 'incoming') {
                // For uniform "take all", only include cells that exist on the preferred side.
                if (preferredSide === 'base') cellToUse = baseCell;
                else if (preferredSide === 'current') cellToUse = currentCellForFallback;
                else if (preferredSide === 'incoming') cellToUse = incomingCell;
            } else {
                // For non-conflict rows, apply source-level 3-way merge semantics so
                // one-sided incoming/current edits are preserved.
                cellToUse = selectNonConflictMergedCell(baseCell, currentCellForFallback, incomingCell);
            }

            if (cellToUse) {
                resolvedCells.push(JSON.parse(JSON.stringify(cellToUse)));
            }
        }

        const templateNotebook = currentNotebook || incomingNotebook || baseNotebook;

        const mergedMetadata = mergeNotebookMetadata(
            baseNotebook?.metadata as any,
            (autoResolvedNotebook || currentNotebook)?.metadata as any,
            incomingNotebook?.metadata as any,
            { preferKernelFromCurrent: settings.autoResolveKernelVersion }
        );
        let resolvedNotebook: Notebook = {
            nbformat: templateNotebook!.nbformat,
            nbformat_minor: templateNotebook!.nbformat_minor,
            metadata: JSON.parse(JSON.stringify(mergedMetadata)),
            cells: resolvedCells
        };

        if (shouldRenumber) {
            resolvedNotebook = renumberExecutionCounts(resolvedNotebook);
        }

        await this.saveResolvedNotebook(uri, resolvedNotebook, markAsResolved);
        onDidResolveConflictWithDetails.fire({
            uri,
            resolvedNotebook,
            resolvedRows,
            markAsResolved,
            renumberExecutionCounts: shouldRenumber
        });

        // Show success notification (non-blocking, fire and forget)
        vscode.window.showInformationMessage(
            `Resolved conflicts in ${path.basename(uri.fsPath)}`
        );
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

        // Fire event to notify extension (for status bar, decorations, etc.)
        onDidResolveConflict.fire(uri);
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
