/**
 * @file CellContent.tsx
 * @description React component for rendering notebook cell content.
 */

import React from 'react';
import type { NotebookCell, CellOutput } from './types';
import { normalizeCellSource } from '../../notebookUtils';
import { renderMarkdown, escapeHtml } from './markdown';
import { computeLineDiff, getDiffLineClass } from './diff';

interface CellContentProps {
    cell: NotebookCell | undefined;
    cellIndex?: number;
    side: 'base' | 'current' | 'incoming';
    isConflict?: boolean;
    compareCell?: NotebookCell;
    showOutputs?: boolean;
}

export function CellContent({
    cell,
    cellIndex,
    side,
    isConflict = false,
    compareCell,
    showOutputs = true,
}: CellContentProps): React.ReactElement {
    if (!cell) {
        return (
            <div className="cell-placeholder">
                <span>(not present)</span>
            </div>
        );
    }

    const source = normalizeCellSource(cell.source);
    const cellType = cell.cell_type;

    return (
        <div className={`notebook-cell ${cellType}-cell ${isConflict ? 'has-conflict' : ''}`}>
            <div className="cell-content">
                {cellType === 'markdown' ? (
                    <MarkdownContent source={source} />
                ) : isConflict && compareCell ? (
                    <DiffContent source={source} compareSource={normalizeCellSource(compareCell.source)} side={side} />
                ) : (
                    <pre>{source}</pre>
                )}
            </div>
            {showOutputs && cellType === 'code' && cell.outputs && cell.outputs.length > 0 && (
                <CellOutputs outputs={cell.outputs} />
            )}
        </div>
    );
}

interface MarkdownContentProps {
    source: string;
}

function MarkdownContent({ source }: MarkdownContentProps): React.ReactElement {
    const html = renderMarkdown(source);
    return (
        <div
            className="markdown-content"
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}

interface DiffContentProps {
    source: string;
    compareSource: string;
    side: 'base' | 'current' | 'incoming';
}

function DiffContent({ source, compareSource, side }: DiffContentProps): React.ReactElement {
    const diffLines = computeLineDiff(compareSource, source);

    return (
        <pre>
            {diffLines.map((line, i) => (
                <span key={i} className={getDiffLineClass(line, side)}>
                    {line.content}
                    {i < diffLines.length - 1 ? '\n' : ''}
                </span>
            ))}
        </pre>
    );
}

interface CellOutputsProps {
    outputs: CellOutput[];
}

function CellOutputs({ outputs }: CellOutputsProps): React.ReactElement {
    return (
        <div className="cell-outputs">
            {outputs.map((output, i) => (
                <OutputItem key={i} output={output} />
            ))}
        </div>
    );
}

function OutputItem({ output }: { output: CellOutput }): React.ReactElement | null {
    if (output.output_type === 'stream' && output.text) {
        const text = Array.isArray(output.text) ? output.text.join('') : output.text;
        return <pre>{text}</pre>;
    }

    if ((output.output_type === 'display_data' || output.output_type === 'execute_result') && output.data) {
        const data = output.data;

        // Try image first
        if (data['image/png']) {
            return <img src={`data:image/png;base64,${data['image/png']}`} alt="output" />;
        }
        if (data['image/jpeg']) {
            return <img src={`data:image/jpeg;base64,${data['image/jpeg']}`} alt="output" />;
        }

        // HTML
        if (data['text/html']) {
            const html = Array.isArray(data['text/html']) ? data['text/html'].join('') : String(data['text/html']);
            return <div dangerouslySetInnerHTML={{ __html: html }} />;
        }

        // Plain text
        if (data['text/plain']) {
            const text = Array.isArray(data['text/plain']) ? data['text/plain'].join('') : String(data['text/plain']);
            return <pre>{text}</pre>;
        }
    }

    if (output.output_type === 'error') {
        const traceback = output.traceback?.join('\n') || `${output.ename}: ${output.evalue}`;
        return <pre className="error-output">{traceback}</pre>;
    }

    return null;
}
