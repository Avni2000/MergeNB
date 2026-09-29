import type { CellMapping, SemanticConflict } from './types';
import { detectReordering } from './cellMatcher';
import { mergeCell } from './cellMerge';

/**
 * Analyze cell mappings to identify semantic conflicts.
 * Exported for testing purposes.
 * Note: Settings are not used here. All conflict filtering based on settings
 * happens in applyAutoResolutions(). This function is purely a detector.
 */
export function analyzeSemanticConflictsFromMappings(
    mappings: CellMapping[]
): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];

    // Check for cell reordering
    if (detectReordering(mappings)) {
        conflicts.push({
            type: 'cell-reordered'
        });
    }

    for (const mapping of mappings) {
        const { baseIndex, currentIndex, incomingIndex, baseCell, currentCell, incomingCell } = mapping;

        // Case 1: Cell added in current only
        if (currentCell && !baseCell && !incomingCell) {
            conflicts.push({
                type: 'cell-added',
                currentCellIndex: currentIndex,
                currentContent: currentCell
            });
            continue;
        }

        // Case 2: Cell added in incoming only
        if (incomingCell && !baseCell && !currentCell) {
            conflicts.push({
                type: 'cell-added',
                incomingCellIndex: incomingIndex,
                incomingContent: incomingCell
            });
            continue;
        }

        // Case 3: Cell added in both (conflict!)
        if (currentCell && incomingCell && !baseCell) {
            conflicts.push(...compareMappedCells(mapping));
            continue;
        }

        // Case 4: Cell deleted in current
        if (baseCell && !currentCell && incomingCell) {
            conflicts.push({
                type: 'cell-deleted',
                baseCellIndex: baseIndex,
                incomingCellIndex: incomingIndex,
                baseContent: baseCell,
                incomingContent: incomingCell
            });
            continue;
        }

        // Case 5: Cell deleted in incoming
        if (baseCell && currentCell && !incomingCell) {
            conflicts.push({
                type: 'cell-deleted',
                baseCellIndex: baseIndex,
                currentCellIndex: currentIndex,
                baseContent: baseCell,
                currentContent: currentCell
            });
            continue;
        }

        // Case 6: Cell deleted in both (no conflict, just deleted)
        if (baseCell && !currentCell && !incomingCell) {
            // Not a conflict, skip
            continue;
        }

        // Case 7: Cell exists in all three - check for modifications
        if (baseCell && currentCell && incomingCell) {
            conflicts.push(...compareMappedCells(mapping));
        }
    }

    return conflicts;
}

function compareMappedCells(mapping: CellMapping): SemanticConflict[] {
    const { baseCell, currentCell, incomingCell, baseIndex, currentIndex, incomingIndex } = mapping;
    if (!currentCell || !incomingCell) return [];
    const fields = mergeCell(baseCell, currentCell, incomingCell).conflicts;
    const types = new Set<SemanticConflict['type']>();
    for (const field of fields) {
        switch (field.path[0]) {
            case 'source': types.add(baseCell ? 'cell-modified' : 'cell-added'); break;
            case 'metadata': types.add('metadata-changed'); break;
            case 'outputs': types.add('outputs-changed'); break;
            case 'execution_count': types.add('execution-count-changed'); break;
            case 'attachments': types.add('attachments-changed'); break;
            default: types.add('cell-fields-changed');
        }
    }
    return [...types].map(type => ({
        type, baseCellIndex: baseIndex, currentCellIndex: currentIndex, incomingCellIndex: incomingIndex,
        baseContent: baseCell, currentContent: currentCell, incomingContent: incomingCell,
    }));
}
