import type { ResolvedRow, NotebookCell } from './types';
import type { PreferredSide } from './semanticResolution';

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

export function inferPreferredSide(
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

