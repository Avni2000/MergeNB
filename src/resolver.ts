/**
 * @file resolver.ts
 * @description Main conflict resolution orchestrator for MergeNB.
 * 
 * The NotebookConflictResolver class coordinates the entire resolution workflow:
 * 1. Scans workspace for notebooks with Git unmerged status
 * 2. Detects semantic conflicts and retrieves base/current/incoming versions from Git
 * 3. Applies auto-resolutions for trivial conflicts (execution counts, outputs)
 * 4. Opens the browser-based UI for manual resolution of remaining conflicts
 * 5. Applies user choices and writes the resolved notebook back to disk
 * 6. Stages the resolved file in Git
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { detectSemanticConflicts, applyAutoResolutions, AutoResolveResult } from './conflictDetector';
import { parseNotebook, serializeNotebook, renumberExecutionCounts } from './notebookParser';
import { selectNonConflictMergedCell } from './notebookUtils';
import { WebConflictPanel } from './web/WebConflictPanel';
import { UnifiedConflict, UnifiedResolution } from './web/webTypes';
import { ResolutionChoice, NotebookSemanticConflict, Notebook, NotebookCell } from './types';
import * as gitIntegration from './gitIntegration';
import { getSettings } from './settings';
import * as logger from './logger';

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

type PreferredSide = 'base' | 'current' | 'incoming';

function getCellForSide(
    row: import('./web/webTypes').ResolvedRow,
    side: PreferredSide
): NotebookCell | undefined {
    if (side === 'base') return row.baseCell;
    if (side === 'current') return row.currentCell;
    return row.incomingCell;
}

function isConsistentTakeAllSelection(
    resolvedRows: import('./web/webTypes').ResolvedRow[],
    side: PreferredSide,
    allowSingleRow: boolean = false
): boolean {
    const rowsWithResolution = resolvedRows.filter(
        (row): row is import('./web/webTypes').ResolvedRow & { resolution: { choice: ResolutionChoice; resolvedContent: string } } =>
            !!row.resolution
    );

    if (rowsWithResolution.length === 0) {
        return false;
    }

    if (!allowSingleRow && rowsWithResolution.length <= 1) {
        return false;
    }

    let sawSideSelection = false;
    for (const row of rowsWithResolution) {
        const choice = row.resolution.choice;
        const sideCell = getCellForSide(row, side);
        if (choice === side) {
            if (!sideCell) return false;
            sawSideSelection = true;
            continue;
        }
        if (choice === 'delete') {
            // In take-all mode, delete is expected only when the selected side is absent.
            if (sideCell) return false;
            continue;
        }
        return false;
    }

    return sawSideSelection;
}

export function inferPreferredSide(
    resolvedRows: import('./web/webTypes').ResolvedRow[],
    preferredSideHint?: PreferredSide
): PreferredSide | undefined {
    // The UI now emits an explicit semanticChoice for reorder-only conflicts,
    // where there may be zero per-row resolution objects.
    if (preferredSideHint) {
        return preferredSideHint;
    }

    const conflictChoices = resolvedRows
        .map(row => row.resolution?.choice)
        .filter((choice): choice is ResolutionChoice => !!choice);
    const nonDeleteChoices = conflictChoices
        .filter((choice): choice is PreferredSide => choice !== 'delete');

    if (conflictChoices.length <= 1 || nonDeleteChoices.length === 0) {
        return undefined;
    }

    const uniqueChoices = new Set(nonDeleteChoices);
    if (uniqueChoices.size !== 1) {
        return undefined;
    }

    const inferred = [...uniqueChoices][0];
    return isConsistentTakeAllSelection(resolvedRows, inferred, false) ? inferred : undefined;
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
    resolvedNotebook?: Notebook;
    resolvedRows?: import('./web/webTypes').ResolvedRow[];
    markAsResolved: boolean;
    renumberExecutionCounts: boolean;
    fileDeleted?: boolean;
}

export const onDidResolveConflictWithDetails = new vscode.EventEmitter<ResolvedConflictDetails>();

/**
 * Resolver prompt hooks for deterministic test execution without UI interaction.
 */
export type AddOnlyResolutionAction = 'apply-and-stage' | 'open-semantic' | 'cancel';
export type DeleteVsModifyResolutionAction = 'keep-content' | 'keep-delete' | 'cancel';

export interface AddOnlyPromptContext {
    status: 'AU' | 'UA';
    filePath: string;
    availableSide: 'current' | 'incoming';
}

export interface DeleteVsModifyPromptContext {
    status: 'DU' | 'UD';
    filePath: string;
    keepContentSide: 'current' | 'incoming';
}

export interface ResolverConfirmationContext {
    status: gitIntegration.GitUnmergedStatus;
    filePath: string;
    actionId: string;
    actionLabel: string;
    message: string;
}

