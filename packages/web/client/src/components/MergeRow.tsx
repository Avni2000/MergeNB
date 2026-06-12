/**
 * @file MergeRow.tsx
 * @description React component for a single row in the 3-way merge view.
 * 
 * UI flow:
 * 1. User selects a branch (base/current/incoming) 
 * 2. A resolved text area appears with green highlighting, pre-filled with that branch's content
 * 3. User can enter edit mode, which shows a CodeMirror editor for the resolved content
 * 4. Leaving the editor via blur autosaves the current draft and exits edit mode
 */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import CodeMirror, { Extension } from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import type { MergeRow as MergeRowType, ResolutionChoice } from '../types';
import { CellContent, CellSource, EMPTY_EXTENSIONS, MarkdownContent, mergeNBEditorStructure } from './CellContent';
import { WarningModal } from './WarningModal';
import { normalizeCellSource, selectNonConflictMergedCell } from '../../../../core/src';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import type { ResolutionState } from '../store/resolverStore';

interface MergeRowProps {
    row: MergeRowType;
    rowIndex: number;
    languageExtensions?: Extension[];
    resolutionState?: ResolutionState;
    isEditing?: boolean;
    onSelectChoice: (index: number, choice: ResolutionChoice, resolvedContent: string) => void;
    onCommitContent: (index: number, resolvedContent: string) => void;
    onStartEditing: (index: number) => void;
    onStopEditing: (index: number) => void;
    onClearChoice?: (conflictIndex: number) => void;
    onUnmatchRow?: (rowIndex: number) => void;
    onRematchRows?: (unmatchGroupId: string) => void;
    showOutputs?: boolean;
    showBaseColumn?: boolean;
    showCellHeaders?: boolean;
    theme?: 'dark' | 'light';
    'data-testid'?: string;
}

// Test/diagnostic opt-out: `?noLightweight=1` forces every row to render at full
// fidelity, regardless of viewport position. Read once at module load.
const lightweightDisabled =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('noLightweight') === '1';

// Initial-render heuristic: render the first N rows at full fidelity (covers small
// notebooks and the initial viewport region of large ones); rest start lightweight
// and get upgraded as IntersectionObserver fires. Avoids a full-fidelity render of
// hundreds of off-screen rows on mount.
const INITIAL_FULL_FIDELITY_ROW_BUDGET = 30;

