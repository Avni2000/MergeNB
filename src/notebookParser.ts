import { Notebook, NotebookCell } from './types';

/**
 * Parse a Jupyter notebook from JSON string.
 * Handles both clean notebooks and those with potential issues.
 */
export function parseNotebook(content: string): Notebook {
    const parsed = JSON.parse(content);
    
    // Validate basic structure
    if (!parsed.cells || !Array.isArray(parsed.cells)) {
        throw new Error('Invalid notebook: missing cells array');
    }
    if (typeof parsed.nbformat !== 'number') {
        throw new Error('Invalid notebook: missing nbformat');
    }

    return parsed as Notebook;
}

/**
 * Serialize a notebook back to JSON string with proper formatting.
 */
export function serializeNotebook(notebook: Notebook): string {
    return JSON.stringify(notebook, null, 1);
}

/**
 * Normalize cell source to a consistent string format.
 * Notebook sources can be string or string[].
 */
export function normalizeCellSource(source: string | string[]): string {
    if (Array.isArray(source)) {
        return source.join('');
    }
    return source;
}

/**
 * Convert cell source back to the array format expected by nbformat.
 */
export function sourceToCellFormat(source: string): string[] {
    const lines = source.split('\n');
    return lines.map((line, i) => i < lines.length - 1 ? line + '\n' : line);
}

/**
 * Get a display-friendly preview of a cell's content.
 */
export function getCellPreview(cell: NotebookCell, maxLength: number = 100): string {
    const source = normalizeCellSource(cell.source);
    const firstLine = source.split('\n')[0] || '';
    if (firstLine.length > maxLength) {
        return firstLine.substring(0, maxLength) + '...';
    }
    return firstLine;
}

/**
 * Renumber execution counts in a notebook sequentially.
 */
export function renumberExecutionCounts(notebook: Notebook): Notebook {
    let count = 1;
    const cells = notebook.cells.map(cell => {
        if (cell.cell_type === 'code') {
            // Only number cells that have been executed (have outputs)
            if (cell.outputs && cell.outputs.length > 0) {
                return {
                    ...cell,
                    execution_count: count++,
                    outputs: cell.outputs.map(output => {
                        if (output.output_type === 'execute_result') {
                            return { ...output, execution_count: cell.execution_count };
                        }
                        return output;
                    })
                };
            }
            // Unexecuted code cells have null execution_count
            return { ...cell, execution_count: null };
        }
        return cell;
    });

    return { ...notebook, cells };
}

/**
 * Deep clone a notebook to avoid mutations.
 */
export function cloneNotebook(notebook: Notebook): Notebook {
    return JSON.parse(JSON.stringify(notebook));
}
