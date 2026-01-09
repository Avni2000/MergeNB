/**
 * Types for Jupyter Notebook structure (nbformat v4)
 */

export interface NotebookCell {
    cell_type: 'code' | 'markdown' | 'raw';
    source: string | string[];
    metadata: Record<string, unknown>;
    execution_count?: number | null;
    outputs?: CellOutput[];
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
    localBranch?: string;
    remoteBranch?: string;
}

export interface CellConflict {
    cellIndex: number;
    field: 'source' | 'outputs' | 'metadata' | 'execution_count';
    localContent: string;
    remoteContent: string;
    marker: ConflictMarker;
    /** Cell type for display purposes */
    cellType?: 'code' | 'markdown' | 'raw';
    /** Index of the local cell (for cell-level conflicts) */
    localCellIndex?: number;
    /** Index of the remote cell (for cell-level conflicts) */
    remoteCellIndex?: number;
}

export interface NotebookConflict {
    filePath: string;
    rawContent: string;
    conflicts: CellConflict[];
    // If conflict is in top-level metadata
    metadataConflicts: Array<{
        field: string;
        localContent: string;
        remoteContent: string;
        marker: ConflictMarker;
    }>;
}

export type ResolutionChoice = 'local' | 'remote' | 'both' | 'custom';

export interface ConflictResolution {
    conflict: CellConflict;
    choice: ResolutionChoice;
    customContent?: string;
}

/**
 * Semantic conflict types (Git UU status without textual markers)
 */

export type SemanticConflictType = 
    | 'cell-added'           // Cell exists in local or remote but not base
    | 'cell-deleted'         // Cell removed in local or remote
    | 'cell-modified'        // Cell content changed in both branches
    | 'cell-reordered'       // Cells appear in different order
    | 'metadata-changed'     // Cell metadata differs
    | 'outputs-changed'      // Cell outputs differ (execution results)
    | 'execution-count-changed'; // execution_count differs

export interface SemanticConflict {
    type: SemanticConflictType;
    
    // Cell indices in each version (undefined if cell doesn't exist in that version)
    baseCellIndex?: number;
    localCellIndex?: number;
    remoteCellIndex?: number;
    
    // Cell content from each version
    baseContent?: NotebookCell;
    localContent?: NotebookCell;
    remoteContent?: NotebookCell;
    
    // Additional context
    description?: string;
}

export interface CellMapping {
    baseIndex?: number;
    localIndex?: number;
    remoteIndex?: number;
    matchConfidence: number; // 0-1, how confident we are in this mapping
    baseCell?: NotebookCell;
    localCell?: NotebookCell;
    remoteCell?: NotebookCell;
}

export interface NotebookSemanticConflict {
    filePath: string;
    
    // True if file also has textual conflict markers
    hasTextualConflicts: boolean;
    
    // All semantic conflicts detected
    semanticConflicts: SemanticConflict[];
    
    // Cell mappings between versions
    cellMappings: CellMapping[];
    
    // Full notebook versions
    base?: Notebook;
    local?: Notebook;
    remote?: Notebook;
    
    // Branch information
    localBranch?: string;
    remoteBranch?: string;
}

export interface SemanticConflictResolution {
    conflict: SemanticConflict;
    choice: 'base' | 'local' | 'remote' | 'custom';
    customContent?: NotebookCell;
}
