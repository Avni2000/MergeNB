/**
 * @file CellContent.tsx
 * @description React component for rendering notebook cell content.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { HighlightStyle, ensureSyntaxTree } from '@codemirror/language';
import { githubDarkStyle, githubLightStyle } from '@uiw/codemirror-theme-github';
import { StyleModule } from 'style-mod';
import { IRenderMime, OutputModel, RenderMimeRegistry, standardRendererFactories } from '@jupyterlab/rendermime';
import { Widget } from '@lumino/widgets';
import DOMPurify from 'dompurify';
import type { NotebookCell, CellOutput } from '../types';
import { computeDiffMarks, normalizeCellSource } from '../../../../core/src';
import * as logger from '../../../../core/src';
import type { Highlighter } from '@lezer/highlight';
import { highlightCode } from '@lezer/highlight';
import { renderMarkdown } from '../utils/markdown';

export const mergeNBEditorStructure: Extension = EditorView.theme({
    '&': { outline: 'none !important', backgroundColor: 'var(--cell-surface) !important' },
    '&.cm-focused': { outline: 'none !important' },
    '.cm-content': { fontFamily: 'var(--font-code)', fontSize: '13px', lineHeight: '1.5', padding: '0' },
    '.cm-line': { padding: '0' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.05) !important' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
    '.cm-gutters': { display: 'none' },
});

/** Same tag→color rules as @uiw/codemirror-theme-github (resolved CodeMirror uses those themes). */
const staticGithubLightHighlight = HighlightStyle.define(githubLightStyle);
const staticGithubDarkHighlight = HighlightStyle.define(githubDarkStyle);

if (typeof document !== 'undefined') {
    const mods = [staticGithubLightHighlight.module, staticGithubDarkHighlight.module].filter(
        (m): m is StyleModule => m != null
    );
    if (mods.length > 0) StyleModule.mount(document, mods);
}

// ─── Static syntax highlighting helpers ───────────────────────────────────────
// Plain HTML (<pre><code>) with HighlightStyle classes (GitHub light/dark), mounted
// via style-mod — same palette as the resolved CodeMirror editor, no duplicate CSS.

/** Parse `source` with the given language extensions and return styled token spans, in document order. */
function getSyntaxTokens(
    source: string,
    langExtensions: Extension[],
    theme: 'dark' | 'light',
): { from: number; to: number; classes: string }[] {
    const tokens: { from: number; to: number; classes: string }[] = [];
    if (!source || langExtensions.length === 0) return tokens;

    const highlighter: Highlighter =
        theme === 'dark' ? staticGithubDarkHighlight : staticGithubLightHighlight;

    try {
        const state = EditorState.create({ doc: source, extensions: langExtensions });
        const tree = ensureSyntaxTree(state, source.length, 50);
        if (!tree) return tokens;

        let pos = 0;
        highlightCode(source, tree, highlighter,
            (text, classes) => {
                if (classes) tokens.push({ from: pos, to: pos + text.length, classes });
                pos += text.length;
            },
            () => { pos++; }, // newline
        );
        return tokens;
    } catch (err) {
        logger.debug('[MergeNB] Failed to parse syntax tree for highlighting:', err);
        return tokens;
    }
}

interface StaticSegment {
    text: string;
    classes?: string;
}

interface StaticLine {
    lineClass?: string;
    segments: StaticSegment[];
}

type StaticRender = {
    kind: 'flat';
    segments: StaticSegment[];
} | {
    kind: 'lines';
    lines: StaticLine[];
};

/** Build inline spans with syntax tokens only (flat + newlines preserved). */
function buildFlatSegments(source: string, tokens: { from: number; to: number; classes: string }[]): StaticSegment[] {
    const parts: StaticSegment[] = [];
    let lastTo = 0;
    for (const t of tokens) {
        if (t.from > lastTo) parts.push({ text: source.slice(lastTo, t.from) });
        parts.push({ text: source.slice(t.from, t.to), classes: t.classes });
        lastTo = t.to;
    }
    if (lastTo < source.length) parts.push({ text: source.slice(lastTo) });
    return parts;
}

/** Build line-wrapped spans with merged syntax + diff highlighting.
    Both `syntaxTokens` and `inlineRanges` arrive in document order. */
