/** Known nbformat fields with extension fields preserved at every level. */

export type MimeBundle = Record<string, unknown>;

export interface NotebookCell {
    cell_type: string;
    /** Future cell types may use another representation instead of source. */
    source?: string | string[];
    metadata: Record<string, unknown>;
    execution_count?: number | null;
    outputs?: CellOutput[];
    id?: string;
    attachments?: Record<string, MimeBundle>;
    [key: string]: unknown;
}

export interface CellOutput {
    output_type: string;
    data?: MimeBundle;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
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
        language?: string;
        [key: string]: unknown;
        name: string;
    };
    language_info?: {
        name: string;
        version?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface Notebook {
    nbformat: number;
    nbformat_minor: number;
    metadata: NotebookMetadata;
    cells: NotebookCell[];
    [key: string]: unknown;
}

