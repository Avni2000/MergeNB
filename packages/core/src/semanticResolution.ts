/**
 * @file semanticResolution.ts
 * @description Pure helpers for resolving semantic conflicts without VS Code.
 */

import type { Notebook, NotebookCell, NotebookSemanticConflict, MergeNBSettings, ResolvedRow } from './types';
import type { AutoResolveResult } from './conflictDetector';
import { selectNonConflictMergedCell, stableStringify, sourceToCellFormat } from './notebookUtils';
import { renumberExecutionCounts } from './notebookParser';
import * as logger from './logger';

export type PreferredSide = 'base' | 'current' | 'incoming';

export function applyAutoResolveCellPatches(
    cell: NotebookCell,
    row: Pick<ResolvedRow, 'baseCellIndex' | 'currentCellIndex' | 'incomingCellIndex'>,
    autoResolveResult?: AutoResolveResult
): NotebookCell {
    const resolved = JSON.parse(JSON.stringify(cell)) as NotebookCell;
    const indexKeys = ['baseCellIndex', 'currentCellIndex', 'incomingCellIndex'] as const;
    for (const patch of autoResolveResult?.cellPatches ?? []) {
        const sharedIndex = indexKeys.some(key =>
            patch[key] !== undefined && patch[key] === row[key]
        );
        const mismatchedIndex = indexKeys.some(key =>
            patch[key] !== undefined && row[key] !== undefined && patch[key] !== row[key]
        );
        if (sharedIndex && !mismatchedIndex) {
            Object.assign(resolved, JSON.parse(JSON.stringify(patch.changes)));
        }
    }
    return resolved;
}

interface BuildResolvedNotebookOptions {
    semanticConflict: NotebookSemanticConflict;
    resolvedRows: ResolvedRow[];
    autoResolveResult?: AutoResolveResult;
    settings: MergeNBSettings;
    shouldRenumber: boolean;
    preferredSideHint?: PreferredSide;
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
    options: { preferKernelFromCurrent: boolean }
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

function getCellForSide(
    row: ResolvedRow,
    side: PreferredSide
): NotebookCell | undefined {
    if (side === 'base') return row.baseCell;
    if (side === 'current') return row.currentCell;
    return row.incomingCell;
}

function isConsistentTakeAllSelection(
    resolvedRows: ResolvedRow[],
    side: PreferredSide,
    allowSingleRow: boolean = false
): boolean {
    const rowsWithResolution = resolvedRows.filter(
        (row): row is ResolvedRow & { resolution: { choice: string; resolvedContent: string } } =>
            !!row.resolution &&
            typeof (row.resolution as any).choice === 'string' &&
            typeof (row.resolution as any).resolvedContent === 'string'
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
            if (sideCell) return false;
            continue;
        }
        return false;
    }

    return sawSideSelection;
}

function inferPreferredSide(
    resolvedRows: ResolvedRow[],
    preferredSideHint?: PreferredSide
): PreferredSide | undefined {
    if (preferredSideHint && isConsistentTakeAllSelection(resolvedRows, preferredSideHint, true)) {
        return preferredSideHint;
    }

    const conflictChoices = resolvedRows
        .map(row => row.resolution?.choice)
        .filter((choice): choice is PreferredSide | 'delete' => !!choice);
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

export function buildResolvedNotebookFromRows(options: BuildResolvedNotebookOptions): Notebook {
    const {
        semanticConflict,
        resolvedRows,
        autoResolveResult,
        settings,
        shouldRenumber,
        preferredSideHint,
    } = options;

    const baseNotebook = semanticConflict.base;
    const currentNotebook = semanticConflict.current;
    const incomingNotebook = semanticConflict.incoming;
    if (!currentNotebook && !incomingNotebook && !baseNotebook) {
        throw new Error('Cannot apply resolutions: no notebook versions available.');
    }

    const resolvedCells: NotebookCell[] = [];
    const preferredSide = inferPreferredSide(resolvedRows, preferredSideHint);

    let rowsForResolution = resolvedRows;
    if (preferredSide) {
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

        let cellToUse: NotebookCell | undefined;

        if (res) {
            const choice = res.choice;
            const resolvedContent = res.resolvedContent;

            let referenceCell: NotebookCell | undefined;
            switch (choice) {
                case 'base':
                    referenceCell = baseCell;
                    break;
                case 'current':
                    referenceCell = currentCell;
                    break;
                case 'incoming':
                    referenceCell = incomingCell;
                    break;
                case 'delete':
                    continue;
            }

            if (!referenceCell) {
                // User selected a side but that cell doesn't exist in that branch.
                // Skip the cell to avoid adding undefined cells to the resolved notebook.
                logger.warn(`[semanticResolution] Skipping row: user chose '${choice}' but cell not found in that branch`);
                continue;
            }

            const cellType = referenceCell.cell_type || 'code';
            cellToUse = JSON.parse(JSON.stringify(referenceCell)) as NotebookCell;
            cellToUse.cell_type = cellType;
            cellToUse.source = sourceToCellFormat(resolvedContent);
        } else if (preferredSide) {
            if (preferredSide === 'base') cellToUse = baseCell;
            else if (preferredSide === 'current') cellToUse = currentCell;
            else if (preferredSide === 'incoming') cellToUse = incomingCell;
        } else {
            cellToUse = selectNonConflictMergedCell(baseCell, currentCell, incomingCell);
        }

        if (cellToUse) {
            resolvedCells.push(applyAutoResolveCellPatches(cellToUse, row, autoResolveResult));
        }
    }

    const templateNotebook = currentNotebook || incomingNotebook || baseNotebook!;
    const mergedMetadata = mergeNotebookMetadata(
        baseNotebook?.metadata as any,
        currentNotebook?.metadata as any,
        incomingNotebook?.metadata as any,
        { preferKernelFromCurrent: settings.autoResolveKernelVersion }
    );

    let resolvedNotebook: Notebook = {
        nbformat: templateNotebook.nbformat,
        nbformat_minor: templateNotebook.nbformat_minor,
        metadata: JSON.parse(JSON.stringify(mergedMetadata)),
        cells: resolvedCells
    };

    if (shouldRenumber) {
        resolvedNotebook = renumberExecutionCounts(resolvedNotebook);
    }

    return resolvedNotebook;
}
