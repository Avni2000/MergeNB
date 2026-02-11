/**
 * @file ConflictResolver.tsx
 * @description Main React component for the conflict resolution UI.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { sortByPosition } from '../../positionUtils';
import { normalizeCellSource } from '../../notebookUtils';
import type {
    UnifiedConflictData,
    MergeRow as MergeRowType,
    ConflictChoice,
    NotebookSemanticConflict,
    CellMapping,
    SemanticConflict,
    NotebookCell,
    ResolutionChoice,
} from './types';
import { MergeRow } from './MergeRow';

const INITIAL_MARK_AS_RESOLVED = true;
const INITIAL_RENUMBER_EXECUTION_COUNTS = true;

/** Resolution state tracking for a cell conflict */
interface ResolutionState {
    /** The branch choice that determines outputs, metadata, etc. */
    choice: ResolutionChoice;
    /** The original content from the chosen branch (for detecting modifications) */
    originalContent: string;
    /** The current resolved content (may be edited by user) */
    resolvedContent: string;
}

/** Data about a cell being dragged */
interface DraggedCellData {
    rowIndex: number;
    side: 'base' | 'current' | 'incoming';
    cell: NotebookCell;
}

/** Data about a potential drop target */
interface DropTarget {
    rowIndex: number;
    side: 'base' | 'current' | 'incoming';
}

interface ResolverSnapshot {
    choices: Map<number, ResolutionState>;
    rows: MergeRowType[];
    markAsResolved: boolean;
    renumberExecutionCounts: boolean;
}

interface HistoryEntry {
    label: string;
    snapshot: ResolverSnapshot;
}

interface HistoryState {
    entries: HistoryEntry[];
    index: number;
}

function cloneChoices(source: Map<number, ResolutionState>): Map<number, ResolutionState> {
    return new Map(Array.from(source.entries()).map(([key, value]) => [key, { ...value }]));
}

function cloneRows(source: MergeRowType[]): MergeRowType[] {
    return source.map(row => ({ ...row }));
}

interface ConflictResolverProps {
    conflict: UnifiedConflictData;
    onResolve: (resolutions: ConflictChoice[], markAsResolved: boolean, renumberExecutionCounts: boolean, resolvedRows: import('./types').ResolvedRow[]) => void;
    onCancel: () => void;
}