export interface ResolverPromptTestHooks {
    pickAddOnlyAction?: (
        context: AddOnlyPromptContext
    ) => Promise<AddOnlyResolutionAction | undefined> | AddOnlyResolutionAction | undefined;
    pickDeleteVsModifyAction?: (
        context: DeleteVsModifyPromptContext
    ) => Promise<DeleteVsModifyResolutionAction | undefined> | DeleteVsModifyResolutionAction | undefined;
    confirmAction?: (
        context: ResolverConfirmationContext
    ) => Promise<boolean> | boolean;
}

let resolverPromptTestHooks: ResolverPromptTestHooks | undefined;

export function setResolverPromptTestHooks(hooks?: ResolverPromptTestHooks): void {
    resolverPromptTestHooks = hooks;
}

/**
 * Represents a notebook with Git unmerged status.
 */
export interface ConflictedNotebook {
    uri: vscode.Uri;
    hasSemanticConflicts: boolean;
    unmergedStatus: gitIntegration.GitUnmergedStatus;
}

/**
 * Main service for handling notebook merge conflict resolution.
 */
export class NotebookConflictResolver {
    constructor(private readonly extensionUri: vscode.Uri) { }

    /**
     * Check if a file has semantic conflicts (status supports cell-level UI).
     */
    async hasSemanticConflicts(uri: vscode.Uri): Promise<boolean> {
        try {
            const status = await gitIntegration.getUnmergedFileStatus(uri.fsPath);
            return status === 'UU' || status === 'AA' || status === 'AU' || status === 'UA';
        } catch {
            return false;
        }
    }

