/**
 * @file editorTheme.ts
 * @description Custom CodeMirror themes matched to MergeNB's visual palette.
 *
 * Usage:
 *   theme={createMergeNBTheme(mode)}          // syntax colors → `theme` prop
 *   extensions={[...lang, mergeNBEditorStructure]}  // structural overrides
 */

import { createTheme } from '@uiw/codemirror-themes';
import { tags as t } from '@lezer/highlight';
import { classHighlighter } from '@lezer/highlight';
import { EditorView } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

/**
 * Creates a syntax-highlight theme matched to MergeNB's warm palette.
 * Pass the result to the `theme` prop of <CodeMirror>.
 */
export function createMergeNBTheme(mode: 'dark' | 'light'): Extension {
    const isDark = mode === 'dark';
    return createTheme({
        theme: isDark ? 'dark' : 'light',
        settings: {
            // Use CSS vars so both dark/light resolve automatically
            background: 'var(--cell-surface)',
            foreground: isDark ? '#EFE7DB' : '#2D2A24',
            caret: isDark ? '#C59BD0' : '#7C3AED',
            selection: isDark
                ? 'rgba(127, 185, 199, 0.30)'
                : 'rgba(164, 212, 222, 0.40)',
            selectionMatch: isDark
                ? 'rgba(127, 185, 199, 0.15)'
                : 'rgba(164, 212, 222, 0.22)',
            lineHighlight: 'transparent',
            fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Courier New', monospace",
        },
        styles: [
            // Keywords: if/for/def/import/return …
            { tag: t.keyword, color: isDark ? '#C59BD0' : '#7C3AED' },
            // String literals
            { tag: [t.string, t.special(t.string)], color: isDark ? '#A8C49A' : '#2D7A2D' },
            // Comments
            { tag: [t.lineComment, t.blockComment], color: isDark ? '#7A6E62' : '#9A8A78', fontStyle: 'italic' },
            // Numeric / boolean / null literals
            { tag: [t.number, t.bool, t.null], color: isDark ? '#E2A070' : '#C45D0A' },
            // Function names at call site
            { tag: t.function(t.variableName), color: isDark ? '#87B5D9' : '#1565C0' },
            // Function / class definitions
            { tag: t.definition(t.variableName), color: isDark ? '#A8C7EB' : '#1565C0' },
            // Operators  +  -  *  ==  …
            { tag: t.operator, color: isDark ? '#87CDD1' : '#007070' },
            // Type names and class names
            { tag: [t.typeName, t.className], color: isDark ? '#D9879A' : '#B71C1C' },
            // self / this
            { tag: t.self, color: isDark ? '#C59BD0' : '#7C3AED' },
            // Attribute / property access
            { tag: [t.propertyName, t.attributeName], color: isDark ? '#87CDD1' : '#007070' },
            // HTML / JSX tag names
            { tag: t.tagName, color: isDark ? '#C59BD0' : '#7C3AED' },
            // Brackets and punctuation
            { tag: [t.angleBracket, t.punctuation], color: isDark ? '#B5A998' : '#7A6A58' },
            // Plain variable references (default foreground)
            { tag: t.variableName, color: isDark ? '#EFE7DB' : '#2D2A24' },
            // Decorator / annotation
            { tag: t.annotation, color: isDark ? '#E2A070' : '#C45D0A' },
        ],
    });
}

/**
 * Structural EditorView.theme that strips the default CM editor chrome so
 * the component blends into MergeNB's UI. Add to the `extensions` array
 * alongside the language extension.
 *
 * Background and font are deliberately inherited from CSS (via CSS vars) so
 * both the resolved-editor and the read-only cell display share the same
 * extension without hard-coded values.
 */
export const mergeNBEditorStructure: Extension = EditorView.theme({
    // No extra border / shadow on the editor shell — controlled by CSS class
    '&': {
        outline: 'none !important',
    },
    '&.cm-focused': {
        outline: 'none !important',
    },
    // Content area: inherit font from CSS, reset CM default padding
    '.cm-content': {
        fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Courier New', monospace",
        fontSize: '13px',
        lineHeight: '1.5',
        padding: '0',
    },
    // Individual lines: let CSS class handle horizontal padding
    '.cm-line': {
        padding: '0',
    },
    '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'inherit',
    },
    // Hide the gutter (no line numbers)
    '.cm-gutters': {
        display: 'none',
    },
});

/**
 * Lezer classHighlighter emits token classes like `.tok-keyword`, which our
 * integration tests and CSS hooks rely on.
 */
export const mergeNBSyntaxClassHighlighter: Extension = syntaxHighlighting(classHighlighter);
