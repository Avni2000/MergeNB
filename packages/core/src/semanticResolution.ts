/**
 * @file semanticResolution.ts
 * @description Pure helpers for resolving semantic conflicts without VS Code.
 */

import type { Notebook, NotebookCell, NotebookSemanticConflict, MergeNBSettings, ResolvedRow } from './types';
import type { AutoResolveResult } from './conflictDetector';
import { renumberExecutionCounts } from './notebookParser';
import { mergeNotebookFields } from './notebookFields';
import type { FieldResolutions } from './fieldMerge';
import { inferPreferredSide } from './resolutionOrder';
import { resolveCell } from './resolvedCell';
import { repairCellIds } from './cellIds';

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
        const preparedRow = { ...row };
        if (autoResolvedNotebook && row.currentCellIndex !== undefined) {
            preparedRow.currentCell = autoResolvedNotebook.cells[row.currentCellIndex];
        }
        const cell = resolveCell(preparedRow, settings, preferredSide);
        if (cell) resolvedCells.push(structuredClone(cell));
    }

    const fields = mergeNotebookFields(semanticConflict, settings.autoResolveKernelVersion, options.notebookResolutions);
    if (fields.conflicts.length > 0 && !options.allowUnresolvedNotebookFields) {
        throw new Error('Resolve all notebook fields before applying the resolution.');
    }
    const notebooks = [baseNotebook, currentNotebook, incomingNotebook].filter((nb): nb is Notebook => !!nb);
    if (notebooks.some(nb => nb.nbformat !== 4)) throw new Error('Cannot merge notebook major versions other than 4.');
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

    return repairCellIds(resolvedNotebook);
}
