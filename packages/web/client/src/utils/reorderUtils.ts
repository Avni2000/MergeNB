import type { MergeRow as MergeRowType } from '../types';

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
 * Compute row indices whose relative order differs between current and
 * incoming, not rows that merely drifted because of insert/delete offsets.
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

        const currentOrdered = curr.row.currentCellIndex! > prev.row.currentCellIndex!;
        const incomingOrdered = curr.row.incomingCellIndex! > prev.row.incomingCellIndex!;

        if (currentOrdered !== incomingOrdered) {
            reordered.add(prev.index);
            reordered.add(curr.index);
        }
    }

    return reordered;
}
