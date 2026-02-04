/**
 * @file notebookParser.ts
 * @description Jupyter notebook JSON parsing and serialization utilities.
 * 
 * Handles:
 * - Parsing .ipynb JSON into typed Notebook objects
 * - Serializing notebooks back to JSON with consistent formatting
 * - Normalizing cell source (string vs string[] formats)
 * - Renumbering execution counts after merge resolution
 * - Generating cell content previews for UI display
 */

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
