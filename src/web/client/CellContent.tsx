/**
 * @file CellContent.tsx
 * @description React component for rendering notebook cell content.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { StateField, RangeSetBuilder } from '@codemirror/state';
import { IRenderMime, MimeModel, OutputModel, RenderMimeRegistry, standardRendererFactories } from '@jupyterlab/rendermime';
import { Widget } from '@lumino/widgets';
import MarkdownIt from 'markdown-it';
import renderMathInElement from 'katex/contrib/auto-render';
import type { NotebookCell, CellOutput } from './types';
import { normalizeCellSource } from '../../notebookUtils';
import { computeLineDiff, type DiffLine } from '../../diffUtils';
import * as logger from '../../logger';
import { createMergeNBTheme, mergeNBEditorStructure } from './editorTheme';

type RenderMimeOutputValue = ConstructorParameters<typeof OutputModel>[0]['value'];
const renderMimeRegistryCache = new Map<string, RenderMimeRegistry>();
const MAX_RENDERMIME_REGISTRY_CACHE_SIZE = 32;
const renderMimeMd = MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
});
const renderMimeMarkdownParser = {
    async render(source: string): Promise<string> {
        return renderMimeMd.render(source);
    }
};
const renderMimeKatexTypesetter: IRenderMime.ILatexTypesetter = {
    typeset(element: HTMLElement): void {
        renderMathInElement(element, {
            throwOnError: false,
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '\\[', right: '\\]', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\(', right: '\\)', display: false },
            ],
        });
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
    showCellHeaders?: boolean;
    kernelLanguage?: string;
    theme?: 'dark' | 'light';
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
    showCellHeaders = false,
    kernelLanguage,
    theme = 'light',
}: CellContentProps): React.ReactElement {
    const renderMimeRegistry = useMemo(
        () => getRenderMimeRegistry(notebookPath),
        [notebookPath]
    );
    const encodedCell = useMemo(
        () => (cell ? encodeURIComponent(JSON.stringify(cell)) : ''),
        [cell]
    );

    // Load syntax language extension for CodeMirror code cells.
    // Must be declared before any early returns (Rules of Hooks).
    const [langExtension, setLangExtension] = useState<any[]>([]);
    useEffect(() => {
        if (!kernelLanguage) return;
        const desc = LanguageDescription.matchLanguageName(languages, kernelLanguage, true);
        desc?.load().then(lang => setLangExtension([lang]));
    }, [kernelLanguage]);

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

    return (
        <div
            className={cellClasses}
            data-cell={encodedCell}
            data-cell-type={cellType}
        >
            {showCellHeaders && (
                <div className="cell-header" data-testid="cell-header">
                    <span className="cell-header-type">{cellType}</span>
                    {cellIndex !== undefined && (
                        <span className="cell-header-index">Cell {cellIndex + 1}</span>
                    )}
                    {cellType === 'code' && cell.execution_count != null && (
                        <span className="cell-header-exec">In [{cell.execution_count}]</span>
                    )}
                </div>
            )}
            <div className="cell-content">
                {cellType === 'markdown' && !isConflict ? (
                    <MarkdownContent
                        source={source}
                        renderMimeRegistry={renderMimeRegistry}
                    />
                ) : isConflict && (compareCell || baseCell) ? (
                    // Show conflict diffs with syntax highlighting + diff decorations
                    <DiffContent
                        source={source}
                        compareSource={normalizeCellSource((compareCell ?? baseCell)!.source)}
                        side={side}
                        diffMode={diffMode}
                        langExtension={langExtension}
                        theme={theme}
                    />
                ) : cellType !== 'markdown' ? (
                    // Non-markdown cells: syntax-highlighted read-only CodeMirror
                    <CodeMirror
                        value={source}
                        readOnly={true}
                        editable={false}
                        extensions={[...langExtension, mergeNBEditorStructure]}
                        theme={createMergeNBTheme(theme)}
                        basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
                        className="cell-source-cm"
                    />
                ) : (
                    // Markdown in conflict mode: plain pre (diff view takes over)
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
        if (!host || !host.isConnected) return;

        host.replaceChildren();
        setFallback(null);

        let disposed = false;
        let renderer: ReturnType<RenderMimeRegistry['createRenderer']> | null = null;
        let model: (MimeModel & { dispose?: () => void }) | null = null;

        try {
            model = new MimeModel({
                data: { 'text/markdown': source },
                trusted: false,
            });

            renderer = renderMimeRegistry.createRenderer('text/markdown');
            Widget.attach(renderer, host);

            void renderer.renderModel(model).catch((err: unknown) => {
                logger.warn('[MergeNB] Failed to render markdown via rendermime:', err);
                if (!disposed) {
                    disposeRenderer(renderer, host);
                    model?.dispose?.();
                    model = null;
                    renderer = null;
                    setFallback(source);
                }
            });
        } catch (err) {
            logger.warn('[MergeNB] Failed to initialize rendermime markdown renderer:', err);
            disposeRenderer(renderer, host);
            model?.dispose?.();
            model = null;
            setFallback(source);
            return;
        }

        return () => {
            disposed = true;
            disposeRenderer(renderer, host);
            model?.dispose?.();
            model = null;
            host.replaceChildren();
        };
    }, [source, renderMimeRegistry]);

    return (
        <div className="markdown-content">
            <div ref={hostRef} />
            {fallback && <pre className="cell-output-fallback">{fallback}</pre>}
        </div>
    );
}

interface DiffContentProps {
    source: string;
    compareSource: string;
    side?: 'base' | 'current' | 'incoming';
    diffMode: 'base' | 'conflict';
    langExtension: any[];
    theme: 'dark' | 'light';
}

/**
 * Build a CodeMirror StateField extension that decorates changed lines and
 * inline character ranges using the same CSS classes as the previous <pre>
 * implementation.  Syntax highlighting from the language extension is layered
 * underneath — the diff decorations only add backgrounds, not text colours.
 */
