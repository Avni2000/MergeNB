import type { NotebookCell, ResolvedRow, MergeNBSettings } from './types';
import { selectNonConflictMergedCell, sourceToCellFormat } from './notebookUtils';
import type { PreferredSide } from './semanticResolution';
import { isKnownCellType } from './notebookValidation';

/** Whole-cell choices retain their complete payload; source edits affect known cells only. */
export function resolveCell(row: ResolvedRow, settings: MergeNBSettings, preferredSide?: PreferredSide): NotebookCell | undefined {
    if (!row.resolution) {
        if (preferredSide === 'base') return row.baseCell;
        if (preferredSide === 'current') return row.currentCell;
        if (preferredSide === 'incoming') return row.incomingCell;
        return selectNonConflictMergedCell(row.baseCell, row.currentCell, row.incomingCell);
    }
    const { choice, resolvedContent } = row.resolution;
    if (choice === 'delete') return undefined;
    const cell = choice === 'base' ? row.baseCell : choice === 'current' ? row.currentCell : row.incomingCell;
    if (!cell) throw new Error(`Cannot choose ${choice}: this cell is absent. Choose Delete Cell instead.`);
    const resolved = structuredClone(cell);
    if (isKnownCellType(cell.cell_type)) resolved.source = sourceToCellFormat(resolvedContent);
    if (cell.cell_type === 'code') {
        if (settings.stripOutputs) resolved.outputs = [];
        if (settings.autoResolveExecutionCount) resolved.execution_count = null;
    }
    return resolved;
}
