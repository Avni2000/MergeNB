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
    ResolutionChoice
} from '../types';
import type { AutoResolveResult } from '../conflictDetector';

export type { AutoResolveResult } from '../conflictDetector';

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
 * Resolved row from the UI - represents the final state after drag/drop and user edits.
 * This is the source of truth for reconstructing the notebook.
 */
export interface ResolvedRow {
    /** Base cell (may be undefined if cell not present in base) */
    baseCell?: NotebookCell;
    /** Current cell (may be undefined if cell not present in current) */
    currentCell?: NotebookCell;
    /** Incoming cell (may be undefined if cell not present in incoming) */
    incomingCell?: NotebookCell;
    /** Original indices for reliable cell lookup */
    baseCellIndex?: number;
    currentCellIndex?: number;
    incomingCellIndex?: number;
    /** If this row had a conflict, this is the user's resolution */
    resolution?: {
        /** The branch choice that determines outputs, metadata, etc. */
        choice: ResolutionChoice;
        /** The resolved content from the text area (source of truth) */
        resolvedContent: string;
    };
}

/**
 * Resolution result from the panel.
 * 
 * The resolvedRows field is now the primary source of truth - it contains the complete
 * cell structure after all drag/drop operations and user edits.
 */
export interface UnifiedResolution {
    type: 'semantic';
    semanticChoice?: 'base' | 'current' | 'incoming';
    semanticResolutions?: Map<number, { choice: ResolutionChoice; resolvedContent: string }>;
    /** The complete resolved row structure from the UI (source of truth) */
    resolvedRows?: ResolvedRow[];
    // Whether to mark file as resolved with git add
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
    fileName: string;
    type: 'semantic';

    // For semantic conflicts
    semanticConflict?: WebSemanticConflict;

    // Auto-resolution result if any
    autoResolveResult?: AutoResolveResult;

    // Display options
    hideNonConflictOutputs?: boolean;
    showCellHeaders?: boolean;

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
    filePath: string;
    semanticConflicts: WebSemanticConflictItem[];
    cellMappings: CellMapping[];

    // Full notebook versions
    base?: Notebook;
    current?: Notebook;
    incoming?: Notebook;

    // Branch information
    currentBranch?: string;
    incomingBranch?: string;
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
    description?: string;
}

/**
 * Merge row structure for the 3-way view.
 */
export interface WebMergeRow {
    type: 'identical' | 'conflict';
    baseCell?: NotebookCell;
    currentCell?: NotebookCell;
    incomingCell?: NotebookCell;
    baseCellIndex?: number;
    currentCellIndex?: number;
    incomingCellIndex?: number;
    conflictIndex?: number;
    conflictType?: string;
    isUnmatched?: boolean;
    unmatchedSides?: ('base' | 'current' | 'incoming')[];
    anchorPosition?: number;
}

/**
 * Messages sent from the extension to the browser.
 */
export type ExtensionToBrowserMessage =
    | { type: 'connected'; sessionId: string }
    | { type: 'conflict-data'; data: WebConflictData }
    | { type: 'error'; message: string }
    | { type: 'close' };

/**
 * Messages sent from the browser to the extension.
 */
export type BrowserToExtensionMessage =
    | {
        command: 'resolve';
        type: 'semantic';
        resolutions: Array<{
            index: number;
            choice: string;
            customContent?: string;
        }>;
        /** The complete resolved row structure from the UI (source of truth) */
        resolvedRows: ResolvedRow[];
        semanticChoice?: 'base' | 'current' | 'incoming';
        markAsResolved?: boolean;
    }
    | { command: 'cancel' }
    | { command: 'ready' };

/**
 * Resolution data structure returned from the browser.
 */
export interface WebResolutionData {
    type: 'semantic';
    resolutions: Array<{
        index: number;
        choice: ResolutionChoice | 'base';
        customContent?: string;
    }>;
    semanticChoice?: 'base' | 'current' | 'incoming';
    markAsResolved: boolean;
}

/**
 * Convert NotebookSemanticConflict to WebSemanticConflict.
 */
export function toWebSemanticConflict(conflict: NotebookSemanticConflict): WebSemanticConflict {
    return {
        filePath: conflict.filePath,
        semanticConflicts: conflict.semanticConflicts.map(c => ({
            type: c.type,
            baseCellIndex: c.baseCellIndex,
            currentCellIndex: c.currentCellIndex,
            incomingCellIndex: c.incomingCellIndex,
            baseContent: c.baseContent,
            currentContent: c.currentContent,
            incomingContent: c.incomingContent,
            description: c.description
        })),
        cellMappings: conflict.cellMappings,
        base: conflict.base,
        current: conflict.current,
        incoming: conflict.incoming,
        currentBranch: conflict.currentBranch,
        incomingBranch: conflict.incomingBranch
    };
}
