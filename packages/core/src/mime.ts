import type { MimeBundle } from './notebookTypes';

/** JSON MIME values are data, even when they happen to be arrays of strings. */
export function normalizeMimeValue(mimeType: string, value: unknown): unknown {
    if (mimeType === 'application/json' || mimeType.endsWith('+json')) return value;
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
        return value.join('');
    }
    return value;
}

export function normalizeMimeBundle(bundle: MimeBundle): MimeBundle {
    return Object.fromEntries(Object.entries(bundle).map(([mimeType, value]) => [
        mimeType, normalizeMimeValue(mimeType, value),
    ]));
}
