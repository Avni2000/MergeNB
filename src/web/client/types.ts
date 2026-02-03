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
import type { AutoResolveResult } from  '../webTypes';
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
    currentBranch?: string;
    incomingBranch?: string;
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
    choice: 'base' | 'current' | 'incoming' | 'both' | 'delete';
    /** The resolved content - always present for resolved cells, serves as source of truth */
    resolvedContent: string;
}

/**
 * Message sent back to extension with resolution
 */
export interface ResolutionMessage {
    command: 'resolve';
    type: 'semantic';
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
