/**
 * @file MergeRow.tsx
 * @description React component for a single row in the 3-way merge view.
 */

import React from 'react';
import type { MergeRow as MergeRowType, NotebookCell } from './types';
import { CellContent } from './CellContent';

type ResolutionChoice = 'base' | 'current' | 'incoming' | 'both';

interface MergeRowProps {
    row: MergeRowType;
    conflictIndex: number;
    selectedChoice?: ResolutionChoice;
    onSelectChoice: (index: number, choice: ResolutionChoice) => void;
    showOutputs?: boolean;
}

export function MergeRow({
    row,
    conflictIndex,
    selectedChoice,
    onSelectChoice,
    showOutputs = true,
}: MergeRowProps): React.ReactElement {
    const isConflict = row.type === 'conflict';

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

    // For conflicts, show all 3 columns
    return (
        <div className={`merge-row conflict-row ${row.isUnmatched ? 'unmatched-row' : ''}`}>
            <div className="cell-columns">
                <div className="cell-column base-column">
                    <CellContent
                        cell={row.baseCell}
                        cellIndex={row.baseCellIndex}
                        side="base"
                        isConflict={true}
                        compareCell={row.currentCell || row.incomingCell}
                        showOutputs={showOutputs}
                    />
                </div>
                <div className="cell-column current-column">
                    <CellContent
                        cell={row.currentCell}
                        cellIndex={row.currentCellIndex}
                        side="current"
                        isConflict={true}
                        compareCell={row.incomingCell || row.baseCell}
                        showOutputs={showOutputs}
                    />
                </div>
                <div className="cell-column incoming-column">
                    <CellContent
                        cell={row.incomingCell}
                        cellIndex={row.incomingCellIndex}
                        side="incoming"
                        isConflict={true}
                        compareCell={row.currentCell || row.baseCell}
                        showOutputs={showOutputs}
                    />
                </div>
            </div>
            <ResolutionBar
                conflictIndex={conflictIndex}
                hasBase={!!row.baseCell}
                hasCurrent={!!row.currentCell}
                hasIncoming={!!row.incomingCell}
                selectedChoice={selectedChoice}
                onSelectChoice={onSelectChoice}
            />
        </div>
    );
}

interface ResolutionBarProps {
    conflictIndex: number;
    hasBase: boolean;
    hasCurrent: boolean;
    hasIncoming: boolean;
    selectedChoice?: ResolutionChoice;
    onSelectChoice: (index: number, choice: ResolutionChoice) => void;
}

function ResolutionBar({
    conflictIndex,
    hasBase,
    hasCurrent,
    hasIncoming,
    selectedChoice,
    onSelectChoice,
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
        </div>
    );
}
