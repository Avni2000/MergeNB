import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Notebook } from '../../../packages/core/src';
import * as gitIntegration from '../gitIntegration';
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
        assert.deepStrictEqual(written.cells[0].source, ['number = 0.8']);
        assert.strictEqual(written.cells[1].execution_count, null);
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
