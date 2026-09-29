import React from 'react';
import type { NotebookCell } from '../../../../core/src';

/** Make non-source data inspectable without interpreting extension fields. */
export function CellFields({ cell, open = false, showOutputs = true }: { cell: NotebookCell; open?: boolean; showOutputs?: boolean }): React.ReactElement | null {
    const fields = Object.fromEntries(Object.entries(cell).filter(([key, value]) =>
        key !== 'source' && key !== 'cell_type' && (key !== 'outputs' || showOutputs)
        && !(key === 'metadata' && Object.keys(value as object).length === 0)
    ));
    if (Object.keys(fields).length === 0) return null;
    return <details className="cell-fields" open={open}>
        <summary>Cell fields</summary>
        <pre>{JSON.stringify(fields, null, 2)}</pre>
    </details>;
}
