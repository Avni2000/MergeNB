/**
 * @file types.ts
 * @description Shared types for the web client conflict resolver.
 * Exports core types and defines client-specific interfaces.
 */

import type { NotebookCell, NotebookSemanticConflict } from '../../../core/src';
import type { AutoResolveResult, BrowserToExtensionMessage } from '../../server/src';

// Export core types needed by the client
export type {
    NotebookCell,
    CellOutput,
    SemanticConflict,
    NotebookSemanticConflict,
    ResolutionChoice,
    ResolvedRow,
} from '../../../core/src';

// Boilerplate so we don't have to copy-paste
type MergeRowBase = {
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
    /** Whether this row participated in a reorder conflict in the original merge state. */
    isReordered?: boolean;
};

/**
 * Represents a row in the 3-way merge view.
 * Uses a discriminated union to enforce that when isUserUnmatched is true,
 * unmatchGroupId and originalMatchedRow must be present.
 */
export type MergeRow =
    | (MergeRowBase & {
        /** User has not unmatched this row. */
        isUserUnmatched?: false | undefined;
        /** No group ID when not user-unmatched. */
        unmatchGroupId?: undefined;
        /** No original matched row when not user-unmatched. */
        originalMatchedRow?: undefined;
    })
    | (MergeRowBase & {
        /** This row was manually unmatched by the user. */
        isUserUnmatched: true;
        /** Unique group ID linking split rows for rematch. */
        unmatchGroupId: string;
        /** The original matched row before unmatch, used for rematch reconstruction. */
        originalMatchedRow: MergeRow;
    });

/**
 * Unified conflict data sent from extension to browser
 */
export interface UnifiedConflictData {
    filePath: string;
    /** Stable conflict instance key for client-side state reset behavior */
    conflictKey: string;
    type: 'semantic';
    semanticConflict?: NotebookSemanticConflict;
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
 * WebSocket message types
 */
export type WSMessage =
    | { type: 'conflict-data'; data: UnifiedConflictData }
    | { type: 'resolution-success'; message: string }
    | { type: 'resolution-error'; message: string }
    | BrowserToExtensionMessage;
