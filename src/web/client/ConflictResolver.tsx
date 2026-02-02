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
} from './types';
import { MergeRow } from './MergeRow';

type ResolutionChoice = 'base' | 'current' | 'incoming' | 'both';

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
    const [choices, setChoices] = useState<Map<number, ResolutionChoice>>(new Map());
    const [markAsResolved, setMarkAsResolved] = useState(true);

    // Build merge rows from conflict data
    const rows = useMemo(() => {
        if (conflict.type === 'semantic' && conflict.semanticConflict) {
            return buildMergeRowsFromSemantic(conflict.semanticConflict);
        } else if (conflict.type === 'textual' && conflict.textualConflict) {
            return buildMergeRowsFromTextual(conflict.textualConflict);
        }
        return [];
    }, [conflict]);

    const conflictRows = useMemo(() => rows.filter(r => r.type === 'conflict'), [rows]);
    const totalConflicts = conflictRows.length;
    const resolvedCount = choices.size;
    const allResolved = resolvedCount === totalConflicts;

    const handleSelectChoice = useCallback((index: number, choice: ResolutionChoice) => {
        setChoices(prev => {
            const next = new Map(prev);
            next.set(index, choice);
            return next;
        });
    }, []);

    const handleResolve = useCallback(() => {
        const resolutions: ConflictChoice[] = [];
        for (const [index, choice] of choices) {
            resolutions.push({ index, choice });
        }
        onResolve(resolutions, markAsResolved);
    }, [choices, markAsResolved, onResolve]);

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
                    return (
                        <MergeRow
                            key={i}
                            row={row}
                            conflictIndex={conflictIdx}
                            selectedChoice={conflictIdx >= 0 ? choices.get(conflictIdx) : undefined}
                            onSelectChoice={handleSelectChoice}
                            showOutputs={!conflict.hideNonConflictOutputs || row.type === 'conflict'}
                        />
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
