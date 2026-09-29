import type { IRenderMime } from '@jupyterlab/rendermime';

export function getCurrentSessionCredentials(): { sessionId: string; token: string } {
    if (typeof window === 'undefined') return { sessionId: 'default', token: '' };
    const params = new URLSearchParams(window.location.search);
    return {
        sessionId: params.get('session') || 'default',
        token: params.get('token') || '',
    };
}

export function createNotebookAssetResolver(sessionId: string, token: string): IRenderMime.IResolver {
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

export function buildNotebookAssetUrl(sessionId: string, token: string, pathValue: string): string {
    const params = new URLSearchParams({
        session: sessionId,
        token,
        path: pathValue,
    });
    return `/notebook-asset?${params.toString()}`;
}

export function isNotebookLocalPath(url: string, allowRoot = false): boolean {
    const normalized = normalizeLocalPath(url);
    if (!normalized) return false;
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(normalized)) return false;
    if (normalized.startsWith('//')) return false;
    if (!allowRoot && normalized.startsWith('/')) return false;
    return true;
}

export function normalizeLocalPath(url: string): string {
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

