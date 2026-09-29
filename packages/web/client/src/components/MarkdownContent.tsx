import React, { useEffect, useRef } from 'react';
import type { NotebookCell } from '../../../../core/src';
import { renderMarkdown } from '../utils/markdown';
import { getCurrentSessionCredentials, buildNotebookAssetUrl, isNotebookLocalPath, normalizeLocalPath } from '../utils/notebookAssets';

interface MarkdownContentProps {
    source: string;
    attachments?: NotebookCell['attachments'];
    isTrusted?: boolean;
    isLightweight?: boolean;
}

export function MarkdownContent({ source, attachments, isTrusted = false, isLightweight = false }: MarkdownContentProps): React.ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (isLightweight) return;
        const host = hostRef.current;
        if (!host) return;

        host.innerHTML = renderMarkdown(source, isTrusted, attachments);

        // Resolve local image/link URLs to notebook-asset endpoints
        const { sessionId, token } = getCurrentSessionCredentials();
        host.querySelectorAll('img').forEach((img) => {
            const src = img.getAttribute('src');
            if (src && isNotebookLocalPath(src)) {
                img.setAttribute('src', buildNotebookAssetUrl(sessionId, token, normalizeLocalPath(src)));
            }
        });
        host.querySelectorAll('a[href]').forEach((anchor) => {
            const href = anchor.getAttribute('href');
            if (href && isNotebookLocalPath(href)) {
                anchor.setAttribute('href', buildNotebookAssetUrl(sessionId, token, normalizeLocalPath(href)));
            }
        });
    }, [source, attachments, isTrusted, isLightweight]);

    if (isLightweight) {
        return <pre className="markdown-source-lightweight">{source}</pre>;
    }
    return <div className="markdown-content" ref={hostRef} />;
}

