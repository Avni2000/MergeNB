/**
 * @file ConflictResolver.tsx
 * @description Main React component for the conflict resolution UI.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { useStore } from 'zustand';
import { sortByPosition } from '../../positionUtils';
import { normalizeCellSource } from '../../notebookUtils';
import type {
    UnifiedConflictData,
    MergeRow as MergeRowType,
    NotebookSemanticConflict,
    CellMapping,
    SemanticConflict,
    NotebookCell,
} from './types';
import { MergeRow } from './MergeRow';
import {
    createResolverStore,
    type ResolutionState,
    type TakeAllChoice,
} from './resolverStore';
import { computeReorderedRowIndexSet } from './reorderUtils';

interface ConflictResolverProps {
    conflict: UnifiedConflictData;
    onResolve: (
        markAsResolved: boolean,
        renumberExecutionCounts: boolean,
        resolvedRows: import('./types').ResolvedRow[],
        semanticChoice?: 'base' | 'current' | 'incoming'
    ) => void;
    onCancel: () => void;
}

export function ConflictResolver({
    conflict,
    onResolve,
    onCancel,
}: ConflictResolverProps): React.ReactElement {
    const initialRows = useMemo(() => (
        conflict.type === 'semantic' && conflict.semanticConflict
            ? buildMergeRowsFromSemantic(conflict.semanticConflict, conflict.autoResolveResult?.resolvedNotebook)
            : []
    ), [conflict.type, conflict.semanticConflict, conflict.autoResolveResult?.resolvedNotebook]);

    // Recreate resolver state only when the conflict instance key changes.
    // This avoids resets caused by object identity churn on re-sent payloads.
    const resolverStoreKey = conflict.conflictKey;
    const resolverStore = useMemo(
        () => createResolverStore(initialRows),
        [resolverStoreKey]
    );
    const [historyOpen, setHistoryOpen] = useState(false);
    const historyMenuRef = useRef<HTMLDivElement>(null);
    const mainContentRef = useRef<HTMLDivElement>(null);

    const choices = useStore(resolverStore, state => state.choices);
    const rows = useStore(resolverStore, state => state.rows);
    const markAsResolved = useStore(resolverStore, state => state.markAsResolved);
    const renumberExecutionCounts = useStore(resolverStore, state => state.renumberExecutionCounts);
    const takeAllChoice = useStore(resolverStore, state => state.takeAllChoice);
    const history = useStore(resolverStore, state => state.history);

    const handleSelectChoice = useStore(resolverStore, state => state.selectChoice);
    const handleCommitContent = useStore(resolverStore, state => state.commitContent);
    const handleAcceptAll = useStore(resolverStore, state => state.acceptAll);
    const handleToggleRenumberExecutionCounts = useStore(resolverStore, state => state.setRenumberExecutionCounts);
    const handleToggleMarkAsResolved = useStore(resolverStore, state => state.setMarkAsResolved);
    const handleJumpToHistory = useStore(resolverStore, state => state.jumpToHistory);
    const handleUnmatchRow = useStore(resolverStore, state => state.unmatchRow);
    const handleRematchRows = useStore(resolverStore, state => state.rematchRows);
    const handleUndo = useStore(resolverStore, state => state.undo);
    const handleRedo = useStore(resolverStore, state => state.redo);

    useEffect(() => {
        setHistoryOpen(false);
    }, [resolverStore]);

    const isEditableTarget = useCallback((target: EventTarget | null): boolean => {
        if (!target || !(target as HTMLElement).closest) return false;
        const element = target as HTMLElement;
        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return true;
        if (element.isContentEditable) return true;
        return Boolean(element.closest('[contenteditable="true"]'));
    }, []);

    const kernelLanguage = useMemo(() => {
        const meta = conflict.semanticConflict?.base?.metadata
            ?? conflict.semanticConflict?.current?.metadata
            ?? conflict.semanticConflict?.incoming?.metadata;
        return meta?.kernelspec?.language ?? meta?.language_info?.name ?? 'python';
    }, [conflict.semanticConflict]);
    const [languageSupport, setLanguageSupport] = useState<any | null>(() => {
        const desc = LanguageDescription.matchLanguageName(languages, kernelLanguage, true);
        return desc?.support ?? null;
    });
    const languageExtensions = useMemo(
        () => (languageSupport ? [languageSupport] : []),
        [languageSupport]
    );

    useEffect(() => {
        const desc = LanguageDescription.matchLanguageName(languages, kernelLanguage, true);
        if (!desc) {
            setLanguageSupport(null);
            return;
        }
        if (desc.support) {
            setLanguageSupport(desc.support);
            return;
        }

        let cancelled = false;
        // Avoid showing stale highlighting from previous language while loading.
        setLanguageSupport(null);

        desc.load()
            .then(support => {
                if (cancelled) return;
                setLanguageSupport(support);
            })
            .catch(err => {
                if (cancelled) return;
                setLanguageSupport(null);
                console.warn('[MergeNB] Failed to load CodeMirror language support:', err);
            });

        return () => {
            cancelled = true;
        };
    }, [kernelLanguage]);

    const conflictRows = useMemo(() => rows.filter(r => r.type === 'conflict'), [rows]);
    const reorderedRowIndices = useMemo(() => computeReorderedRowIndexSet(rows), [rows]);
    const totalConflicts = conflictRows.length;
    const resolvedCount = choices.size;
    const allResolved = resolvedCount === totalConflicts;
    const canUndo = history.index > 0;
    const canRedo = history.index < history.entries.length - 1;
    const enableUndoRedoHotkeys = conflict.enableUndoRedoHotkeys ?? true;
    const showBaseColumn = conflict.showBaseColumn ?? false;
    const showCellHeaders = conflict.showCellHeaders ?? false;
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
        const {
            rows: liveRows,
            choices: liveChoices,
            takeAllChoice: liveTakeAllChoice,
            markAsResolved: liveMarkAsResolved,
            renumberExecutionCounts: liveRenumberExecutionCounts,
        } = resolverStore.getState();
        // Build resolved rows - this is the source of truth for reconstruction
        const resolvedRows: import('./types').ResolvedRow[] = liveRows.map((row) => {
            const conflictIdx = row.conflictIndex ?? -1;
            const resolutionState = conflictIdx >= 0 ? liveChoices.get(conflictIdx) : undefined;

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

        const semanticChoice = (
            liveTakeAllChoice &&
            isTakeAllChoiceConsistent(liveRows, liveChoices, liveTakeAllChoice, true)
        )
            ? liveTakeAllChoice
            : inferTakeAllChoice(liveRows, liveChoices);
        onResolve(liveMarkAsResolved, liveRenumberExecutionCounts, resolvedRows, semanticChoice);
    };

    const fileName = conflict.filePath.split('/').pop() || 'notebook.ipynb';
    const getScrollElement = useCallback(() => mainContentRef.current, []);
    // Precompute per-row height estimates once per rows change so estimateSize is O(1).
    // This overestimates rather than underestimates — items are placed too far
    // apart initially (harmless gaps) rather than overlapping (visible flicker).
    const estimatedRowHeights = useMemo(() => {
        return rows.map(row => {
            const cells = [row.currentCell, row.incomingCell, row.baseCell].filter(Boolean);
            const maxLines = Math.max(
                ...cells.map(c => normalizeCellSource(c!.source).split('\n').length),
                3
            );
            // 22px per line + 80px overhead (borders, headers, padding)
            return Math.max(120, maxLines * 22 + 80);
        });
    }, [rows]);
    const estimateRowSize = useCallback((index: number) => {
        return estimatedRowHeights[index] ?? 200;
    }, [estimatedRowHeights]);
    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement,
        estimateSize: estimateRowSize,
        overscan: 6,
    });
    const virtualRows = rowVirtualizer.getVirtualItems();

    // Defer measureElement by one animation frame so CodeMirror's useEffect
    // has time to create the EditorView before TanStack samples the DOM height.
    // Without this, the initial measurement captures the empty CodeMirror shell
    // (near-zero height), causing subsequent rows to overlap ("flicker").
    const virtualizerRef = useRef(rowVirtualizer);
    virtualizerRef.current = rowVirtualizer;
    const deferredMeasureRef = useCallback((node: HTMLElement | null) => {
        if (!node) return;
        requestAnimationFrame(() => {
            if (node.isConnected) {
                virtualizerRef.current.measureElement(node);
            }
        });
    }, []);
    // Keep the container height monotonically non-decreasing so the scrollbar
    // doesn't jump when TanStack refines its measurements.
    const totalSize = rowVirtualizer.getTotalSize();
    const stableTotalSizeRef = useRef(0);
    stableTotalSizeRef.current = Math.max(stableTotalSizeRef.current, totalSize);

    return (
        <div className="app-container">
            <header className="header">
                <div className="header-left">
                    <div className="logo-icon">
                        <div className="logo-card logo-card-left"></div>
                        <div className="logo-card logo-card-right"></div>
                    </div>
                    <div className="header-title">
                        <span className="header-title-merge">Merge</span>
                        <span className="header-title-nb">NB</span>
                    </div>
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
                        {showBaseColumn && (
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
                        )}
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
                        Mark as resolved (stage in Git)
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

                <div className={`column-labels${showBaseColumn ? '' : ' two-column'}`}>
                    {showBaseColumn && (
                        <div className="column-label base">
                            Base
                        </div>
                    )}
                    <div className="column-label current">
                        Current {conflict.currentBranch ? `(${conflict.currentBranch})` : ''}
                    </div>
                    <div className="column-label incoming">
                        Incoming {conflict.incomingBranch ? `(${conflict.incomingBranch})` : ''}
                    </div>
                </div>

                <div
                    style={{
                        height: stableTotalSizeRef.current,
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
                                ref={deferredMeasureRef}
                                className="virtual-row"
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    transform: `translateY(${virtualRow.start}px)`,
                                }}
                            >
                                <MergeRow
                                    row={row}
                                    rowIndex={i}
                                    isReordered={reorderedRowIndices.has(i)}
                                    conflictIndex={conflictIdx}
                                    notebookPath={conflict.filePath}
                                    languageExtensions={languageExtensions}
                                    theme={conflict.theme ?? 'light'}
                                    resolutionState={resolutionState}
                                    onSelectChoice={handleSelectChoice}
                                    onCommitContent={handleCommitContent}
                                    onUnmatchRow={handleUnmatchRow}
                                    onRematchRows={handleRematchRows}
                                    showOutputs={!conflict.hideNonConflictOutputs || row.type === 'conflict'}
                                    showBaseColumn={showBaseColumn}
                                    showCellHeaders={showCellHeaders}
                                    data-testid={conflictIdx >= 0 ? `conflict-row-${conflictIdx}` : `row-${i}`}
                                />
                            </div>
                        );
                    })}
                </div>
            </main>
        </div>
    );
}

function isTakeAllChoiceConsistent(
    rows: MergeRowType[],
    choices: Map<number, ResolutionState>,
    side: TakeAllChoice,
    allowSingleConflict: boolean
): boolean {
    const conflictRows = rows.filter((row): row is MergeRowType & { conflictIndex: number } =>
        row.type === 'conflict' && row.conflictIndex !== undefined
    );

    if (conflictRows.length === 0) {
        return false;
    }

    // Without explicit "Take All" intent, single-conflict notebooks can produce
    // false positives from ordinary per-row selections.
    if (!allowSingleConflict && conflictRows.length <= 1) {
        return false;
    }

    let sawSideChoice = false;
    for (const row of conflictRows) {
        const choice = choices.get(row.conflictIndex)?.choice;
        if (!choice) {
            return false;
        }
        const sideCell = getCellForSide(row, side);
        if (choice === side) {
            if (!sideCell) return false;
            sawSideChoice = true;
            continue;
        }
        if (choice === 'delete') {
            if (sideCell) return false;
            continue;
        }
        return false;
    }

    return sawSideChoice;
}

function inferTakeAllChoice(
    rows: MergeRowType[],
    choices: Map<number, ResolutionState>
): TakeAllChoice | undefined {
    const candidateSides: TakeAllChoice[] = ['base', 'current', 'incoming'];
    for (const side of candidateSides) {
        if (isTakeAllChoiceConsistent(rows, choices, side, false)) {
            return side;
        }
    }

    return undefined;
}

function getCellForSide(
    row: MergeRowType,
    side: TakeAllChoice
): NotebookCell | undefined {
    if (side === 'base') return row.baseCell;
    if (side === 'current') return row.currentCell;
    return row.incomingCell;
}

/**
 * Build merge rows from semantic conflict data.
 */
