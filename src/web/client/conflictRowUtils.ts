/**
 * @file conflictRowUtils.ts
 * @description Pure utility functions for conflict row accounting.
 *
 * Kept in a separate module (no React / JupyterLab imports) so that
 * Node.js-based logic tests can import these without triggering the
 * full browser-side dependency chain.
 */

import type { MergeRow as MergeRowType, SemanticConflict } from './types';

function conflictHasCellIndices(conflict: SemanticConflict): boolean {
    return (
        conflict.baseCellIndex !== undefined ||
        conflict.currentCellIndex !== undefined ||
        conflict.incomingCellIndex !== undefined
    );
}

export function collectRowConflictIndexes(rows: MergeRowType[]): Set<number> {
    const indexes = new Set<number>();
    for (const row of rows) {
        if (row.type === 'conflict' && row.conflictIndex !== undefined) {
            indexes.add(row.conflictIndex);
        }
    }
    return indexes;
}

export function hasUnmappedReorderConflict(
    semanticConflicts: SemanticConflict[] | undefined,
    rowConflictIndexes: Set<number>
): boolean {
    if (!semanticConflicts) return false;
    return semanticConflicts.some((c, index) =>
        c.type === 'cell-reordered' &&
        !conflictHasCellIndices(c) &&
        !rowConflictIndexes.has(index)
    );
}
