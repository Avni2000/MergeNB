/**
 * @file CellContent.tsx
 * @description React component for rendering notebook cell content.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { StateField, RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { IRenderMime, OutputModel, RenderMimeRegistry, standardRendererFactories } from '@jupyterlab/rendermime';
import { Widget } from '@lumino/widgets';
import DOMPurify from 'dompurify';
import type { NotebookCell, CellOutput } from './types';
import { normalizeCellSource } from '../../notebookUtils';
import { diff as computeDiff, type Change } from '@codemirror/merge';
import * as logger from '../../logger';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import { classHighlighter } from '@lezer/highlight';
import { syntaxHighlighting } from '@codemirror/language';
import { renderMarkdown } from './markdown';


export const mergeNBEditorStructure: Extension = EditorView.theme({
    '&': { outline: 'none !important', backgroundColor: 'var(--cell-surface) !important' },
    '&.cm-focused': { outline: 'none !important' },
    '.cm-content': { fontFamily: 'var(--font-code)', fontSize: '13px', lineHeight: '1.5', padding: '0' },
    '.cm-line': { padding: '0' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
    '.cm-gutters': { display: 'none' },
});

export const mergeNBSyntaxClassHighlighter: Extension = syntaxHighlighting(classHighlighter);

type RenderMimeOutputValue = ConstructorParameters<typeof OutputModel>[0]['value'];
const renderMimeRegistryCache = new Map<string, RenderMimeRegistry>();
const MAX_RENDERMIME_REGISTRY_CACHE_SIZE = 32;

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
    languageExtensions?: Extension[];
    theme?: 'dark' | 'light';
}
const EMPTY_EXTENSIONS: Extension[] = [];
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
    languageExtensions = EMPTY_EXTENSIONS,
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

    // Memoize theme and extensions so @uiw/react-codemirror's internal useEffect
    // (deps: [theme, extensions, ...]) only fires StateEffect.reconfigure when
    // these values truly change — not on every render due to new object/array refs.
    const cmTheme = useMemo(() => theme === 'dark' ? githubDark : githubLight, [theme]);

    const cellType = cell?.cell_type || 'code';
    const cellExtensions = useMemo(
        () => [...(cellType === 'markdown' ? [] : languageExtensions), mergeNBSyntaxClassHighlighter, mergeNBEditorStructure],
        [languageExtensions, cellType]
    );

    if (!cell) {
        return (
            <div className="cell-placeholder">
                <span className="placeholder-text">(not present)</span>
            </div>
        );
    }

    const source = normalizeCellSource(cell.source);

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
                    />
                ) : isConflict && (compareCell || baseCell) ? (
                    // Show conflict diffs with syntax highlighting + diff decorations
                    <DiffContent
                        source={source}
                        compareSource={normalizeCellSource((compareCell ?? baseCell)!.source)}
                        side={side}
                        diffMode={diffMode}
                        langExtension={cellType === 'markdown' ? [] : languageExtensions}
                        theme={theme}
                    />
                ) : cellType !== 'markdown' ? (
                    // Non-markdown cells: syntax-highlighted read-only CodeMirror
                    <CodeMirror
                        value={source}
                        readOnly={true}
                        editable={false}
                        extensions={cellExtensions}
                        theme={cmTheme}
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
}

function MarkdownContent({ source }: MarkdownContentProps): React.ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host || !host.isConnected) return;

        host.replaceChildren();

        const html = renderMarkdown(source);
        host.innerHTML = html;

        // Resolve local image/link URLs to notebook-asset endpoints
        const { sessionId, token } = getCurrentSessionCredentials();
        host.querySelectorAll('img').forEach((img) => {
            const src = img.getAttribute('src');
            if (src && isNotebookLocalPath(src)) {
                img.setAttribute('src', buildNotebookAssetUrl(sessionId, token, normalizeLocalPath(src)));
            }
        });
        host.querySelectorAll('a[href]').forEach((anchor) => {
            const href = anchor.getAttribute('href');
            if (href && isNotebookLocalPath(href)) {
                anchor.setAttribute('href', buildNotebookAssetUrl(sessionId, token, normalizeLocalPath(href)));
            }
        });

        return () => { host.replaceChildren(); };
    }, [source]);

    return <div className="markdown-content" ref={hostRef} />;
}

interface DiffContentProps {
    source: string;
    compareSource: string;
    side?: 'base' | 'current' | 'incoming';
    diffMode: 'base' | 'conflict';
    langExtension: Extension[];
    theme: 'dark' | 'light';
}

/**
 * Build a CodeMirror StateField extension that decorates changed lines and
 * inline character ranges using the same CSS classes as the previous implementation.
 * Uses @codemirror/merge's character-level diff — no line-pairing heuristics needed.
 */