function createDiffExtension(
    allDiffLines: DiffLine[],
    side: 'base' | 'current' | 'incoming',
    diffMode: 'base' | 'conflict',
): DecorationSet {
    return StateField.define<DecorationSet>({
        create(state) {
            const builder = new RangeSetBuilder<Decoration>();
            // allDiffLines maps 1:1 to source lines — must NOT be pre-filtered.
            // Using a filtered array breaks the index→line-number correspondence and
            // causes inline mark `to` values to exceed the next line's `from`,
            // which throws "Ranges must be added sorted by from position and startSide".
            for (let i = 0; i < allDiffLines.length; i++) {
                if (i >= state.doc.lines) break;
                const diffLine = allDiffLines[i];
                if (diffLine.type === 'unchanged') continue;

                const line = state.doc.line(i + 1);
                const whitespaceOnly = isWhitespaceOnlyLineChange(diffLine);
                const lineClass = getDiffLineClass(diffLine, side, diffMode, whitespaceOnly);
                builder.add(line.from, line.from, Decoration.line({ class: lineClass }));

                if (diffLine.inlineChanges) {
                    let pos = line.from;
                    for (const change of diffLine.inlineChanges) {
                        const end = Math.min(pos + change.text.length, line.to);
                        if (change.type !== 'unchanged' && end > pos) {
                            const inlineClass = getInlineChangeClass(change.type, side, diffMode, whitespaceOnly);
                            builder.add(pos, end, Decoration.mark({ class: inlineClass }));
                        }
                        pos = pos + change.text.length;
                        if (pos >= line.to) break;
                    }
                }
            }
            return builder.finish();
        },
        update(deco) { return deco; },
        provide: f => EditorView.decorations.from(f),
    }) as unknown as DecorationSet; // StateField satisfies Extension; cast for useMemo typing
}

function DiffContent({ source, compareSource, side, diffMode, langExtension, theme }: DiffContentProps): React.ReactElement {
    const diff = useMemo(() => computeLineDiff(compareSource, source), [compareSource, source]);
    const diffExtension = useMemo(
        () => createDiffExtension(diff.right, side ?? 'current', diffMode),
        [diff.right, side, diffMode]
    );

    return (
        <CodeMirror
            value={source}
            readOnly={true}
            editable={false}
            extensions={[...langExtension, mergeNBEditorStructure, diffExtension]}
            theme={createMergeNBTheme(theme)}
            basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
            className="cell-source-cm"
        />
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
                <RenderMimeOutput
                    key={i}
                    output={output}
                    renderMimeRegistry={renderMimeRegistry}
                />
            ))}
        </div>
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
        if (!host || !host.isConnected) return;
        host.replaceChildren();
        setFallback(null);

        let disposed = false;
        let renderer: ReturnType<RenderMimeRegistry['createRenderer']> | null = null;
        let model: OutputModel | null = null;

        try {
            const normalizedOutput = normalizeOutputForRenderMime(output) as RenderMimeOutputValue;

            const untrustedModel = new OutputModel({
                value: normalizedOutput,
                trusted: false,
            });

            const preferredMimeType = renderMimeRegistry.preferredMimeType(untrustedModel.data, 'any');
            if (!preferredMimeType) {
                setFallback(getOutputTextFallback(output));
                untrustedModel.dispose();
                return;
            }

            const trusted = shouldTrustOutputMimeType(preferredMimeType);
            if (trusted) {
                // Jupyter's HTML renderer evaluates inline scripts for trusted output.
                // Keep HTML and other rich outputs untrusted; only SVG requires trust
                // to avoid rendermime's "Cannot display an untrusted SVG" fallback.
                untrustedModel.dispose();
                model = new OutputModel({
                    value: normalizedOutput,
                    trusted: true,
                });
            } else {
                model = untrustedModel;
            }

            renderer = renderMimeRegistry.createRenderer(preferredMimeType);

            Widget.attach(renderer, host);

            void renderer.renderModel(model).catch((err: unknown) => {
                logger.warn('[MergeNB] Failed to render output via rendermime:', err);
                if (!disposed) {
                    disposeRenderer(renderer, host);
                    renderer = null;
                    model?.dispose();
                    model = null;
                    setFallback(getOutputTextFallback(output));
                }
            });
        } catch (err) {
            logger.warn('[MergeNB] Failed to initialize rendermime output model:', err);
            setFallback(getOutputTextFallback(output));
            disposeRenderer(renderer, host);
            model?.dispose();
            return;
        }

        return () => {
            disposed = true;
            disposeRenderer(renderer, host);
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
        if (Array.isArray(output.traceback)) {
            return output.traceback.join('\n');
        }

        const errorParts = [output.ename, output.evalue]
            .filter((part): part is string => typeof part === 'string' && part.trim() !== '');
        return errorParts.length > 0 ? errorParts.join(': ') : 'Error';
    }

    if ((output.output_type === 'display_data' || output.output_type === 'execute_result') && output.data) {
        const plainText = output.data['text/plain'];
        if (plainText !== undefined) {
            return String(normalizeMimeValue(plainText));
        }
    }

    return '[Unsupported output]';
}

