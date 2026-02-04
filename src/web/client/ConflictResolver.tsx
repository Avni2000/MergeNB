/**
 * @file ConflictResolver.tsx
 * @description Main React component for the conflict resolution UI.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
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
} from './types';
import { MergeRow } from './MergeRow';

// Virtualization constants
const INITIAL_VISIBLE_ROWS = 20; // Number of rows to render initially
const DEFAULT_ROW_HEIGHT = 200; // Default height for unmeasured rows (fallback)
const VIRTUALIZATION_OVERSCAN_ROWS = 5; // Number of rows to render outside viewport for smooth scrolling

type ResolutionChoice = 'base' | 'current' | 'incoming' | 'both' | 'delete';

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
    const [choices, setChoices] = useState<Map<number, ResolutionState>>(new Map());
    const [markAsResolved, setMarkAsResolved] = useState(true);
    const [renumberExecutionCounts, setRenumberExecutionCounts] = useState(true);
    const [rows, setRows] = useState<MergeRowType[]>(() => {
        if (conflict.type === 'semantic' && conflict.semanticConflict) {
            return buildMergeRowsFromSemantic(conflict.semanticConflict);
        }
        return [];
    });

    // Virtualization state
    const mainContentRef = useRef<HTMLDivElement>(null);
    const [visibleRange, setVisibleRange] = useState({ start: 0, end: INITIAL_VISIBLE_ROWS });
    const [scrollTop, setScrollTop] = useState(0);

    // Track actual row heights using ResizeObserver
    const [rowHeights, setRowHeights] = useState<Map<number, number>>(new Map());
    const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
    const resizeObserver = useRef<ResizeObserver | null>(null);
    const previousRowsLength = useRef<number>(rows.length);

    // Cell-level drag state (for dragging cells between/into rows)
    const [draggedCell, setDraggedCell] = useState<DraggedCellData | null>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

    // Row-level drag state (for reordering rows)
    const [draggedRowIndex, setDraggedRowIndex] = useState<number | null>(null);
    const [dropRowIndex, setDropRowIndex] = useState<number | null>(null);

    const conflictRows = useMemo(() => rows.filter(r => r.type === 'conflict'), [rows]);
    const totalConflicts = conflictRows.length;
    const resolvedCount = choices.size;
    const allResolved = resolvedCount === totalConflicts;

    // Helper to get row height (actual or default)
    const getRowHeight = useCallback((index: number): number => {
        return rowHeights.get(index) ?? DEFAULT_ROW_HEIGHT;
    }, [rowHeights]);

    // Pre-calculate cumulative heights to optimize scrolling performance (O(1) lookups vs O(N))
    // cumulativeHeights[i] = cumulative height BEFORE row i starts (i.e. top position of row i)
    // cumulativeHeights[rows.length] = total height
    const cumulativeHeights = useMemo(() => {
        const heights = new Array(rows.length + 1).fill(0);
        let current = 0;
        for (let i = 0; i < rows.length; i++) {
            heights[i] = current;
            current += (rowHeights.get(i) ?? DEFAULT_ROW_HEIGHT);
        }
        heights[rows.length] = current;
        return heights;
    }, [rows.length, rowHeights]);

    // Get total content height
    const getTotalHeight = useCallback((): number => {
        return cumulativeHeights[rows.length];
    }, [cumulativeHeights, rows.length]);

    // Find row index at a given scroll position using binary search
    const getRowIndexAtPosition = useCallback((scrollPos: number): number => {
        if (rows.length === 0) return 0;

        // Binary search for the row where cumulativeHeights[i] <= scrollPos < cumulativeHeights[i+1]
        let low = 0;
        let high = rows.length - 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const rowTop = cumulativeHeights[mid];
            const rowBottom = cumulativeHeights[mid + 1];

            if (scrollPos >= rowTop && scrollPos < rowBottom) {
                return mid;
            } else if (scrollPos < rowTop) {
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }

        // Fallback for out of bounds (should return last row if scrolled way past)
        if (scrollPos >= cumulativeHeights[rows.length]) return rows.length - 1;
        return 0;
    }, [cumulativeHeights, rows.length]);

    // Setup ResizeObserver to track actual row heights
    useEffect(() => {
        resizeObserver.current = new ResizeObserver((entries) => {
            setRowHeights(prev => {
                const newHeights = new Map(prev);
                let hasChanges = false;

                for (const entry of entries) {
                    const element = entry.target as HTMLDivElement;
                    const rowIndex = parseInt(element.dataset.rowIndex ?? '-1', 10);
                    if (rowIndex >= 0) {
                        const newHeight = entry.contentRect.height;
                        const currentHeight = newHeights.get(rowIndex);
                        if (currentHeight !== newHeight && newHeight > 0) {
                            newHeights.set(rowIndex, newHeight);
                            hasChanges = true;
                        }
                    }
                }

                return hasChanges ? newHeights : prev;
            });
        });

        return () => {
            resizeObserver.current?.disconnect();
        };
    }, []); // Only create observer once

    // Callback to register row refs with ResizeObserver
    const registerRowRef = useCallback((index: number, element: HTMLDivElement | null) => {
        const prevElement = rowRefs.current.get(index);

        if (prevElement && prevElement !== element) {
            resizeObserver.current?.unobserve(prevElement);
            rowRefs.current.delete(index);
        }

        if (element) {
            rowRefs.current.set(index, element);
            resizeObserver.current?.observe(element);
        }
    }, []);

    const getRefCallback = useCallback((index: number) => (element: HTMLDivElement | null) => {
        registerRowRef(index, element);
    }, [registerRowRef]);

    // Adjust scroll position when rows are deleted to prevent "black spots"
    useEffect(() => {
        const prevLength = previousRowsLength.current;
        const currentLength = rows.length;

        if (currentLength < prevLength && mainContentRef.current) {
            // Rows were deleted - adjust scroll position
            const element = mainContentRef.current;
            const viewportHeight = element.clientHeight;
            const totalHeight = getTotalHeight();

            // If scroll position is now beyond content, scroll to end
            if (element.scrollTop > totalHeight - viewportHeight) {
                element.scrollTop = Math.max(0, totalHeight - viewportHeight);
            }

            // Clean up height measurements for deleted rows
            setRowHeights(new Map());
        }

        previousRowsLength.current = currentLength;
    }, [rows.length, getTotalHeight]);

    // Handle scroll for virtualization using actual heights
    useEffect(() => {
        const handleScroll = () => {
            if (!mainContentRef.current) return;

            const currentScrollTop = mainContentRef.current.scrollTop;
            const viewportHeight = mainContentRef.current.clientHeight;

            // Find start index using actual heights
            const rawStartIndex = getRowIndexAtPosition(currentScrollTop);
            const startIndex = Math.max(0, rawStartIndex - VIRTUALIZATION_OVERSCAN_ROWS);

            // Find end index using actual heights
            const viewportEndPos = currentScrollTop + viewportHeight;
            const rawEndIndex = getRowIndexAtPosition(viewportEndPos);
            const endIndex = Math.min(rows.length, rawEndIndex + VIRTUALIZATION_OVERSCAN_ROWS + 1);

            setVisibleRange({ start: startIndex, end: endIndex });
            setScrollTop(currentScrollTop);
        };

        const element = mainContentRef.current;
        if (element) {
            element.addEventListener('scroll', handleScroll);
            // Initial calculation
            handleScroll();

            return () => element.removeEventListener('scroll', handleScroll);
        }
    }, [rows.length, getRowIndexAtPosition]);

    /** Handle user selecting a branch choice (sets both choice and initial content) */
    const handleSelectChoice = useCallback((index: number, choice: ResolutionChoice, resolvedContent: string) => {
        setChoices(prev => {
            const next = new Map(prev);
            next.set(index, {
                choice,
                originalContent: resolvedContent,
                resolvedContent
            });
            return next;
        });
    }, []);

    /** Handle user editing the resolved content (just updates the text) */
    const handleUpdateContent = useCallback((index: number, resolvedContent: string) => {
        setChoices(prev => {
            const existing = prev.get(index);
            if (!existing) return prev;
            const next = new Map(prev);
            next.set(index, { ...existing, resolvedContent });
            return next;
        });
    }, []);

    const handleResolve = useCallback(() => {
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
    }, [choices, markAsResolved, renumberExecutionCounts, onResolve, rows]);

    // Cell drag handlers
    const handleCellDragStart = useCallback((rowIndex: number, side: 'base' | 'current' | 'incoming', cell: NotebookCell) => {
        setDraggedCell({ rowIndex, side, cell });
    }, []);

    const handleCellDragEnd = useCallback(() => {
        setDraggedCell(null);
        setDropTarget(null);
    }, []);

    const handleCellDragOver = useCallback((e: React.DragEvent, rowIndex: number, side: 'base' | 'current' | 'incoming') => {
        e.preventDefault();
        e.stopPropagation();

        if (!draggedCell) return;

        // Only allow dropping in the same column (same side)
        if (draggedCell.side !== side) return;

        // Don't allow dropping on itself
        if (draggedCell.rowIndex === rowIndex) return;

        // Only update if the drop target actually changed (prevent excessive re-renders)
        setDropTarget(prev => {
            if (prev?.rowIndex === rowIndex && prev?.side === side) {
                return prev; // No change, don't trigger re-render
            }
            return { rowIndex, side };
        });
    }, [draggedCell]);

    const handleCellDrop = useCallback((targetRowIndex: number, targetSide: 'base' | 'current' | 'incoming') => {
        if (!draggedCell) return;
        if (draggedCell.side !== targetSide) return;
        if (draggedCell.rowIndex === targetRowIndex) return;

        // Move cell from source row to target row
        setRows(prevRows => {
            const newRows = [...prevRows];
            const sourceRow = { ...newRows[draggedCell.rowIndex] };
            const targetRow = { ...newRows[targetRowIndex] };

            // Set the cell in target row
            if (targetSide === 'base') {
                targetRow.baseCell = draggedCell.cell;
            } else if (targetSide === 'current') {
                targetRow.currentCell = draggedCell.cell;
            } else {
                targetRow.incomingCell = draggedCell.cell;
            }

            // Remove cell from source row
            if (draggedCell.side === 'base') {
                sourceRow.baseCell = undefined;
            } else if (draggedCell.side === 'current') {
                sourceRow.currentCell = undefined;
            } else {
                sourceRow.incomingCell = undefined;
            }

            // Update row type based on new cell configuration
            const sourceHasCells = sourceRow.baseCell || sourceRow.currentCell || sourceRow.incomingCell;
            const targetCellCount = [targetRow.baseCell, targetRow.currentCell, targetRow.incomingCell].filter(Boolean).length;

            // Mark target as conflict if it now has cells from multiple sides
            if (targetCellCount > 1) {
                targetRow.type = 'conflict';
            }
            targetRow.isUnmatched = targetCellCount < 3 && targetCellCount > 0;

            newRows[draggedCell.rowIndex] = sourceRow;
            newRows[targetRowIndex] = targetRow;

            // Filter out rows with no cells
            return newRows.filter(r => r.baseCell || r.currentCell || r.incomingCell);
        });

        setDraggedCell(null);
        setDropTarget(null);
    }, [draggedCell]);

    // Row reorder handlers
    const handleRowDragStart = useCallback((index: number) => {
        setDraggedRowIndex(index);
    }, []);

    const handleRowDragEnd = useCallback(() => {
        setDraggedRowIndex(null);
        setDropRowIndex(null);
    }, []);

    const handleRowDragOver = useCallback((e: React.DragEvent, targetIndex: number) => {
        e.preventDefault();
        if (draggedRowIndex === null || draggedRowIndex === targetIndex) {
            return;
        }
        // Only update if target changed (prevent excessive re-renders)
        setDropRowIndex(prev => prev === targetIndex ? prev : targetIndex);
    }, [draggedRowIndex]);

    const handleRowDrop = useCallback((targetIndex: number) => {
        if (draggedRowIndex === null || draggedRowIndex === targetIndex) {
            setDraggedRowIndex(null);
            setDropRowIndex(null);
            return;
        }

        const newRows = [...rows];
        const [draggedRow] = newRows.splice(draggedRowIndex, 1);
        newRows.splice(targetIndex, 0, draggedRow);
        setRows(newRows);
        setDraggedRowIndex(null);
        setDropRowIndex(null);
    }, [draggedRowIndex, rows]);

    const fileName = conflict.filePath.split('/').pop() || 'notebook.ipynb';
    const allowCellDrag = true;

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
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <input
                            type="checkbox"
                            checked={renumberExecutionCounts}
                            onChange={e => setRenumberExecutionCounts(e.target.checked)}
                        />
                        Renumber execution counts
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <input
                            type="checkbox"
                            checked={markAsResolved}
                            onChange={e => setMarkAsResolved(e.target.checked)}
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

                {/* 
                    Virtualization Strategy: Content Windowing
                    
                    We render ALL row wrapper divs in the normal document flow here. 
                    This allows the browser to calculate the correct document height and scrollbar natively,
                    and allows ResizeObserver to measure the actual height of every row (even "off-screen" ones).
                    
                    True virtualization (removing nodes) would require absolute positioning and estimating heights,
                    which breaks the sticky headers and variable-height content flow.
                    
                    Optimization comes from passing `isVisible` to the MergeRow component.
                    When `isVisible` is false, MergeRow skips rendering expensive content (like syntax highlighting 
                    and diffs), rendering lightweight placeholders instead.
                */}
                <div style={{ position: 'relative', minHeight: getTotalHeight() }}>
                    {rows.map((row, i) => {
                        const conflictIdx = row.conflictIndex ?? -1;
                        const resolutionState = conflictIdx >= 0 ? choices.get(conflictIdx) : undefined;
                        const isDropTargetRow = dropRowIndex === i;

                        // Check if row is in visible range
                        const isVisible = i >= visibleRange.start && i < visibleRange.end;

                        return (
                            <React.Fragment key={i}>
                                {/* Drop zone before first row */}
                                {i === 0 && draggedRowIndex !== null && (
                                    <div
                                        className={`row-drop-zone ${dropRowIndex === 0 ? 'drag-over' : ''}`}
                                        onDragOver={(e) => handleRowDragOver(e, 0)}
                                        onDrop={() => handleRowDrop(0)}
                                        onDragLeave={() => setDropRowIndex(null)}
                                    />
                                )}

                                {/* Row wrapper for height measurement */}
                                <div
                                    ref={getRefCallback(i)}
                                    data-row-index={i}
                                    style={{ width: '100%' }}
                                >
                                    <MergeRow
                                        row={row}
                                        rowIndex={i}
                                        conflictIndex={conflictIdx}
                                        resolutionState={resolutionState}
                                        onSelectChoice={handleSelectChoice}
                                        onUpdateContent={handleUpdateContent}
                                        isDragging={draggedRowIndex === i || draggedCell?.rowIndex === i}
                                        showOutputs={!conflict.hideNonConflictOutputs || row.type === 'conflict'}
                                        enableCellDrag={allowCellDrag}
                                        isVisible={isVisible}
                                        // Cell drag props
                                        draggedCell={draggedCell}
                                        dropTarget={dropTarget}
                                        onCellDragStart={handleCellDragStart}
                                        onCellDragEnd={handleCellDragEnd}
                                        onCellDragOver={handleCellDragOver}
                                        onCellDrop={handleCellDrop}
                                        data-testid={row.type === 'conflict' ? `conflict-row-${conflictIdx}` : `row-${i}`}
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
                            </React.Fragment>
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
