/**
 * @file markdown.ts
 * @description Markdown and LaTeX rendering utilities.
 */

import MarkdownIt from 'markdown-it';
// @ts-ignore - markdown-it-katex has no types
import katex from '@vscode/markdown-it-katex';
import DOMPurify from 'dompurify';
import { escapeHtml } from '../../../../core/src';
import * as logger from '../../../../core/src';

// Initialize markdown-it with KaTeX plugin
const md = MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
}).use(katex);

/**
 * Render markdown source to HTML.
 *
 * Sanitizes the output with DOMPurify to prevent XSS, unless `isTrusted` is set - a
 * trusted session (workspace trust AND the mergeNB.security.trustContent setting,
 * resolved in resolver.ts and threaded via WebConflictData.isTrusted) skips
 * sanitization entirely, so markdown-embedded scripts and event handlers run as
 * authored.
 */
export function renderMarkdown(source: string, isTrusted: boolean = false): string {
    try {
        const rawHtml = md.render(source);
        // TODO: Investigate making a strict/relaxed config?
        if (isTrusted) return rawHtml;
        return DOMPurify.sanitize(rawHtml);
    } catch (err) {
        logger.error('[MergeNB] Markdown render error:', err);
        return `<pre>${escapeHtml(source)}</pre>`;
    }
}
