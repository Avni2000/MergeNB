import { enableMapSet } from 'immer';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import { normalizeCellSource, sortByPosition } from '../../../../core/src';
import type { MergeRow as MergeRowType, NotebookCell, ResolutionChoice } from '../types';

enableMapSet();

const INITIAL_MARK_AS_RESOLVED = true;
const INITIAL_RENUMBER_EXECUTION_COUNTS = true;

export interface ResolutionState {
    choice: ResolutionChoice;
    originalContent: string;
    resolvedContent: string;
}

export type TakeAllChoice = 'base' | 'current' | 'incoming';

interface ResolverSnapshot {
    choices: Map<number, ResolutionState>;
    rows: MergeRowType[];
    markAsResolved: boolean;
    renumberExecutionCounts: boolean;
    takeAllChoice?: TakeAllChoice;
}

interface HistoryEntry {
    label: string;
    snapshot: ResolverSnapshot;
}

interface HistoryState {
    entries: HistoryEntry[];
    index: number;
}

interface ResolverStoreState {
    choices: Map<number, ResolutionState>;
    rows: MergeRowType[];
    markAsResolved: boolean;
    renumberExecutionCounts: boolean;
    takeAllChoice?: TakeAllChoice;
    history: HistoryState;
    selectChoice: (index: number, choice: ResolutionChoice, resolvedContent: string) => void;
    commitContent: (index: number, resolvedContent: string) => void;
    acceptAll: (choice: TakeAllChoice) => void;
    setRenumberExecutionCounts: (checked: boolean) => void;
    setMarkAsResolved: (checked: boolean) => void;
    jumpToHistory: (targetIndex: number) => void;
    unmatchRow: (rowIndex: number) => void;
    rematchRows: (unmatchGroupId: string) => void;
    undo: () => void;
    redo: () => void;
}

type ResolverStore = StoreApi<ResolverStoreState>;

function cloneChoices(source: Map<number, ResolutionState>): Map<number, ResolutionState> {
    return new Map(Array.from(source.entries()).map(([key, value]) => [key, { ...value }]));
}

function cloneRows(source: MergeRowType[]): MergeRowType[] {
    return source.map(row => {
        if (row.isUserUnmatched) {
            return {
                ...row,
                originalMatchedRow: { ...row.originalMatchedRow } as MergeRowType,
            };
        }
        return {
            ...row,
            originalMatchedRow: undefined,
        };
    });
}

function buildInitialHistory(rows: MergeRowType[]): HistoryState {
    return {
        entries: [{
            label: 'Initial state',
            snapshot: {
                choices: cloneChoices(new Map()),
                rows: cloneRows(rows),
                markAsResolved: INITIAL_MARK_AS_RESOLVED,
                renumberExecutionCounts: INITIAL_RENUMBER_EXECUTION_COUNTS,
                takeAllChoice: undefined,
            },
        }],
        index: 0,
    };
}

function recordHistory(
    state: ResolverStoreState,
    label: string,
    overrides?: {
        markAsResolved?: boolean;
        renumberExecutionCounts?: boolean;
        takeAllChoice?: TakeAllChoice;
    }
): void {
    const entries = state.history.entries.slice(0, state.history.index + 1);
    entries.push({
        label,
        snapshot: {
            choices: cloneChoices(state.choices),
            rows: cloneRows(state.rows),
            markAsResolved: overrides?.markAsResolved ?? state.markAsResolved,
            renumberExecutionCounts: overrides?.renumberExecutionCounts ?? state.renumberExecutionCounts,
            takeAllChoice: overrides?.takeAllChoice ?? state.takeAllChoice,
        },
    });
    state.history.entries = entries;
    state.history.index = entries.length - 1;
}

function applySnapshot(state: ResolverStoreState, snapshot: ResolverSnapshot): void {
    state.choices = cloneChoices(snapshot.choices);
    state.rows = cloneRows(snapshot.rows);
    state.markAsResolved = snapshot.markAsResolved;
    state.renumberExecutionCounts = snapshot.renumberExecutionCounts;
    state.takeAllChoice = snapshot.takeAllChoice;
}

function getCellForSide(
    row: MergeRowType,
    side: TakeAllChoice
): NotebookCell | undefined {
    if (side === 'base') return row.baseCell;
    if (side === 'current') return row.currentCell;
    return row.incomingCell;
}

