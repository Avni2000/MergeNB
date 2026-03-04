import type { MergeRow as MergeRowType } from './types';

interface IndexedRow {
    row: MergeRowType;
    index: number;
}

function hasAllThreeIndices(row: MergeRowType): boolean {
    return row.baseCellIndex !== undefined
        && row.currentCellIndex !== undefined
        && row.incomingCellIndex !== undefined;
}

/**
 * Compute row indices that are truly reordered (relative-order inversion),
 * not just shifted by insert/delete offset.
 */
export function computeReorderedRowIndexSet(rows: MergeRowType[]): Set<number> {
    const withAllIndices: IndexedRow[] = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => hasAllThreeIndices(row));

    const reordered = new Set<number>();
    if (withAllIndices.length < 2) return reordered;

    for (let i = 1; i < withAllIndices.length; i++) {
        const prev = withAllIndices[i - 1];
        const curr = withAllIndices[i];

        const baseOrdered = curr.row.baseCellIndex! > prev.row.baseCellIndex!;
        const currentOrdered = curr.row.currentCellIndex! > prev.row.currentCellIndex!;
        const incomingOrdered = curr.row.incomingCellIndex! > prev.row.incomingCellIndex!;

        if (baseOrdered !== currentOrdered || baseOrdered !== incomingOrdered) {
            reordered.add(prev.index);
            reordered.add(curr.index);
        }
    }

    return reordered;
}

export function isRowReorderedAtIndex(rows: MergeRowType[], rowIndex: number): boolean {
    return computeReorderedRowIndexSet(rows).has(rowIndex);
}
