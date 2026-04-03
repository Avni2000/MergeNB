/**
 * @file MergeRow.tsx
 * @description React component for a single row in the 3-way merge view.
 * 
 * UI flow:
 * 1. User selects a branch (base/current/incoming) 
 * 2. A resolved text area appears with green highlighting, pre-filled with that branch's content
 * 3. User can edit the content freely
 * 4. If user changes the selected branch after editing, show a warning
 */

import React, { useEffect, useState, useMemo } from 'react';
import CodeMirror, { Extension } from '@uiw/react-codemirror';
import type { MergeRow as MergeRowType, ResolutionChoice } from '../types';
import { CellContent, mergeNBEditorStructure } from './CellContent';
import { normalizeCellSource, selectNonConflictMergedCell } from '../../../../core/src';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import type { ResolutionState } from '../store/resolverStore';

interface MergeRowProps {
    row: MergeRowType;
    rowIndex: number;
    languageExtensions?: Extension[];
    resolutionState?: ResolutionState;
    onSelectChoice: (index: number, choice: ResolutionChoice, resolvedContent: string) => void;
    onCommitContent: (index: number, resolvedContent: string) => void;
    onUnmatchRow?: (rowIndex: number) => void;
    onRematchRows?: (unmatchGroupId: string) => void;
    showOutputs?: boolean;
    showBaseColumn?: boolean;
    showCellHeaders?: boolean;
    theme?: 'dark' | 'light';
    'data-testid'?: string;
}

const EMPTY_EXTENSIONS: Extension[] = [];

