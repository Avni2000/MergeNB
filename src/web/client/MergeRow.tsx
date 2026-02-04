/**
 * @file MergeRow.tsx
 * @description React component for a single row in the 3-way merge view.
 * 
 * New UI flow:
 * 1. User selects a branch (base/current/incoming) 
 * 2. A resolved text area appears with green highlighting, pre-filled with that branch's content
 * 3. User can edit the content freely
 * 4. If user changes the selected branch after editing, show a warning
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import type { MergeRow as MergeRowType, NotebookCell } from './types';
import { CellContent } from './CellContent';
import { normalizeCellSource } from '../../notebookUtils';

type ResolutionChoice = 'base' | 'current' | 'incoming' | 'both' | 'delete';

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

/** Resolution state for a cell */
interface ResolutionState {
    choice: ResolutionChoice;
    /** The content as it was when the branch was selected */
    originalContent: string;
    /** The current content in the text area (may be edited) */
    resolvedContent: string;
}

interface MergeRowProps {
    row: MergeRowType;
    rowIndex: number;
    conflictIndex: number;
    resolutionState?: ResolutionState;
    onSelectChoice: (index: number, choice: ResolutionChoice, resolvedContent: string) => void;
    onUpdateContent: (index: number, resolvedContent: string) => void;
    isDragging?: boolean;
    showOutputs?: boolean;
    enableCellDrag?: boolean;
    isVisible?: boolean; // For lazy rendering optimization
    // Cell drag props
    draggedCell: DraggedCellData | null;
    dropTarget: DropTarget | null;
    onCellDragStart: (rowIndex: number, side: 'base' | 'current' | 'incoming', cell: NotebookCell) => void;
    onCellDragEnd: () => void;
    onCellDragOver: (e: React.DragEvent, rowIndex: number, side: 'base' | 'current' | 'incoming') => void;
    onCellDrop: (targetRowIndex: number, targetSide: 'base' | 'current' | 'incoming') => void;
    'data-testid'?: string;
}

