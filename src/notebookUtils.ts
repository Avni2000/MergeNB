/**
 * @file notebookUtils.ts
 * @description Browser-safe notebook utility functions.
 * 
 * These pure functions work in both Node.js and browser environments.
 * For Node.js-specific operations (file I/O, parsing), use notebookParser.ts.
 */

import { NotebookCell } from './types';

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
 * Choose the effective merged cell for a row that is not marked as a conflict.
 * Uses source-based 3-way logic so one-sided edits are preserved:
 * - base == current, incoming changed => choose incoming
 * - base == incoming, current changed => choose current
 * - otherwise prefer current for deterministic behavior
 */
export function selectNonConflictMergedCell(
    baseCell?: NotebookCell,
    currentCell?: NotebookCell,
    incomingCell?: NotebookCell
): NotebookCell | undefined {
    if (baseCell && currentCell && incomingCell) {
        const baseSource = normalizeCellSource(baseCell.source);
        const currentSource = normalizeCellSource(currentCell.source);
        const incomingSource = normalizeCellSource(incomingCell.source);

        const currentMatchesBase = currentSource === baseSource;
        const incomingMatchesBase = incomingSource === baseSource;

        if (currentMatchesBase && !incomingMatchesBase) {
            return incomingCell;
        }
        if (!currentMatchesBase && incomingMatchesBase) {
            return currentCell;
        }

        // Includes unchanged rows and same-result concurrent edits.
        if (currentSource === incomingSource) {
            return currentCell;
        }

        // Defensive fallback; true conflicts should be handled elsewhere.
        return currentCell;
    }

    return currentCell || incomingCell || baseCell;
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
 * Check if a cell is a code cell.
 */
export function isCodeCell(cell: NotebookCell): boolean {
    return cell.cell_type === 'code';
}

/**
 * Check if a cell is a markdown cell.
 */
export function isMarkdownCell(cell: NotebookCell): boolean {
    return cell.cell_type === 'markdown';
}

/**
 * Get the cell type as a display string.
 */
export function getCellTypeDisplay(cell: NotebookCell): string {
    switch (cell.cell_type) {
        case 'code':
            return 'Code';
        case 'markdown':
            return 'Markdown';
        case 'raw':
            return 'Raw';
        default:
            return cell.cell_type;
    }
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
