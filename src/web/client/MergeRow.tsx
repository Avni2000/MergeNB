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
import type { MergeRow as MergeRowType, ResolutionChoice } from './types';
import { CellContent } from './CellContent';
import { normalizeCellSource, selectNonConflictMergedCell } from '../../notebookUtils';
import { createMergeNBTheme, mergeNBEditorStructure, mergeNBSyntaxClassHighlighter } from './editorTheme';

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
    notebookPath?: string;
    languageExtensions?: Extension[];
    resolutionState?: ResolutionState;
    onSelectChoice: (index: number, choice: ResolutionChoice, resolvedContent: string) => void;
    onCommitContent: (index: number, resolvedContent: string) => void;
    showOutputs?: boolean;
    showBaseColumn?: boolean;
    showCellHeaders?: boolean;
    theme?: 'dark' | 'light';
    'data-testid'?: string;
}
const EMPTY_EXTENSIONS: Extension[] = [];

export function MergeRowInner({
    row,
    rowIndex,
    conflictIndex,
    notebookPath,
    languageExtensions = EMPTY_EXTENSIONS,
    resolutionState,
    onSelectChoice,
    onCommitContent,
    showOutputs = true,
    showBaseColumn = true,
    showCellHeaders = false,
    theme = 'light',
    'data-testid': testId,
}: MergeRowProps): React.ReactElement {
    const isConflict = row.type === 'conflict';

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
    const resolvedEditorTheme = useMemo(() => createMergeNBTheme(theme), [theme]);
    const editorExtensions = useMemo(
        () => [...languageExtensions, mergeNBSyntaxClassHighlighter, mergeNBEditorStructure],
        [languageExtensions]
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

    // For identical rows, show a unified single cell
    if (!isConflict) {
        const cell = selectNonConflictMergedCell(row.baseCell, row.currentCell, row.incomingCell);
        // Compute raw source for testing - this is what will become the cell source in the resolved notebook
        const rawSource = cell ? normalizeCellSource(cell.source) : '';
        const cellType = cell?.cell_type || 'code';
        return (
            <div
                className="merge-row identical-row"
                data-testid={testId}
                data-raw-source={rawSource}
                data-cell-type={cellType}
                data-cell={encodeURIComponent(cell ? JSON.stringify(cell) : '')}
            >
                <div className="cell-columns">
                    <div className="cell-column" style={{ gridColumn: '1 / -1' }}>
                        <CellContent
                            cell={cell}
                            cellIndex={row.currentCellIndex ?? row.incomingCellIndex ?? row.baseCellIndex}
                            side="current"
                            notebookPath={notebookPath}
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
        resolutionState && 'resolved-row'
    ].filter(Boolean).join(' ');

    const hasBase = !!row.baseCell;
    const hasCurrent = !!row.currentCell;
    const hasIncoming = !!row.incomingCell;
    // Always use conflict diffing mode for consistent red highlighting of divergence
    const diffMode = 'conflict';
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
            <div className={`cell-columns${showBaseColumn ? '' : ' two-column'}`}>
                {showBaseColumn && (
                    <div className="cell-column base-column">
                        {row.baseCell ? (
                            <CellContent
                                cell={row.baseCell}
                                cellIndex={row.baseCellIndex}
                                side="base"
                                notebookPath={notebookPath}
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
                            notebookPath={notebookPath}
                            isConflict={true}
                            compareCell={row.incomingCell || row.baseCell}
                            baseCell={row.baseCell}
                            diffMode={diffMode}
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
                            notebookPath={notebookPath}
                            isConflict={true}
                            compareCell={row.currentCell || row.baseCell}
                            baseCell={row.baseCell}
                            diffMode={diffMode}
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
            <div className="resolution-bar">
                {showBaseColumn && hasBase && (
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