function sortRowsByPosition(rows: MergeRowType[]): MergeRowType[] {
    return sortByPosition(rows, (row) => ({
        anchor: row.anchorPosition ?? 0,
        incoming: row.incomingCellIndex,
        current: row.currentCellIndex,
        base: row.baseCellIndex,
    }));
}

export function createResolverStore(initialRows: MergeRowType[]): ResolverStore {
    let unmatchGroupCounter = 0;
    const generateUnmatchGroupId = () => `unmatch-${++unmatchGroupCounter}`;

    return createStore<ResolverStoreState>()(
        immer((set) => ({
            choices: new Map(),
            rows: cloneRows(initialRows),
            markAsResolved: INITIAL_MARK_AS_RESOLVED,
            renumberExecutionCounts: INITIAL_RENUMBER_EXECUTION_COUNTS,
            takeAllChoice: undefined,
            history: buildInitialHistory(initialRows),
            selectChoice: (index: number, choice: ResolutionChoice, resolvedContent: string) => set(state => {
                state.choices.set(index, {
                    choice,
                    originalContent: resolvedContent,
                    resolvedContent,
                });
                state.takeAllChoice = undefined;
                recordHistory(state, `Resolve conflict ${index + 1} (${choice})`, { takeAllChoice: undefined });
            }),
            commitContent: (index: number, resolvedContent: string) => set(state => {
                const current = state.choices.get(index);
                if (!current) return;

                if (current.resolvedContent !== resolvedContent) {
                    state.choices.set(index, { ...current, resolvedContent });
                    state.takeAllChoice = undefined;
                }

                const lastSnapshot = state.history.entries[state.history.index]?.snapshot;
                const lastChoice = lastSnapshot?.choices.get(index);
                const nextChoice = state.choices.get(index);
                if (
                    lastChoice &&
                    nextChoice &&
                    lastChoice.resolvedContent === nextChoice.resolvedContent &&
                    lastChoice.choice === nextChoice.choice
                ) {
                    return;
                }
                recordHistory(state, `Edit conflict ${index + 1}`, { takeAllChoice: undefined });
            }),
            acceptAll: (choice: TakeAllChoice) => set(state => {
                const conflictRows = state.rows.filter(row => row.type === 'conflict');
                let didChange = false;

                conflictRows.forEach(row => {
                    const conflictIdx = row.conflictIndex ?? -1;
                    if (conflictIdx < 0) return;
                    if (state.choices.has(conflictIdx)) return;

                    const cell = getCellForSide(row, choice);
                    const effectiveChoice: ResolutionChoice = cell ? choice : 'delete';
                    const content = cell ? normalizeCellSource(cell.source) : '';

                    state.choices.set(conflictIdx, {
                        choice: effectiveChoice,
                        originalContent: content,
                        resolvedContent: content,
                    });
                    didChange = true;
                });

                if (!didChange) return;
                state.takeAllChoice = choice;
                recordHistory(state, `Accept all ${choice}`, { takeAllChoice: choice });
            }),
            setRenumberExecutionCounts: (checked: boolean) => set(state => {
                if (checked === state.renumberExecutionCounts) return;
                state.renumberExecutionCounts = checked;
                recordHistory(state, `Renumber execution counts ${checked ? 'on' : 'off'}`, { renumberExecutionCounts: checked });
            }),
            setMarkAsResolved: (checked: boolean) => set(state => {
                if (checked === state.markAsResolved) return;
                state.markAsResolved = checked;
                recordHistory(state, `Mark as resolved ${checked ? 'on' : 'off'}`, { markAsResolved: checked });
            }),
            jumpToHistory: (targetIndex: number) => set(state => {
                if (targetIndex === state.history.index) return;
                if (targetIndex < 0 || targetIndex >= state.history.entries.length) return;
                const targetSnapshot = state.history.entries[targetIndex].snapshot;
                applySnapshot(state, targetSnapshot);
                state.history.index = targetIndex;
            }),
            unmatchRow: (rowIndex: number) => set(state => {
                const row = state.rows[rowIndex];
                if (!row || row.type !== 'conflict') return;
                if (row.conflictIndex === undefined) return;
                if (row.isUserUnmatched || row.unmatchGroupId !== undefined || row.originalMatchedRow !== undefined) return;

                // Reorder eligibility is part of the original row state, not the current
                // live row list, so other unmatches do not invalidate this row.
                if (!row.isReordered) return;

                // Unmatch separates current from incoming.  Base is reference
                // context (preserved in originalMatchedRow for rematch), not an
                // independent side the user resolves.
                const sides: Array<'current' | 'incoming'> = [];
                if (row.currentCell) sides.push('current');
                if (row.incomingCell) sides.push('incoming');
                if (sides.length < 2) return;

                const groupId = generateUnmatchGroupId();

                // Find max existing conflictIndex
                let maxConflictIndex = -1;
                for (const r of state.rows) {
                    if (r.conflictIndex !== undefined && r.conflictIndex > maxConflictIndex) {
                        maxConflictIndex = r.conflictIndex;
                    }
                }
                let nextConflictIndex = maxConflictIndex + 1;

                const splitRows: MergeRowType[] = sides.map(side => ({
                    type: 'conflict' as const,
                    baseCell: undefined,
                    currentCell: side === 'current' ? row.currentCell : undefined,
                    incomingCell: side === 'incoming' ? row.incomingCell : undefined,
                    baseCellIndex: undefined,
                    currentCellIndex: side === 'current' ? row.currentCellIndex : undefined,
                    incomingCellIndex: side === 'incoming' ? row.incomingCellIndex : undefined,
                    conflictIndex: nextConflictIndex++,
                    conflictType: 'user-unmatched',
                    isUnmatched: true,
                    unmatchedSides: [side],
                    anchorPosition: (side === 'current' ? row.currentCellIndex
                        : row.incomingCellIndex) ?? row.anchorPosition,
                    isUserUnmatched: true,
                    unmatchGroupId: groupId,
                    originalMatchedRow: cloneRows([row])[0],
                }));

                // Remove choice for the original row
                if (row.conflictIndex !== undefined) {
                    state.choices.delete(row.conflictIndex);
                }

                // Replace the original row and re-sort globally so split rows
                // land where their per-side positions say they belong.
                const nextRows = state.rows.slice();
                nextRows.splice(rowIndex, 1, ...splitRows);
                state.rows = sortRowsByPosition(nextRows);
                state.takeAllChoice = undefined;
                recordHistory(state, `Unmatch row ${rowIndex + 1}`);
            }),
            rematchRows: (unmatchGroupId: string) => set(state => {
                // Find all split rows with this group ID
                const groupRowIndices: number[] = [];
                let originalRow: MergeRowType | undefined;

                for (let i = 0; i < state.rows.length; i++) {
                    if (state.rows[i].unmatchGroupId === unmatchGroupId) {
                        groupRowIndices.push(i);
                        if (!originalRow && state.rows[i].originalMatchedRow) {
                            originalRow = state.rows[i].originalMatchedRow;
                        }
                    }
                }

                if (groupRowIndices.length === 0 || !originalRow) return;

                // Remove choices for all split rows
                for (const idx of groupRowIndices) {
                    const ci = state.rows[idx].conflictIndex;
                    if (ci !== undefined) state.choices.delete(ci);
                }

                const restoredRow: MergeRowType = {
                    ...originalRow,
                    isUserUnmatched: undefined,
                    unmatchGroupId: undefined,
                    originalMatchedRow: undefined,
                };
                if (restoredRow.conflictIndex !== undefined) {
                    state.choices.delete(restoredRow.conflictIndex);
                }

                const groupRowIndexSet = new Set(groupRowIndices);
                state.rows = sortRowsByPosition([
                    ...state.rows.filter((_, index) => !groupRowIndexSet.has(index)),
                    restoredRow,
                ]);

                state.takeAllChoice = undefined;
                recordHistory(state, `Rematch row group`);
            }),
            undo: () => set(state => {
                if (state.history.index === 0) return;
                const nextIndex = state.history.index - 1;
                const targetSnapshot = state.history.entries[nextIndex].snapshot;
                applySnapshot(state, targetSnapshot);
                state.history.index = nextIndex;
            }),
            redo: () => set(state => {
                if (state.history.index >= state.history.entries.length - 1) return;
                const nextIndex = state.history.index + 1;
                const targetSnapshot = state.history.entries[nextIndex].snapshot;
                applySnapshot(state, targetSnapshot);
                state.history.index = nextIndex;
            }),
        }))
    );
}
