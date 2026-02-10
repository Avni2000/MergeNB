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

// Performance tuning constants
const LAZY_PREVIEW_LENGTH = 100; // Characters to show in lazy-loaded markdown preview

interface CellContentProps {
    cell: NotebookCell | undefined;
    cellIndex?: number;
    side: 'base' | 'current' | 'incoming';
    isConflict?: boolean;
    compareCell?: NotebookCell;
    showOutputs?: boolean;
    onDragStart?: (e: React.DragEvent) => void;
    onDragEnd?: () => void;
    isVisible?: boolean; // For lazy rendering optimization
}

export function CellContent({
    cell,
    cellIndex,
    side,
    isConflict = false,
    compareCell,
    showOutputs = true,
    onDragStart,
    onDragEnd,
    isVisible = true,
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
    const encodedCell = encodeURIComponent(JSON.stringify(cell));

    const cellClasses = [
        'notebook-cell',
        `${cellType}-cell`,
        isConflict && 'has-conflict'
    ].filter(Boolean).join(' ');

    // For non-visible cells, render a minimal placeholder to maintain layout.
    // Keep data attributes + drag handlers so tests and drag/drop remain stable.
    if (!isVisible && cellType === 'markdown') {
        return (
            <div
                className={cellClasses}
                data-lazy="true"
                draggable={Boolean(isConflict && onDragStart)}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                data-cell={encodedCell}
                data-cell-type={cellType}
            >
                <div className="cell-content">
                    <div style={{ minHeight: '50px', opacity: 0.3 }}>
                        <pre>{source.length > LAZY_PREVIEW_LENGTH ? `${source.substring(0, LAZY_PREVIEW_LENGTH)}...` : source}</pre>
                    </div>
                </div>
            </div>
        );
    }

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
    // Memoize HTML rendering to avoid re-parsing on every render
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
    side: 'base' | 'current' | 'incoming';
}

function DiffContent({ source, compareSource, side }: DiffContentProps): React.ReactElement {
    const diff = computeLineDiff(compareSource, source);
    // Use the right side for display (shows the "new" content with change markers)
    const diffLines = diff.right;
    // Filter out empty alignment lines to avoid unnecessary whitespace
    const visibleLines = diffLines.filter(line => line.type !== 'unchanged' || line.content !== '');

    return (
        <pre>
            {visibleLines.map((line, i) => (
                <React.Fragment key={i}>
                    <span className={getDiffLineClass(line, side)}>
                        {line.inlineChanges ? (
                            line.inlineChanges.map((change, j) => (
                                <span key={j} className={getInlineChangeClass(change.type, side)}>
                                    {change.text}
                                </span>
                            ))
                        ) : (
                            line.content
                        )}
                    </span>
                    {i < visibleLines.length - 1 ? '\n' : ''}
                </React.Fragment>
            ))}
        </pre>
    );
}

/**
 * Get CSS class for diff line based on type and side.
 */
function getDiffLineClass(line: DiffLine, side: 'base' | 'current' | 'incoming'): string {
    switch (line.type) {
        case 'unchanged':
            return 'diff-line';
        case 'added':
            return 'diff-line added';
        case 'removed':
            return 'diff-line removed';
        case 'modified':
            // Modified lines show inline changes
            return side === 'current' ? 'diff-line modified-old' : 'diff-line modified-new';
        default:
            return 'diff-line';
    }
}

function getInlineChangeClass(type: 'unchanged' | 'added' | 'removed', side: 'base' | 'current' | 'incoming'): string {
    switch (type) {
        case 'unchanged':
            return 'diff-inline-unchanged';
        case 'added':
            return 'diff-inline-added';
        case 'removed':
            return 'diff-inline-removed';
        default:
            return '';
    }
}

interface CellOutputsProps {
    outputs: CellOutput[];
}

function CellOutputs({ outputs }: CellOutputsProps): React.ReactElement {
    // Always render outputs consistently without CSS changes that trigger ResizeObserver.
    // Using text placeholders for images prevents browser decoding and size oscillation.
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
 */
function ImagePlaceholder({ mimeType }: { mimeType: string }): React.ReactElement {
    const placeholderText = `![Image: ${mimeType}]`;
    return (
        <div 
            className="image-placeholder"
            role="img"
            aria-label={`Image output of type ${mimeType}`}
        >
            {placeholderText}
        </div>
    );
}
