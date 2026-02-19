/**
 * @file types.ts
 * @description Shared types for the web client conflict resolver.
 * Exports core types and defines client-specific interfaces.
 */

// Export core types needed by the client
export type {
    NotebookCell,
    CellOutput,
    Notebook,
    NotebookMetadata,
    CellConflict,
    NotebookConflict,
    SemanticConflict,
    SemanticConflictType,
    CellMapping,
    NotebookSemanticConflict,
    ResolutionChoice,
} from '../../types';
import type { AutoResolveResult } from '../webTypes';
export type { AutoResolveResult } from '../webTypes';

/**
 * Represents a row in the 3-way merge view
 */
export interface MergeRow {
    type: 'identical' | 'conflict';
    baseCell?: import('../../types').NotebookCell;
    currentCell?: import('../../types').NotebookCell;
    incomingCell?: import('../../types').NotebookCell;
    baseCellIndex?: number;
    currentCellIndex?: number;
    incomingCellIndex?: number;
    conflictIndex?: number;
    conflictType?: string;
    isUnmatched?: boolean;
    unmatchedSides?: ('base' | 'current' | 'incoming')[];
    anchorPosition?: number;
    /** Whether this row is in edit mode */
    isEditing?: boolean;
    /** Whether this row is being dragged */
    isDragging?: boolean;
}

/**
 * Unified conflict data sent from extension to browser
 */
export interface UnifiedConflictData {
    filePath: string;
    type: 'semantic';
    semanticConflict?: import('../../types').NotebookSemanticConflict;
    autoResolveResult?: AutoResolveResult;
    hideNonConflictOutputs?: boolean;
    showCellHeaders?: boolean;
    currentBranch?: string;
    incomingBranch?: string;
    enableUndoRedoHotkeys?: boolean;
    showBaseColumn?: boolean;
    theme?: 'dark' | 'light';
}

/**
 * Resolution choice for a single conflict.
 * 
 * New flow: User selects a branch, then can edit the content.
 * The resolvedContent is always the source of truth for rebuilding.
 */
export interface ConflictChoice {
    index: number;
    /** The base branch the user selected (determines outputs, metadata, etc.) */
    choice: import('../../types').ResolutionChoice;
    /** The resolved content - always present for resolved cells, serves as source of truth */
    resolvedContent: string;
}

/**
 * Resolved row from the UI - represents the final state after drag/drop and user edits.
 * This is the source of truth for reconstructing the notebook.
 */
export interface ResolvedRow {
    /** Base cell (may be undefined if cell not present in base) */
    baseCell?: import('../../types').NotebookCell;
    /** Current cell (may be undefined if cell not present in current) */
    currentCell?: import('../../types').NotebookCell;
    /** Incoming cell (may be undefined if cell not present in incoming) */
    incomingCell?: import('../../types').NotebookCell;
    /** Original indices for reliable cell lookup */
    baseCellIndex?: number;
    currentCellIndex?: number;
    incomingCellIndex?: number;
    /** If this row had a conflict, this is the user's resolution */
    resolution?: {
        /** The branch choice that determines outputs, metadata, etc. */
        choice: import('../../types').ResolutionChoice;
        /** The resolved content from the text area (source of truth) */
        resolvedContent: string;
    };
}

/**
 * Message sent back to extension with resolution
 */
export interface ResolutionMessage {
    command: 'resolve';
    type: 'semantic';
    resolutions: ConflictChoice[];
    /** The complete resolved row structure from the UI (source of truth) */
    resolvedRows: ResolvedRow[];
    semanticChoice?: 'current' | 'incoming';
    markAsResolved: boolean;
    renumberExecutionCounts: boolean;
}

/**
 * WebSocket message types
 */
export type WSMessage =
    | { type: 'connected'; sessionId: string }
    | { type: 'conflict-data'; data: UnifiedConflictData }
    | { type: 'resolution-success'; message: string }
    | { type: 'resolution-error'; message: string }
    | ResolutionMessage
    | { command: 'cancel' }
    | { command: 'ready' };
