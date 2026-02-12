/**
 * @file CellContent.tsx
 * @description React component for rendering notebook cell content.
 */

import React, { useMemo } from 'react';
import type { NotebookCell, CellOutput } from './types';
import { normalizeCellSource } from '../../notebookUtils';
import { renderMarkdown } from './markdown';
import { computeLineDiff, type DiffLine } from '../../diffUtils';
import DOMPurify from 'dompurify';

interface CellContentProps {
    cell: NotebookCell | undefined;
    cellIndex?: number;
    side: 'base' | 'current' | 'incoming';
    isConflict?: boolean;
    compareCell?: NotebookCell;
    baseCell?: NotebookCell;
    diffMode?: 'base' | 'conflict';
    showOutputs?: boolean;
    onDragStart?: (e: React.DragEvent) => void;
    onDragEnd?: () => void;
}

export function CellContentInner({
    cell,
    cellIndex,
    side,
    isConflict = false,
    compareCell,
    baseCell,
    diffMode = 'base',
    showOutputs = true,
    onDragStart,
    onDragEnd,
}: CellContentProps): React.ReactElement {
    if (!cell) {
        return (
            <div className="cell-placeholder">
                <span className="placeholder-text">(not present)</span>
            </div>
        );
    }

    const source = normalizeCellSource(cell.source);
    const cellType = cell.cell_type;
    const encodedCell = useMemo(() => encodeURIComponent(JSON.stringify(cell)), [cell]);

    const cellClasses = [
        'notebook-cell',
        `${cellType}-cell`,
        isConflict && 'has-conflict'
    ].filter(Boolean).join(' ');

    return (
        <div
            className={cellClasses}
            draggable={Boolean(isConflict && onDragStart)}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            data-cell={encodedCell}
            data-cell-type={cellType}
        >
            <div className="cell-content">
                {cellType === 'markdown' && !isConflict ? (
                    <MarkdownContent source={source} />
                ) : isConflict && (compareCell || baseCell) ? (
                    // Show conflict diffs as raw text (no markdown rendering)
                    <DiffContent
                        source={source}
                        compareSource={normalizeCellSource((compareCell ?? baseCell)!.source)}
                        side={side}
                        diffMode={diffMode}
                    />
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
    const html = useMemo(() => renderMarkdown(source), [source]);

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
    side?: 'base' | 'current' | 'incoming';
    diffMode: 'base' | 'conflict';
}

function DiffContent({ source, compareSource, side, diffMode }: DiffContentProps): React.ReactElement {
    const diff = useMemo(() => computeLineDiff(compareSource, source), [compareSource, source]);
    // Use the right side for display (shows the "new" content with change markers)
    const diffLines = diff.right;
    // Filter out empty alignment lines to avoid unnecessary whitespace
    const visibleLines = diffLines.filter(line => line.type !== 'unchanged' || line.content !== '');

    return (
        <pre>
            {visibleLines.map((line, i) => {
                const whitespaceOnly = isWhitespaceOnlyLineChange(line);
                return (
                    <React.Fragment key={i}>
                        <span className={getDiffLineClass(line, side ?? 'current', diffMode, whitespaceOnly)}>
                            {line.inlineChanges ? (
                                line.inlineChanges.map((change, j) => (
                                    <span key={j} className={getInlineChangeClass(change.type, side ?? 'current', diffMode, whitespaceOnly)}>
                                        {change.text}
                                    </span>
                                ))
                            ) : (
                                line.content
                            )}
                        </span>
                        {i < visibleLines.length - 1 ? '\n' : ''}
                    </React.Fragment>
                );
            })}
        </pre>
    );
}

/**
 * Get CSS class for diff line based on type and side.
 * Branch-based coloring: green for current, blue for incoming.
 */
function getDiffLineClass(
    line: DiffLine,
    side: 'base' | 'current' | 'incoming',
    diffMode: 'base' | 'conflict',
    isWhitespaceOnly: boolean
): string {
    switch (line.type) {
        case 'unchanged':
            return 'diff-line';
        case 'added':
        case 'removed':
        case 'modified':
            if (diffMode === 'conflict' || isWhitespaceOnly) {
                return 'diff-line diff-line-conflict';
            }
            // Use branch-based coloring: the color tells you which branch the content comes from
            return side === 'current' ? 'diff-line diff-line-current' : 'diff-line diff-line-incoming';
        default:
            return 'diff-line';
    }
}

function getInlineChangeClass(
    type: 'unchanged' | 'added' | 'removed',
    side: 'base' | 'current' | 'incoming',
    diffMode: 'base' | 'conflict',
    isWhitespaceOnly: boolean
): string {
    switch (type) {
        case 'unchanged':
            return 'diff-inline-unchanged';
        case 'added':
        case 'removed':
            if (diffMode === 'conflict' || isWhitespaceOnly) {
                return 'diff-inline-conflict';
            }
            // Use branch-based coloring for inline changes too
            return side === 'current' ? 'diff-inline-current' : 'diff-inline-incoming';
        default:
            return '';
    }
}

function isWhitespaceOnlyLineChange(line: DiffLine): boolean {
    if (line.type === 'unchanged') return false;

    if (line.inlineChanges && line.inlineChanges.length > 0) {
        let hasChange = false;
        for (const change of line.inlineChanges) {
            if (change.type === 'unchanged') continue;
            if (change.text.trim() !== '') {
                return false;
            }
            hasChange = true;
        }
        return hasChange;
    }

    if (line.type === 'added' || line.type === 'removed') {
        return line.content.trim() === '' && line.content.length > 0;
    }

    return false;
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

        // Use text placeholders for images instead of rendering actual <img> tags.
        // This prevents browser decoding overhead, ResizeObserver feedback loops,
        // and flickering from invalid/broken image data.
        if (data['image/png']) {
            return <ImagePlaceholder mimeType="image/png" />;
        }
        if (data['image/jpeg']) {
            return <ImagePlaceholder mimeType="image/jpeg" />;
        }

        // HTML
        if (data['text/html']) {
            const html = Array.isArray(data['text/html']) ? data['text/html'].join('') : String(data['text/html']);
            const sanitizedHtml = DOMPurify.sanitize(html);
            return <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />;
        }

        // Plain text
        if (data['text/plain']) {
            const text = Array.isArray(data['text/plain']) ? data['text/plain'].join('') : String(data['text/plain']);
            return <pre>{text}</pre>;
        }
    }

    if (output.output_type === 'error') {
        const traceback = Array.isArray(output.traceback) ? output.traceback.join('\n') : (output.traceback ?? `${output.ename}: ${output.evalue}`);
        return <pre className="error-output">{traceback}</pre>;
    }

    return null;
}

/**
 * Renders a text placeholder for an image output.
 * Uses markdown-style format to provide a consistent, stable representation.
 * 
 * @param mimeType - Currently only 'image/png' or 'image/jpeg' are supported and passed by OutputItem
 */
function ImagePlaceholder({ mimeType }: { mimeType: string }): React.ReactElement {
    const placeholderText = `![Image: ${mimeType}]`;
    // Convert MIME type to user-friendly label for screen readers
    const imageType = mimeType === 'image/png' ? 'PNG' : 'JPEG';
    return (
        <div 
            className="image-placeholder"
            role="img"
            aria-label={`${imageType} image output`}
        >
            {placeholderText}
        </div>
    );
}

export const CellContent = React.memo(CellContentInner);