function MergeRowInner({
    row,
    rowIndex,
    languageExtensions = EMPTY_EXTENSIONS,
    resolutionState,
    isEditing = false,
    onSelectChoice,
    onCommitContent,
    onStartEditing,
    onStopEditing,
    onClearChoice,
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
    const [showUndoWarning, setShowUndoWarning] = useState(false);
    const [justSaved, setJustSaved] = useState(false);
    const [draftResolvedContent, setDraftResolvedContent] = useState(resolutionState?.resolvedContent ?? '');
    const draftResolvedContentRef = useRef(draftResolvedContent);
    const suppressBlurEditGuardRef = useRef(false);
    const isEditingRef = useRef(isEditing);
    const latestResolvedContentRef = useRef(resolutionState?.resolvedContent);

    useEffect(() => {
        setDraftResolvedContent(resolutionState?.resolvedContent ?? '');
    }, [resolutionState?.choice, resolutionState?.resolvedContent, conflictIndex]);

    useEffect(() => {
        draftResolvedContentRef.current = draftResolvedContent;
    }, [draftResolvedContent]);

    useEffect(() => {
        isEditingRef.current = isEditing;
    }, [isEditing]);

    useEffect(() => {
        latestResolvedContentRef.current = resolutionState?.resolvedContent;
    }, [resolutionState?.resolvedContent]);

    // Cleanup on unmount: commit pending edits to prevent data loss.
    // Uses refs so the cleanup reads current values rather than stale closed-over ones — preventing
    // duplicate callbacks when deps change mid-lifecycle (e.g., isEditing flips false on blur autosave).
    useEffect(() => {
        return () => {
            if (isEditingRef.current && draftResolvedContentRef.current !== latestResolvedContentRef.current) {
                onCommitContent(conflictIndex, draftResolvedContentRef.current);
                onStopEditing(conflictIndex);
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Lightweight off-viewport rendering: keep all rows in the DOM (so native Ctrl+F
    // still hits every cell) but start heavy content (markdown HTML, rich outputs) as
    // plain text until the row first comes within an 800px buffer of the viewport.
    // The upgrade is one-way: never swap DOM back out, so scrolling can't destroy an
    // in-progress text selection anchored in an upgraded row.
    const rowRef = useRef<HTMLDivElement>(null);
    const [isNearViewport, setIsNearViewport] = useState(
        () => lightweightDisabled || rowIndex < INITIAL_FULL_FIDELITY_ROW_BUDGET
    );
    useEffect(() => {
        if (lightweightDisabled || rowIndex < INITIAL_FULL_FIDELITY_ROW_BUDGET) return;
        const el = rowRef.current;
        if (!el) return;
        // Observe relative to the actual scroll container (.main-content) rather
        // than the document viewport, so header overlap and ancestor clipping
        // don't skew intersection results.
        const scrollRoot = el.closest('.main-content');
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setIsNearViewport(true);
                    observer.disconnect();
                }
            },
            { root: scrollRoot, rootMargin: '800px 0px' }
        );
        observer.observe(el);
        return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
        () => [...(resolvedCellType === 'markdown' ? [] : languageExtensions), mergeNBEditorStructure, EditorView.lineWrapping],
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
    const displayedResolvedContent = isEditing
        ? draftResolvedContent
        : (resolutionState?.resolvedContent ?? '');
    const isContentModified = resolutionState
        ? displayedResolvedContent !== resolutionState.originalContent
        : false;

    const handleChoiceClick = (choice: ResolutionChoice) => {
        const content = getContentForChoice(choice);
        onSelectChoice(conflictIndex, choice, content);
    };

    const handleUndoResolution = () => {
        if (isEditing || isContentModified) {
            setShowUndoWarning(true);
            return;
        }
        onClearChoice?.(conflictIndex);
    };

    const confirmUndoResolution = () => {
        setShowUndoWarning(false);
        onClearChoice?.(conflictIndex);
    };

    const cancelUndoResolution = () => {
        setShowUndoWarning(false);
    };

    // Handle content editing in the resolved editor
    const handleContentChange = (value: string) => {
        draftResolvedContentRef.current = value;
        setDraftResolvedContent(value);
    };

    // Leaving the editor autosaves the draft, unless focus moved to a control that
    // manages the edit session itself (marked with data-editing-allow).
    const handleEditorBlur = (event: { relatedTarget: EventTarget | null }) => {
        if (suppressBlurEditGuardRef.current) {
            suppressBlurEditGuardRef.current = false;
            return;
        }
        const relatedTarget = event.relatedTarget as HTMLElement | null;
        if (relatedTarget?.closest('[data-editing-allow="true"]')) return;
        onCommitContent(conflictIndex, draftResolvedContentRef.current);
        onStopEditing(conflictIndex);
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 1000);
    };

    const handleSaveEdits = () => {
        if (!resolutionState) return;
        suppressBlurEditGuardRef.current = true;
        onCommitContent(conflictIndex, draftResolvedContentRef.current);
        onStopEditing(conflictIndex);

        // Trigger save animation
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 1000);

        // Clear the blur-suppress flag after editor unmounts.
        // The blur event may have already fired (hitting the relatedTarget guard),
        // so we can't rely on onBlur to clear the flag. Use a microtask to ensure
        // the flag is reset after the editor unmounts.
        Promise.resolve().then(() => {
            suppressBlurEditGuardRef.current = false;
        });
    };

    const undoWarningModal = showUndoWarning ? (
        <WarningModal
            title="Discard edits and undo resolution?"
            message="You have edited the resolved content. Undoing this resolution will discard those changes."
            confirmLabel="Undo resolution"
            onConfirm={confirmUndoResolution}
            onCancel={cancelUndoResolution}
            testId="undo-warning-modal"
        />
    ) : null;

    const base = row.baseCellIndex;
    const currentDelta = (isReordered && base !== undefined && row.currentCellIndex !== undefined)
        ? row.currentCellIndex - base : undefined;
    const incomingDelta = (isReordered && base !== undefined && row.incomingCellIndex !== undefined)
        ? row.incomingCellIndex - base : undefined;
    const reorderIndicator = isReordered ? (
        <div className="reorder-indicator-bar" data-testid="reorder-indicator">
            {currentDelta !== undefined && currentDelta !== 0 && (
                <span className="reorder-delta current-delta">
                    {currentDelta > 0 ? '↓' : '↑'} {Math.abs(currentDelta)}
                </span>
            )}
            {incomingDelta !== undefined && incomingDelta !== 0 && (
                <span className="reorder-delta incoming-delta">
                    {incomingDelta > 0 ? '↓' : '↑'} {Math.abs(incomingDelta)}
                </span>
            )}
        </div>
    ) : null;
    const canUnmatch = isConflict
        && isReordered
        && !row.isUserUnmatched
        && row.conflictIndex !== undefined
        && !!row.currentCell && !!row.incomingCell;

    // Lightweight when far from viewport AND not actively editing.
    const isLightweight = !isNearViewport && !isEditing;

    // For identical rows, show a unified single cell
    if (!isConflict) {
        const cell = selectNonConflictMergedCell(row.baseCell, row.currentCell, row.incomingCell);
        // Compute raw source for testing - this is what will become the cell source in the resolved notebook
        const rawSource = cell ? normalizeCellSource(cell.source) : '';
        const cellType = cell?.cell_type || 'code';
        const identicalClasses = [
            'merge-row',
            'identical-row',
            isReordered && 'reordered-row'
        ].filter(Boolean).join(' ');
        return (
            <div
                ref={rowRef}
                className={identicalClasses}
                data-testid={testId}
                data-raw-source={rawSource}
                data-cell-type={cellType}
                data-cell={encodeURIComponent(cell ? JSON.stringify(cell) : '')}
            >
                {reorderIndicator}
                <div className="readable-row-wrapper">
                    <CellContent
                        cell={cell}
                        cellIndex={row.currentCellIndex ?? row.incomingCellIndex ?? row.baseCellIndex}
                        side="current"
                        isConflict={false}
                        languageExtensions={languageExtensions}
                        theme={theme}
                        showOutputs={showOutputs}
                        showCellHeaders={showCellHeaders}
                        isLightweight={isLightweight}
                    />
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
    // If resolved, show single-column collapsed view with undo button
    if (resolutionState && conflictIndex >= 0) {
        if (resolutionState.choice === 'delete') {
            return (
                <div ref={rowRef} className={rowClasses} data-testid={testId}>
                    <div className="resolved-row-wrapper">
                        <div className="resolved-row-chrome resolved-row-chrome--delete">
                            <div className="resolved-cell resolved-deleted">
                                <div className="resolved-header">
                                    <div className="resolved-header-lead">
                                        <span className="resolved-label">✓ Resolved</span>
                                        <span className="resolved-base">
                                            Based on: <strong>delete</strong>
                                        </span>
                                    </div>
                                    <div className="resolved-header-actions" data-testid="resolved-action-bar">
                                        <button
                                            className="btn btn-secondary"
                                            onClick={handleUndoResolution}
                                            title="Undo resolution and show the conflict again"
                                        >
                                            Undo resolution
                                        </button>
                                    </div>
                                </div>
                                <p className="resolved-deleted-message">This cell will be deleted.</p>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <div ref={rowRef} className={rowClasses} data-testid={testId}>
                <div className="resolved-row-wrapper">
                    <div className={`resolved-row-chrome${justSaved ? ' just-saved' : ''}`}>
                        <div
                            className={`resolved-cell ${resolvedCellType}-cell`}
                            data-raw-source={displayedResolvedContent}
                        >
                            <div className="resolved-header">
                                <div className="resolved-header-lead">
                                    <span className="resolved-label">✓ Resolved</span>
                                    <span className="resolved-base">
                                        Based on: <strong>{resolutionState.choice}</strong>
                                        {isContentModified && <span className="modified-badge">(edited)</span>}
                                    </span>
                                </div>
                            <div className="resolved-header-actions" data-testid="resolved-action-bar">
                                {isEditing && (
                                    <button
                                        className="btn btn-resolved-save"
                                        onClick={handleSaveEdits}
                                        data-editing-allow="true"
                                        data-testid="save-edits-button"
                                    >
                                        Save edits
                                    </button>
                                )}
                                {!isEditing && (
                                    <button
                                        className="btn btn-resolved-edit"
                                        onClick={() => onStartEditing(conflictIndex)}
                                        data-testid="edit-button"
                                    >
                                        Edit
                                    </button>
                                )}
                                <button
                                    className="btn btn-resolved-undo"
                                    onMouseDown={e => {
                                        if (isEditing) e.preventDefault();
                                    }}
                                    onClick={handleUndoResolution}
                                    title="Undo resolution and show the conflict again"
                                >
                                    Undo resolution
                                </button>
                            </div>
                            </div>
                            {isEditing ? (
                                <div data-editing-allow="true">
                                    <CodeMirror
                                        value={draftResolvedContent}
                                        onChange={handleContentChange}
                                        extensions={editorExtensions}
                                        placeholder="Enter cell content..."
                                        className="resolved-content-input"
                                        basicSetup={{ lineNumbers: false, foldGutter: false }}
                                        theme={resolvedEditorTheme}
                                        autoFocus={true}
                                        onBlur={handleEditorBlur}
                                    />
                                </div>
                            ) : resolvedCellType === 'markdown' ? (
                                <div className="resolved-content-static">
                                    <MarkdownContent
                                        source={displayedResolvedContent}
                                        isLightweight={isLightweight}
                                    />
                                </div>
                            ) : (
                                <CellSource
                                    source={displayedResolvedContent}
                                    langExtensions={languageExtensions}
                                    theme={theme}
                                    className="resolved-content-static"
                                    isLightweight={isLightweight}
                                />
                            )}
                        </div>
                    </div>
                </div>

                {undoWarningModal}
            </div>
        );
    }

    return (
        <div ref={rowRef} className={rowClasses} data-testid={testId}>
            {/* Top action bar - always present for conflicts */}
            <div className="conflict-action-bar" data-testid="conflict-action-bar">
                <div className="conflict-action-left">
                    {!row.isUserUnmatched && reorderIndicator}
                </div>
                <div className="conflict-action-right">
                    <button
                        title="Resolve by omitting this cell from the merged notebook"
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

            {undoWarningModal}

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
                                isLightweight={isLightweight}
                            />
                        ) : (
                            <div
                                className="cell-placeholder cell-deleted"
                                title={row.isUnmatched ? "This branch has no cell here — the cell exists only in the other column(s)" : undefined}
                            >
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
                            isLightweight={isLightweight}
                        />
                    ) : (
                        <div
                            className="cell-placeholder cell-deleted"
                            title={row.isUnmatched ? "This branch has no cell here — the cell exists only in the other column(s)" : undefined}
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
                            diffMode="conflict"
                            languageExtensions={languageExtensions}
                            theme={theme}
                            showOutputs={showOutputs}
                            showCellHeaders={showCellHeaders}
                            isLightweight={isLightweight}
                        />
                    ) : (
                        <div
                            className="cell-placeholder cell-deleted"
                            title={row.isUnmatched ? "This branch has no cell here — the cell exists only in the other column(s)" : undefined}
                        >
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

        </div>
    );
}
export const MergeRow = React.memo(MergeRowInner);