function buildMergeRowsFromSemantic(
    conflict: NotebookSemanticConflict,
    currentNotebookOverride?: import('../../types').Notebook
): MergeRowType[] {
    const rows: MergeRowType[] = [];
    const conflictMap = new Map<string, { conflict: SemanticConflict; index: number }>();
    const conflictPriority: Record<SemanticConflict['type'], number> = {
        'cell-modified': 0,
        'cell-added': 1,
        'cell-deleted': 2,
        'cell-reordered': 3,
        'metadata-changed': 4,
        'outputs-changed': 5,
        'execution-count-changed': 6
    };

    conflict.semanticConflicts.forEach((c, i) => {
        const key = `${c.baseCellIndex ?? 'x'}-${c.currentCellIndex ?? 'x'}-${c.incomingCellIndex ?? 'x'}`;
        const existing = conflictMap.get(key);
        const nextRank = conflictPriority[c.type] ?? Number.MAX_SAFE_INTEGER;
        const existingRank = existing ? conflictPriority[existing.conflict.type] ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;

        if (!existing || nextRank < existingRank) {
            conflictMap.set(key, { conflict: c, index: i });
        }
    });

    for (const mapping of conflict.cellMappings) {
        const baseCell = mapping.baseIndex !== undefined && conflict.base
            ? conflict.base.cells[mapping.baseIndex] : undefined;
        const currentSource = currentNotebookOverride || conflict.current;
        const currentCell = mapping.currentIndex !== undefined && currentSource
            ? currentSource.cells[mapping.currentIndex] : undefined;
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