function MergeRowInner({
    row,
    rowIndex,
    languageExtensions = EMPTY_EXTENSIONS,
    resolutionState,
    onSelectChoice,
    onCommitContent,
    onUnmatchRow,
    onRematchRows,
    showOutputs = true,
    showBaseColumn = true,
    showCellHeaders = false,
    theme = 'light',
    'data-testid': testId,
}: MergeRowProps): React.ReactElement {
    const isConflict = row.type === 'conflict';
    const isReordered = row.isReordered ?? false;
    const conflictIndex = row.conflictIndex ?? -1;

    // All hooks must be called unconditionally at the top (Rules of Hooks)
    const [pendingChoice, setPendingChoice] = useState<ResolutionChoice | null>(null);
    const [showWarning, setShowWarning] = useState(false);
    const [draftResolvedContent, setDraftResolvedContent] = useState(resolutionState?.resolvedContent ?? '');

    useEffect(() => {
        setDraftResolvedContent(resolutionState?.resolvedContent ?? '');
    }, [resolutionState?.choice, resolutionState?.resolvedContent, conflictIndex]);

    // Memoize theme and extensions so @uiw/react-codemirror's internal useEffect
    // (which triggers StateEffect.reconfigure) only fires when these values actually
    // change — not on every render because of new object/array references.
    const resolvedEditorTheme = useMemo(() => theme === 'dark' ? githubDark : githubLight, [theme]);
    
    // Derive resolvedCellType from the user's selected branch choice, not a fixed fallback order.
    // This ensures the editor extensions and styling update when the user switches branches.
    const resolvedCellType = resolutionState
        ? (
            resolutionState.choice === 'base' ? row.baseCell?.cell_type
            : resolutionState.choice === 'current' ? row.currentCell?.cell_type
            : resolutionState.choice === 'incoming' ? row.incomingCell?.cell_type
            : 'code'
        )
        : (row.currentCell?.cell_type || row.incomingCell?.cell_type || row.baseCell?.cell_type || 'code');
    
    const editorExtensions = useMemo(
        () => [...(resolvedCellType === 'markdown' ? [] : languageExtensions), mergeNBEditorStructure],
        [languageExtensions, resolvedCellType]
    );

    // Get content for a given choice
    const getContentForChoice = (choice: ResolutionChoice): string => {
        if (choice === 'delete') return '';
        const cell = choice === 'base' ? row.baseCell
            : choice === 'current' ? row.currentCell
                : row.incomingCell;
        return cell ? normalizeCellSource(cell.source) : '';
    };

    // Check if content has been modified from the original
    const isContentModified = resolutionState
        ? draftResolvedContent !== resolutionState.originalContent
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

    // Handle content editing in the resolved editor
    const handleContentChange = (value: string) => {
        setDraftResolvedContent(value);
    };

    // Commit content to history on blur
    const handleBlur = () => {
        if (!resolutionState) return;
        onCommitContent(conflictIndex, draftResolvedContent);
    };

    const base = row.baseCellIndex;
    const currentDelta = (isReordered && base !== undefined && row.currentCellIndex !== undefined)
        ? row.currentCellIndex - base : undefined;
    const incomingDelta = (isReordered && base !== undefined && row.incomingCellIndex !== undefined)
        ? row.incomingCellIndex - base : undefined;
    const canUnmatch = isConflict
        && isReordered
        && !row.isUserUnmatched
        && row.conflictIndex !== undefined
        && !!row.currentCell && !!row.incomingCell;

    // For identical rows, show a unified single cell
    if (!isConflict) {
        const cell = selectNonConflictMergedCell(row.baseCell, row.currentCell, row.incomingCell);
        // Compute raw source for testing - this is what will become the cell source in the resolved notebook
        const rawSource = cell ? normalizeCellSource(cell.source) : '';
        const cellType = cell?.cell_type || 'code';
        const identicalClasses = [
            'merge-row',
            'identical-row',
            isReordered && 'reordered-row',
        ].filter(Boolean).join(' ');
        return (
            <div
                className={identicalClasses}
                data-testid={testId}
                data-raw-source={rawSource}
                data-cell-type={cellType}
                data-cell={encodeURIComponent(cell ? JSON.stringify(cell) : '')}
            >
                {isReordered && (
                    <div className="reorder-indicator-bar" data-testid="reorder-indicator">
                        {currentDelta !== undefined && currentDelta !== 0 && (
                            <span className="reorder-delta current-delta">
                                {currentDelta > 0 ? '\u2193' : '\u2191'} {Math.abs(currentDelta)}
                            </span>
                        )}
                        {incomingDelta !== undefined && incomingDelta !== 0 && (
                            <span className="reorder-delta incoming-delta">
                                {incomingDelta > 0 ? '\u2193' : '\u2191'} {Math.abs(incomingDelta)}
                            </span>
                        )}
                    </div>
                )}
                <div className="cell-columns">
                    <div className="cell-column" style={{ gridColumn: '1 / -1' }}>
                        <CellContent
                            cell={cell}
                            cellIndex={row.currentCellIndex ?? row.incomingCellIndex ?? row.baseCellIndex}
                            side="current"
                            isConflict={false}
                            languageExtensions={languageExtensions}
                            theme={theme}
                            showOutputs={showOutputs}
                            showCellHeaders={showCellHeaders}
                        />
                    </div>
                </div>
            </div>
        );
    }

    const getPlaceholderText = (side: 'base' | 'current' | 'incoming') => {
        if (row.isUnmatched && row.unmatchedSides && !row.unmatchedSides.includes(side)) {
            return '(unmatched cell)';
        }
        return '(cell deleted)';
    };

    // For conflicts, show all 3 columns
    const rowClasses = [
        'merge-row',
        'conflict-row',
        row.isUnmatched && 'unmatched-row',
        row.isUserUnmatched && 'user-unmatched-row',
        isReordered && !row.isUserUnmatched && 'reordered-row',
        resolutionState && 'resolved-row'
    ].filter(Boolean).join(' ');

    const hasBase = !!row.baseCell;
    const hasCurrent = !!row.currentCell;
    const hasIncoming = !!row.incomingCell;
    return (
        <div className={rowClasses} data-testid={testId}>
            {/* Top action bar - always present for conflicts */}
            <div className="conflict-action-bar" data-testid="conflict-action-bar">
                <div className="conflict-action-left">
                    {isReordered && !row.isUserUnmatched && (
                        <div className="reorder-indicator-bar" data-testid="reorder-indicator">
                            {currentDelta !== undefined && currentDelta !== 0 && (
                                <span className="reorder-delta current-delta">
                                    {currentDelta > 0 ? '\u2193' : '\u2191'} {Math.abs(currentDelta)}
                                </span>
                            )}
                            {incomingDelta !== undefined && incomingDelta !== 0 && (
                                <span className="reorder-delta incoming-delta">
                                    {incomingDelta > 0 ? '\u2193' : '\u2191'} {Math.abs(incomingDelta)}
                                </span>
                            )}
                        </div>
                    )}
                </div>
                <div className="conflict-action-right">
                    <button
                        className={`btn-resolve btn-delete ${resolutionState?.choice === 'delete' ? 'selected' : ''}`}
                        onClick={() => handleChoiceClick('delete')}
                    >
                        Delete Cell
                    </button>
                    {/* Always render unmatch/rematch group; use CSS to toggle visibility.
                        Show when: isReordered + canUnmatch OR user-unmatched + unmatchGroupId */}
                    {(isReordered || row.isUserUnmatched) && (
                        <div
                            className={`unmatch-rematch-group ${row.isUserUnmatched ? 'rematch-visible' : 'unmatch-visible'}`}
                        >
                            {isReordered && !row.isUserUnmatched && canUnmatch && (
                                <button
                                    className="btn-unmatch"
                                    onClick={() => onUnmatchRow?.(rowIndex)}
                                    title="Unmatch this row into separate cells"
                                    data-testid="unmatch-btn"
                                >
                                    Unmatch
                                </button>
                            )}
                            {row.isUserUnmatched && (
                                <>
                                    <span className="rematch-label">Unmatched</span>
                                    <button
                                        className="btn-rematch"
                                        onClick={() => onRematchRows?.(row.unmatchGroupId)}
                                        title="Rematch these cells back into one row"
                                        data-testid="rematch-btn"
                                    >
                                        Rematch
                                    </button>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>

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
            <div className={`cell-columns${showBaseColumn ? '' : ' two-column'}`}>
                {showBaseColumn && (
                    <div className="cell-column base-column">
                        {row.baseCell ? (
                            <CellContent
                                cell={row.baseCell}
                                cellIndex={row.baseCellIndex}
                                side="base"
                                isConflict={true}
                                compareCell={row.currentCell || row.incomingCell}
                                languageExtensions={languageExtensions}
                                theme={theme}
                                showOutputs={showOutputs}
                                showCellHeaders={showCellHeaders}
                            />
                        ) : (
                            <div className="cell-placeholder cell-deleted">
                                <span className="placeholder-text">{getPlaceholderText('base')}</span>
                            </div>
                        )}
                    </div>
                )}
                <div className="cell-column current-column">
                    {row.currentCell ? (
                        <CellContent
                            cell={row.currentCell}
                            cellIndex={row.currentCellIndex}
                            side="current"
                            isConflict={true}
                            compareCell={row.incomingCell || row.baseCell}
                            diffMode="conflict"
                            languageExtensions={languageExtensions}
                            theme={theme}
                            showOutputs={showOutputs}
                            showCellHeaders={showCellHeaders}
                        />
                    ) : (
                        <div className="cell-placeholder cell-deleted">
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
                            diffMode="conflict"
                            languageExtensions={languageExtensions}
                            theme={theme}
                            showOutputs={showOutputs}
                            showCellHeaders={showCellHeaders}
                        />
                    ) : (
                        <div className="cell-placeholder cell-deleted">
                            <span className="placeholder-text">{getPlaceholderText('incoming')}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Resolution bar - select which branch to use as base */}
            <div className={`resolution-bar cell-columns${showBaseColumn && !row.isUserUnmatched ? '' : ' two-column'}`}>
                {showBaseColumn && !row.isUserUnmatched && (
                    <div className="cell-column base-column">
                        {hasBase && (
                            <button
                                className={`btn-resolve btn-base ${resolutionState?.choice === 'base' ? 'selected' : ''}`}
                                onClick={() => handleChoiceClick('base')}
                            >
                                Use Base
                            </button>
                        )}
                    </div>
                )}
                <div className="cell-column current-column">
                    {hasCurrent && (
                        <button
                            className={`btn-resolve btn-current ${resolutionState?.choice === 'current' ? 'selected' : ''}`}
                            onClick={() => handleChoiceClick('current')}
                        >
                            Use Current
                        </button>
                    )}
                </div>
                <div className="cell-column incoming-column">
                    {hasIncoming && (
                        <button
                            className={`btn-resolve btn-incoming ${resolutionState?.choice === 'incoming' ? 'selected' : ''}`}
                            onClick={() => handleChoiceClick('incoming')}
                        >
                            Use Incoming
                        </button>
                    )}
                </div>
            </div>

            {/* Resolved content editor - appears after selecting a branch */}
            {resolutionState && resolutionState.choice !== 'delete' && (
                <div className={`resolved-cell ${resolvedCellType}-cell`}>
                    <div className="resolved-header">
                        <span className="resolved-label">✓ Resolved</span>
                        <span className="resolved-base">
                            Based on: <strong>{resolutionState.choice}</strong>
                            {isContentModified && <span className="modified-badge">(edited)</span>}
                        </span>
                    </div>
                    <CodeMirror
                        value={draftResolvedContent}
                        onChange={handleContentChange}
                        onBlur={handleBlur}
                        extensions={editorExtensions}
                        placeholder="Enter cell content..."
                        className="resolved-content-input"
                        basicSetup={{ lineNumbers: false, foldGutter: false }}
                        theme={resolvedEditorTheme}
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
export const MergeRow = React.memo(MergeRowInner);
