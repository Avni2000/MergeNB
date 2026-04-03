import { sortByPosition, detectReordering, type Notebook } from '../../../../core/src';
import type {
    MergeRow as MergeRowType,
    NotebookSemanticConflict,
    SemanticConflict,
} from '../types';
import { computeReorderedRowIndexSet } from './reorderUtils';

const conflictPriority: Record<SemanticConflict['type'], number> = {
    'cell-modified': 0,
    'cell-added': 1,
    'cell-deleted': 2,
    'cell-reordered': 3,
    'metadata-changed': 4,
    'outputs-changed': 5,
    'execution-count-changed': 6,
};

function sortMergeRowsByPosition(rows: MergeRowType[]): MergeRowType[] {
    return sortByPosition(rows, (row) => ({
        anchor: row.anchorPosition ?? 0,
        incoming: row.incomingCellIndex,
        current: row.currentCellIndex,
        base: row.baseCellIndex,
    }));
}

export function buildMergeRowsFromSemantic(
    conflict: NotebookSemanticConflict,
    currentNotebookOverride?: Notebook
): MergeRowType[] {
    const rows: MergeRowType[] = [];
    const conflictMap = new Map<string, { conflict: SemanticConflict; index: number }>();

    conflict.semanticConflicts.forEach((semanticConflict, index) => {
        const key = `${semanticConflict.baseCellIndex ?? 'x'}-${semanticConflict.currentCellIndex ?? 'x'}-${semanticConflict.incomingCellIndex ?? 'x'}`;
        const existing = conflictMap.get(key);
        const nextRank = conflictPriority[semanticConflict.type] ?? Number.MAX_SAFE_INTEGER;
        const existingRank = existing
            ? conflictPriority[existing.conflict.type] ?? Number.MAX_SAFE_INTEGER
            : Number.MAX_SAFE_INTEGER;

        if (!existing || nextRank < existingRank) {
            conflictMap.set(key, { conflict: semanticConflict, index });
        }
    });

    for (const mapping of conflict.cellMappings) {
        const baseCell = mapping.baseIndex !== undefined && conflict.base
            ? conflict.base.cells[mapping.baseIndex]
            : undefined;
        const currentSource = currentNotebookOverride || conflict.current;
        const currentCell = mapping.currentIndex !== undefined && currentSource
            ? currentSource.cells[mapping.currentIndex]
            : undefined;
        const incomingCell = mapping.incomingIndex !== undefined && conflict.incoming
            ? conflict.incoming.cells[mapping.incomingIndex]
            : undefined;

        const key = `${mapping.baseIndex ?? 'x'}-${mapping.currentIndex ?? 'x'}-${mapping.incomingIndex ?? 'x'}`;
        const conflictInfo = conflictMap.get(key);

        const presentSides: ('base' | 'current' | 'incoming')[] = [];
        if (baseCell) presentSides.push('base');
        if (currentCell) presentSides.push('current');
        if (incomingCell) presentSides.push('incoming');

        const isUnmatched = presentSides.length < 3 && presentSides.length > 0;
        const anchorPosition = mapping.baseIndex ?? mapping.currentIndex ?? mapping.incomingIndex ?? 0;

        rows.push({
            type: conflictInfo ? 'conflict' : 'identical',
            baseCell,
            currentCell,
            incomingCell,
            baseCellIndex: mapping.baseIndex,
            currentCellIndex: mapping.currentIndex,
            incomingCellIndex: mapping.incomingIndex,
            conflictIndex: conflictInfo?.index,
            conflictType: conflictInfo?.conflict.type,
            isUnmatched,
            unmatchedSides: isUnmatched ? presentSides : undefined,
            anchorPosition,
        });
    }

    const sortedRows = sortMergeRowsByPosition(rows);
    const hasGlobalReorderConflict = detectReordering(conflict.cellMappings);
    if (!hasGlobalReorderConflict) {
        return sortedRows;
    }

    const reorderedRowIndices = computeReorderedRowIndexSet(sortedRows);
    if (reorderedRowIndices.size === 0) {
        return sortedRows;
    }

    let nextSyntheticConflictIndex = sortedRows.reduce((maxIndex, row) => {
        return row.conflictIndex !== undefined && row.conflictIndex > maxIndex
            ? row.conflictIndex
            : maxIndex;
    }, -1) + 1;

    return sortedRows.map((row, index) => {
        if (!reorderedRowIndices.has(index)) {
            return row;
        }

        if (row.type === 'conflict') {
            return {
                ...row,
                isReordered: true,
            };
        }

        return {
            ...row,
            isReordered: true,
            type: 'conflict',
            conflictIndex: nextSyntheticConflictIndex++,
            conflictType: 'cell-reordered',
        };
    });
}
