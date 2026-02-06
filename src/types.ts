/**
 * @file types.ts
 * @description Core TypeScript type definitions for MergeNB.
 * 
 * Contains:
 * - Jupyter notebook structure types (nbformat v4): Notebook, NotebookCell, CellOutput
 * - Conflict marker types: ConflictMarker, CellConflict, NotebookConflict
 * - Semantic conflict types: SemanticConflict, SemanticConflictType, CellMapping
 * - Resolution types: ResolutionChoice, ConflictResolution, SemanticConflictResolution
 */

export interface NotebookCell {
    cell_type: 'code' | 'markdown' | 'raw';
    source: string | string[];
    metadata: Record<string, unknown>;
    execution_count?: number | null;
    outputs?: CellOutput[];
    id?: string;
}

export interface CellOutput {
    output_type: 'stream' | 'display_data' | 'execute_result' | 'error';
    data?: Record<string, unknown>;
    text?: string | string[];
    name?: string;
    execution_count?: number | null;
    ename?: string;
    evalue?: string;
    traceback?: string[];
}

export interface NotebookMetadata {
    kernelspec?: {
        display_name: string;
        language: string;
        name: string;
    };
    language_info?: {
        name: string;
        version?: string;
    };
    [key: string]: unknown;
}

export interface Notebook {
    nbformat: number;
    nbformat_minor: number;
    metadata: NotebookMetadata;
    cells: NotebookCell[];
}

/**
 * Conflict-related types
 */

export interface ConflictMarker {
    start: number;  // Line index of <<<<<<<
    middle: number; // Line index of =======
    end: number;    // Line index of >>>>>>>
    currentBranch?: string;
    incomingBranch?: string;
}

export interface CellConflict {
    cellIndex: number;
    field: 'source' | 'outputs' | 'metadata' | 'execution_count';
    currentContent: string;
    incomingContent: string;
    marker: ConflictMarker;
    /** Cell type for display purposes */
    cellType?: 'code' | 'markdown' | 'raw';
    /** Index of the current cell (for cell-level conflicts) */
    currentCellIndex?: number;
    /** Index of the incoming cell (for cell-level conflicts) */
    incomingCellIndex?: number;
}

export interface NotebookConflict {
    filePath: string;
    rawContent: string;
    conflicts: CellConflict[];
    // If conflict is in top-level metadata
    metadataConflicts: Array<{
        field: string;
        currentContent: string;
        incomingContent: string;
        marker: ConflictMarker;
    }>;
    
    // Full notebook versions from Git staging areas (for showing non-conflicted context)
    base?: Notebook;
    current?: Notebook;
    incoming?: Notebook;
    
    // Cell mappings between versions (like semantic conflicts)
    cellMappings?: CellMapping[];
    
    // Branch information
    currentBranch?: string;
    incomingBranch?: string;
}

/**
 * Resolution choices for conflict resolution.
 * - base: Use the base version (pre-merge common ancestor)
 * - current: Use the current branch version
 * - incoming: Use the incoming branch version  
 * - both: Include both current and incoming content
 * - delete: Remove the cell entirely
 */
export type ResolutionChoice = 'base' | 'current' | 'incoming' | 'both' | 'delete';

export interface ConflictResolution {
    conflict: CellConflict;
    choice: ResolutionChoice;
    /** The resolved content from the editable text area (source of truth) */
    resolvedContent?: string;
}

/**
 * Semantic conflict types (Git UU status)
 */

export type SemanticConflictType = 
    | 'cell-added'           // Cell exists in current or incoming but not base
    | 'cell-deleted'         // Cell removed in current or incoming
    | 'cell-modified'        // Cell content changed in both branches
    | 'cell-reordered'       // Cells appear in different order
    | 'metadata-changed'     // Cell metadata differs
    | 'outputs-changed'      // Cell outputs differ (execution results)
    | 'execution-count-changed'; // execution_count differs

export interface SemanticConflict {
    type: SemanticConflictType;
    
    // Cell indices in each version (undefined if cell doesn't exist in that version)
    baseCellIndex?: number;
    currentCellIndex?: number;
    incomingCellIndex?: number;
    
    // Cell content from each version
    baseContent?: NotebookCell;
    currentContent?: NotebookCell;
    incomingContent?: NotebookCell;
    
    // Additional context
    description?: string;
}

export interface CellMapping {
    baseIndex?: number;
    currentIndex?: number;
    incomingIndex?: number;
    matchConfidence: number; // 0-1, how confident we are in this mapping
    baseCell?: NotebookCell;
    currentCell?: NotebookCell;
    incomingCell?: NotebookCell;
}

export interface NotebookSemanticConflict {
    filePath: string;
    
    // All semantic conflicts detected
    semanticConflicts: SemanticConflict[];
    
    // Cell mappings between versions
    cellMappings: CellMapping[];
    
    // Full notebook versions
    base?: Notebook;
    current?: Notebook;
    incoming?: Notebook;
    
    // Branch information
    currentBranch?: string;
    incomingBranch?: string;
}

export interface SemanticConflictResolution {
    conflict: SemanticConflict;
    choice: 'base' | 'current' | 'incoming' | 'delete';
    /** The resolved content from the editable text area (source of truth) */
    resolvedContent?: string;
}
