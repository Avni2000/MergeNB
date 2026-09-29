import React from 'react';
import { mergeNotebookFields, type NotebookSemanticConflict, type FieldConflict, type FieldResolutions, type FieldChoice } from '../../../../core/src';

interface Props {
    notebook: NotebookSemanticConflict;
    conflicts: FieldConflict[];
    choices: FieldResolutions;
    preferCurrentKernel: boolean;
    showBase: boolean;
    onSelect: (path: string[], choice: FieldChoice | undefined) => void;
}

export function NotebookFields({ notebook, conflicts, choices, preferCurrentKernel, showBase, onSelect }: Props): React.ReactElement {
    const merged = mergeNotebookFields(notebook, preferCurrentKernel, choices);
    return <section className="notebook-fields" aria-label="Notebook fields" data-notebook-fields={JSON.stringify(merged.value)}>
        {conflicts.map(field => {
            const key = JSON.stringify(field.path);
            return <div className="notebook-field-conflict" key={key} data-field-path={key}>
                <strong>{field.path.join(' → ')}</strong>
                <div className="notebook-field-options">
                    {(['base', 'current', 'incoming'] as const).filter(side => showBase || side !== 'base').map(side =>
                        <div key={side}>
                            <button className={`btn btn-${side}`} aria-pressed={choices[key] === side}
                                onClick={() => onSelect(field.path, side)}>Keep {side}</button>
                            <pre>{field[side] === undefined ? '(removed / absent)' : JSON.stringify(field[side], null, 2)}</pre>
                        </div>
                    )}
                </div>
                {choices[key] && <button className="btn" onClick={() => onSelect(field.path, undefined)}>Undo field resolution</button>}
            </div>;
        })}
        <details>
            <summary>Notebook fields {merged.conflicts.length ? '(unresolved)' : '(merged)'}</summary>
            <pre>{JSON.stringify(merged.value, null, 2)}</pre>
        </details>
    </section>;
}
