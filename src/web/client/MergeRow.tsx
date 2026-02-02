/**
 * @file MergeRow.tsx
 * @description React component for a single row in the 3-way merge view.
 */

import React, { useState } from 'react';
import type { MergeRow as MergeRowType, NotebookCell } from './types';
import { CellContent } from './CellContent';

type ResolutionChoice = 'base' | 'current' | 'incoming' | 'both' | 'custom' | 'delete';

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

interface MergeRowProps {
    row: MergeRowType;
    rowIndex: number;
    conflictIndex: number;
    selectedChoice?: ResolutionChoice;
    customContent?: string;
    onSelectChoice: (index: number, choice: ResolutionChoice, customContent?: string) => void;
    isDragging?: boolean;
    showOutputs?: boolean;
    // Cell drag props
    draggedCell: DraggedCellData | null;
    dropTarget: DropTarget | null;
    onCellDragStart: (rowIndex: number, side: 'base' | 'current' | 'incoming', cell: NotebookCell) => void;
    onCellDragEnd: () => void;
    onCellDragOver: (e: React.DragEvent, rowIndex: number, side: 'base' | 'current' | 'incoming') => void;
    onCellDrop: (targetRowIndex: number, targetSide: 'base' | 'current' | 'incoming') => void;
}

export function MergeRow({
    row,
    rowIndex,
    conflictIndex,
    selectedChoice,
    customContent,
    onSelectChoice,
    isDragging = false,
    showOutputs = true,
    draggedCell,
    dropTarget,
    onCellDragStart,
    onCellDragEnd,
    onCellDragOver,
    onCellDrop,
}: MergeRowProps): React.ReactElement {
    const isConflict = row.type === 'conflict';
    const [isEditMode, setIsEditMode] = useState(false);
    const [editContent, setEditContent] = useState(customContent || '');

    // For identical rows, show a unified single cell
    if (!isConflict) {
        const cell = row.currentCell || row.incomingCell || row.baseCell;
        return (
            <div className="merge-row identical-row">
                <div className="cell-columns">
                    <div className="cell-column" style={{ gridColumn: '1 / -1' }}>
                        <CellContent
                            cell={cell}
                            cellIndex={row.currentCellIndex ?? row.incomingCellIndex ?? row.baseCellIndex}
                            side="current"
                            showOutputs={showOutputs}
                        />
                    </div>
                </div>
            </div>
        );
    }

    const handleSaveCustom = () => {
        onSelectChoice(conflictIndex, 'custom', editContent);
        setIsEditMode(false);
    };

    const handleCancelEdit = () => {
        setEditContent(customContent || '');
        setIsEditMode(false);
    };

    // Check if this cell is a valid drop target
    const isDropTarget = (side: 'base' | 'current' | 'incoming') => {
        if (!draggedCell) return false;
        if (draggedCell.side !== side) return false; // Same column only
        if (draggedCell.rowIndex === rowIndex) return false; // Not same row
        return dropTarget?.rowIndex === rowIndex && dropTarget?.side === side;
    };

    // Check if a cell can be dragged (only unmatched cells)
    const canDragCell = row.isUnmatched;

    // For conflicts, show all 3 columns with drag-and-drop support for unmatched cells
    const rowClasses = [
        'merge-row',
        'conflict-row',
        row.isUnmatched && 'unmatched-row',
        isDragging && 'dragging'
    ].filter(Boolean).join(' ');

    return (
        <div className={rowClasses}>
            {isEditMode ? (
                <div className="custom-editor">
                    <textarea
                        className="custom-content-input"
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        placeholder="Enter custom cell content..."
                        rows={10}
                    />
                    <div className="editor-actions">
                        <button className="btn-save" onClick={handleSaveCustom}>
                            Save Custom Content
                        </button>
                        <button className="btn-cancel" onClick={handleCancelEdit}>
                            Cancel
                        </button>
                    </div>
                </div>
            ) : (
                <>
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
                                    onDragStart={canDragCell ? (e) => {
                                        e.dataTransfer.effectAllowed = 'move';
                                        e.dataTransfer.setData('text/plain', Array.isArray(row.baseCell!.source) ? row.baseCell!.source.join('') : row.baseCell!.source);
                                        onCellDragStart(rowIndex, 'base', row.baseCell!);
                                    } : undefined}
                                    onDragEnd={canDragCell ? () => onCellDragEnd() : undefined}
                                />
                            ) : (
                                <div 
                                    className={`cell-placeholder ${isDropTarget('base') ? 'drop-target' : ''}`}
                                    onDragOver={(e) => { e.preventDefault(); onCellDragOver(e, rowIndex, 'base'); }}
                                    onDrop={() => onCellDrop(rowIndex, 'base')}
                                >
                                    <span className="placeholder-text">(not present)</span>
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
                                    onDragStart={canDragCell ? (e) => {
                                        e.dataTransfer.effectAllowed = 'move';
                                        e.dataTransfer.setData('text/plain', Array.isArray(row.currentCell!.source) ? row.currentCell!.source.join('') : row.currentCell!.source);
                                        onCellDragStart(rowIndex, 'current', row.currentCell!);
                                    } : undefined}
                                    onDragEnd={canDragCell ? () => onCellDragEnd() : undefined}
                                />
                            ) : (
                                <div 
                                    className={`cell-placeholder ${isDropTarget('current') ? 'drop-target' : ''}`}
                                    onDragOver={(e) => { e.preventDefault(); onCellDragOver(e, rowIndex, 'current'); }}
                                    onDrop={() => onCellDrop(rowIndex, 'current')}
                                >
                                    <span className="placeholder-text">(not present)</span>
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
                                    onDragStart={canDragCell ? (e) => {
                                        e.dataTransfer.effectAllowed = 'move';
                                        e.dataTransfer.setData('text/plain', Array.isArray(row.incomingCell!.source) ? row.incomingCell!.source.join('') : row.incomingCell!.source);
                                        onCellDragStart(rowIndex, 'incoming', row.incomingCell!);
                                    } : undefined}
                                    onDragEnd={canDragCell ? () => onCellDragEnd() : undefined}
                                />
                            ) : (
                                <div 
                                    className={`cell-placeholder ${isDropTarget('incoming') ? 'drop-target' : ''}`}
                                    onDragOver={(e) => { e.preventDefault(); onCellDragOver(e, rowIndex, 'incoming'); }}
                                    onDrop={() => onCellDrop(rowIndex, 'incoming')}
                                >
                                    <span className="placeholder-text">(not present)</span>
                                </div>
                            )}
                        </div>
                    </div>
                    <ResolutionBar
                        conflictIndex={conflictIndex}
                        hasBase={!!row.baseCell}
                        hasCurrent={!!row.currentCell}
                        hasIncoming={!!row.incomingCell}
                        selectedChoice={selectedChoice}
                        onSelectChoice={onSelectChoice}
                        onEditCustom={() => setIsEditMode(true)}
                    />
                </>
            )}
        </div>
    );
}

