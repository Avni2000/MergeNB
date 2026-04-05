/**
 * @file ConflictResolver.tsx
 * @description Main React component for the conflict resolution UI.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useVirtualizer, defaultRangeExtractor, type Range } from '@tanstack/react-virtual';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { useStore } from 'zustand';
import { normalizeCellSource, selectNonConflictMergedCell } from '../../../../core/src';
import type {
    UnifiedConflictData,
    MergeRow as MergeRowType,
    NotebookCell,
} from '../types';
import { MergeRow } from './MergeRow';
import { CellContent } from './CellContent';
import {
    createResolverStore,
    type ResolutionState,
    type TakeAllChoice,
} from '../store/resolverStore';
import { buildMergeRowsFromSemantic } from '../utils/mergeRowBuilder';
import * as logger from '../../../../core/src';

interface ConflictResolverProps {
    conflict: UnifiedConflictData;
    onResolve: (
        markAsResolved: boolean,
        renumberExecutionCounts: boolean,
        resolvedRows: import('../types').ResolvedRow[],
        semanticChoice?: 'base' | 'current' | 'incoming'
    ) => void;
    onCancel: () => void;
}

function selectPreviewCell(row: MergeRowType): NotebookCell | undefined {
    return row.currentCell ?? row.incomingCell ?? row.baseCell;
}

export function ConflictResolver({
    conflict,
    onResolve,
    onCancel,
}: ConflictResolverProps): React.ReactElement {
    const initialRows = useMemo(() => (
        conflict.semanticConflict
            ? buildMergeRowsFromSemantic(conflict.semanticConflict, conflict.autoResolveResult?.resolvedNotebook)
            : []
    ), [conflict.semanticConflict, conflict.autoResolveResult?.resolvedNotebook]);

    // Recreate resolver state only when the conflict instance key changes.
    // This avoids resets caused by object identity churn on re-sent payloads.
    const resolverStore = useMemo(
        () => createResolverStore(initialRows),
        [conflict.conflictKey]
    );
    const [historyOpen, setHistoryOpen] = useState(false);
    const [autoResolveBannerOpen, setAutoResolveBannerOpen] = useState(false);
    const [previewOpen, setPreviewOpen] = useState(false);
    const historyMenuRef = useRef<HTMLDivElement>(null);
    const mainContentRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);
    const dragRenderedIndicesRef = useRef<number[] | null>(null);
    const pendingMeasureNodesRef = useRef<Set<HTMLElement>>(new Set());

    const choices = useStore(resolverStore, state => state.choices);
    const rows = useStore(resolverStore, state => state.rows);
    const markAsResolved = useStore(resolverStore, state => state.markAsResolved);
    const renumberExecutionCounts = useStore(resolverStore, state => state.renumberExecutionCounts);
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
                logger.warn('[MergeNB] Failed to load CodeMirror language support:', err);
            });

        return () => {
            cancelled = true;
        };
    }, [kernelLanguage]);

    const conflictRows = useMemo(() => rows.filter(r => r.type === 'conflict'), [rows]);
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

    useEffect(() => {
        const el = mainContentRef.current;
        let prevScrollTop = el?.scrollTop ?? 0;
        let correcting = false;

        const onDown = (event: MouseEvent) => {
            if (event.button !== 0) return;
            const target = event.target instanceof Element ? event.target : null;
            if (!target?.closest?.(
                '.cell-content, .cell-output-host, .cell-output-fallback, .resolved-content-input, .markdown-content'
            )) return;
            isDraggingRef.current = true;
            dragRenderedIndicesRef.current = null;
            prevScrollTop = el?.scrollTop ?? 0;
        };
        const onUp = () => {
            isDraggingRef.current = false;
            prevScrollTop = el?.scrollTop ?? 0;

            // If the user completed a drag-selection, keep the accumulated
            // row indices pinned so the browser selection survives scrolling.
            const sel = window.getSelection();
            const hasSelection = sel && !sel.isCollapsed
                && el?.contains(sel.anchorNode ?? null);
            if (!hasSelection) {
                dragRenderedIndicesRef.current = null;
            }

            const pending = pendingMeasureNodesRef.current;
            if (pending.size > 0) {
                for (const node of pending) {
                    if (node.isConnected) {
                        virtualizerRef.current.measureElement(node);
                    }
                }
                pending.clear();
            }
        };

        const onSelectionChange = () => {
            if (isDraggingRef.current) return;
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !el?.contains(sel.anchorNode ?? null)) {
                dragRenderedIndicesRef.current = null;
            }
        };

        const onScroll = () => {
            if (!el || correcting) {
                prevScrollTop = el?.scrollTop ?? 0;
                return;
            }
            if (!isDraggingRef.current) {
                prevScrollTop = el.scrollTop;
                return;
            }
            const delta = el.scrollTop - prevScrollTop;
            const MAX_DELTA = 200;
            if (Math.abs(delta) > MAX_DELTA) {
                correcting = true;
                el.scrollTop = prevScrollTop + Math.sign(delta) * MAX_DELTA;
                correcting = false;
                prevScrollTop = el.scrollTop;
            } else {
                prevScrollTop = el.scrollTop;
            }
        };

        window.addEventListener('mousedown', onDown);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onUp);
        document.addEventListener('selectionchange', onSelectionChange);
        el?.addEventListener('scroll', onScroll);
        return () => {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('blur', onUp);
            document.removeEventListener('selectionchange', onSelectionChange);
            el?.removeEventListener('scroll', onScroll);
        };
    }, []);

    const handleResolve = () => {
        const {
            rows: liveRows,
            choices: liveChoices,
            takeAllChoice: liveTakeAllChoice,
            markAsResolved: liveMarkAsResolved,
            renumberExecutionCounts: liveRenumberExecutionCounts,
        } = resolverStore.getState();
        // Build resolved rows - this is the source of truth for reconstruction
        const resolvedRows: import('../types').ResolvedRow[] = liveRows.map((row) => {
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

    // During drag-select, never remove rows from the DOM — only accumulate.
    // The browser anchors its selection to specific DOM nodes; if the
    // virtualizer removes the selection-start node (scrolled out of the
    // overscan window), the browser resets the selection and scroll position.
    const dragSafeRangeExtractor = useCallback((range: Range) => {
        const normal = defaultRangeExtractor(range);
        const pinned = dragRenderedIndicesRef.current;

        if (!isDraggingRef.current && !pinned) {
            return normal;
        }

        if (!pinned) {
            dragRenderedIndicesRef.current = [...normal];
            return normal;
        }

        const merged = new Set([...pinned, ...normal]);
        const result = Array.from(merged).sort((a, b) => a - b);
        if (isDraggingRef.current) {
            dragRenderedIndicesRef.current = result;
        }
        return result;
    }, []);

    const noVirtualize = useMemo(() => {
        if (typeof window === 'undefined') return false;
        return new URLSearchParams(window.location.search).has('noVirtualize');
    }, []);

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement,
        estimateSize: estimateRowSize,
        overscan: noVirtualize ? Infinity : 6,
        rangeExtractor: dragSafeRangeExtractor,
    });

    const virtualRows = rowVirtualizer.getVirtualItems();
    const virtualizerRef = useRef(rowVirtualizer);
    virtualizerRef.current = rowVirtualizer;
    const measureRef = useCallback((node: HTMLElement | null) => {
        if (!node) return;
        if (isDraggingRef.current) {
            pendingMeasureNodesRef.current.add(node);
            return;
        }
        pendingMeasureNodesRef.current.delete(node);
        virtualizerRef.current.measureElement(node);
    }, []);
    const totalSize = rowVirtualizer.getTotalSize();

    return (
        <div className="app-container jp-Notebook">
            <header className="header">
                <div className="header-toolbar">
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
                        <button
                            className={`btn btn-secondary${previewOpen ? ' btn-preview-active' : ''}`}
                            onClick={() => setPreviewOpen(p => !p)}
                            title="Preview the resolved notebook as a single column"
                        >
                            {previewOpen ? 'Back to Merge' : 'Preview'}
                        </button>
                        <button
                            className="btn btn-primary"
                            onClick={handleResolve}
                            disabled={!allResolved}
                        >
                            Apply Resolution
                        </button>
                    </div>
                </div>
                {!previewOpen && (
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
                )}
            </header>

            {previewOpen ? (
                <main className="main-content preview-content" ref={mainContentRef}>
                    <div className="preview-column">
                        {rows.map((row, i) => {
                            const conflictIdx = row.conflictIndex ?? -1;
                            const resolutionState = conflictIdx >= 0 ? choices.get(conflictIdx) : undefined;
                            const isConflict = row.type === 'conflict';
                            const isResolved = isConflict && !!resolutionState;
                            const isUnresolved = isConflict && !resolutionState;

                            if (isResolved && resolutionState!.choice === 'delete') {
                                return null;
                            }

                            const previewCell = isResolved
                                ? undefined
                                : isConflict
                                    ? selectPreviewCell(row)
                                    : selectNonConflictMergedCell(row.baseCell, row.currentCell, row.incomingCell);

                            const previewSource = isResolved
                                ? resolutionState!.resolvedContent
                                : previewCell
                                    ? normalizeCellSource(previewCell.source)
                                    : '';

                            const cellType = isResolved
                                ? (resolutionState!.choice === 'current' ? row.currentCell?.cell_type
                                    : resolutionState!.choice === 'incoming' ? row.incomingCell?.cell_type
                                    : resolutionState!.choice === 'base' ? row.baseCell?.cell_type
                                    : 'code')
                                : (previewCell?.cell_type ?? 'code');

                            if (isUnresolved) {
                                return (
                                    <div key={i} className="preview-cell preview-cell-unresolved">
                                        <div className="preview-unresolved-placeholder">
                                            Unresolved conflict
                                        </div>
                                    </div>
                                );
                            }

                            return (
                                <div
                                    key={i}
                                    className="preview-cell"
                                >
                                    <CellContent
                                        cell={isResolved
                                            ? { ...selectPreviewCell(row)!, source: previewSource, cell_type: cellType } as NotebookCell
                                            : previewCell}
                                        cellIndex={row.currentCellIndex ?? row.incomingCellIndex ?? row.baseCellIndex}
                                        side="current"
                                        isConflict={false}
                                        languageExtensions={languageExtensions}
                                        theme={conflict.theme ?? 'light'}
                                        showOutputs={true}
                                        showCellHeaders={showCellHeaders}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </main>
            ) : (
                <main className="main-content" ref={mainContentRef}>
                    {conflict.autoResolveResult && conflict.autoResolveResult.autoResolvedCount > 0 && (
                        <div className="auto-resolve-banner">
                            <button
                                className="auto-resolve-summary"
                                onClick={() => setAutoResolveBannerOpen(o => !o)}
                                aria-expanded={autoResolveBannerOpen}
                            >
                                <span className="icon">✓</span>
                                <span className="text">
                                    Auto-resolved {conflict.autoResolveResult.autoResolvedCount} conflict{conflict.autoResolveResult.autoResolvedCount !== 1 ? 's' : ''}
                                </span>
                                <span className="chevron">{autoResolveBannerOpen ? '▲' : '▼'}</span>
                            </button>
                            {autoResolveBannerOpen && conflict.autoResolveResult.autoResolvedDescriptions.length > 0 && (
                                <ul className="auto-resolve-list">
                                    {conflict.autoResolveResult.autoResolvedDescriptions.map((desc, i) => (
                                        <li key={i}>{desc}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    <div
                        style={{
                            height: totalSize,
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
                                    // tanstack uses this attribute to associate DOM measurements
                                    //  with the correct virtualized item
                                    data-index={virtualRow.index}
                                    ref={measureRef}
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
            )}
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
