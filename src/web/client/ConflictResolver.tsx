/**
 * @file ConflictResolver.tsx
 * @description Main React component for the conflict resolution UI.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { sortByPosition } from '../../positionUtils';
import { normalizeCellSource } from '../../notebookUtils';
import type {
    UnifiedConflictData,
    MergeRow as MergeRowType,
    ConflictChoice,
    NotebookSemanticConflict,
    NotebookConflict,
    CellMapping,
    SemanticConflict,
    NotebookCell,
} from './types';
import { MergeRow } from './MergeRow';

type ResolutionChoice = 'base' | 'current' | 'incoming' | 'both' | 'custom' | 'delete';

interface ResolutionState {
    choice: ResolutionChoice;
    customContent?: string;
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
    onResolve: (resolutions: ConflictChoice[], markAsResolved: boolean) => void;
    onCancel: () => void;
}

export function ConflictResolver({
    conflict,
    onResolve,
    onCancel,
}: ConflictResolverProps): React.ReactElement {
    const [choices, setChoices] = useState<Map<number, ResolutionState>>(new Map());
    const [markAsResolved, setMarkAsResolved] = useState(true);
    const [rows, setRows] = useState<MergeRowType[]>(() => {
        if (conflict.type === 'semantic' && conflict.semanticConflict) {
            return buildMergeRowsFromSemantic(conflict.semanticConflict);
        } else if (conflict.type === 'textual' && conflict.textualConflict) {
            return buildMergeRowsFromTextual(conflict.textualConflict);
        }
        return [];
    });
    
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

    const handleSelectChoice = useCallback((index: number, choice: ResolutionChoice, customContent?: string) => {
        setChoices(prev => {
            const next = new Map(prev);
            next.set(index, { choice, customContent });
            return next;
        });
    }, []);

    const handleResolve = useCallback(() => {
        const resolutions: ConflictChoice[] = [];
        for (const [index, state] of choices) {
            resolutions.push({ index, choice: state.choice, customContent: state.customContent });
        }
        onResolve(resolutions, markAsResolved);
    }, [choices, markAsResolved, onResolve]);

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
        
        setDropTarget({ rowIndex, side });
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
        setDropRowIndex(targetIndex);
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

            <main className="main-content">
                {conflict.autoResolveResult && conflict.autoResolveResult.resolved > 0 && (
                    <div className="auto-resolve-banner">
                        <span className="icon">✓</span>
                        <span className="text">
                            Auto-resolved {conflict.autoResolveResult.resolved} of {conflict.autoResolveResult.total} conflicts
                            ({conflict.autoResolveResult.types.join(', ')})
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

                {rows.map((row, i) => {
                    const conflictIdx = row.conflictIndex ?? -1;
                    const resolutionState = conflictIdx >= 0 ? choices.get(conflictIdx) : undefined;
                    const isDropTargetRow = dropRowIndex === i;
                    
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
                            
                            <MergeRow
                                row={row}
                                rowIndex={i}
                                conflictIndex={conflictIdx}
                                selectedChoice={resolutionState?.choice}
                                customContent={resolutionState?.customContent}
                                onSelectChoice={handleSelectChoice}
                                isDragging={draggedRowIndex === i || draggedCell?.rowIndex === i}
                                showOutputs={!conflict.hideNonConflictOutputs || row.type === 'conflict'}
                                // Cell drag props
                                draggedCell={draggedCell}
                                dropTarget={dropTarget}
                                onCellDragStart={handleCellDragStart}
                                onCellDragEnd={handleCellDragEnd}
                                onCellDragOver={handleCellDragOver}
                                onCellDrop={handleCellDrop}
                            />
                            
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

/**
 * Build merge rows from textual conflict data.
 */
function buildMergeRowsFromTextual(conflict: NotebookConflict): MergeRowType[] {
    const rows: MergeRowType[] = [];

    if (!conflict.cellMappings) {
        // Fallback: just show the conflicts directly
        return conflict.conflicts.map((c, i) => ({
            type: 'conflict' as const,
            currentCell: { cell_type: c.cellType || 'code', source: c.currentContent, metadata: {} },
            incomingCell: { cell_type: c.cellType || 'code', source: c.incomingContent, metadata: {} },
            conflictIndex: i,
        }));
    }

    let conflictIndex = 0;

    for (const mapping of conflict.cellMappings) {
        const baseCell = mapping.baseIndex !== undefined && conflict.base
            ? conflict.base.cells[mapping.baseIndex] : undefined;
        const currentCell = mapping.currentIndex !== undefined && conflict.current
            ? conflict.current.cells[mapping.currentIndex] : undefined;
        const incomingCell = mapping.incomingIndex !== undefined && conflict.incoming
            ? conflict.incoming.cells[mapping.incomingIndex] : undefined;

        // Detect if this is a conflict by comparing cells
        let isConflict = false;
        if (currentCell && incomingCell) {
            const currSrc = normalizeCellSource(currentCell.source);
            const incSrc = normalizeCellSource(incomingCell.source);
            if (currSrc !== incSrc) {
                isConflict = true;
            }
        } else if ((currentCell && !incomingCell) || (!currentCell && incomingCell)) {
            // One side added/deleted
            isConflict = true;
        }

        const currentConflictIndex = isConflict ? conflictIndex++ : undefined;

        const presentSides: ('base' | 'current' | 'incoming')[] = [];
        if (baseCell) presentSides.push('base');
        if (currentCell) presentSides.push('current');
        if (incomingCell) presentSides.push('incoming');

        const isUnmatched = presentSides.length < 3 && presentSides.length > 0;
        const anchorPosition = mapping.baseIndex ?? mapping.currentIndex ?? mapping.incomingIndex ?? 0;

        rows.push({
            type: isConflict ? 'conflict' : 'identical',
            baseCell,
            currentCell,
            incomingCell,
            baseCellIndex: mapping.baseIndex,
            currentCellIndex: mapping.currentIndex,
            incomingCellIndex: mapping.incomingIndex,
            conflictIndex: currentConflictIndex,
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