export function ConflictResolver({
    conflict,
    onResolve,
    onCancel,
}: ConflictResolverProps): React.ReactElement {
    const initialRows = conflict.type === 'semantic' && conflict.semanticConflict
        ? buildMergeRowsFromSemantic(conflict.semanticConflict)
        : [];

    const [choices, setChoices] = useState<Map<number, ResolutionState>>(new Map());
    const [markAsResolved, setMarkAsResolved] = useState(INITIAL_MARK_AS_RESOLVED);
    const [renumberExecutionCounts, setRenumberExecutionCounts] = useState(INITIAL_RENUMBER_EXECUTION_COUNTS);
    const [rows, setRows] = useState<MergeRowType[]>(initialRows);
    const [history, setHistory] = useState<HistoryState>(() => ({
        entries: [{
            label: 'Initial state',
            snapshot: {
                choices: cloneChoices(new Map()),
                rows: cloneRows(initialRows),
                markAsResolved: INITIAL_MARK_AS_RESOLVED,
                renumberExecutionCounts: INITIAL_RENUMBER_EXECUTION_COUNTS,
            },
        }],
        index: 0,
    }));
    const [historyOpen, setHistoryOpen] = useState(false);
    const historyMenuRef = useRef<HTMLDivElement>(null);
    const mainContentRef = useRef<HTMLDivElement>(null);

    // Cell-level drag state (for dragging cells between/into rows)
    const [draggedCell, setDraggedCell] = useState<DraggedCellData | null>(null);
    const draggedCellRef = useRef<DraggedCellData | null>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

    // Row-level drag state (for reordering rows)
    const [draggedRowIndex, setDraggedRowIndex] = useState<number | null>(null);
    const draggedRowIndexRef = useRef<number | null>(null);
    const [dropRowIndex, setDropRowIndex] = useState<number | null>(null);

    const choicesRef = useRef(choices);
    const rowsRef = useRef(rows);
    const markAsResolvedRef = useRef(markAsResolved);
    const renumberExecutionCountsRef = useRef(renumberExecutionCounts);
    const historyRef = useRef(history);

    useEffect(() => {
        choicesRef.current = choices;
    }, [choices]);

    useEffect(() => {
        rowsRef.current = rows;
    }, [rows]);

    useEffect(() => {
        markAsResolvedRef.current = markAsResolved;
    }, [markAsResolved]);

    useEffect(() => {
        renumberExecutionCountsRef.current = renumberExecutionCounts;
    }, [renumberExecutionCounts]);

    useEffect(() => {
        historyRef.current = history;
    }, [history]);

    const recordHistory = useCallback((
        label: string,
        nextChoices: Map<number, ResolutionState>,
        nextRows: MergeRowType[],
        overrides?: {
            markAsResolved?: boolean;
            renumberExecutionCounts?: boolean;
        }
    ) => {
        setHistory(prev => {
            const entries = prev.entries.slice(0, prev.index + 1);
            entries.push({
                label,
                snapshot: {
                    choices: cloneChoices(nextChoices),
                    rows: cloneRows(nextRows),
                    markAsResolved: overrides?.markAsResolved ?? markAsResolvedRef.current,
                    renumberExecutionCounts: overrides?.renumberExecutionCounts ?? renumberExecutionCountsRef.current,
                },
            });
            return { entries, index: entries.length - 1 };
        });
    }, []);

    const applySnapshot = useCallback((snapshot: ResolverSnapshot) => {
        setChoices(cloneChoices(snapshot.choices));
        setRows(cloneRows(snapshot.rows));
        setMarkAsResolved(snapshot.markAsResolved);
        setRenumberExecutionCounts(snapshot.renumberExecutionCounts);
        draggedCellRef.current = null;
        setDraggedCell(null);
        setDropTarget(null);
        setDraggedRowIndex(null);
        setDropRowIndex(null);
    }, []);

    const isEditableTarget = useCallback((target: EventTarget | null): boolean => {
        if (!target || !(target as HTMLElement).closest) return false;
        const element = target as HTMLElement;
        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return true;
        if (element.isContentEditable) return true;
        return Boolean(element.closest('[contenteditable="true"]'));
    }, []);

    const conflictRows = useMemo(() => rows.filter(r => r.type === 'conflict'), [rows]);
    const totalConflicts = conflictRows.length;
    const resolvedCount = choices.size;
    const allResolved = resolvedCount === totalConflicts;
    const canUndo = history.index > 0;
    const canRedo = history.index < history.entries.length - 1;
    const enableUndoRedoHotkeys = conflict.enableUndoRedoHotkeys ?? true;
    const isMac = useMemo(() => /Mac|iPod|iPhone|iPad/.test(navigator.platform), []);
    const undoShortcutLabel = isMac ? 'Cmd+Z' : 'Ctrl+Z';
    const redoShortcutLabel = isMac ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Z';
    useEffect(() => {
        if (!historyOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (!historyMenuRef.current) return;
            if (!historyMenuRef.current.contains(event.target as Node)) {
                setHistoryOpen(false);
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setHistoryOpen(false);
            }
        };

        window.addEventListener('mousedown', handleClickOutside);
        window.addEventListener('keydown', handleEscape);

        return () => {
            window.removeEventListener('mousedown', handleClickOutside);
            window.removeEventListener('keydown', handleEscape);
        };
    }, [historyOpen]);


    /** Handle user selecting a branch choice (sets both choice and initial content) */
    const handleSelectChoice = useCallback((index: number, choice: ResolutionChoice, resolvedContent: string) => {
        const next = new Map(choicesRef.current);
        next.set(index, {
            choice,
            originalContent: resolvedContent,
            resolvedContent
        });
        setChoices(next);
        recordHistory(`Resolve conflict ${index + 1} (${choice})`, next, rowsRef.current);
    }, [recordHistory]);

    /** Handle user editing the resolved content (just updates the text) */
    const handleUpdateContent = useCallback((index: number, resolvedContent: string) => {
        setChoices(prev => {
            const existing = prev.get(index);
            if (!existing || existing.resolvedContent === resolvedContent) return prev;
            const next = new Map(prev);
            next.set(index, { ...existing, resolvedContent });
            return next;
        });
    }, []);

    const handleCommitContent = useCallback((index: number) => {
        const current = choicesRef.current.get(index);
        if (!current) return;
        const h = historyRef.current;
        const lastSnapshot = h.entries[h.index]?.snapshot;
        const lastChoice = lastSnapshot?.choices.get(index);
        if (lastChoice && lastChoice.resolvedContent === current.resolvedContent && lastChoice.choice === current.choice) {
            return;
        }
        recordHistory(`Edit conflict ${index + 1}`, choicesRef.current, rowsRef.current);
    }, [recordHistory]);

    /** Handle "Accept All" action */
    const handleAcceptAll = (choice: 'base' | 'current' | 'incoming') => {
        const next = new Map(choicesRef.current);
        let didChange = false;
        conflictRows.forEach(row => {
            const conflictIdx = row.conflictIndex ?? -1;
            if (conflictIdx < 0) return;
            if (next.has(conflictIdx)) {
                // Respect any already-resolved conflicts when taking all
                return;
            }

            let cell: NotebookCell | undefined;
            if (choice === 'base') cell = row.baseCell;
            else if (choice === 'current') cell = row.currentCell;
            else if (choice === 'incoming') cell = row.incomingCell;

            // If cell exists on the chosen side, use it.
            // If not (e.g. side deleted the cell), we resolve to "delete" (empty).
            const effectiveChoice: ResolutionChoice = cell ? choice : 'delete';
            const content = cell ? normalizeCellSource(cell.source) : '';

            next.set(conflictIdx, {
                choice: effectiveChoice,
                originalContent: content,
                resolvedContent: content
            });
            didChange = true;
        });
        if (!didChange) return;
        setChoices(next);
        recordHistory(`Accept all ${choice}`, next, rowsRef.current);
    };

    const handleToggleRenumberExecutionCounts = (checked: boolean) => {
        if (checked === renumberExecutionCountsRef.current) return;
        setRenumberExecutionCounts(checked);
        recordHistory(
            `Renumber execution counts ${checked ? 'on' : 'off'}`,
            choicesRef.current,
            rowsRef.current,
            { renumberExecutionCounts: checked }
        );
    };

    const handleToggleMarkAsResolved = (checked: boolean) => {
        if (checked === markAsResolvedRef.current) return;
        setMarkAsResolved(checked);
        recordHistory(
            `Mark as resolved ${checked ? 'on' : 'off'}`,
            choicesRef.current,
            rowsRef.current,
            { markAsResolved: checked }
        );
    };

    const handleJumpToHistory = (targetIndex: number) => {
        setHistory(prev => {
            if (targetIndex === prev.index) return prev;
            if (targetIndex < 0 || targetIndex >= prev.entries.length) return prev;
            applySnapshot(prev.entries[targetIndex].snapshot);
            return { ...prev, index: targetIndex };
        });
    };

    const handleUndo = useCallback(() => {
        setHistory(prev => {
            if (prev.index === 0) return prev;
            const nextIndex = prev.index - 1;
            applySnapshot(prev.entries[nextIndex].snapshot);
            return { ...prev, index: nextIndex };
        });
    }, [applySnapshot]);

    const handleRedo = useCallback(() => {
        setHistory(prev => {
            if (prev.index >= prev.entries.length - 1) return prev;
            const nextIndex = prev.index + 1;
            applySnapshot(prev.entries[nextIndex].snapshot);
            return { ...prev, index: nextIndex };
        });
    }, [applySnapshot]);

    useEffect(() => {
        if (!enableUndoRedoHotkeys) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (isEditableTarget(event.target)) return;

            const isPrimaryModifier = isMac ? event.metaKey : event.ctrlKey;
            if (!isPrimaryModifier) return;
            if (event.key.toLowerCase() !== 'z') return;

            event.preventDefault();
            if (event.shiftKey) {
                handleRedo();
            } else {
                handleUndo();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [enableUndoRedoHotkeys, handleRedo, handleUndo, isMac, isEditableTarget]);

    const handleResolve = () => {
        const resolutions: ConflictChoice[] = [];
        for (const [index, state] of choices) {
            resolutions.push({
                index,
                choice: state.choice,
                resolvedContent: state.resolvedContent
            });
        }

        // Build resolved rows - this is the source of truth for reconstruction
        const resolvedRows: import('./types').ResolvedRow[] = rows.map((row) => {
            const conflictIdx = row.conflictIndex ?? -1;
            const resolutionState = conflictIdx >= 0 ? choices.get(conflictIdx) : undefined;

            return {
                baseCell: row.baseCell,
                currentCell: row.currentCell,
                incomingCell: row.incomingCell,
                baseCellIndex: row.baseCellIndex,
                currentCellIndex: row.currentCellIndex,
                incomingCellIndex: row.incomingCellIndex,
                resolution: resolutionState ? {
                    choice: resolutionState.choice,
                    resolvedContent: resolutionState.resolvedContent
                } : undefined
            };
        });

        onResolve(resolutions, markAsResolved, renumberExecutionCounts, resolvedRows);
    };

    // Cell drag handlers
    const handleCellDragStart = useCallback((rowIndex: number, side: 'base' | 'current' | 'incoming', cell: NotebookCell) => {
        const data = { rowIndex, side, cell };
        draggedCellRef.current = data;
        setDraggedCell(data);
    }, []);

    const handleCellDragEnd = useCallback(() => {
        draggedCellRef.current = null;
        setDraggedCell(null);
        setDropTarget(null);
    }, []);

    const handleCellDragOver = useCallback((e: React.DragEvent, rowIndex: number, side: 'base' | 'current' | 'incoming') => {
        e.preventDefault();
        e.stopPropagation();

        const dragged = draggedCellRef.current;
        if (!dragged) return;

        // Only allow dropping in the same column (same side)
        if (dragged.side !== side) return;

        // Don't allow dropping on itself
        if (dragged.rowIndex === rowIndex) return;

        // Only update if the drop target actually changed (prevent excessive re-renders)
        setDropTarget(prev => {
            if (prev?.rowIndex === rowIndex && prev?.side === side) {
                return prev; // No change, don't trigger re-render
            }
            return { rowIndex, side };
        });
    }, []);

    const handleCellDrop = useCallback((targetRowIndex: number, targetSide: 'base' | 'current' | 'incoming') => {
        const dragged = draggedCellRef.current;
        if (!dragged) return;
        if (dragged.side !== targetSide) return;
        if (dragged.rowIndex === targetRowIndex) return;

        // Move cell from source row to target row
        const newRows = [...rowsRef.current];
        const sourceRow = { ...newRows[dragged.rowIndex] };
        const targetRow = { ...newRows[targetRowIndex] };

        // Set the cell in target row
        if (targetSide === 'base') {
            targetRow.baseCell = dragged.cell;
        } else if (targetSide === 'current') {
            targetRow.currentCell = dragged.cell;
        } else {
            targetRow.incomingCell = dragged.cell;
        }

        // Remove cell from source row
        if (dragged.side === 'base') {
            sourceRow.baseCell = undefined;
        } else if (dragged.side === 'current') {
            sourceRow.currentCell = undefined;
        } else {
            sourceRow.incomingCell = undefined;
        }

        // Update target row status
        const targetCellCount = [targetRow.baseCell, targetRow.currentCell, targetRow.incomingCell].filter(Boolean).length;
        if (targetCellCount > 1) {
            targetRow.type = 'conflict';
        }
        targetRow.isUnmatched = targetCellCount < 3 && targetCellCount > 0;

        // Update source row status
        const sourceCellCount = [sourceRow.baseCell, sourceRow.currentCell, sourceRow.incomingCell].filter(Boolean).length;
        if (sourceCellCount > 1) {
            sourceRow.type = 'conflict';
        }
        // If count <= 1, keep existing type (preserves conflict view for unmatched leftovers, maintaining test selectors)
        sourceRow.isUnmatched = sourceCellCount < 3 && sourceCellCount > 0;

        newRows[dragged.rowIndex] = sourceRow;
        newRows[targetRowIndex] = targetRow;

        // Filter out rows with no cells
        const filteredRows = newRows.filter(r => r.baseCell || r.currentCell || r.incomingCell);
        setRows(filteredRows);
        recordHistory(`Move ${targetSide} cell`, choicesRef.current, filteredRows);
        draggedCellRef.current = null;
        setDraggedCell(null);
        setDropTarget(null);
    }, [recordHistory]);

    // Row reorder handlers
    const handleRowDragStart = useCallback((index: number) => {
        draggedRowIndexRef.current = index;
        setDraggedRowIndex(index);
    }, []);

    const handleRowDragEnd = useCallback(() => {
        draggedRowIndexRef.current = null;
        setDraggedRowIndex(null);
        setDropRowIndex(null);
    }, []);

    const handleRowDragOver = (e: React.DragEvent, targetIndex: number) => {
        e.preventDefault();
        const dragged = draggedRowIndexRef.current;
        if (dragged === null || dragged === targetIndex) {
            return;
        }
        // Only update if target changed (prevent excessive re-renders)
        setDropRowIndex(prev => prev === targetIndex ? prev : targetIndex);
    };

    const handleRowDrop = (targetIndex: number) => {
        const dragged = draggedRowIndexRef.current;
        if (dragged === null || dragged === targetIndex) {
            draggedRowIndexRef.current = null;
            setDraggedRowIndex(null);
            setDropRowIndex(null);
            return;
        }

        const newRows = [...rowsRef.current];
        const [draggedRow] = newRows.splice(dragged, 1);
        newRows.splice(targetIndex, 0, draggedRow);
        setRows(newRows);
        recordHistory(`Reorder row ${dragged + 1}`, choicesRef.current, newRows);
        draggedRowIndexRef.current = null;
        setDraggedRowIndex(null);
        setDropRowIndex(null);
    };

    const fileName = conflict.filePath.split('/').pop() || 'notebook.ipynb';
    const allowCellDrag = true;
    const allowRowDrag = true;
    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => mainContentRef.current,
        estimateSize: () => 240,
        overscan: 6,
    });
    const virtualRows = rowVirtualizer.getVirtualItems();

    return (
        <div className="app-container">
            <header className="header">
                <div className="header-left">
                    <span className="header-title">MergeNB</span>
                    <span className="file-path">{fileName}</span>
                </div>
                <div className="header-right">
                    <span className="conflict-counter">
                        {resolvedCount} / {totalConflicts} resolved
                    </span>
                    <div className="header-group">
                        <button
                            className="btn btn-secondary"
                            onClick={handleUndo}
                            disabled={!canUndo}
                            data-testid="history-undo"
                            title={`Undo (${undoShortcutLabel})`}
                        >
                            Undo
                        </button>
                        <button
                            className="btn btn-secondary"
                            onClick={handleRedo}
                            disabled={!canRedo}
                            data-testid="history-redo"
                            title={`Redo (${redoShortcutLabel})`}
                        >
                            Redo
                        </button>
                        <div className="history-menu" ref={historyMenuRef}>
                            <button
                                className="btn btn-secondary history-toggle"
                                onClick={() => setHistoryOpen(prev => !prev)}
                                aria-expanded={historyOpen}
                                data-testid="history-toggle"
                            >
                                History
                            </button>
                            <div
                                className={`history-panel history-dropdown${historyOpen ? ' open' : ''}`}
                                data-testid="history-panel"
                                aria-hidden={!historyOpen}
                            >
                                <div className="history-header">
                                    <span className="history-title">History</span>
                                    <div className="history-actions">
                                        <button
                                            className="btn btn-secondary"
                                            onClick={handleUndo}
                                            disabled={!canUndo}
                                            data-testid="history-panel-undo"
                                        >
                                            Undo
                                        </button>
                                        <button
                                            className="btn btn-secondary"
                                            onClick={handleRedo}
                                            disabled={!canRedo}
                                            data-testid="history-panel-redo"
                                        >
                                            Redo
                                        </button>
                                    </div>
                                </div>
                                <ul className="history-list">
                                    {history.entries.map((entry, index) => (
                                        <li
                                            key={`${entry.label}-${index}`}
                                            className={`history-item${index === history.index ? ' current' : ''}${index > history.index ? ' future' : ''}`}
                                            data-testid="history-item"
                                            role="button"
                                            tabIndex={0}
                                            aria-current={index === history.index ? 'true' : undefined}
                                            onClick={() => {
                                                handleJumpToHistory(index);
                                                setHistoryOpen(false);
                                            }}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                    handleJumpToHistory(index);
                                                    setHistoryOpen(false);
                                                }
                                            }}
                                        >
                                            <span className="history-label">{entry.label}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginRight: 12, paddingRight: 12, borderRight: '1px solid var(--border-color)' }}>
                        <button
                            className="btn"
                            style={{
                                background: 'var(--base-bg)',
                                border: '1px solid var(--base-border)',
                                color: 'var(--text-primary)',
                                fontSize: 11,
                                padding: '4px 8px'
                            }}
                            title="Accept all base (original) changes"
                            onClick={() => handleAcceptAll('base')}
                        >
                            All Base
                        </button>
                        <button
                            className="btn"
                            style={{
                                background: 'var(--current-bg)',
                                border: '1px solid var(--current-border)',
                                color: 'var(--text-primary)',
                                fontSize: 11,
                                padding: '4px 8px'
                            }}
                            title="Accept all current (local) changes"
                            onClick={() => handleAcceptAll('current')}
                        >
                            All Current
                        </button>
                        <button
                            className="btn"
                            style={{
                                background: 'var(--incoming-bg)',
                                border: '1px solid var(--incoming-border)',
                                color: 'var(--text-primary)',
                                fontSize: 11,
                                padding: '4px 8px'
                            }}
                            title="Accept all incoming (remote) changes"
                            onClick={() => handleAcceptAll('incoming')}
                        >
                            All Incoming
                        </button>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <input
                            type="checkbox"
                            checked={renumberExecutionCounts}
                            onChange={e => handleToggleRenumberExecutionCounts(e.target.checked)}
                        />
                        Renumber execution counts
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <input
                            type="checkbox"
                            checked={markAsResolved}
                            onChange={e => handleToggleMarkAsResolved(e.target.checked)}
                        />
                        Mark as resolved (git add)
                    </label>
                    <button className="btn btn-secondary" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        className="btn btn-primary"
                        onClick={handleResolve}
                        disabled={!allResolved}
                    >
                        Apply Resolution
                    </button>
                </div>
            </header>

            <main className="main-content" ref={mainContentRef}>
                {conflict.autoResolveResult && conflict.autoResolveResult.autoResolvedCount > 0 && (
                    <div className="auto-resolve-banner">
                        <span className="icon">✓</span>
                        <span className="text">
                            Auto-resolved {conflict.autoResolveResult.autoResolvedCount} conflict{conflict.autoResolveResult.autoResolvedCount !== 1 ? 's' : ''}
                            {conflict.autoResolveResult.autoResolvedDescriptions.length > 0 &&
                                ` (${conflict.autoResolveResult.autoResolvedDescriptions.join(', ')})`}
                        </span>
                    </div>
                )}

                <div className="column-labels">
                    <div className="column-label base">
                        Base
                    </div>
                    <div className="column-label current">
                        Current {conflict.currentBranch ? `(${conflict.currentBranch})` : ''}
                    </div>
                    <div className="column-label incoming">
                        Incoming {conflict.incomingBranch ? `(${conflict.incomingBranch})` : ''}
                    </div>
                </div>

                <div
                    style={{
                        height: rowVirtualizer.getTotalSize(),
                        position: 'relative',
                    }}
                >
                    {virtualRows.map((virtualRow) => {
                        const i = virtualRow.index;
                        const row = rows[i];
                        const conflictIdx = row?.conflictIndex ?? -1;
                        const resolutionState = conflictIdx >= 0 ? choices.get(conflictIdx) : undefined;

                        if (!row) return null;

                        return (
                            <div
                                key={virtualRow.key}
                                data-index={virtualRow.index}
                                ref={rowVirtualizer.measureElement}
                                className="virtual-row"
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    transform: `translateY(${virtualRow.start}px)`,
                                }}
                            >
                                {/* Drop zone before first row */}
                                {i === 0 && draggedRowIndex !== null && (
                                    <div
                                        className={`row-drop-zone ${dropRowIndex === 0 ? 'drag-over' : ''}`}
                                        onDragOver={(e) => handleRowDragOver(e, 0)}
                                        onDrop={() => handleRowDrop(0)}
                                        onDragLeave={() => setDropRowIndex(null)}
                                    />
                                )}

                                <div
                                    style={{ width: '100%' }}
                                    onDragOver={(e) => { if (draggedRowIndexRef.current !== null) handleRowDragOver(e, i); }}
                                    onDrop={() => { if (draggedRowIndexRef.current !== null) handleRowDrop(i); }}
                                    onDragLeave={() => { if (draggedRowIndexRef.current !== null) setDropRowIndex(null); }}
                                >
                                    <MergeRow
                                        row={row}
                                        rowIndex={i}
                                        conflictIndex={conflictIdx}
                                        resolutionState={resolutionState}
                                        onSelectChoice={handleSelectChoice}
                                        onUpdateContent={handleUpdateContent}
                                        onCommitContent={handleCommitContent}
                                        isDragging={draggedRowIndex === i || draggedCell?.rowIndex === i}
                                        showOutputs={!conflict.hideNonConflictOutputs || row.type === 'conflict'}
                                        enableCellDrag={allowCellDrag}
                                        rowDragEnabled={allowRowDrag}
                                        onRowDragStart={allowRowDrag ? handleRowDragStart : undefined}
                                        onRowDragEnd={allowRowDrag ? handleRowDragEnd : undefined}
                                        // Cell drag state (primitives for stable memo comparison)
                                        cellDragActive={draggedCell !== null}
                                        cellDragSide={draggedCell?.side}
                                        cellDragSourceRow={draggedCell?.rowIndex}
                                        isRowDropTarget={dropTarget?.rowIndex === i}
                                        rowDropTargetSide={dropTarget?.rowIndex === i ? dropTarget?.side : undefined}
                                        // Cell drag callbacks
                                        onCellDragStart={handleCellDragStart}
                                        onCellDragEnd={handleCellDragEnd}
                                        onCellDragOver={handleCellDragOver}
                                        onCellDrop={handleCellDrop}
                                        data-testid={conflictIdx >= 0 ? `conflict-row-${conflictIdx}` : `row-${i}`}
                                    />
                                </div>

                                {/* Drop zone between/after rows */}
                                {draggedRowIndex !== null && draggedRowIndex !== i && draggedRowIndex !== i + 1 && (
                                    <div
                                        className={`row-drop-zone ${dropRowIndex === i + 1 ? 'drag-over' : ''}`}
                                        onDragOver={(e) => handleRowDragOver(e, i + 1)}
                                        onDrop={() => handleRowDrop(i + 1)}
                                        onDragLeave={() => setDropRowIndex(null)}
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>
            </main>
        </div>
    );
}

/**
 * Build merge rows from semantic conflict data.
 */
function buildMergeRowsFromSemantic(conflict: NotebookSemanticConflict): MergeRowType[] {
    const rows: MergeRowType[] = [];
    const conflictMap = new Map<string, { conflict: SemanticConflict; index: number }>();

    conflict.semanticConflicts.forEach((c, i) => {
        const key = `${c.baseCellIndex ?? 'x'}-${c.currentCellIndex ?? 'x'}-${c.incomingCellIndex ?? 'x'}`;
        conflictMap.set(key, { conflict: c, index: i });
    });

    for (const mapping of conflict.cellMappings) {
        const baseCell = mapping.baseIndex !== undefined && conflict.base
            ? conflict.base.cells[mapping.baseIndex] : undefined;
        const currentCell = mapping.currentIndex !== undefined && conflict.current
            ? conflict.current.cells[mapping.currentIndex] : undefined;
        const incomingCell = mapping.incomingIndex !== undefined && conflict.incoming
            ? conflict.incoming.cells[mapping.incomingIndex] : undefined;

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

    return sortByPosition(rows, (r) => ({
        anchor: r.anchorPosition ?? 0,
        incoming: r.incomingCellIndex,
        current: r.currentCellIndex,
        base: r.baseCellIndex
    }));
}
