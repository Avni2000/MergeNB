/**
 * @file markdown.ts
 * @description Markdown and LaTeX rendering utilities.
 */

import MarkdownIt from 'markdown-it';
// @ts-ignore - markdown-it-mathjax3 has no types
import mathjax3 from 'markdown-it-mathjax3';
import { escapeHtml } from '../../notebookUtils';

// Re-export escapeHtml for backward compatibility
export { escapeHtml } from '../../notebookUtils';

// Initialize markdown-it with MathJax 3 plugin
const md = MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
}).use(mathjax3);

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
