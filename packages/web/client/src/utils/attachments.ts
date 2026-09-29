import DOMPurify from 'dompurify';
import { normalizeMimeValue, type NotebookCell } from '../../../../core/src';

/** Resolve only this cell's embedded images; attachment names are not file paths. */
export function resolveAttachmentUrl(
    reference: string,
    attachments: NotebookCell['attachments'],
    isTrusted: boolean
): string | undefined {
    let name = reference.slice('attachment:'.length);
    try { name = decodeURIComponent(name); } catch { /* Literal names remain usable. */ }
    if (!attachments || !Object.hasOwn(attachments, name)) return undefined;

    for (const mimeType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']) {
        const value = normalizeMimeValue(mimeType, attachments[name][mimeType]);
        if (typeof value !== 'string') continue;
        if (mimeType === 'image/svg+xml') {
            const svg = isTrusted ? value : DOMPurify.sanitize(value, { USE_PROFILES: { svg: true } });
            return `data:${mimeType};charset=utf-8,${encodeURIComponent(svg)}`;
        }
        return `data:${mimeType};base64,${value.replace(/\s/g, '')}`;
    }
    return undefined;
}
