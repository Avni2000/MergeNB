/**
 * @file CellContent.tsx
 * @description React component for rendering notebook cell content.
 */

import React, { useEffect, useRef, useMemo, useState } from 'react';
import type { NotebookCell, CellOutput } from './types';
import { normalizeCellSource } from '../../notebookUtils';
import { renderMarkdown, escapeHtml } from './markdown';
import { computeLineDiff, getDiffLineClass } from './diff';
import DOMPurify from 'dompurify';

// Augment window type for MathJax
declare global {
    interface Window {
        rerenderMath?: () => Promise<void>;
        mathJaxReady?: boolean;
        MathJax?: {
            typesetPromise: (elements?: HTMLElement[]) => Promise<void>;
        };
    }
}

// Debounce utility for MathJax rendering
let mathJaxRenderTimeout: ReturnType<typeof setTimeout> | null = null;
const pendingMathJaxElements = new Set<HTMLElement>();

function queueMathJaxRender(element: HTMLElement): void {
    pendingMathJaxElements.add(element);
    
    if (mathJaxRenderTimeout) {
        clearTimeout(mathJaxRenderTimeout);
    }
    
    mathJaxRenderTimeout = setTimeout(() => {
        if (window.MathJax && window.mathJaxReady && pendingMathJaxElements.size > 0) {
            const elementsToRender = Array.from(pendingMathJaxElements);
            pendingMathJaxElements.clear();
            
            // Batch render all pending elements
            window.MathJax.typesetPromise(elementsToRender).catch((err: Error) => {
                console.error('MathJax batch render error:', err);
            });
        }
        mathJaxRenderTimeout = null;
    }, 100); // 100ms debounce
}

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

    const cellClasses = [
        'notebook-cell',
        `${cellType}-cell`,
        isConflict && 'has-conflict'
    ].filter(Boolean).join(' ');

    // For non-visible cells, render a minimal placeholder to maintain layout
    if (!isVisible && cellType === 'markdown') {
        return (
            <div className={cellClasses} data-lazy="true">
                <div className="cell-content">
                    <div style={{ minHeight: '50px', opacity: 0.3 }}>
                        <pre>{source.substring(0, 100)}...</pre>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div 
            className={cellClasses}
            draggable={isConflict && !!onDragStart}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
        >
            <div className="cell-content">
                {cellType === 'markdown' ? (
                    <MarkdownContent source={source} isVisible={isVisible} />
                ) : isConflict && compareCell ? (
                    <DiffContent source={source} compareSource={normalizeCellSource(compareCell.source)} side={side} />
                ) : (
                    <pre>{source}</pre>
                )}
            </div>
            {showOutputs && cellType === 'code' && cell.outputs && cell.outputs.length > 0 && (
                <CellOutputs outputs={cell.outputs} isVisible={isVisible} />
            )}
        </div>
    );
}

interface MarkdownContentProps {
    source: string;
    isVisible?: boolean;
}

function MarkdownContent({ source, isVisible = true }: MarkdownContentProps): React.ReactElement {
    const containerRef = useRef<HTMLDivElement>(null);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const [isInView, setIsInView] = useState(false);
    
    // Memoize HTML rendering to avoid re-parsing on every render
    const html = useMemo(() => renderMarkdown(source), [source]);

    useEffect(() => {
        if (!containerRef.current) return;

        // Set up intersection observer for lazy MathJax rendering
        observerRef.current = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        setIsInView(true);
                        // Queue MathJax rendering only when element is visible
                        if (window.mathJaxReady && containerRef.current) {
                            queueMathJaxRender(containerRef.current);
                        }
                    }
                });
            },
            { rootMargin: '200px' } // Pre-render 200px before entering viewport
        );

        observerRef.current.observe(containerRef.current);

        return () => {
            if (observerRef.current) {
                observerRef.current.disconnect();
            }
        };
    }, []);

    // Re-render MathJax when HTML content changes and element is in view
    useEffect(() => {
        if (isInView && containerRef.current && window.mathJaxReady) {
            queueMathJaxRender(containerRef.current);
        }
    }, [html, isInView]);

    return (
        <div
            ref={containerRef}
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
    isVisible?: boolean;
}

function CellOutputs({ outputs, isVisible = true }: CellOutputsProps): React.ReactElement {
    // For non-visible outputs, render minimal placeholder
    if (!isVisible && outputs.length > 0) {
        return (
            <div className="cell-outputs" style={{ minHeight: '30px', opacity: 0.3 }}>
                <pre>({outputs.length} output{outputs.length > 1 ? 's' : ''})</pre>
            </div>
        );
    }

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
        const traceback = output.traceback?.join('\n') || `${output.ename}: ${output.evalue}`;
        return <pre className="error-output">{traceback}</pre>;
    }

    return null;
}