interface ResolutionBarProps {
    conflictIndex: number;
    hasBase: boolean;
    hasCurrent: boolean;
    hasIncoming: boolean;
    selectedChoice?: ResolutionChoice;
    onSelectChoice: (index: number, choice: ResolutionChoice, customContent?: string) => void;
    onEditCustom: () => void;
}

function ResolutionBar({
    conflictIndex,
    hasBase,
    hasCurrent,
    hasIncoming,
    selectedChoice,
    onSelectChoice,
    onEditCustom,
}: ResolutionBarProps): React.ReactElement {
    const handleClick = (choice: ResolutionChoice) => {
        onSelectChoice(conflictIndex, choice);
    };

    return (
        <div className="resolution-bar">
            {hasBase && (
                <button
                    className={`btn-resolve btn-base ${selectedChoice === 'base' ? 'selected' : ''}`}
                    onClick={() => handleClick('base')}
                >
                    Use Base
                </button>
            )}
            {hasCurrent && (
                <button
                    className={`btn-resolve btn-current ${selectedChoice === 'current' ? 'selected' : ''}`}
                    onClick={() => handleClick('current')}
                >
                    Use Current
                </button>
            )}
            {hasIncoming && (
                <button
                    className={`btn-resolve btn-incoming ${selectedChoice === 'incoming' ? 'selected' : ''}`}
                    onClick={() => handleClick('incoming')}
                >
                    Use Incoming
                </button>
            )}
            {hasCurrent && hasIncoming && (
                <button
                    className={`btn-resolve btn-both ${selectedChoice === 'both' ? 'selected' : ''}`}
                    onClick={() => handleClick('both')}
                >
                    Use Both
                </button>
            )}
            <button
                className={`btn-resolve btn-custom ${selectedChoice === 'custom' ? 'selected' : ''}`}
                onClick={onEditCustom}
            >
                Custom...
            </button>
            <button
                className={`btn-resolve btn-delete ${selectedChoice === 'delete' ? 'selected' : ''}`}
                onClick={() => handleClick('delete')}
            >
                Delete Cell
            </button>
        </div>
    );
}
