/**
 * @file markdown.ts
 * @description Markdown and LaTeX rendering utilities.
 */

import MarkdownIt from 'markdown-it';
// @ts-ignore - markdown-it-texmath has no types but is installed
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import { escapeHtml } from '../../notebookUtils';

// Re-export escapeHtml for backward compatibility
export { escapeHtml } from '../../notebookUtils';

// Initialize markdown-it with texmath plugin
const md = MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
}).use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: {
        throwOnError: false,
        displayMode: false,
    },
});

/**
 * Render markdown source to HTML.
 */
export function renderMarkdown(source: string): string {
    try {
        return md.render(source);
    } catch (err) {
        console.error('[MergeNB] Markdown render error:', err);
        return `<pre>${escapeHtml(source)}</pre>`;
    }
}
