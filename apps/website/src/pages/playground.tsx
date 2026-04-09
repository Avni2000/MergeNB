import {useState, useEffect, type ReactNode} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

function PlaygroundInner(): ReactNode {
    const [content, setContent] = useState<ReactNode>(null);

    useEffect(() => {
        (async () => {
            const [{ConflictResolver}, {matchCells, analyzeSemanticConflictsFromMappings}, {injectStyles}, baseNb, currentNb, incomingNb] = await Promise.all([
                import('../../../../packages/web/client/src/components/ConflictResolver'),
                import('../../../../packages/core/src'),
                import('../../../../packages/web/client/src/styles'),
                import('../../../../test-fixtures/demo_base.ipynb'),
                import('../../../../test-fixtures/demo_current.ipynb'),
                import('../../../../test-fixtures/demo_incoming.ipynb'),
            ]);

            const base = baseNb.default ?? baseNb;
            const current = currentNb.default ?? currentNb;
            const incoming = incomingNb.default ?? incomingNb;

            const cellMappings = matchCells(base, current, incoming);
            const semanticConflicts = analyzeSemanticConflictsFromMappings(cellMappings);

            injectStyles('dark', '.mergenb-playground-root');

            setContent(
                <div className="mergenb-playground-root">
                <ConflictResolver
                    conflict={{
                        filePath: 'demo.ipynb',
                        conflictKey: 'playground-demo-v1',
                        type: 'semantic',
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
        })();
    }, []);

    return content ?? <div>Loading playground...</div>;
}

export default function Playground() {
    return (
        <Layout title="MergeNB Playground">
            <BrowserOnly fallback={<div>Loading playground...</div>}>
                {() => <PlaygroundInner />}
            </BrowserOnly>
        </Layout>
    );
}
