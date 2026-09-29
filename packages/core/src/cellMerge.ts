import type { NotebookCell, CellOutput } from './notebookTypes';
import { mergeFields, type FieldConflict } from './fieldMerge';
import { normalizeCellSource, stableStringify } from './notebookUtils';
import { normalizeMimeBundle } from './mime';

function comparisonOutput(output: CellOutput): CellOutput {
    return {
        ...output,
        ...(output.output_type === 'stream' && output.text !== undefined ? { text: normalizeCellSource(output.text) } : {}),
        ...(output.data ? { data: normalizeMimeBundle(output.data) } : {}),
    };
}

function comparisonValue(value: unknown, path: string[]): unknown {
    if (value === undefined) return value;
    if (path.length === 0) {
        return Object.fromEntries(Object.entries(value as NotebookCell).map(([key, field]) => [key, comparisonValue(field, [key])]));
    }
    if (path.length === 1 && path[0] === 'source') return normalizeCellSource(value as NotebookCell['source']);
    if (path.length === 1 && path[0] === 'outputs') return (value as CellOutput[]).map(comparisonOutput);
    if (path[0] === 'attachments') {
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
    if (base && base.attachments === undefined && current.attachments && incoming.attachments) {
        base = { ...base, attachments: {} };
    }
    const merged = mergeFields(base ?? {}, current, incoming, {
        // A type change chooses a complete cell so code-only fields cannot leak into raw/Markdown cells.
        atomic: path => (path.length === 0 && current.cell_type !== incoming.cell_type)
            || (path[0] === 'attachments' && path.length === 2),
        equal: (left, right, path) => stableStringify(comparisonValue(left, path)) === stableStringify(comparisonValue(right, path)),
    });
    return { cell: merged.value as NotebookCell, conflicts: merged.conflicts };
}