function buildLineSegments(
    source: string,
    syntaxTokens: { from: number; to: number; classes: string }[],
    lineClasses: Map<number, string>,
    inlineRanges: { from: number; to: number; classes: string }[],
): StaticLine[] {
    const lines = source.split('\n');
    const sortedSyntax = syntaxTokens;
    const sortedInline = inlineRanges;
    const result: StaticLine[] = [];
    let offset = 0;
    let syntaxIndex = 0;
    let inlineIndex = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineStart = offset;
        const lineEnd = offset + line.length;

        const lineClass = lineClasses.get(lineIdx);
        const segments: StaticSegment[] = [];

        if (line.length > 0) {
            const bounds = new Set<number>();
            bounds.add(lineStart);
            bounds.add(lineEnd);

            while (syntaxIndex < sortedSyntax.length && sortedSyntax[syntaxIndex].to <= lineStart) syntaxIndex++;
            while (inlineIndex < sortedInline.length && sortedInline[inlineIndex].to <= lineStart) inlineIndex++;

            for (let scanIndex = syntaxIndex; scanIndex < sortedSyntax.length && sortedSyntax[scanIndex].from < lineEnd; scanIndex++) {
                const t = sortedSyntax[scanIndex];
                if (t.to > lineStart) {
                    bounds.add(Math.max(t.from, lineStart));
                    bounds.add(Math.min(t.to, lineEnd));
                }
            }
            for (let scanIndex = inlineIndex; scanIndex < sortedInline.length && sortedInline[scanIndex].from < lineEnd; scanIndex++) {
                const r = sortedInline[scanIndex];
                if (r.to > lineStart) {
                    bounds.add(Math.max(r.from, lineStart));
                    bounds.add(Math.min(r.to, lineEnd));
                }
            }

            const sorted = Array.from(bounds).sort((a, b) => a - b);
            const syntaxClassAtPos = new Map<number, string>();
            const inlineClassAtPos = new Map<number, string>();
            let lineSyntaxIndex = syntaxIndex;
            let lineInlineIndex = inlineIndex;

            for (const pos of sorted) {
                while (lineSyntaxIndex < sortedSyntax.length && sortedSyntax[lineSyntaxIndex].to <= pos) lineSyntaxIndex++;
                const token = sortedSyntax[lineSyntaxIndex];
                if (token && token.from <= pos && token.to > pos && token.classes) {
                    syntaxClassAtPos.set(pos, token.classes);
                }

                while (lineInlineIndex < sortedInline.length && sortedInline[lineInlineIndex].to <= pos) lineInlineIndex++;
                const range = sortedInline[lineInlineIndex];
                if (range && range.from <= pos && range.to > pos && range.classes) {
                    inlineClassAtPos.set(pos, range.classes);
                }
            }
            syntaxIndex = lineSyntaxIndex;
            inlineIndex = lineInlineIndex;

            for (let i = 0; i < sorted.length - 1; i++) {
                const from = sorted[i];
                const to = sorted[i + 1];
                const text = source.slice(from, to);

                const sc = syntaxClassAtPos.get(from) ?? '';
                const dc = inlineClassAtPos.get(from) ?? '';
                const cls = [sc, dc].filter(Boolean).join(' ');

                segments.push(cls ? { text, classes: cls } : { text });
            }
        }

        result.push({ lineClass, segments });
        offset = lineEnd + 1;
    }

    return result;
}

/** Build a static render plan with syntax highlighting and optional diff marks. */
function buildStaticRender(
    source: string,
    syntaxTokens: { from: number; to: number; classes: string }[],
    lineClasses?: Map<number, string>,
    inlineRanges?: { from: number; to: number; classes: string }[],
): StaticRender {
    if (!source) return { kind: 'flat', segments: [] };
    const hasDiff = (lineClasses && lineClasses.size > 0) || (inlineRanges && inlineRanges.length > 0);
    if (!hasDiff) return { kind: 'flat', segments: buildFlatSegments(source, syntaxTokens) };
    return {
        kind: 'lines',
        lines: buildLineSegments(source, syntaxTokens, lineClasses ?? new Map(), inlineRanges ?? []),
    };
}

function renderSegmentsToReact(segments: StaticSegment[]): React.ReactNode[] {
    return segments.map((segment, index) => (
        segment.classes
            ? <span key={index} className={segment.classes}>{segment.text}</span>
            : segment.text
    ));
}

function renderStaticToReact(render: StaticRender): React.ReactNode {
    if (render.kind === 'flat') return renderSegmentsToReact(render.segments);
    return render.lines.map((line, index) => (
        <span
            key={index}
            className={line.lineClass ? `source-line ${line.lineClass}` : 'source-line'}
        >
            {renderSegmentsToReact(line.segments)}
        </span>
    ));
}

type RenderMimeOutputValue = ConstructorParameters<typeof OutputModel>[0]['value'];

