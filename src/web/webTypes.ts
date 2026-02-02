/**
 * @file webTypes.ts
 * @description Shared type definitions for web-based conflict resolution.
 * 
 * These types are used for communication between the VSCode extension
 * and the browser-based conflict resolver UI via WebSocket.
 */

import { 
    NotebookCell, 
    Notebook, 
    CellMapping, 
    NotebookConflict, 
    NotebookSemanticConflict,
    ResolutionChoice 
} from '../types';
import { AutoResolveResult } from '../conflictDetector';

/**
 * Unified conflict data sent to the browser.
 * This is the web-compatible version of UnifiedConflict.
 */
export interface WebConflictData {
    filePath: string;
    fileName: string;
    type: 'textual' | 'semantic';
    
    // For textual conflicts
    textualConflict?: WebTextualConflict;
    
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
}

/**
 * Web-compatible textual conflict structure.
 */
export interface WebTextualConflict {
    filePath: string;
    conflicts: WebCellConflict[];
    metadataConflicts: WebMetadataConflict[];
    
    // Full notebook versions
    base?: Notebook;
    current?: Notebook;
    incoming?: Notebook;
    
    // Cell mappings
    cellMappings?: CellMapping[];
    
    // Branch information
    currentBranch?: string;
    incomingBranch?: string;
}

/**
 * Web-compatible cell conflict.
 */
export interface WebCellConflict {
    cellIndex: number;
    field: 'source' | 'outputs' | 'metadata' | 'execution_count';
    currentContent: string;
    incomingContent: string;
    cellType?: 'code' | 'markdown' | 'raw';
}

/**
 * Web-compatible metadata conflict.
 */
export interface WebMetadataConflict {
    field: string;
    currentContent: string;
    incomingContent: string;
}

/**
 * Web-compatible semantic conflict structure.
 */
export interface WebSemanticConflict {
    filePath: string;
    hasTextualConflicts: boolean;
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
 * Web-compatible individual semantic conflict.
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
        type: 'textual' | 'semantic';
        resolutions: Array<{
            index: number;
            choice: string;
            customContent?: string;
        }>;
        semanticChoice?: string;
        markAsResolved?: boolean;
    }
    | { command: 'cancel' }
    | { command: 'ready' };

/**
 * Resolution data structure returned from the browser.
 */
export interface WebResolutionData {
    type: 'textual' | 'semantic';
    resolutions: Array<{
        index: number;
        choice: ResolutionChoice | 'base';
        customContent?: string;
    }>;
    semanticChoice?: 'current' | 'incoming';
    markAsResolved: boolean;
}

/**
 * Convert NotebookConflict to WebTextualConflict.
 */
export function toWebTextualConflict(conflict: NotebookConflict): WebTextualConflict {
    return {
        filePath: conflict.filePath,
        conflicts: conflict.conflicts.map(c => ({
            cellIndex: c.cellIndex,
            field: c.field,
            currentContent: c.currentContent,
            incomingContent: c.incomingContent,
            cellType: c.cellType
        })),
        metadataConflicts: conflict.metadataConflicts.map(m => ({
            field: m.field,
            currentContent: m.currentContent,
            incomingContent: m.incomingContent
        })),
        base: conflict.base,
        current: conflict.current,
        incoming: conflict.incoming,
        cellMappings: conflict.cellMappings,
        currentBranch: conflict.currentBranch,
        incomingBranch: conflict.incomingBranch
    };
}

/**
 * Convert NotebookSemanticConflict to WebSemanticConflict.
 */
export function toWebSemanticConflict(conflict: NotebookSemanticConflict): WebSemanticConflict {
    return {
        filePath: conflict.filePath,
        hasTextualConflicts: conflict.hasTextualConflicts,
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