function createDiffExtension(
    compareSource: string,
    source: string,
    changes: readonly Change[],
    side: 'base' | 'current' | 'incoming',
    diffMode: 'base' | 'conflict',
): Extension {
    return StateField.define<DecorationSet>({
        create(state) {
            // Collect all decorations first, then sort + deduplicate before adding to the
            // builder. This avoids ordering violations when multiple Changes share a line
            // (which would cause duplicate line decorations at the same `from` position).
            type Entry = { from: number; to: number; decoration: Decoration; isLine: boolean };
            const entries: Entry[] = [];

            for (const change of changes) {
                if (change.fromB === change.toB) continue; // nothing on the B (source) side

                const changedText = state.doc.sliceString(change.fromB, change.toB);
                const isWhitespaceOnly = changedText.length > 0 && changedText.trim() === '';
                const useConflictClass = diffMode === 'conflict' || isWhitespaceOnly;

                const lineClass = useConflictClass
                    ? 'diff-line diff-line-conflict'
                    : side === 'current' ? 'diff-line diff-line-current' : 'diff-line diff-line-incoming';
                const inlineClass = useConflictClass
                    ? 'diff-inline-conflict'
                    : side === 'current' ? 'diff-inline-current' : 'diff-inline-incoming';

                const firstLine = state.doc.lineAt(change.fromB);
                const lastLine = state.doc.lineAt(Math.max(change.fromB, change.toB - 1));

                for (let lineNum = firstLine.number; lineNum <= lastLine.number; lineNum++) {
                    const line = state.doc.line(lineNum);
                    entries.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: lineClass }), isLine: true });
                }

                // Re-diff the hunk's text slices for character-level inline marks.
                // Sub-change positions are relative to the slice, so offset by change.fromB.
                const aSlice = compareSource.slice(change.fromA, change.toA);
                const bSlice = source.slice(change.fromB, change.toB);
                for (const sub of computeDiff(aSlice, bSlice)) {
                    if (sub.fromB < sub.toB) {
                        entries.push({
                            from: change.fromB + sub.fromB,
                            to: change.fromB + sub.toB,
                            decoration: Decoration.mark({ class: inlineClass }),
                            isLine: false,
                        });
                    }
                }
            }

            // Sort: ascending from; line decs (startSide -1) before marks (startSide 0) at same position.
            entries.sort((a, b) => a.from !== b.from ? a.from - b.from : (a.isLine ? -1 : 1) - (b.isLine ? -1 : 1));

            const builder = new RangeSetBuilder<Decoration>();
            const seenLineDecs = new Set<number>();
            for (const { from, to, decoration, isLine } of entries) {
                if (isLine) {
                    if (seenLineDecs.has(from)) continue; // skip duplicate line decs on same line
                    seenLineDecs.add(from);
                }
                builder.add(from, to, decoration);
            }

            return builder.finish();
        },
        update(deco) { return deco; },
        provide: f => EditorView.decorations.from(f),
    });
}

function DiffContent({ source, compareSource, side, diffMode, langExtension, theme }: DiffContentProps): React.ReactElement {
    const changes = useMemo(() => computeDiff(compareSource, source), [compareSource, source]);
    const diffExtension = useMemo(
        () => createDiffExtension(compareSource, source, changes, side ?? 'current', diffMode),
        [compareSource, source, changes, side, diffMode]
    );
    const cmTheme = useMemo(() => theme === 'dark' ? githubDark : githubLight, [theme]);
    const allExtensions = useMemo(
        () => [...langExtension, mergeNBSyntaxClassHighlighter, mergeNBEditorStructure, diffExtension],
        [langExtension, diffExtension]
    );

    return (
        <CodeMirror
            value={source}
            readOnly={true}
            editable={false}
            extensions={allExtensions}
            theme={cmTheme}
            basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
            className="cell-source-cm"
        />
    );
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
            let normalizedValue = normalizeMimeValue(value);
            if (mimeType === 'image/svg+xml' && typeof normalizedValue === 'string') {
                normalizedValue = DOMPurify.sanitize(normalizedValue, { USE_PROFILES: { svg: true } });
            }
            normalizedData[mimeType] = normalizedValue;
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
