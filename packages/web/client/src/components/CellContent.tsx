/**
 * @file CellContent.tsx
 * @description React component for rendering notebook cell content.
 */

import React, { useMemo } from 'react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { HighlightStyle, ensureSyntaxTree } from '@codemirror/language';
import { githubDarkStyle, githubLightStyle } from '@uiw/codemirror-theme-github';
import { StyleModule } from 'style-mod';
import type { NotebookCell } from '../types';
import { computeDiffMarks, normalizeCellSource } from '../../../../core/src';
import * as logger from '../../../../core/src';
import type { Highlighter } from '@lezer/highlight';
import { highlightCode } from '@lezer/highlight';
import { MarkdownContent } from './MarkdownContent';
import { CellOutputs } from './CellOutputs';

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

interface CellContentProps {
    cell: NotebookCell | undefined;
    cellIndex?: number;
    side: 'base' | 'current' | 'incoming';
    isConflict?: boolean;
    compareCell?: NotebookCell;
    showOutputs?: boolean;
    showCellHeaders?: boolean;
    languageExtensions?: Extension[];
    theme?: 'dark' | 'light';
    isTrusted?: boolean;
    isLightweight?: boolean;
}
export const EMPTY_EXTENSIONS: Extension[] = [];
function CellContentInner({
    cell,
    cellIndex,
    side,
    isConflict = false,
    compareCell,
    showOutputs = true,
    showCellHeaders = false,
    languageExtensions = EMPTY_EXTENSIONS,
    theme = 'light',
    isTrusted = false,
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
                        attachments={cell.attachments}
                        isTrusted={isTrusted}
                        isLightweight={isLightweight}
                    />
                ) : (
                    <CellSource
                        source={source}
                        compareSource={isConflict && compareCell ? normalizeCellSource(compareCell.source) : undefined}
                        side={side}
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
                    isTrusted={isTrusted}
                    isLightweight={isLightweight}
                />
            )}
        </div>
    );
}

// ─── Static cell source (replaces CodeMirror read-only instances) ─────────────

export function CellSource({
    source,
    langExtensions,
    theme,
    compareSource,
    side = 'base',
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
    isMarkdown?: boolean;
    className?: string;
    isLightweight?: boolean;
}): React.ReactElement {
    const nodes = useMemo(() => {
        if (isLightweight) return null;
        const tokens = getSyntaxTokens(source, isMarkdown ? [] : langExtensions, theme);
        const marks = compareSource !== undefined
            ? computeDiffMarks(source, compareSource, side)
            : undefined;
        return renderStaticToReact(buildStaticRender(source, tokens, marks?.lineClasses, marks?.inlineRanges));
    }, [source, compareSource, side, langExtensions, theme, isMarkdown, isLightweight]);

    const content = isLightweight ? source : nodes;
    // Markdown cells don't need a <code> wrapper - it's text content, not code
    return (
        <pre className={className}>
            {isMarkdown ? content : <code>{content}</code>}
        </pre>
    );
}

export const CellContent = React.memo(CellContentInner);