export function MergeRow({
    row,
    rowIndex,
    conflictIndex,
    resolutionState,
    onSelectChoice,
    onUpdateContent,
    isDragging = false,
    showOutputs = true,
    enableCellDrag = true,
    isVisible = true,
    draggedCell,
    dropTarget,
    onCellDragStart,
    onCellDragEnd,
    onCellDragOver,
    onCellDrop,
    'data-testid': testId,
}: MergeRowProps): React.ReactElement {
    const isConflict = row.type === 'conflict';

    // All hooks must be called unconditionally at the top (Rules of Hooks)
    const [pendingChoice, setPendingChoice] = useState<ResolutionChoice | null>(null);
    const [showWarning, setShowWarning] = useState(false);

    // Get content for a given choice
    const getContentForChoice = useCallback((choice: ResolutionChoice): string => {
        if (choice === 'delete') return '';
        if (choice === 'both') {
            const currentContent = row.currentCell ? normalizeCellSource(row.currentCell.source) : '';
            const incomingContent = row.incomingCell ? normalizeCellSource(row.incomingCell.source) : '';
            return currentContent + '\n' + incomingContent;
        }
        const cell = choice === 'base' ? row.baseCell
            : choice === 'current' ? row.currentCell
                : row.incomingCell;
        return cell ? normalizeCellSource(cell.source) : '';
    }, [row]);

    // Check if content has been modified from the original
    const isContentModified = resolutionState
        ? resolutionState.resolvedContent !== resolutionState.originalContent
        : false;

    // Handle branch selection
    const handleChoiceClick = (choice: ResolutionChoice) => {
        if (resolutionState && isContentModified && choice !== resolutionState.choice) {
            // User has modified content and is trying to change branch - show warning
            setPendingChoice(choice);
            setShowWarning(true);
        } else {
            // No modification or same choice - proceed directly
            const content = getContentForChoice(choice);
            onSelectChoice(conflictIndex, choice, content);
        }
    };

    // Confirm branch change (overwrite edited content)
    const confirmBranchChange = () => {
        if (pendingChoice) {
            const content = getContentForChoice(pendingChoice);
            onSelectChoice(conflictIndex, pendingChoice, content);
        }
        setShowWarning(false);
        setPendingChoice(null);
    };

    // Cancel branch change
    const cancelBranchChange = () => {
        setShowWarning(false);
        setPendingChoice(null);
    };

    // Handle content editing in the resolved text area
    const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onUpdateContent(conflictIndex, e.target.value);
    };

    // For identical rows, show a unified single cell
    if (!isConflict) {
        const cell = row.currentCell || row.incomingCell || row.baseCell;
        // Compute raw source for testing - this is what will become the cell source in the resolved notebook
        const rawSource = cell ? normalizeCellSource(cell.source) : '';
        const cellType = cell?.cell_type || 'code';
        return (
            <div 
                className="merge-row identical-row" 
                data-testid={testId}
                data-raw-source={rawSource}
                data-cell-type={cellType}
            >
                <div className="cell-columns">
                    <div className="cell-column" style={{ gridColumn: '1 / -1' }}>
                        <CellContent
                            cell={cell}
                            cellIndex={row.currentCellIndex ?? row.incomingCellIndex ?? row.baseCellIndex}
                            side="current"
                            showOutputs={showOutputs}
                            isVisible={isVisible}
                        />
                    </div>
                </div>
            </div>
        );
    }

    // Check if this cell is a valid drop target
    const isDropTargetCell = (side: 'base' | 'current' | 'incoming') => {
        if (!enableCellDrag) return false;
        if (!draggedCell) return false;
        if (draggedCell.side !== side) return false; // Same column only
        if (draggedCell.rowIndex === rowIndex) return false; // Not same row
        return dropTarget?.rowIndex === rowIndex && dropTarget?.side === side;
    };

    // Check if a cell can be dragged (only unmatched cells)
    const canDragCell = enableCellDrag && row.isUnmatched;

    const getPlaceholderText = (side: 'base' | 'current' | 'incoming') => {
        if (row.isUnmatched && row.unmatchedSides && !row.unmatchedSides.includes(side)) {
            return '(unmatched cell)';
        }
        return '(cell deleted)';
    };

    // For conflicts, show all 3 columns with drag-and-drop support for unmatched cells
    const rowClasses = [
        'merge-row',
        'conflict-row',
        row.isUnmatched && 'unmatched-row',
        isDragging && 'dragging',
        resolutionState && 'resolved-row'
    ].filter(Boolean).join(' ');

    const hasBase = !!row.baseCell;
    const hasCurrent = !!row.currentCell;
    const hasIncoming = !!row.incomingCell;

    return (
        <div className={rowClasses} data-testid={testId}>
            {/* Warning modal for branch change */}
            {showWarning && (
                <div className="warning-modal-overlay">
                    <div className="warning-modal">
                        <div className="warning-icon">⚠️</div>
                        <h3>Change base branch?</h3>
                        <p>You have edited the resolved content. Changing the base branch will overwrite your changes.</p>
                        <div className="warning-actions">
                            <button className="btn-cancel" onClick={cancelBranchChange}>
                                Keep my edits
                            </button>
                            <button className="btn-confirm" onClick={confirmBranchChange}>
                                Overwrite with {pendingChoice}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Three-way diff view */}
            <div className="cell-columns">
                <div className="cell-column base-column">
                    {row.baseCell ? (
                        <CellContent
                            cell={row.baseCell}
                            cellIndex={row.baseCellIndex}
                            side="base"
                            isConflict={true}
                            compareCell={row.currentCell || row.incomingCell}
                            showOutputs={showOutputs}
                            isVisible={isVisible}
                            onDragStart={canDragCell ? (e) => {
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/plain', Array.isArray(row.baseCell!.source) ? row.baseCell!.source.join('') : row.baseCell!.source);
                                onCellDragStart(rowIndex, 'base', row.baseCell!);
                            } : undefined}
                            onDragEnd={canDragCell ? () => onCellDragEnd() : undefined}
                        />
                    ) : (
                        <div
                            className={`cell-placeholder cell-deleted ${isDropTargetCell('base') ? 'drop-target' : ''}`}
                            onDragOver={enableCellDrag ? (e) => { e.preventDefault(); onCellDragOver(e, rowIndex, 'base'); } : undefined}
                            onDrop={enableCellDrag ? () => onCellDrop(rowIndex, 'base') : undefined}
                        >
                            <span className="placeholder-text">{getPlaceholderText('base')}</span>
                        </div>
                    )}
                </div>
                <div className="cell-column current-column">
                    {row.currentCell ? (
                        <CellContent
                            cell={row.currentCell}
                            cellIndex={row.currentCellIndex}
                            side="current"
                            isConflict={true}
                            compareCell={row.incomingCell || row.baseCell}
                            showOutputs={showOutputs}
                            isVisible={isVisible}
                            onDragStart={canDragCell ? (e) => {
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/plain', Array.isArray(row.currentCell!.source) ? row.currentCell!.source.join('') : row.currentCell!.source);
                                onCellDragStart(rowIndex, 'current', row.currentCell!);
                            } : undefined}
                            onDragEnd={canDragCell ? () => onCellDragEnd() : undefined}
                        />
                    ) : (
                        <div
                            className={`cell-placeholder cell-deleted ${isDropTargetCell('current') ? 'drop-target' : ''}`}
                            onDragOver={enableCellDrag ? (e) => { e.preventDefault(); onCellDragOver(e, rowIndex, 'current'); } : undefined}
                            onDrop={enableCellDrag ? () => onCellDrop(rowIndex, 'current') : undefined}
                        >
                            <span className="placeholder-text">{getPlaceholderText('current')}</span>
                        </div>
                    )}
                </div>
                <div className="cell-column incoming-column">
                    {row.incomingCell ? (
                        <CellContent
                            cell={row.incomingCell}
                            cellIndex={row.incomingCellIndex}
                            side="incoming"
                            isConflict={true}
                            compareCell={row.currentCell || row.baseCell}
                            showOutputs={showOutputs}
                            isVisible={isVisible}
                            onDragStart={canDragCell ? (e) => {
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/plain', Array.isArray(row.incomingCell!.source) ? row.incomingCell!.source.join('') : row.incomingCell!.source);
                                onCellDragStart(rowIndex, 'incoming', row.incomingCell!);
                            } : undefined}
                            onDragEnd={canDragCell ? () => onCellDragEnd() : undefined}
                        />
                    ) : (
                        <div
                            className={`cell-placeholder cell-deleted ${isDropTargetCell('incoming') ? 'drop-target' : ''}`}
                            onDragOver={enableCellDrag ? (e) => { e.preventDefault(); onCellDragOver(e, rowIndex, 'incoming'); } : undefined}
                            onDrop={enableCellDrag ? () => onCellDrop(rowIndex, 'incoming') : undefined}
                        >
                            <span className="placeholder-text">{getPlaceholderText('incoming')}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Resolution bar - select which branch to use as base */}
            <div className="resolution-bar">
                {hasBase && (
                    <button
                        className={`btn-resolve btn-base ${resolutionState?.choice === 'base' ? 'selected' : ''}`}
                        onClick={() => handleChoiceClick('base')}
                    >
                        Use Base
                    </button>
                )}
                {hasCurrent && (
                    <button
                        className={`btn-resolve btn-current ${resolutionState?.choice === 'current' ? 'selected' : ''}`}
                        onClick={() => handleChoiceClick('current')}
                    >
                        Use Current
                    </button>
                )}
                {hasIncoming && (
                    <button
                        className={`btn-resolve btn-incoming ${resolutionState?.choice === 'incoming' ? 'selected' : ''}`}
                        onClick={() => handleChoiceClick('incoming')}
                    >
                        Use Incoming
                    </button>
                )}
                {hasCurrent && hasIncoming && (
                    <button
                        className={`btn-resolve btn-both ${resolutionState?.choice === 'both' ? 'selected' : ''}`}
                        onClick={() => handleChoiceClick('both')}
                    >
                        Use Both
                    </button>
                )}
                <button
                    className={`btn-resolve btn-delete ${resolutionState?.choice === 'delete' ? 'selected' : ''}`}
                    onClick={() => handleChoiceClick('delete')}
                >
                    Delete Cell
                </button>
            </div>

            {/* Resolved content editor - appears after selecting a branch */}
            {resolutionState && resolutionState.choice !== 'delete' && (
                <div className="resolved-cell">
                    <div className="resolved-header">
                        <span className="resolved-label">✓ Resolved</span>
                        <span className="resolved-base">
                            Based on: <strong>{resolutionState.choice}</strong>
                            {isContentModified && <span className="modified-badge">(edited)</span>}
                        </span>
                    </div>
                    <textarea
                        className="resolved-content-input"
                        value={resolutionState.resolvedContent}
                        onChange={handleContentChange}
                        placeholder="Enter cell content..."
                        rows={Math.max(5, resolutionState.resolvedContent.split('\n').length + 1)}
                    />
                </div>
            )}

            {/* Show delete confirmation */}
            {resolutionState && resolutionState.choice === 'delete' && (
                <div className="resolved-cell resolved-deleted">
                    <div className="resolved-header">
                        <span className="resolved-label">✓ Resolved</span>
                        <span className="resolved-base">Cell will be deleted</span>
                    </div>
                </div>
            )}
        </div>
    );
}
