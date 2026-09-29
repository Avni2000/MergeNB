/**
 * @file semanticResolution.ts
 * @description Pure helpers for resolving semantic conflicts without VS Code.
 */

import type { Notebook, NotebookCell, NotebookSemanticConflict, MergeNBSettings, ResolvedRow } from './types';
import type { AutoResolveResult } from './conflictDetector';
import { selectNonConflictMergedCell, sourceToCellFormat } from './notebookUtils';
import { renumberExecutionCounts } from './notebookParser';
import { mergeNotebookFields } from './notebookFields';
import type { FieldResolutions } from './fieldMerge';
import * as logger from './logger';

export type PreferredSide = 'base' | 'current' | 'incoming';

interface BuildResolvedNotebookOptions {
    semanticConflict: NotebookSemanticConflict;
    resolvedRows: ResolvedRow[];
    autoResolveResult?: AutoResolveResult;
    settings: MergeNBSettings;
    shouldRenumber: boolean;
    preferredSideHint?: PreferredSide;
    notebookResolutions?: FieldResolutions;
    allowUnresolvedNotebookFields?: boolean;
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
    const autoResolvedNotebook = autoResolveResult?.currentNotebook;

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
                    referenceCell = baseCell;
                    break;
                case 'current':
                    referenceCell = currentCellForFallback;
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

            if (cellType === 'code') {
                if (settings.stripOutputs) {
                    (cellToUse as any).execution_count = null;
                    (cellToUse as any).outputs = [];
                }
                // else: outputs/execution_count already preserved from the deep clone
            }
        } else if (preferredSide) {
            if (preferredSide === 'base') cellToUse = baseCell;
            else if (preferredSide === 'current') cellToUse = currentCellForFallback;
            else if (preferredSide === 'incoming') cellToUse = incomingCell;
        } else {
            cellToUse = selectNonConflictMergedCell(baseCell, currentCellForFallback, incomingCell);
        }

        if (cellToUse) {
            resolvedCells.push(JSON.parse(JSON.stringify(cellToUse)));
        }
    }

    const fields = mergeNotebookFields(semanticConflict, settings.autoResolveKernelVersion, options.notebookResolutions);
    if (fields.conflicts.length > 0 && !options.allowUnresolvedNotebookFields) {
        throw new Error('Resolve all notebook fields before applying the resolution.');
    }
    const notebooks = [baseNotebook, currentNotebook, incomingNotebook].filter((nb): nb is Notebook => !!nb);
    let resolvedNotebook: Notebook = {
        ...fields.value,
        nbformat: notebooks[0].nbformat,
        nbformat_minor: Math.max(...notebooks.map(nb => nb.nbformat_minor)),
        metadata: fields.value.metadata as Notebook['metadata'],
        cells: resolvedCells,
    };

    if (shouldRenumber) {
        resolvedNotebook = renumberExecutionCounts(resolvedNotebook);
    }

    return resolvedNotebook;
}
