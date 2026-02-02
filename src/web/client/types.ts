/**
 * @file types.ts
 * @description Shared types for the web client conflict resolver.
 * Re-exports core types and defines client-specific interfaces.
 */

// Re-export core types needed by the client
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
 * Auto-resolution result info
 */
export interface AutoResolveResult {
    resolved: number;
    total: number;
    types: string[];
}

/**
 * Unified conflict data sent from extension to browser
 */
export interface UnifiedConflictData {
    filePath: string;
    type: 'textual' | 'semantic';
    textualConflict?: import('../../types').NotebookConflict;
    semanticConflict?: import('../../types').NotebookSemanticConflict;
    autoResolveResult?: AutoResolveResult;
    hideNonConflictOutputs?: boolean;
    currentBranch?: string;
    incomingBranch?: string;
}

/**
 * Resolution choice for a single conflict
 */
export interface ConflictChoice {
    index: number;
    choice: 'base' | 'current' | 'incoming' | 'both' | 'custom' | 'delete';
    customContent?: string;
}

/**
 * Message sent back to extension with resolution
 */
export interface ResolutionMessage {
    command: 'resolve';
    type: 'textual' | 'semantic';
    resolutions: ConflictChoice[];
    semanticChoice?: 'current' | 'incoming';
    markAsResolved: boolean;
}

/**
 * WebSocket message types
 */
export type WSMessage =
    | { type: 'connected'; sessionId: string }
    | { type: 'conflict-data'; data: UnifiedConflictData }
    | ResolutionMessage
    | { command: 'cancel' }
    | { command: 'ready' };
