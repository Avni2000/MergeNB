/**
 * @file markdown.ts
 * @description Markdown and LaTeX rendering utilities.
 */

import MarkdownIt from 'markdown-it';
// @ts-ignore - markdown-it-katex has no types
import katex from '@vscode/markdown-it-katex';
import DOMPurify from 'dompurify';
import { escapeHtml } from '../../notebookUtils';

// Re-export escapeHtml for backward compatibility
export { escapeHtml } from '../../notebookUtils';

// Initialize markdown-it with KaTeX plugin
const md = MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
}).use(katex);

/**
 * Render markdown source to HTML.
 * Sanitizes the output with DOMPurify to prevent XSS attacks.
 */
export function renderMarkdown(source: string): string {
    try {
        const rawHtml = md.render(source);
        // Sanitize HTML to prevent XSS
        return DOMPurify.sanitize(rawHtml);
    } catch (err) {
        console.error('[MergeNB] Markdown render error:', err);
        return `<pre>${escapeHtml(source)}</pre>`;
    }
}
