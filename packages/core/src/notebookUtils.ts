/**
 * @file notebookUtils.ts
 * @description Browser-safe notebook utility functions.
 * 
 * These pure functions work in both Node.js and browser environments.
 * For Node.js-specific operations (file I/O, parsing), use notebookParser.ts.
 */

import { NotebookCell } from './types';
import { mergeCell } from './cellMerge';
export { stableStringify } from './json';
export { normalizeCellSource, sourceToCellFormat } from './notebookSource';

/** Assemble every clean field change in a unified row. */
export function selectNonConflictMergedCell(
    baseCell?: NotebookCell,
    currentCell?: NotebookCell,
    incomingCell?: NotebookCell
): NotebookCell | undefined {
    if (currentCell && incomingCell) return mergeCell(baseCell, currentCell, incomingCell).cell;
    if (baseCell && !currentCell && !incomingCell) return undefined;
    return currentCell ?? incomingCell;
}

/**
 * Escape HTML special characters for safe display.
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
