/**
 * @file markdown.ts
 * @description Markdown and LaTeX rendering utilities.
 */

import MarkdownIt from 'markdown-it';
// @ts-ignore - markdown-it-katex has no types
import katex from '@vscode/markdown-it-katex';
import DOMPurify from 'dompurify';
import { resolveAttachmentUrl } from './attachments';
import type { NotebookCell } from '../../../../core/src';
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
export function renderMarkdown(source: string, isTrusted: boolean = false, attachments?: NotebookCell['attachments']): string {
    try {
        const template = document.createElement('template');
        template.innerHTML = md.render(source);
        for (const element of template.content.querySelectorAll('img[src], a[href]')) {
            const attribute = element.tagName === 'IMG' ? 'src' : 'href';
            const reference = element.getAttribute(attribute)!;
            if (!reference.startsWith('attachment:')) continue;
            const url = resolveAttachmentUrl(reference, attachments, isTrusted);
            if (url) element.setAttribute(attribute, url);
            else element.replaceWith(document.createTextNode(`[Missing or unsupported attachment: ${reference.slice(11)}]`));
        }
        const rawHtml = template.innerHTML;
        // TODO: Investigate making a strict/relaxed config?
        if (isTrusted) return rawHtml;
        return DOMPurify.sanitize(rawHtml);
    } catch (err) {
        logger.error('[MergeNB] Markdown render error:', err);
        return `<pre>${escapeHtml(source)}</pre>`;
    }
}
