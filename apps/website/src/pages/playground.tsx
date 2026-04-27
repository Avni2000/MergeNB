import {useState, useEffect, type ReactNode} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import 'katex/dist/katex.min.css';
import type {Notebook} from '../../../../packages/core/src/types';

/**
 * Custom CSS to ensure the playground fills the viewport and hides the footer. 
 * Removes scroll conflicts
*/
const PLAYGROUND_LAYOUT_CSS = `
/* Hide footer on the playground page */
.playground-wrapper + footer { display: none !important; }

/* Fill remaining viewport after the sticky navbar */
.playground-wrapper {
    display: flex;
    flex-direction: column;
    height: calc(100vh - var(--ifm-navbar-height, 60px));
    overflow: hidden;
}

/* Playground root fills the wrapper */
.mergenb-playground-root {
    flex: 1;
    min-height: 0;
}

/* Override standalone 100vh — let the parent dictate height */
.mergenb-playground-root .app-container {
    height: 100% !important;
}
`;

function getNotebook(moduleValue: unknown): Notebook {
    const maybeModule = moduleValue as {default?: Notebook};
    return (maybeModule.default ?? moduleValue) as Notebook;
}

function PlaygroundInner(): ReactNode {
    const [content, setContent] = useState<ReactNode>(null);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        void (async () => {
            try {
                const [{ConflictResolver}, {matchCells, analyzeSemanticConflictsFromMappings}, {injectStyles}, baseNb, currentNb, incomingNb] = await Promise.all([
                    import('../../../../packages/web/client/src/components/ConflictResolver'),
                    import('../../../../packages/core/src'),
                    import('../../../../packages/web/client/src/styles'),
                    import('../../../../test-fixtures/demo/base.ipynb'),
                    import('../../../../test-fixtures/demo/current.ipynb'),
                    import('../../../../test-fixtures/demo/incoming.ipynb'),
                ]);

                const base = getNotebook(baseNb);
                const current = getNotebook(currentNb);
                const incoming = getNotebook(incomingNb);

                const cellMappings = matchCells(base, current, incoming);
                const semanticConflicts = analyzeSemanticConflictsFromMappings(cellMappings);

                injectStyles('light', '.mergenb-playground-root');

                if (cancelled) return;
                setContent(
                    <div className="mergenb-playground-root">
                    <ConflictResolver
                        conflict={{
                            filePath: 'demo.ipynb',
                            conflictKey: 'playground-demo-v1',
                            type: 'semantic',
                            theme: 'light',
                            semanticConflict: {
                                filePath: 'demo.ipynb',
                                semanticConflicts,
                                cellMappings,
                                base,
                                current,
                                incoming,
                                currentBranch: 'current',
                                incomingBranch: 'incoming',
                        }}}
                        onResolve={() => {}}
                        onCancel={() => {}}
                    />
                    </div>
                );
            } catch (error) {
                if (cancelled) return;

                const message = error instanceof Error ? error.message : 'Unknown error';
                console.error('[MergeNB playground] Failed to initialize:', error);
                setLoadError(message);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    if (loadError) {
        return <div role="alert">Failed to load playground: {loadError}</div>;
    }

    return content ?? <div>Loading playground...</div>;
}

export default function Playground() {
    return (
        <Layout title="MergeNB Playground" wrapperClassName="playground-wrapper">
            <style>{PLAYGROUND_LAYOUT_CSS}</style>
            <BrowserOnly fallback={<div>Loading playground...</div>}>
                {() => <PlaygroundInner />}
            </BrowserOnly>
        </Layout>
    );
}
