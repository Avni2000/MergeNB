/**
 * @file notebookUtils.ts
 * @description Browser-safe notebook utility functions.
 * 
 * These pure functions work in both Node.js and browser environments.
 * For Node.js-specific operations (file I/O, parsing), use notebookParser.ts.
 */

import { NotebookCell } from './types';

export function stableStringify(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(value);

    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }

    if (t === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
    }

    // functions/symbols/etc. shouldn't appear in notebook JSON; stringify defensively
    return JSON.stringify(String(value));
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
        // If source is identical, still consider one-sided metadata edits.
        if (currentSource === incomingSource) {
            const baseMetadata = stableStringify(baseCell.metadata ?? {});
            const currentMetadata = stableStringify(currentCell.metadata ?? {});
            const incomingMetadata = stableStringify(incomingCell.metadata ?? {});

            const currentMetadataMatchesBase = currentMetadata === baseMetadata;
            const incomingMetadataMatchesBase = incomingMetadata === baseMetadata;

            if (currentMetadataMatchesBase && !incomingMetadataMatchesBase) {
                return incomingCell;
            }
            if (!currentMetadataMatchesBase && incomingMetadataMatchesBase) {
                return currentCell;
            }

            return currentCell;
        }

        // Defensive fallback; true conflicts should be handled elsewhere.
        return currentCell;
    }

    return currentCell || incomingCell || baseCell;
}

/**
 * Convert cell source back to the array format expected by nbformat.
 * Avoids producing empty strings at the end when source ends with \n.
 */
export function sourceToCellFormat(source: string): string[] {
    if (!source) return [];
    const lines = source.split('\n');
    const result = lines.map((line, i) => i < lines.length - 1 ? line + '\n' : line);
    // Remove empty string at the end if source ended with \n (split produces ["a", "b", ""])
    if (result.length > 0 && result[result.length - 1] === '') {
        result.pop();
    }
    return result;
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
