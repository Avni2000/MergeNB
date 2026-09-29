import type { ResolvedRow } from '../../../../core/src';
import type { ResolverSnapshot } from '../store/resolverStore';

export function resolvedRowsFromState(state: Pick<ResolverSnapshot, 'rows' | 'choices'>): ResolvedRow[] {
    return state.rows.map(row => {
        const choice = row.conflictIndex === undefined ? undefined : state.choices.get(row.conflictIndex);
        return {
            baseCell: row.baseCell,
            currentCell: row.currentCell,
            incomingCell: row.incomingCell,
            baseCellIndex: row.baseCellIndex,
            currentCellIndex: row.currentCellIndex,
            incomingCellIndex: row.incomingCellIndex,
            resolution: choice ? { choice: choice.choice, resolvedContent: choice.resolvedContent } : undefined,
        };
    });
}