function shouldTrustOutputMimeType(mimeType: string): boolean {
    return mimeType === 'image/svg+xml';
}

function getCurrentSessionCredentials(): { sessionId: string; token: string } {
    if (typeof window === 'undefined') return { sessionId: 'default', token: '' };
    const params = new URLSearchParams(window.location.search);
    return {
        sessionId: params.get('session') || 'default',
        token: params.get('token') || '',
    };
}

function getRenderMimeRegistry(notebookPath?: string): RenderMimeRegistry {
    const { sessionId, token } = getCurrentSessionCredentials();
    const cacheKey = `${sessionId}::${token}::${notebookPath ?? ''}`;
    const cached = renderMimeRegistryCache.get(cacheKey);
    if (cached) {
        renderMimeRegistryCache.delete(cacheKey);
        renderMimeRegistryCache.set(cacheKey, cached);
        return cached;
    }

    const registry = new RenderMimeRegistry({
        initialFactories: standardRendererFactories,
        resolver: createNotebookAssetResolver(sessionId, token),
        latexTypesetter: renderMimeKatexTypesetter,
        markdownParser: renderMimeMarkdownParser,
    });

    renderMimeRegistryCache.set(cacheKey, registry);
    evictRenderMimeRegistryCacheEntries();
    return registry;
}

function evictRenderMimeRegistryCacheEntries(): void {
    while (renderMimeRegistryCache.size > MAX_RENDERMIME_REGISTRY_CACHE_SIZE) {
        const leastRecentlyUsedKey = renderMimeRegistryCache.keys().next().value as string | undefined;
        if (!leastRecentlyUsedKey) return;

        const leastRecentlyUsedRegistry = renderMimeRegistryCache.get(leastRecentlyUsedKey);
        renderMimeRegistryCache.delete(leastRecentlyUsedKey);
        disposeRenderMimeRegistry(leastRecentlyUsedRegistry);
    }
}

function disposeRenderMimeRegistry(registry: RenderMimeRegistry | undefined): void {
    if (!registry) return;

    const resolver = registry.resolver as (IRenderMime.IResolver & { dispose?: () => void }) | null;
    try {
        resolver?.dispose?.();
    } catch (err) {
        logger.warn('[MergeNB] Failed to dispose rendermime resolver:', err);
    }

    const disposableRegistry = registry as RenderMimeRegistry & { dispose?: () => void };
    try {
        disposableRegistry.dispose?.();
    } catch (err) {
        logger.warn('[MergeNB] Failed to dispose rendermime registry:', err);
    }
}

function createNotebookAssetResolver(sessionId: string, token: string): IRenderMime.IResolver {
    return {
        async resolveUrl(url: string): Promise<string> {
            return normalizeLocalPath(url);
        },
        async getDownloadUrl(urlPath: string): Promise<string> {
            return buildNotebookAssetUrl(sessionId, token, urlPath);
        },
        isLocal(url: string, allowRoot = false): boolean {
            return isNotebookLocalPath(url, allowRoot);
        },
    };
}

function buildNotebookAssetUrl(sessionId: string, token: string, pathValue: string): string {
    const params = new URLSearchParams({
        session: sessionId,
        token,
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

function disposeRenderer(
    renderer: ReturnType<RenderMimeRegistry['createRenderer']> | null,
    host: HTMLElement
): void {
    if (!renderer) return;

    try {
        if (renderer.isAttached && renderer.node.isConnected) {
            Widget.detach(renderer);
        } else if (renderer.node.parentElement === host) {
            host.removeChild(renderer.node);
        }
    } catch (err) {
        logger.warn('[MergeNB] Failed to detach rendermime renderer:', err);
        if (renderer.node.parentElement === host) {
            host.removeChild(renderer.node);
        }
    }

    try {
        renderer.dispose();
    } catch (err) {
        logger.warn('[MergeNB] Failed to dispose rendermime renderer:', err);
    }
}

export const CellContent = React.memo(CellContentInner);
