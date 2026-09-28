import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    applyAutoResolutions,
    buildResolvedNotebookFromRows,
    detectSemanticConflicts,
    normalizeCellSource,
    type Notebook,
} from '../../../packages/core/src';
import { buildMergeRowsFromSemantic } from '../../../packages/web/client/src/utils/mergeRowBuilder';
import * as gitIntegration from '../gitIntegration';
import { getSettings } from '../settings';
import {
    NotebookConflictResolver,
    onDidResolveConflictWithDetails,
    setResolverPromptTestHooks,
} from '../resolver';
import { WebConflictPanel } from '../web/WebConflictPanel';

export async function run(): Promise<void> {
    const fixtureDir = path.resolve(
        __dirname,
        '../../../../test-fixtures/edge-cases/auto-resolve-preserves-unified'
    );
    const read = (name: string) => fs.readFileSync(path.join(fixtureDir, `${name}.ipynb`), 'utf8');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergenb-auto-unified-'));
    const uri = vscode.Uri.file(path.join(tempDir, 'conflict.ipynb'));
    fs.writeFileSync(uri.fsPath, read('base'));

    const originals = {
        getThreeWayVersions: gitIntegration.getThreeWayVersions,
        getCurrentBranch: gitIntegration.getCurrentBranch,
        getMergeBranch: gitIntegration.getMergeBranch,
        stageFile: gitIntegration.stageFile,
        createOrShow: WebConflictPanel.createOrShow,
    };
    let openedWebPanel = false;

    try {
        (gitIntegration as any).getThreeWayVersions = async () => ({
            base: read('base'),
            current: read('current'),
            incoming: read('incoming'),
        });
        (gitIntegration as any).getCurrentBranch = async () => 'current';
        (gitIntegration as any).getMergeBranch = async () => 'incoming';
        (gitIntegration as any).stageFile = async () => true;
        (WebConflictPanel as any).createOrShow = async () => { openedWebPanel = true; };
        setResolverPromptTestHooks({ pickRenumberExecutionCounts: () => false });

        const semanticConflict = await detectSemanticConflicts(uri.fsPath, gitIntegration);
        assert.ok(semanticConflict);
        const originalConflict = JSON.stringify(semanticConflict);
        const settings = getSettings();
        const autoResolveResult = applyAutoResolutions(semanticConflict, settings);

        // Auto-resolution must describe only the affected row, not a replacement notebook.
        assert.deepStrictEqual(autoResolveResult.remainingConflicts, []);
        assert.strictEqual('resolvedNotebook' in autoResolveResult, false);
        assert.deepStrictEqual(autoResolveResult.cellPatches, [
            {
                baseCellIndex: 1,
                currentCellIndex: 1,
                incomingCellIndex: 1,
                changes: { execution_count: null, outputs: [] },
            },
            {
                baseCellIndex: 3,
                currentCellIndex: 3,
                incomingCellIndex: 3,
                changes: { execution_count: null },
            },
        ]);

        const uiRows = buildMergeRowsFromSemantic({
            ...semanticConflict,
            semanticConflicts: autoResolveResult.remainingConflicts,
        }, autoResolveResult);
        assert.strictEqual(uiRows.length, 4);
        assert.ok(uiRows.every(row => row.type === 'identical'));
        assert.deepStrictEqual(uiRows[0].currentCell, semanticConflict.current!.cells[0]);
        assert.deepStrictEqual(uiRows[0].incomingCell, semanticConflict.incoming!.cells[0]);
        assert.deepStrictEqual(uiRows[1].currentCell, {
            ...semanticConflict.current!.cells[1],
            execution_count: null,
            outputs: [],
        });
        assert.deepStrictEqual(uiRows[2].currentCell, semanticConflict.current!.cells[2]);
        assert.deepStrictEqual(uiRows[3].currentCell, {
            ...semanticConflict.current!.cells[3],
            execution_count: null,
        });

        const uiNotebook = buildResolvedNotebookFromRows({
            semanticConflict,
            resolvedRows: uiRows,
            autoResolveResult,
            settings,
            shouldRenumber: false,
        });
        // Choosing incoming must retain its source, metadata and non-conflicting outputs.
        const incomingNotebook = buildResolvedNotebookFromRows({
            semanticConflict,
            resolvedRows: uiRows.map(row => row.currentCellIndex === 3 ? {
                ...row,
                resolution: {
                    choice: 'incoming' as const,
                    resolvedContent: normalizeCellSource(row.incomingCell!.source),
                },
            } : row),
            autoResolveResult,
            settings,
            shouldRenumber: false,
        });
        assert.strictEqual(JSON.stringify(semanticConflict), originalConflict);

        const resolved = new Promise<Notebook>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for automatic resolution')), 5000);
            const subscription = onDidResolveConflictWithDetails.event(details => {
                if (details.uri.fsPath !== uri.fsPath || !details.resolvedNotebook) return;
                clearTimeout(timeout);
                subscription.dispose();
                resolve(details.resolvedNotebook);
            });
        });

        await new NotebookConflictResolver(vscode.Uri.file(tempDir)).resolveSemanticConflicts(uri);
        const emitted = await resolved;
        const written = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8')) as Notebook;

        assert.strictEqual(openedWebPanel, false);
        assert.deepStrictEqual(written, emitted);
        assert.deepStrictEqual(written, uiNotebook);
        assert.deepStrictEqual(written, incomingNotebook);
        assert.deepStrictEqual(written.cells[0].source, ['number = 0.8']);
        assert.strictEqual(written.cells[1].execution_count, null);
        assert.deepStrictEqual(written.cells[1].outputs, []);
        assert.deepStrictEqual(written.cells[2], semanticConflict.current!.cells[2]);
        assert.deepStrictEqual(written.cells[3], {
            ...semanticConflict.incoming!.cells[3],
            execution_count: null,
        });
    } finally {
        (gitIntegration as any).getThreeWayVersions = originals.getThreeWayVersions;
        (gitIntegration as any).getCurrentBranch = originals.getCurrentBranch;
        (gitIntegration as any).getMergeBranch = originals.getMergeBranch;
        (gitIntegration as any).stageFile = originals.stageFile;
        (WebConflictPanel as any).createOrShow = originals.createOrShow;
        setResolverPromptTestHooks(undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
