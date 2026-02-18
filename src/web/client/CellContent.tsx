/**
 * @file CellContent.tsx
 * @description React component for rendering notebook cell content.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { OutputModel, RenderMimeRegistry, standardRendererFactories } from '@jupyterlab/rendermime';
import type { NotebookCell, CellOutput } from './types';
import { normalizeCellSource } from '../../notebookUtils';
import { renderMarkdown } from './markdown';
import { computeLineDiff, type DiffLine } from '../../diffUtils';

type RenderMimeOutputValue = ConstructorParameters<typeof OutputModel>[0]['value'];
const renderMimeRegistryCache = new Map<string, RenderMimeRegistry>();
const renderMimeMarkdownParser = {
    async render(source: string): Promise<string> {
        return renderMarkdown(source);
    }
};

interface CellContentProps {
    cell: NotebookCell | undefined;
    cellIndex?: number;
    side: 'base' | 'current' | 'incoming';
    notebookPath?: string;
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
    notebookPath,
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
    const renderMimeRegistry = useMemo(
        () => getRenderMimeRegistry(notebookPath),
        [notebookPath]
    );
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
                    <MarkdownContent
                        source={source}
                        renderMimeRegistry={renderMimeRegistry}
                    />
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
                <CellOutputs
                    outputs={cell.outputs}
                    renderMimeRegistry={renderMimeRegistry}
                />
            )}
        </div>
    );
}

interface MarkdownContentProps {
    source: string;
    renderMimeRegistry: RenderMimeRegistry;
}

function MarkdownContent({ source, renderMimeRegistry }: MarkdownContentProps): React.ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);
    const [fallback, setFallback] = useState<string | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        host.replaceChildren();
        setFallback(null);

        let disposed = false;
        let renderer: ReturnType<RenderMimeRegistry['createRenderer']> | null = null;
        let model: OutputModel | null = null;

        try {
            model = new OutputModel({
                value: {
                    output_type: 'display_data',
                    data: { 'text/markdown': source },
                    metadata: {},
                } as RenderMimeOutputValue,
                trusted: false,
            });

            const preferredMimeType = renderMimeRegistry.preferredMimeType(model.data, 'any') ?? 'text/markdown';
            renderer = renderMimeRegistry.createRenderer(preferredMimeType);

            void renderer.renderModel(model).then(() => {
                if (disposed || !hostRef.current || !renderer) return;
                hostRef.current.replaceChildren(renderer.node);
            }).catch((err: unknown) => {
                console.warn('[MergeNB] Failed to render markdown via rendermime:', err);
                if (!disposed) {
                    setFallback(source);
                }
            });
        } catch (err) {
            console.warn('[MergeNB] Failed to initialize markdown rendermime model:', err);
            setFallback(source);
            renderer?.dispose();
            model?.dispose();
            return;
        }

        return () => {
            disposed = true;
            renderer?.dispose();
            model?.dispose();
            host.replaceChildren();
        };
    }, [source, renderMimeRegistry]);

    return (
        <div className="markdown-content">
            <div ref={hostRef} className="markdown-content-host" />
            {fallback && <pre>{fallback}</pre>}
        </div>
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
    renderMimeRegistry: RenderMimeRegistry;
}

function CellOutputs({ outputs, renderMimeRegistry }: CellOutputsProps): React.ReactElement {
    return (
        <div className="cell-outputs">
            {outputs.map((output, i) => (
                <OutputItem
                    key={i}
                    output={output}
                    renderMimeRegistry={renderMimeRegistry}
                />
            ))}
        </div>
    );
}

function OutputItem({
    output,
    renderMimeRegistry
}: {
    output: CellOutput;
    renderMimeRegistry: RenderMimeRegistry;
}): React.ReactElement {
    return (
        <RenderMimeOutput
            output={output}
            renderMimeRegistry={renderMimeRegistry}
        />
    );
}

function RenderMimeOutput({
    output,
    renderMimeRegistry
}: {
    output: CellOutput;
    renderMimeRegistry: RenderMimeRegistry;
}): React.ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);
    const [fallback, setFallback] = useState<string | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        host.replaceChildren();
        setFallback(null);

        let disposed = false;
        let renderer: ReturnType<RenderMimeRegistry['createRenderer']> | null = null;
        let model: OutputModel | null = null;

        try {
            const normalizedOutput = normalizeOutputForRenderMime(output) as RenderMimeOutputValue;

            // Use trusted: true so that rich MIME types (text/html, image/svg+xml,
            // application/json, etc.) are not silently downgraded or filtered.
            // Outputs come from the user's own local git repository, so the threat
            // surface is equivalent to opening a notebook in a local Jupyter server.
            model = new OutputModel({
                value: normalizedOutput,
                trusted: true,
            });

            const preferredMimeType = renderMimeRegistry.preferredMimeType(model.data, 'any');
            if (!preferredMimeType) {
                setFallback(getOutputTextFallback(output));
                model.dispose();
                return;
            }

            renderer = renderMimeRegistry.createRenderer(preferredMimeType);

            void renderer.renderModel(model).then(() => {
                if (disposed || !hostRef.current || !renderer) return;
                hostRef.current.replaceChildren(renderer.node);
            }).catch((err: unknown) => {
                console.warn('[MergeNB] Failed to render output via rendermime:', err);
                if (!disposed) {
                    setFallback(getOutputTextFallback(output));
                }
            });
        } catch (err) {
            console.warn('[MergeNB] Failed to initialize rendermime output model:', err);
            setFallback(getOutputTextFallback(output));
            renderer?.dispose();
            model?.dispose();
            return;
        }

        return () => {
            disposed = true;
            renderer?.dispose();
            model?.dispose();
            host.replaceChildren();
        };
    }, [output, renderMimeRegistry]);

    return (
        <div className="cell-output-item">
            <div className="cell-output-host" ref={hostRef} />
            {fallback && <pre className="cell-output-fallback">{fallback}</pre>}
        </div>
    );
}

function normalizeOutputForRenderMime(output: CellOutput): Record<string, unknown> {
    const normalizedOutput = { ...(output as unknown as Record<string, unknown>) };

    if (output.text !== undefined) {
        normalizedOutput.text = normalizeTextValue(output.text);
    }

    if (output.data) {
        const normalizedData: Record<string, unknown> = {};
        for (const [mimeType, value] of Object.entries(output.data)) {
            normalizedData[mimeType] = normalizeMimeValue(value);
        }
        normalizedOutput.data = normalizedData;
    }

    return normalizedOutput;
}

function normalizeTextValue(value: string | string[]): string {
    return Array.isArray(value) ? value.join('') : value;
}

function normalizeMimeValue(value: unknown): unknown {
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
        return value.join('');
    }
    return value;
}

function getOutputTextFallback(output: CellOutput): string {
    if (output.output_type === 'stream' && output.text) {
        return normalizeTextValue(output.text);
    }

    if (output.output_type === 'error') {
        return Array.isArray(output.traceback)
            ? output.traceback.join('\n')
            : (output.traceback ?? `${output.ename}: ${output.evalue}`);
    }

    if ((output.output_type === 'display_data' || output.output_type === 'execute_result') && output.data) {
        const plainText = output.data['text/plain'];
        if (plainText !== undefined) {
            return String(normalizeMimeValue(plainText));
        }
    }

    return '[Unsupported output]';
}

function getCurrentSessionId(): string {
    if (typeof window === 'undefined') return 'default';
    const params = new URLSearchParams(window.location.search);
    return params.get('session') || 'default';
}

function getRenderMimeRegistry(notebookPath?: string): RenderMimeRegistry {
    const sessionId = getCurrentSessionId();
    const cacheKey = `${sessionId}::${notebookPath ?? ''}`;
    const cached = renderMimeRegistryCache.get(cacheKey);
    if (cached) return cached;

    const registry = new RenderMimeRegistry({
        initialFactories: standardRendererFactories,
        resolver: createNotebookAssetResolver(sessionId, notebookPath),
        markdownParser: renderMimeMarkdownParser,
    });
    renderMimeRegistryCache.set(cacheKey, registry);
    return registry;
}

function createNotebookAssetResolver(
    sessionId: string,
    notebookPath?: string
): {
    resolveUrl: (url: string) => Promise<string>;
    getDownloadUrl: (urlPath: string) => Promise<string>;
    isLocal: (url: string, allowRoot?: boolean) => boolean;
} | undefined {
    if (!notebookPath) return undefined;

    return {
        async resolveUrl(url: string): Promise<string> {
            return normalizeLocalPath(url) || url;
        },
        async getDownloadUrl(urlPath: string): Promise<string> {
            const normalizedPath = normalizeLocalPath(urlPath);
            if (!normalizedPath) return urlPath;

            const relativePath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;
            if (!isNotebookLocalPath(relativePath, true)) {
                return urlPath;
            }
            return buildNotebookAssetUrl(sessionId, relativePath);
        },
        isLocal(url: string, allowRoot = false): boolean {
            return isNotebookLocalPath(url, allowRoot);
        },
    };
}

function buildNotebookAssetUrl(sessionId: string, pathValue: string): string {
    const params = new URLSearchParams({
        session: sessionId,
        path: pathValue,
    });
    return `/notebook-asset?${params.toString()}`;
}

function isNotebookLocalPath(url: string, allowRoot = false): boolean {
    const normalized = normalizeLocalPath(url);
    if (!normalized) return false;
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(normalized)) return false;
    if (normalized.startsWith('//')) return false;
    if (!allowRoot && normalized.startsWith('/')) return false;
    return true;
}

function normalizeLocalPath(url: string): string {
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('#')) return '';

    const withoutHash = trimmed.split('#', 1)[0];
    const withoutQuery = withoutHash.split('?', 1)[0];
    if (!withoutQuery) return '';

    try {
        return decodeURIComponent(withoutQuery);
    } catch {
        return withoutQuery;
    }
}

export const CellContent = React.memo(CellContentInner);
