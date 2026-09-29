import React from 'react';
import { assignedCellIds, type Notebook, type NotebookSemanticConflict } from '../../../../core/src';

export function ResolutionPreview({ notebook, error, original }: {
    notebook?: Notebook;
    error?: string;
    original?: NotebookSemanticConflict;
}): React.ReactElement | null {
    if (error) return <p role="alert" className="notebook-fields">{error}</p>;
    if (!notebook) return null;
    const repairs = assignedCellIds(notebook, [original?.base, original?.current, original?.incoming]);
    return <section className="notebook-fields resolution-preview" data-resolved-notebook={JSON.stringify(notebook)}>
        {repairs.length > 0 && <p role="status">Assigned {repairs.length} cell ID(s) to satisfy nbformat {notebook.nbformat}.{notebook.nbformat_minor}: {repairs.join(', ')}.</p>}
        <details>
            <summary>Resolved notebook preview · nbformat {notebook.nbformat}.{notebook.nbformat_minor}</summary>
            <pre>{JSON.stringify(notebook, null, 2)}</pre>
        </details>
    </section>;
}
