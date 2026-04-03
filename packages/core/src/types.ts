/**
 * @file types.ts
 * @description Core TypeScript type definitions for MergeNB.
 * 
 * Contains:
 * - Jupyter notebook structure types (nbformat v4): Notebook, NotebookCell, CellOutput
 * - Semantic conflict types: SemanticConflict, SemanticConflictType, CellMapping
 * - Resolution types used by the semantic resolver UI
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
 * Resolution choices for semantic conflict resolution.
 */
export type ResolutionChoice = 'base' | 'current' | 'incoming' | 'delete';

/**
 * Semantic conflict types (Git unmerged status)
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
    
}

export interface CellMapping {
    baseIndex?: number;
    currentIndex?: number;
    incomingIndex?: number;
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

/**
 * Resolved row from the UI - represents the final state after user edits.
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
 * Extension settings consumed by core logic (auto-resolution, semantic resolution).
 * The actual settings source (VS Code workspace config, JSON file, etc.) is defined
 * by the host application; core only depends on this shape.
 */
export interface MergeNBSettings {
    autoResolveExecutionCount: boolean;
    autoResolveKernelVersion: boolean;
    stripOutputs: boolean;
    autoResolveWhitespace: boolean;
    hideNonConflictOutputs: boolean;
    showCellHeaders: boolean;
    enableUndoRedoHotkeys: boolean;
    showBaseColumn: boolean;
    theme: 'dark' | 'light';
}

/**
 * Abstraction over Git operations needed by the conflict detector.
 * The host application provides the concrete implementation (e.g. shelling
 * out to git, using a VS Code Git API, etc.).
 */
export interface GitOperations {
    getThreeWayVersions(filePath: string): Promise<{
        base: string | null;
        current: string | null;
        incoming: string | null;
    } | null>;
    getCurrentBranch(filePath: string): Promise<string | null>;
    getMergeBranch(filePath: string): Promise<string | null>;
}
