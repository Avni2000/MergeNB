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

import { Notebook } from './types';
import { validateNotebook } from './notebookValidation';

/**
 * Parse a Jupyter notebook from JSON string.
 * Handles both clean notebooks and those with potential issues.
 */
export function parseNotebook(content: string): Notebook {
    const parsed = JSON.parse(content);

    validateNotebook(parsed, false);
    return parsed;
}

/**
 * Serialize a notebook back to JSON string with proper formatting.
 */
export function serializeNotebook(notebook: Notebook): string {
    validateNotebook(notebook);
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
                const nextCount = count++;
                return {
                    ...cell,
                    execution_count: nextCount,
                    outputs: cell.outputs.map(output => {
                        if (output.output_type === 'execute_result') {
                            return { ...output, execution_count: nextCount };
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

