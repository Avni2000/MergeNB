import type { Notebook, NotebookSemanticConflict } from './types';
import { mergeFields, type FieldResolutions } from './fieldMerge';

export function notebookFields(notebook?: Notebook): Record<string, unknown> {
    if (!notebook) return {};
    return Object.fromEntries(Object.entries(notebook).filter(([key]) =>
        key !== 'cells' && key !== 'nbformat' && key !== 'nbformat_minor'
    ));
}

/** Notebook metadata and extension fields use the same deletion-aware merge. */
export function mergeNotebookFields(
    notebook: Pick<NotebookSemanticConflict, 'base' | 'current' | 'incoming'>,
    preferCurrentKernel: boolean,
    choices: FieldResolutions = {}
) {
    if (!notebook.current) return { value: notebookFields(notebook.incoming), conflicts: [], kernelFields: [] };
    if (!notebook.incoming) return { value: notebookFields(notebook.current), conflicts: [], kernelFields: [] };
    const base = notebookFields(notebook.base);
    const current = notebookFields(notebook.current);
    const incoming = notebookFields(notebook.incoming);
    const unresolved = mergeFields(base, current, incoming);
    const kernelFields = unresolved.conflicts.filter(({ path }) =>
        path[0] === 'metadata' && (path[1] === 'kernelspec' || path[1] === 'language_info')
    );
    const resolutions = { ...choices };
    if (preferCurrentKernel) {
        for (const field of kernelFields) resolutions[JSON.stringify(field.path)] = 'current';
    }
    const merged = mergeFields(base, current, incoming, { choices: resolutions });
    return { ...merged, value: merged.value as Record<string, unknown>, kernelFields };
}
