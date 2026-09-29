import { isKnownCellType } from './notebookValidation';
import type { NotebookCell, CellOutput } from './notebookTypes';
import { mergeFields, type FieldConflict } from './fieldMerge';
import { normalizeCellSource } from './notebookSource';
import { stableStringify } from './json';
import { normalizeMimeBundle } from './mime';

function comparisonOutput(output: CellOutput): CellOutput {
    if (output.output_type === 'stream' && output.text !== undefined) {
        return { ...output, text: normalizeCellSource(output.text) };
    }
    if ((output.output_type === 'display_data' || output.output_type === 'execute_result') && output.data) {
        return { ...output, data: normalizeMimeBundle(output.data) };
    }
    return output;
}

function comparisonValue(value: unknown, path: string[], cellType?: string): unknown {
    if (value === undefined) return value;
    if (path.length === 0) {
        if ('cell_type' in (value as object) && !isKnownCellType((value as NotebookCell).cell_type)) return value;
        return Object.fromEntries(Object.entries(value as NotebookCell).map(([key, field]) => [key, comparisonValue(field, [key], (value as NotebookCell).cell_type)]));
    }
    if (path.length === 1 && path[0] === 'source') return normalizeCellSource(value as NotebookCell['source']);
    if (path.length === 1 && path[0] === 'outputs' && cellType === 'code') return (value as CellOutput[]).map(comparisonOutput);
    if (path[0] === 'attachments' && (cellType === 'markdown' || cellType === 'raw')) {
        if (path.length === 1) return Object.fromEntries(Object.entries(value as NonNullable<NotebookCell['attachments']>)
            .map(([name, bundle]) => [name, normalizeMimeBundle(bundle)]));
        if (path.length === 2) return normalizeMimeBundle(value as Record<string, unknown>);
    }
    return value;
}

/** Compare the same normalized fields in detection and in unified-cell assembly. */
export function mergeCell(
    base: NotebookCell | undefined,
    current: NotebookCell,
    incoming: NotebookCell
): { cell: NotebookCell; conflicts: FieldConflict[] } {
    // Each filename is independent even when neither branch had attachments before.
    const baseFields: Record<string, unknown> = { ...base };
    if (baseFields.attachments === undefined && current.attachments && incoming.attachments) {
        baseFields.attachments = {};
    }
    const merged = mergeFields(baseFields, current, incoming, {
        // A type change chooses a complete cell so code-only fields cannot leak into raw/Markdown cells.
        atomic: path => (path.length === 0 && (current.cell_type !== incoming.cell_type || !isKnownCellType(current.cell_type)))
            || (path[0] === 'attachments' && path.length === 2),
        equal: (left, right, path) => stableStringify(comparisonValue(left, path, current.cell_type)) === stableStringify(comparisonValue(right, path, current.cell_type)),
    });
    return { cell: merged.value as NotebookCell, conflicts: merged.conflicts };
}
