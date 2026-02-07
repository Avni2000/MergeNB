/**
 * @file useUndoRedo.ts
 * @description React hook for undo/redo state management in the conflict resolver.
 * 
 * Tracks snapshots of mutable UI state (choices, rows, checkbox settings) as an 
 * undo/redo timeline. Each undoable action pushes a snapshot with a label describing 
 * the action. Undo pops the stack; redo re-applies.
 */

import { useCallback, useRef, useState } from 'react';
import type { MergeRow, ResolutionChoice } from './types';

/** Resolution state tracking for a cell conflict */
export interface ResolutionState {
    choice: ResolutionChoice;
    originalContent: string;
    resolvedContent: string;
}

/** A snapshot of all mutable state in the conflict resolver */
export interface UndoableSnapshot {
    choices: Map<number, ResolutionState>;
    rows: MergeRow[];
    markAsResolved: boolean;
    renumberExecutionCounts: boolean;
}

/** An entry in the undo/redo history */
export interface HistoryEntry {
    label: string;
    snapshot: UndoableSnapshot;
    timestamp: number;
}

/** Deep-clone a snapshot so mutations don't affect history */
function cloneSnapshot(snapshot: UndoableSnapshot): UndoableSnapshot {
    const clonedChoices = new Map<number, ResolutionState>();
    for (const [key, value] of snapshot.choices) {
        clonedChoices.set(key, { ...value });
    }
    return {
        choices: clonedChoices,
        rows: snapshot.rows.map(r => ({ ...r })),
        markAsResolved: snapshot.markAsResolved,
        renumberExecutionCounts: snapshot.renumberExecutionCounts,
    };
}

export interface UndoRedoControls {
    /** Push a new undoable action onto the history */
    pushAction: (label: string, snapshot: UndoableSnapshot) => void;
    /** Undo the last action, returns the snapshot to restore (or null if nothing to undo) */
    undo: () => UndoableSnapshot | null;
    /** Redo the last undone action, returns the snapshot to restore (or null if nothing to redo) */
    redo: () => UndoableSnapshot | null;
    /** Whether undo is available */
    canUndo: boolean;
    /** Whether redo is available */
    canRedo: boolean;
    /** The complete history for display in dropdown */
    history: HistoryEntry[];
    /** Current position in history (index of the current state) */
    currentIndex: number;
    /** Jump to a specific history entry, returns the snapshot to restore */
    jumpTo: (index: number) => UndoableSnapshot | null;
}

const MAX_HISTORY = 100;

export function useUndoRedo(initialSnapshot: UndoableSnapshot): UndoRedoControls {
    // History is stored as a ref to avoid re-renders on every push; 
    // a version counter triggers re-renders when needed.
    const historyRef = useRef<HistoryEntry[]>([{
        label: 'Initial state',
        snapshot: cloneSnapshot(initialSnapshot),
        timestamp: Date.now(),
    }]);
    const currentIndexRef = useRef(0);
    const [, setVersion] = useState(0);

    const bump = useCallback(() => setVersion(v => v + 1), []);

    const pushAction = useCallback((label: string, snapshot: UndoableSnapshot) => {
        const history = historyRef.current;
        const idx = currentIndexRef.current;

        // Truncate any redo entries beyond current position
        historyRef.current = history.slice(0, idx + 1);

        // Push new entry
        historyRef.current.push({
            label,
            snapshot: cloneSnapshot(snapshot),
            timestamp: Date.now(),
        });

        // Cap history size
        if (historyRef.current.length > MAX_HISTORY) {
            historyRef.current = historyRef.current.slice(historyRef.current.length - MAX_HISTORY);
        }

        currentIndexRef.current = historyRef.current.length - 1;
        bump();
    }, [bump]);

    const undo = useCallback((): UndoableSnapshot | null => {
        if (currentIndexRef.current <= 0) return null;
        currentIndexRef.current -= 1;
        bump();
        return cloneSnapshot(historyRef.current[currentIndexRef.current].snapshot);
    }, [bump]);

    const redo = useCallback((): UndoableSnapshot | null => {
        if (currentIndexRef.current >= historyRef.current.length - 1) return null;
        currentIndexRef.current += 1;
        bump();
        return cloneSnapshot(historyRef.current[currentIndexRef.current].snapshot);
    }, [bump]);

    const jumpTo = useCallback((index: number): UndoableSnapshot | null => {
        if (index < 0 || index >= historyRef.current.length) return null;
        currentIndexRef.current = index;
        bump();
        return cloneSnapshot(historyRef.current[index].snapshot);
    }, [bump]);

    return {
        pushAction,
        undo,
        redo,
        canUndo: currentIndexRef.current > 0,
        canRedo: currentIndexRef.current < historyRef.current.length - 1,
        history: historyRef.current,
        currentIndex: currentIndexRef.current,
        jumpTo,
    };
}
