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
import {
    detectSemanticConflicts,
    applyAutoResolutions,
    parseNotebook,
    serializeNotebook,
    renumberExecutionCounts,
    buildResolvedNotebookFromRows,
    type AutoResolveResult,
    type PreferredSide,
    type NotebookSemanticConflict,
    type Notebook,
    type ResolvedRow,
} from '../../packages/core/src';
import { WebConflictPanel } from './web/WebConflictPanel';
import { UnifiedConflict, UnifiedResolution } from '../../packages/web/server/src';
import * as gitIntegration from './gitIntegration';
import { getSettings } from './settings';
import * as logger from '../../packages/core/src';




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
    resolvedRows?: ResolvedRow[];
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

interface AddOnlyPromptContext {
    status: 'AU' | 'UA';
    filePath: string;
    availableSide: 'current' | 'incoming';
}

interface DeleteVsModifyPromptContext {
    status: 'DU' | 'UD';
    filePath: string;
    keepContentSide: 'current' | 'incoming';
}

interface ResolverConfirmationContext {
    actionLabel: string;
    message: string;
}

interface ResolverPromptTestHooks {
    pickAddOnlyAction?: (
        context: AddOnlyPromptContext
    ) => Promise<AddOnlyResolutionAction | undefined> | AddOnlyResolutionAction | undefined;
    pickDeleteVsModifyAction?: (
        context: DeleteVsModifyPromptContext
    ) => Promise<DeleteVsModifyResolutionAction | undefined> | DeleteVsModifyResolutionAction | undefined;
    pickRenumberExecutionCounts?: () => Promise<boolean | undefined> | boolean | undefined;
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
    unmergedStatus: gitIntegration.GitUnmergedStatus;
}

/**
 * Main service for handling notebook merge conflict resolution.
 */
export class NotebookConflictResolver {
    constructor(private readonly extensionUri: vscode.Uri) { }

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
        const semanticConflict = await detectSemanticConflicts(uri.fsPath, {
            getThreeWayVersions: gitIntegration.getThreeWayVersions,
            getCurrentBranch: gitIntegration.getCurrentBranch,
            getMergeBranch: gitIntegration.getMergeBranch,
        });

        if (!semanticConflict) {
            vscode.window.showInformationMessage('No semantic conflicts detected.');
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

        // If no manual conflicts remain, save and return. This also handles
        // unmerged notebooks whose branches already agree semantically
        // (for example, both sides made the same reorder).
        if (autoResolveResult.remainingConflicts.length === 0) {
            const shouldRenumber = await this.pickRenumberExecutionCounts();

            let finalNotebook = autoResolveResult.resolvedNotebook;
            if (shouldRenumber) {
                finalNotebook = renumberExecutionCounts(finalNotebook);
            }

            await this.saveResolvedNotebook(uri, finalNotebook, true);
            onDidResolveConflictWithDetails.fire({
                uri,
                resolvedNotebook: finalNotebook,
                resolvedRows: [],
                markAsResolved: true,
                renumberExecutionCounts: shouldRenumber
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

    private async pickRenumberExecutionCounts(): Promise<boolean> {
        if (resolverPromptTestHooks?.pickRenumberExecutionCounts) {
            return (await resolverPromptTestHooks.pickRenumberExecutionCounts()) === true;
        }

        const picked = await vscode.window.showQuickPick(
            ['Yes', 'No'],
            {
                placeHolder: 'Renumber execution counts sequentially?',
                title: 'Execution Counts'
            }
        );

        return picked === 'Yes';
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

        if (resolvedRows == null) {
            // No resolutions provided
            if (autoResolveResult) {
                let resolvedNotebook = autoResolveResult.resolvedNotebook;

                const shouldRenumber = await this.pickRenumberExecutionCounts();

                if (shouldRenumber) {
                    resolvedNotebook = renumberExecutionCounts(resolvedNotebook);
                }

                await this.saveResolvedNotebook(uri, resolvedNotebook);
                onDidResolveConflictWithDetails.fire({
                    uri,
                    resolvedNotebook,
                    resolvedRows: [],
                    markAsResolved: false,
                    renumberExecutionCounts: shouldRenumber
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
        resolvedRows: ResolvedRow[],
        markAsResolved: boolean,
        shouldRenumber: boolean,
        autoResolveResult?: AutoResolveResult,
        preferredSideHint?: PreferredSide
    ): Promise<void> {
        const settings = getSettings();

        if (!semanticConflict.current && !semanticConflict.incoming) {
            vscode.window.showErrorMessage('Cannot apply resolutions: no notebook versions available.');
            return;
        }

        const resolvedNotebook = buildResolvedNotebookFromRows({
            semanticConflict,
            resolvedRows,
            autoResolveResult,
            settings,
            shouldRenumber,
            preferredSideHint,
        });

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
