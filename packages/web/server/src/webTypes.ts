/**
 * @file webTypes.ts
 * @description Shared type definitions for web-based conflict resolution.
 * 
 * These types are used for communication between the VSCode extension
 * and the browser-based conflict resolver UI via WebSocket.
 * 
 */

import type {
    NotebookCell,
    Notebook,
    CellMapping,
    NotebookSemanticConflict,
    ResolvedRow
} from '../../../core/src';
import type { AutoResolveResult } from '../../../core/src';

export type { AutoResolveResult } from '../../../core/src';
export type { ResolvedRow } from '../../../core/src';

/**
 * Unified conflict data structure.
 */
export interface UnifiedConflict {
    filePath: string;
    type: 'semantic';
    semanticConflict?: NotebookSemanticConflict;
    /** Result of auto-resolution, if any conflicts were auto-resolved */
    autoResolveResult?: AutoResolveResult;
    /** Whether to hide outputs for non-conflicted cells */
    hideNonConflictOutputs?: boolean;
    /** Whether to show cell type, execution count, and cell index headers */
    showCellHeaders?: boolean;
    /** Whether undo/redo hotkeys are enabled in the web UI */
    enableUndoRedoHotkeys?: boolean;
    /** Whether to show the base column in the 3-way merge view */
    showBaseColumn?: boolean;
    /** UI theme ('dark' | 'light') */
    theme?: 'dark' | 'light';
}

/**
 * Resolution result from the panel.
 * 
 * The resolvedRows field is now the primary source of truth - it contains the complete
 * cell structure after user edits.
 */
export interface UnifiedResolution {
    type: 'semantic';
    semanticChoice?: 'base' | 'current' | 'incoming';
    /** The complete resolved row structure from the UI (source of truth) */
    resolvedRows?: ResolvedRow[];
    // Whether to mark file as resolved by staging in Git
    markAsResolved: boolean;
    // Whether to renumber execution counts sequentially
    renumberExecutionCounts: boolean;
}

/**
 * Unified conflict data sent to the browser.
 * This is the web-compatible version of UnifiedConflict.
 */
export interface WebConflictData {
    filePath: string;
    /** Stable conflict instance key for client-side state reset behavior */
    conflictKey: string;
    type: 'semantic';

    // For semantic conflicts
    semanticConflict?: WebSemanticConflict;

    // Auto-resolution result if any
    autoResolveResult?: AutoResolveResult;

    // Display options
    hideNonConflictOutputs?: boolean;
    showCellHeaders?: boolean;
    enableUndoRedoHotkeys?: boolean;
    showBaseColumn?: boolean;

    // Branch information
    currentBranch?: string;
    incomingBranch?: string;

    // UI theme
    theme?: 'dark' | 'light';
}

/**
 * Semantic conflict structure.
 */
export interface WebSemanticConflict {
    semanticConflicts: WebSemanticConflictItem[];
    cellMappings: CellMapping[];

    // Full notebook versions
    base?: Notebook;
    current?: Notebook;
    incoming?: Notebook;

}

/**
 * Individual semantic conflict.
 */
export interface WebSemanticConflictItem {
    type: string;
    baseCellIndex?: number;
    currentCellIndex?: number;
    incomingCellIndex?: number;
    baseContent?: NotebookCell;
    currentContent?: NotebookCell;
    incomingContent?: NotebookCell;
}

/**
 * Messages sent from the browser to the extension.
 */
export type BrowserToExtensionMessage =
    | {
        command: 'resolve';
        type: 'semantic';
        /** The complete resolved row structure from the UI (source of truth) */
        resolvedRows: ResolvedRow[];
        semanticChoice?: 'base' | 'current' | 'incoming';
        markAsResolved?: boolean;
        renumberExecutionCounts?: boolean;
    }
    | { command: 'cancel' }
    | { command: 'ready' };

/**
 * Build the complete WebConflictData payload from a UnifiedConflict.
 * Use this as the single construction point to keep browser payloads in sync.
 */
export function toWebConflictData(conflict: UnifiedConflict, conflictKey: string): WebConflictData {
    return {
        filePath: conflict.filePath,
        conflictKey,
        type: conflict.type,
        semanticConflict: conflict.semanticConflict
            ? toWebSemanticConflict(conflict.semanticConflict)
            : undefined,
        autoResolveResult: conflict.autoResolveResult,
        hideNonConflictOutputs: conflict.hideNonConflictOutputs,
        showCellHeaders: conflict.showCellHeaders,
        enableUndoRedoHotkeys: conflict.enableUndoRedoHotkeys,
        showBaseColumn: conflict.showBaseColumn,
        theme: conflict.theme,
        currentBranch: conflict.semanticConflict?.currentBranch,
        incomingBranch: conflict.semanticConflict?.incomingBranch,
    };
}

/**
 * Convert NotebookSemanticConflict to WebSemanticConflict.
 */
export function toWebSemanticConflict(conflict: NotebookSemanticConflict): WebSemanticConflict {
    return {
        semanticConflicts: conflict.semanticConflicts.map(c => ({
            type: c.type,
            baseCellIndex: c.baseCellIndex,
            currentCellIndex: c.currentCellIndex,
            incomingCellIndex: c.incomingCellIndex,
            baseContent: c.baseContent,
            currentContent: c.currentContent,
            incomingContent: c.incomingContent
        })),
        cellMappings: conflict.cellMappings,
        base: conflict.base,
        current: conflict.current,
        incoming: conflict.incoming
    };
}