interface CellContentProps {
    cell: NotebookCell | undefined;
    cellIndex?: number;
    side: 'base' | 'current' | 'incoming';
    isConflict?: boolean;
    compareCell?: NotebookCell;
    diffMode?: 'base' | 'conflict';
    showOutputs?: boolean;
    showCellHeaders?: boolean;
    languageExtensions?: Extension[];
    theme?: 'dark' | 'light';
    isLightweight?: boolean;
}
export const EMPTY_EXTENSIONS: Extension[] = [];
function CellContentInner({
    cell,
    cellIndex,
    side,
    isConflict = false,
    compareCell,
    diffMode = 'base',
    showOutputs = true,
    showCellHeaders = false,
    languageExtensions = EMPTY_EXTENSIONS,
    theme = 'light',
    isLightweight = false,
}: CellContentProps): React.ReactElement {
    const encodedCell = useMemo(
        () => (cell ? encodeURIComponent(JSON.stringify(cell)) : ''),
        [cell]
    );

    const cellType = cell?.cell_type || 'code';

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
                        isLightweight={isLightweight}
                    />
                ) : (
                    <CellSource
                        source={source}
                        compareSource={isConflict && compareCell ? normalizeCellSource(compareCell.source) : undefined}
                        side={side}
                        diffMode={diffMode}
                        langExtensions={languageExtensions}
                        theme={theme}
                        isMarkdown={cellType === 'markdown'}
                        isLightweight={isLightweight}
                    />
                )}
            </div>
            {showOutputs && cellType === 'code' && cell.outputs && cell.outputs.length > 0 && (
                <CellOutputs
                    outputs={cell.outputs}
                    isLightweight={isLightweight}
                />
            )}
        </div>
    );
}

interface MarkdownContentProps {
    source: string;
    isLightweight?: boolean;
}

export function MarkdownContent({ source, isLightweight = false }: MarkdownContentProps): React.ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (isLightweight) return;
        const host = hostRef.current;
        if (!host) return;

        host.innerHTML = renderMarkdown(source);

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
    }, [source, isLightweight]);

    if (isLightweight) {
        return <pre className="markdown-source-lightweight">{source}</pre>;
    }
    return <div className="markdown-content" ref={hostRef} />;
}

// ─── Static cell source (replaces CodeMirror read-only instances) ─────────────

export function CellSource({
    source,
    langExtensions,
    theme,
    compareSource,
    side = 'base',
    diffMode = 'base',
    isMarkdown = false,
    className = 'cell-source-static',
    isLightweight = false,
}: {
    source: string;
    langExtensions: Extension[];
    theme: 'dark' | 'light';
    /** When set, line/inline diff marks against this content are rendered. */
    compareSource?: string;
    side?: 'base' | 'current' | 'incoming';
    diffMode?: 'base' | 'conflict';
    isMarkdown?: boolean;
    className?: string;
    isLightweight?: boolean;
}): React.ReactElement {
    const nodes = useMemo(() => {
        if (isLightweight) return null;
        const tokens = getSyntaxTokens(source, isMarkdown ? [] : langExtensions, theme);
        const marks = compareSource !== undefined
            ? computeDiffMarks(source, compareSource, side, diffMode)
            : undefined;
        return renderStaticToReact(buildStaticRender(source, tokens, marks?.lineClasses, marks?.inlineRanges));
    }, [source, compareSource, side, diffMode, langExtensions, theme, isMarkdown, isLightweight]);

    const content = isLightweight ? source : nodes;
    // Markdown cells don't need a <code> wrapper - it's text content, not code
    return (
        <pre className={className}>
            {isMarkdown ? content : <code>{content}</code>}
        </pre>
    );
}

interface CellOutputsProps {
    outputs: CellOutput[];
    isLightweight?: boolean;
}

function CellOutputs({ outputs, isLightweight = false }: CellOutputsProps): React.ReactElement {
    if (isLightweight) {
        return (
            <div className="cell-outputs">
                {outputs.map((output, i) => (
                    <pre key={i} className="cell-output-fallback">{getOutputTextFallback(output)}</pre>
                ))}
            </div>
        );
    }
    return (
        <div className="cell-outputs">
            {outputs.map((output, i) => (
                <RenderMimeOutput key={i} output={output} />
            ))}
        </div>
    );
}

function RenderMimeOutput({ output }: { output: CellOutput }): React.ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);
    const [fallback, setFallback] = useState<string | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host || !host.isConnected) return;
        host.replaceChildren();
        setFallback(null);

        const renderMimeRegistry = getRenderMimeRegistry();
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
    }, [output]);

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

// Session credentials come from window.location and never change within a page,
// so one registry serves the whole session.
let renderMimeRegistry: RenderMimeRegistry | null = null;

function getRenderMimeRegistry(): RenderMimeRegistry {
    if (!renderMimeRegistry) {
        const { sessionId, token } = getCurrentSessionCredentials();
        renderMimeRegistry = new RenderMimeRegistry({
            initialFactories: standardRendererFactories,
            resolver: createNotebookAssetResolver(sessionId, token),
        });
    }
    return renderMimeRegistry;
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
