/**
 * @file ConflictResolver.tsx
 * @description Main React component for the conflict resolution UI.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { useStore } from 'zustand';
import { createPortal } from 'react-dom';
import type {
    UnifiedConflictData,
    MergeRow as MergeRowType,
} from '../types';
import { MergeRow } from './MergeRow';
import {
    createResolverStore,
    getCellForSide,
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
    const [destructiveActionWarning, setDestructiveActionWarning] = useState<{
        title: string;
        message: string;
        confirmLabel: string;
    } | null>(null);
    const historyMenuRef = useRef<HTMLDivElement>(null);
    const mainContentRef = useRef<HTMLDivElement>(null);
    const pendingDestructiveActionRef = useRef<(() => void) | null>(null);
    const suppressApplyResolutionClickRef = useRef(false);
    const suppressGuardedClickRef = useRef(false);

    const choices = useStore(resolverStore, state => state.choices);
    const editingConflicts = useStore(resolverStore, state => state.editingConflicts);
    const rows = useStore(resolverStore, state => state.rows);
    const markAsResolved = useStore(resolverStore, state => state.markAsResolved);
    const renumberExecutionCounts = useStore(resolverStore, state => state.renumberExecutionCounts);
    const history = useStore(resolverStore, state => state.history);

    const handleSelectChoice = useStore(resolverStore, state => state.selectChoice);
    const handleStartEditing = useStore(resolverStore, state => state.startEditing);
    const handleStopEditing = useStore(resolverStore, state => state.stopEditing);
    const handleCommitContent = useStore(resolverStore, state => state.commitContent);
    const acceptAll = useStore(resolverStore, state => state.acceptAll);
    const setRenumberExecutionCounts = useStore(resolverStore, state => state.setRenumberExecutionCounts);
    const setMarkAsResolved = useStore(resolverStore, state => state.setMarkAsResolved);
    const jumpToHistory = useStore(resolverStore, state => state.jumpToHistory);
    const unmatchRow = useStore(resolverStore, state => state.unmatchRow);
    const rematchRows = useStore(resolverStore, state => state.rematchRows);
    const undo = useStore(resolverStore, state => state.undo);
    const redo = useStore(resolverStore, state => state.redo);
    const handleClearChoice = useStore(resolverStore, state => state.clearChoice);

    useEffect(() => {
        setHistoryOpen(false);
    }, [resolverStore]);

    const activeEditingConflictIndex = useMemo(() => {
        const editingIterator = editingConflicts.values();
        const firstEditing = editingIterator.next();
        return firstEditing.done ? null : firstEditing.value;
    }, [editingConflicts]);

    const hasEditedResolvedContent = useMemo(
        () => Array.from(choices.values()).some(choice => choice.resolvedContent !== choice.originalContent),
        [choices]
    );

    const guardEditedResolutions = useCallback(
        (action: () => void) => {
            if (!hasEditedResolvedContent) {
                action();
                return;
            }

            pendingDestructiveActionRef.current = action;
            setDestructiveActionWarning({
                title: 'Discard edited resolutions?',
                message:
                    'This action will discard one or more edited resolved cells from history.',
                confirmLabel: 'Discard edits',
            });
        },
        [hasEditedResolvedContent]
    );

    const dismissDestructiveActionWarning = useCallback(() => {
        pendingDestructiveActionRef.current = null;
        setDestructiveActionWarning(null);
    }, []);

    const confirmDestructiveActionWarning = useCallback(() => {
        const action = pendingDestructiveActionRef.current;
        pendingDestructiveActionRef.current = null;
        setDestructiveActionWarning(null);
        action?.();
    }, []);

    // Wrapped handlers for destructive actions
    const handleUndo = useCallback(() => {
        guardEditedResolutions(() => undo());
    }, [guardEditedResolutions, undo]);

    const handleRedo = useCallback(() => {
        guardEditedResolutions(() => redo());
    }, [guardEditedResolutions, redo]);

    const handleAcceptAll = useCallback((choice: TakeAllChoice) => {
        guardEditedResolutions(() => acceptAll(choice));
    }, [guardEditedResolutions, acceptAll]);

    const handleJumpToHistory = useCallback((index: number) => {
        guardEditedResolutions(() => jumpToHistory(index));
    }, [guardEditedResolutions, jumpToHistory]);

    // Generic mousedown guard for controls that would trigger a blur+autosave race.
    // Call from onMouseDown with event.preventDefault() to keep the editor focused until
    // the user confirms. The click event still fires; the suppress ref discards it.
    const mouseDownGuardActiveEditing = useCallback(
        (event: React.MouseEvent, action: () => void) => {
            if (activeEditingConflictIndex === null) return;
            event.preventDefault();
            suppressGuardedClickRef.current = true;
            pendingDestructiveActionRef.current = action;
            setDestructiveActionWarning({
                title: 'A cell is still being edited',
                message: 'Finish editing first, or proceed using the last saved content.',
                confirmLabel: 'Proceed anyway',
            });
        },
        [activeEditingConflictIndex]
    );

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
    const unresolvedCount = totalConflicts - resolvedCount;

    const handleNextConflict = useCallback(() => {
        const container = mainContentRef.current;
        if (!container) return;

        const allConflictEls = Array.from(
            container.querySelectorAll<HTMLElement>('[data-testid^="conflict-row-"]')
        ).filter(el => {
            const idx = parseInt((el.getAttribute('data-testid') ?? '').replace('conflict-row-', ''), 10);
            return !isNaN(idx) && !choices.has(idx);
        });

        if (allConflictEls.length === 0) return;

        const containerTop = container.getBoundingClientRect().top;
        let currentIdx = -1;
        for (let i = 0; i < allConflictEls.length; i++) {
            if (allConflictEls[i].getBoundingClientRect().top - containerTop <= 40) {
                currentIdx = i;
            }
        }

        const nextIdx = (currentIdx + 1) % allConflictEls.length;
        allConflictEls[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, [choices]);
    const canUndo = history.index > 0;
    const canRedo = history.index < history.entries.length - 1;
    const enableUndoRedoHotkeys = conflict.enableUndoRedoHotkeys ?? true;
    const showBaseColumn = conflict.showBaseColumn ?? false;
    const showCellHeaders = conflict.showCellHeaders ?? false;
    const isMac = useMemo(() => {
        if (typeof navigator === 'undefined') return false;
        const platform = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform;
        if (platform === 'macOS') return true;
        return /Mac|iPod|iPhone|iPad/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);
    }, []);
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
                guardEditedResolutions(() => redo());
            } else {
                guardEditedResolutions(() => undo());
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [enableUndoRedoHotkeys, isEditableTarget, isMac, redo, undo, guardEditedResolutions]);

    const applyResolutionNow = useCallback(() => {
        const {
            rows: liveRows,
            choices: liveChoices,
            takeAllChoice: liveTakeAllChoice,
            markAsResolved: liveMarkAsResolved,
            renumberExecutionCounts: liveRenumberExecutionCounts,
        } = resolverStore.getState();
        // Build resolved rows - this is the source of truth for reconstruction
        const resolvedRows: import('../types').ResolvedRow[] = liveRows.map(
            row => {
                const conflictIdx = row.conflictIndex ?? -1;
                const resolutionState =
                    conflictIdx >= 0 ? liveChoices.get(conflictIdx) : undefined;

                return {
                    baseCell: row.baseCell,
                    currentCell: row.currentCell,
                    incomingCell: row.incomingCell,
                    baseCellIndex: row.baseCellIndex,
                    currentCellIndex: row.currentCellIndex,
                    incomingCellIndex: row.incomingCellIndex,
                    resolution: resolutionState
                        ? {
                            choice: resolutionState.choice,
                            resolvedContent: resolutionState.resolvedContent,
                        }
                        : undefined,
                };
            }
        );

        const semanticChoice =
            liveTakeAllChoice &&
                isTakeAllChoiceConsistent(liveRows, liveChoices, liveTakeAllChoice, true)
                ? liveTakeAllChoice
                : inferTakeAllChoice(liveRows, liveChoices);
        onResolve(
            liveMarkAsResolved,
            liveRenumberExecutionCounts,
            resolvedRows,
            semanticChoice
        );
    }, [onResolve, resolverStore]);

    const handleResolve = useCallback(() => {
        if (suppressApplyResolutionClickRef.current) {
            suppressApplyResolutionClickRef.current = false;
            return;
        }

        if (activeEditingConflictIndex !== null) {
            pendingDestructiveActionRef.current = applyResolutionNow;
            setDestructiveActionWarning({
                title: 'Apply resolution now?',
                message:
                    'A cell is still in edit mode. Apply the current saved content, or keep editing first.',
                confirmLabel: 'Apply resolution (without saving edits)',
            });
            return;
        }

        applyResolutionNow();
    }, [activeEditingConflictIndex, applyResolutionNow]);

    const handleResolveMouseDown = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            if (activeEditingConflictIndex === null) {
                return;
            }

            // Intercept before CodeMirror blur autosaves, so Apply Resolution can still
            // ask whether to keep editing or proceed with the last saved content.
            event.preventDefault();
            suppressApplyResolutionClickRef.current = true;
            pendingDestructiveActionRef.current = applyResolutionNow;
            setDestructiveActionWarning({
                title: 'Apply resolution now?',
                message:
                    'A cell is still in edit mode. Apply the current saved content, or keep editing first.',
                confirmLabel: 'Apply resolution',
            });
        },
        [activeEditingConflictIndex, applyResolutionNow]
    );

    const fileName = conflict.filePath.split('/').pop() || 'notebook.ipynb';

    const destructiveActionModal = destructiveActionWarning
        ? createPortal(
            <div
                className="warning-modal-overlay"
                data-testid="destructive-action-warning-modal"
                data-editing-allow="true"
            >
                <div className="warning-modal">
                    <div className="warning-icon">⚠️</div>
                    <h3>{destructiveActionWarning.title}</h3>
                    <p>{destructiveActionWarning.message}</p>
                    <div className="warning-actions">
                        <button
                            className="btn-cancel"
                            onClick={dismissDestructiveActionWarning}
                        >
                            Keep my edits
                        </button>
                        <button
                            className="btn-confirm"
                            onClick={confirmDestructiveActionWarning}
                            data-testid="destructive-action-warning-confirm"
                        >
                            {destructiveActionWarning.confirmLabel}
                        </button>
                    </div>
                </div>
            </div>,
            document.body
        )
        : null;

    return (
        <div className="app-container jp-Notebook">
            {destructiveActionModal}
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
                        <button
                            className="btn btn-secondary"
                            onClick={handleNextConflict}
                            disabled={unresolvedCount === 0}
                            title={unresolvedCount === 0 ? 'All conflicts resolved' : 'Scroll to next unresolved conflict'}
                        >
                            Next Conflict &#8595;
                        </button>
                        <div className="header-group">
                                <button
                                    className="btn btn-secondary"
                                    onMouseDown={e => mouseDownGuardActiveEditing(e, handleUndo)}
                                    onClick={() => {
                                        if (suppressGuardedClickRef.current) { suppressGuardedClickRef.current = false; return; }
                                        handleUndo();
                                    }}
                                    disabled={!canUndo}
                                    data-testid="history-undo"
                                    title={`Undo (${undoShortcutLabel})`}
                            >
                                Undo
                            </button>
                                <button
                                    className="btn btn-secondary"
                                    onMouseDown={e => mouseDownGuardActiveEditing(e, handleRedo)}
                                    onClick={() => {
                                        if (suppressGuardedClickRef.current) { suppressGuardedClickRef.current = false; return; }
                                        handleRedo();
                                    }}
                                    disabled={!canRedo}
                                    data-testid="history-redo"
                                    title={`Redo (${redoShortcutLabel})`}
                            >
                                Redo
                            </button>
                            <div className="history-menu" ref={historyMenuRef}>
                                <button
                                    title="View and jump to previous resolution states"
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
                                                onMouseDown={e => mouseDownGuardActiveEditing(e, handleUndo)}
                                                onClick={() => {
                                                    if (suppressGuardedClickRef.current) { suppressGuardedClickRef.current = false; return; }
                                                    handleUndo();
                                                }}
                                                disabled={!canUndo}
                                                data-testid="history-panel-undo"
                                            >
                                                Undo
                                            </button>
                                            <button
                                                className="btn btn-secondary"
                                                onMouseDown={e => mouseDownGuardActiveEditing(e, handleRedo)}
                                                onClick={() => {
                                                    if (suppressGuardedClickRef.current) { suppressGuardedClickRef.current = false; return; }
                                                    handleRedo();
                                                }}
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
                                                onMouseDown={e => mouseDownGuardActiveEditing(e, () => { handleJumpToHistory(index); setHistoryOpen(false); })}
                                                onClick={() => {
                                                    if (suppressGuardedClickRef.current) { suppressGuardedClickRef.current = false; return; }
                                                    handleJumpToHistory(index);
                                                    setHistoryOpen(false);
                                                }}
                                                onKeyDown={event => {
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
                                    title="Accept all base changes for remaining conflicts"
                                    onMouseDown={e => mouseDownGuardActiveEditing(e, () => handleAcceptAll('base'))}
                                    onClick={() => {
                                        if (suppressGuardedClickRef.current) { suppressGuardedClickRef.current = false; return; }
                                        handleAcceptAll('base');
                                    }}
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
                                    padding: '4px 8px',
                                }}
                                title="Accept all current changes for remaining conflicts"
                                onMouseDown={e => mouseDownGuardActiveEditing(e, () => handleAcceptAll('current'))}
                                onClick={() => {
                                    if (suppressGuardedClickRef.current) { suppressGuardedClickRef.current = false; return; }
                                    handleAcceptAll('current');
                                }}
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
                                title="Accept all incoming changes for remaining conflicts"
                                onMouseDown={e => mouseDownGuardActiveEditing(e, () => handleAcceptAll('incoming'))}
                                onClick={() => {
                                    if (suppressGuardedClickRef.current) { suppressGuardedClickRef.current = false; return; }
                                    handleAcceptAll('incoming');
                                }}
                            >
                                All Incoming
                            </button>
                        </div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                            <input
                                type="checkbox"
                                checked={renumberExecutionCounts}
                                onChange={e => setRenumberExecutionCounts(e.target.checked)}
                            />
                            Renumber execution counts
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                            <input
                                type="checkbox"
                                checked={markAsResolved}
                                onChange={e => setMarkAsResolved(e.target.checked)}
                            />
                            Mark as resolved (stage in Git)
                        </label>
                        <button
                            title={allResolved ?
                                "Write the merged notebook with your resolution choices"
                                : "Resolve all conflicts before applying"}
                            className="btn btn-primary"
                            onMouseDown={handleResolveMouseDown}
                            onClick={handleResolve}
                            disabled={!allResolved}
                        >
                            Apply Resolution
                        </button>
                    </div>
                </div>
                <div className={`column-labels${showBaseColumn ? '' : ' two-column'}`}>
                    {showBaseColumn && (
                        <div className="column-label base">
                            Base
                        </div>
                    )}
                    <div className="column-label current">
                        Current{' '}
                        {conflict.currentBranch ? `(${conflict.currentBranch})` : ''}
                    </div>
                    <div className="column-label incoming">
                        Incoming{' '}
                        {conflict.incomingBranch ? `(${conflict.incomingBranch})` : ''}
                    </div>
                </div>
            </header>

            <main className="main-content" ref={mainContentRef}>
                {conflict.autoResolveResult &&
                    conflict.autoResolveResult.autoResolvedCount > 0 && (
                        <div className="auto-resolve-banner">
                            <button
                                className="auto-resolve-summary"
                                onClick={() => setAutoResolveBannerOpen(o => !o)}
                                aria-expanded={autoResolveBannerOpen}
                            >
                                <span className="icon">✓</span>
                                <span className="text">
                                    Auto-resolved {conflict.autoResolveResult.autoResolvedCount}{' '}
                                    conflict
                                    {conflict.autoResolveResult.autoResolvedCount !== 1
                                        ? 's'
                                        : ''}
                                </span>
                                <span className="chevron">
                                    {autoResolveBannerOpen ? '▲' : '▼'}
                                </span>
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

                    <div>
                        {rows.map((row, i) => {
                            const conflictIdx = row?.conflictIndex ?? -1;
                            const resolutionState = conflictIdx >= 0 ? choices.get(conflictIdx) : undefined;
                            const rowKey = conflictIdx >= 0
                                ? `conflict-${conflictIdx}`
                                : `identical-${row.baseCellIndex ?? 'x'}-${row.currentCellIndex ?? 'x'}-${row.incomingCellIndex ?? 'x'}`;
                            return (
                                <MergeRow
                                    key={rowKey}
                                    row={row}
                                    rowIndex={i}
                                    languageExtensions={languageExtensions}
                                    theme={conflict.theme ?? 'light'}
                                    resolutionState={resolutionState}
                                    isEditing={
                                        conflictIdx >= 0 && editingConflicts.has(conflictIdx)
                                    }
                                    onSelectChoice={handleSelectChoice}
                                    onCommitContent={handleCommitContent}
                                    onStartEditing={handleStartEditing}
                                    onStopEditing={handleStopEditing}
                                    onClearChoice={handleClearChoice}
                                    onUnmatchRow={unmatchRow}
                                    onRematchRows={rematchRows}
                                    showOutputs={
                                        !conflict.hideNonConflictOutputs || row.type === 'conflict'
                                    }
                                    showBaseColumn={showBaseColumn}
                                    showCellHeaders={showCellHeaders}
                                    data-testid={
                                        conflictIdx >= 0
                                            ? `conflict-row-${conflictIdx}`
                                            : `row-${i}`
                                    }
                                />
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
    const conflictRows = rows.filter(
        (row): row is MergeRowType & { conflictIndex: number } =>
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