    /**
     * Check if a file has any unmerged Git status.
     */
    async hasAnyConflicts(uri: vscode.Uri): Promise<ConflictedNotebook | null> {
        try {
            const status = await gitIntegration.getUnmergedFileStatus(uri.fsPath);
            if (status) {
                return {
                    uri,
                    hasSemanticConflicts: status === 'UU' || status === 'AA' || status === 'AU' || status === 'UA',
                    unmergedStatus: status
                };
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Find all notebook files with conflicts (Git unmerged status) in the workspace.
     * Only queries Git for unmerged files, no file scanning.
     */
    async findNotebooksWithConflicts(): Promise<ConflictedNotebook[]> {
        logger.debug('[Resolver] findNotebooksWithConflicts: scanning for unmerged files');
        const withConflicts: ConflictedNotebook[] = [];

        // Get unmerged files from Git status
        const unmergedFiles = await gitIntegration.getUnmergedFiles();
        logger.debug(`[Resolver] findNotebooksWithConflicts: found ${unmergedFiles.length} unmerged file(s)`);

        for (const file of unmergedFiles) {
            logger.debug(`[Resolver] Checking unmerged file: ${file.path}`);
            // Only process .ipynb files
            if (!file.path.endsWith('.ipynb')) {
                logger.debug(`[Resolver] Skipping non-ipynb: ${file.path}`);
                continue;
            }

            if (file.status === 'DD') {
                logger.debug(`[Resolver] Skipping DD (both deleted) notebook: ${file.path}`);
                continue;
            }

            logger.debug(`[Resolver] Found conflicted notebook: ${file.path}`);
            const uri = vscode.Uri.file(file.path);

            withConflicts.push({
                uri,
                hasSemanticConflicts: file.status === 'UU' || file.status === 'AA' || file.status === 'AU' || file.status === 'UA',
                unmergedStatus: file.status
            });
        }

        logger.debug(`[Resolver] findNotebooksWithConflicts: returning ${withConflicts.length} notebook(s)`);
        return withConflicts;
    }

    /**
     * Resolve conflicts in a notebook based on explicit unmerged status.
     */
    async resolveConflicts(uri: vscode.Uri): Promise<void> {
        const status = await gitIntegration.getUnmergedFileStatus(uri.fsPath);
        if (!status) {
            vscode.window.showInformationMessage('No merge conflicts found in this notebook.');
            return;
        }

        if (status === 'DD') {
            vscode.window.showInformationMessage('Both-deleted (DD) conflicts are not handled by MergeNB.');
            return;
        }

        if (status === 'DU' || status === 'UD') {
            await this.resolveDeleteVsModifyConflict(uri, status);
            return;
        }

        if (status === 'AU' || status === 'UA') {
            const handled = await this.resolveAddOnlyConflict(uri, status);
            if (handled) {
                return;
            }
        }

        await this.resolveSemanticConflicts(uri);
    }

    /**
     * Resolve semantic conflicts (Git unmerged status).
     * Auto-resolves execution count and kernel version differences based on settings.
     */
    async resolveSemanticConflicts(uri: vscode.Uri): Promise<void> {
        const semanticConflict = await detectSemanticConflicts(uri.fsPath);

        if (!semanticConflict) {
            vscode.window.showInformationMessage('No semantic conflicts detected.');
            return;
        }

        // Apply auto-resolutions based on settings
        const settings = getSettings();
        const autoResolveResult = applyAutoResolutions(semanticConflict, settings);

        if (
            semanticConflict.semanticConflicts.length === 0 &&
            autoResolveResult.autoResolvedCount === 0
        ) {
            vscode.window.showInformationMessage('Notebook is in unmerged state but no conflicts detected.');
            return;
        }

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
            const resolvedCount = semanticConflict.semanticConflicts.length;
            if (resolvedCount > 0) {
                vscode.window.showInformationMessage(`All ${resolvedCount} conflicts were auto-resolved.`);
            } else {
                vscode.window.showInformationMessage('Applied automatic notebook-level resolutions.');
            }
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

    private async pickAddOnlyAction(context: AddOnlyPromptContext): Promise<AddOnlyResolutionAction | undefined> {
        if (resolverPromptTestHooks?.pickAddOnlyAction) {
            return resolverPromptTestHooks.pickAddOnlyAction(context);
        }

        const applyLabel = `Apply ${context.availableSide} version + stage`;
        const openLabel = 'Open semantic resolver';
        const cancelLabel = 'Cancel';

        const picked = await vscode.window.showQuickPick(
            [applyLabel, openLabel, cancelLabel],
            {
                title: `Add-only conflict (${context.status})`,
                placeHolder: `Choose how to resolve ${path.basename(context.filePath)}`
            }
        );

        if (picked === applyLabel) {
            return 'apply-and-stage';
        }
        if (picked === openLabel) {
            return 'open-semantic';
        }
        if (picked === cancelLabel) {
            return 'cancel';
        }
        return undefined;
    }

    private async pickDeleteVsModifyAction(
        context: DeleteVsModifyPromptContext
    ): Promise<DeleteVsModifyResolutionAction | undefined> {
        if (resolverPromptTestHooks?.pickDeleteVsModifyAction) {
            return resolverPromptTestHooks.pickDeleteVsModifyAction(context);
        }

        const keepContentLabel = `Keep ${context.keepContentSide} content`;
        const keepDeleteLabel = 'Keep deletion';
        const cancelLabel = 'Cancel';

        const picked = await vscode.window.showQuickPick(
            [keepContentLabel, keepDeleteLabel, cancelLabel],
            {
                title: `Delete/modify conflict (${context.status})`,
                placeHolder: `Choose a file-level resolution for ${path.basename(context.filePath)}`
            }
        );

        if (picked === keepContentLabel) {
            return 'keep-content';
        }
        if (picked === keepDeleteLabel) {
            return 'keep-delete';
        }
        if (picked === cancelLabel) {
            return 'cancel';
        }
        return undefined;
    }

    private async confirmResolutionAction(context: ResolverConfirmationContext): Promise<boolean> {
        if (resolverPromptTestHooks?.confirmAction) {
            return resolverPromptTestHooks.confirmAction(context);
        }

        const picked = await vscode.window.showWarningMessage(
            context.message,
            { modal: true },
            context.actionLabel
        );
        return picked === context.actionLabel;
    }

    private async writeNotebookBlob(uri: vscode.Uri, notebookContent: string): Promise<void> {
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(notebookContent));
    }

    private async deleteFileIfPresent(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.workspace.fs.delete(uri, { useTrash: false });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/not.*found|entry.*not.*found/i.test(message)) {
                return;
            }
            throw error;
        }
    }

    private async resolveAddOnlyConflict(
        uri: vscode.Uri,
        status: 'AU' | 'UA'
    ): Promise<boolean> {
        const versions = await gitIntegration.getThreeWayVersions(uri.fsPath);
        if (!versions) {
            return false;
        }

        const availableSide: 'current' | 'incoming' = status === 'AU' ? 'current' : 'incoming';
        const availableContent = status === 'AU' ? versions.current : versions.incoming;
        const missingContent = status === 'AU' ? versions.incoming : versions.current;

        // Conditional auto-accept only applies when exactly one side is available.
        if (!availableContent || missingContent !== null) {
            return false;
        }

        let resolvedNotebook: Notebook | undefined;
        try {
            resolvedNotebook = parseNotebook(availableContent);
        } catch {
            // Non-parseable blobs should fall back to semantic resolver path.
            return false;
        }

        const action = await this.pickAddOnlyAction({
            status,
            filePath: uri.fsPath,
            availableSide
        });
        if (!action || action === 'cancel') {
            return true;
        }
        if (action === 'open-semantic') {
            return false;
        }

        const actionLabel = `Apply ${availableSide} version`;
        const confirmed = await this.confirmResolutionAction({
            status,
            filePath: uri.fsPath,
            actionId: 'add-only-apply-stage',
            actionLabel,
            message: `${actionLabel} and stage ${path.basename(uri.fsPath)}?`
        });
        if (!confirmed) {
            return true;
        }

        await this.writeNotebookBlob(uri, availableContent);
        await this.markFileAsResolved(uri, { suppressSuccessMessage: true });
        onDidResolveConflict.fire(uri);
        onDidResolveConflictWithDetails.fire({
            uri,
            resolvedNotebook,
            resolvedRows: [],
            markAsResolved: true,
            renumberExecutionCounts: false
        });

        vscode.window.showInformationMessage(
            `Applied ${availableSide} version and staged ${path.basename(uri.fsPath)}`
        );
        return true;
    }

    private async resolveDeleteVsModifyConflict(
        uri: vscode.Uri,
        status: 'DU' | 'UD'
    ): Promise<void> {
        const keepContentSide: 'current' | 'incoming' = status === 'DU' ? 'incoming' : 'current';
        const keepContentBlob = status === 'DU'
            ? await gitIntegration.getIncomingVersion(uri.fsPath)
            : await gitIntegration.getCurrentVersion(uri.fsPath);

        if (!keepContentBlob) {
            vscode.window.showErrorMessage(
                `Cannot resolve ${status} conflict: missing ${keepContentSide} notebook content.`
            );
            return;
        }

        const action = await this.pickDeleteVsModifyAction({
            status,
            filePath: uri.fsPath,
            keepContentSide
        });
        if (!action || action === 'cancel') {
            return;
        }

        const actionLabel = action === 'keep-content'
            ? `Keep ${keepContentSide} content`
            : 'Keep deletion';
        const confirmed = await this.confirmResolutionAction({
            status,
            filePath: uri.fsPath,
            actionId: action,
            actionLabel,
            message: `${actionLabel} for ${path.basename(uri.fsPath)} and stage the result?`
        });
        if (!confirmed) {
            return;
        }

        if (action === 'keep-content') {
            let resolvedNotebook: Notebook | undefined;
            try {
                resolvedNotebook = parseNotebook(keepContentBlob);
            } catch {
                resolvedNotebook = undefined;
            }

            await this.writeNotebookBlob(uri, keepContentBlob);
            await this.markFileAsResolved(uri, { suppressSuccessMessage: true });

            onDidResolveConflict.fire(uri);
            onDidResolveConflictWithDetails.fire({
                uri,
                resolvedNotebook,
                resolvedRows: [],
                markAsResolved: true,
                renumberExecutionCounts: false
            });

            vscode.window.showInformationMessage(
                `Kept ${keepContentSide} content and staged ${path.basename(uri.fsPath)}`
            );
            return;
        }

        await this.deleteFileIfPresent(uri);
        await this.markFileAsResolved(uri, { suppressSuccessMessage: true });
        onDidResolveConflict.fire(uri);
        onDidResolveConflictWithDetails.fire({
            uri,
            resolvedRows: [],
            markAsResolved: true,
            renumberExecutionCounts: false,
            fileDeleted: true
        });

        vscode.window.showInformationMessage(
            `Kept deletion and staged ${path.basename(uri.fsPath)}`
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
            autoResolveResult,
            resolution.semanticChoice
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
        autoResolveResult?: AutoResolveResult,
        preferredSideHint?: PreferredSide
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
        // Prefer an explicit semanticChoice from UI (including reorder-only flows).
        // Otherwise infer with strict delete-side consistency checks.
        const preferredSide = inferPreferredSide(resolvedRows, preferredSideHint);

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
                    if (settings.stripOutputs) {
                        (cellToUse as any).execution_count = null;
                        (cellToUse as any).outputs = [];
                    } else {
                        (cellToUse as any).execution_count = (referenceCell as any)?.execution_count ?? null;
                        (cellToUse as any).outputs = (referenceCell as any)?.outputs
                            ? JSON.parse(JSON.stringify((referenceCell as any).outputs))
                            : [];
                    }
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

        // Mark as resolved by staging in Git if requested
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
     * Mark a file as resolved by staging it through the VS Code Git API.
     */
    private async markFileAsResolved(
        uri: vscode.Uri,
        options?: { suppressSuccessMessage?: boolean }
    ): Promise<void> {
        try {
            const staged = await gitIntegration.stageFile(uri.fsPath);
            if (!staged) {
                vscode.window.showWarningMessage(`MergeNB could not stage ${path.basename(uri.fsPath)} automatically.`);
                return;
            }

            if (!options?.suppressSuccessMessage) {
                const relativePath = vscode.workspace.asRelativePath(uri, false);
                vscode.window.showInformationMessage(`Marked ${relativePath} as resolved`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to mark file as resolved: ${error}`);
        }
    }
}
