import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import * as gitIntegration from '../gitIntegration';
import { NotebookConflictResolver } from '../resolver';
import { readTestConfig } from './testHarness';
import { git, gitAllowFailure, hashBlob } from './gitTestUtils';
import * as logger from '../../../packages/core/src';

type GitStage = '1' | '2' | '3';
type StatusSpec = {
    stages: GitStage[];
    expectedPresence: {
        base: boolean;
        current: boolean;
        incoming: boolean;
    };
    shouldAppearInResolver: boolean;
};

const STATUS_SPECS: Record<gitIntegration.GitUnmergedStatus, StatusSpec> = {
    UU: {
        stages: ['1', '2', '3'],
        expectedPresence: { base: true, current: true, incoming: true },
        shouldAppearInResolver: true,
    },
    AA: {
        stages: ['2', '3'],
        expectedPresence: { base: false, current: true, incoming: true },
        shouldAppearInResolver: true,
    },
    DD: {
        stages: ['1'],
        expectedPresence: { base: true, current: false, incoming: false },
        shouldAppearInResolver: false,
    },
    AU: {
        stages: ['2'],
        expectedPresence: { base: false, current: true, incoming: false },
        shouldAppearInResolver: true,
    },
    UA: {
        stages: ['3'],
        expectedPresence: { base: false, current: false, incoming: true },
        shouldAppearInResolver: true,
    },
    DU: {
        stages: ['1', '3'],
        expectedPresence: { base: true, current: false, incoming: true },
        shouldAppearInResolver: true,
    },
    UD: {
        stages: ['1', '2'],
        expectedPresence: { base: true, current: true, incoming: false },
        shouldAppearInResolver: true,
    },
};

function notebookContent(label: string): string {
    return `${JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { label },
        cells: [
            {
                cell_type: 'markdown',
                metadata: {},
                source: [`${label}\\n`],
            },
        ],
    }, null, 2)}\n`;
}

function setUnmergedIndexEntries(
    cwd: string,
    repoPath: string,
    stageBlobs: Partial<Record<GitStage, string>>
): void {
    gitAllowFailure(cwd, ['update-index', '--force-remove', '--', repoPath]);

    const lines: string[] = [];
    for (const stage of ['1', '2', '3'] as GitStage[]) {
        const blob = stageBlobs[stage];
        if (!blob) {
            continue;
        }
        lines.push(`100644 ${blob} ${stage}\t${repoPath}`);
    }

    if (lines.length === 0) {
        throw new Error(`No stage entries specified for ${repoPath}`);
    }

    git(cwd, ['update-index', '--index-info'], `${lines.join('\n')}\n`);
}

export async function run(): Promise<void> {
    const config = readTestConfig();
    const workspacePath = config.workspacePath;

    const baseBlob = hashBlob(workspacePath, notebookContent('base'));
    const currentBlob = hashBlob(workspacePath, notebookContent('current'));
    const incomingBlob = hashBlob(workspacePath, notebookContent('incoming'));

    for (const [status, spec] of Object.entries(STATUS_SPECS) as [gitIntegration.GitUnmergedStatus, StatusSpec][]) {
        const repoPath = `status_${status}.ipynb`;
        const stageBlobs: Partial<Record<GitStage, string>> = {};
        for (const stage of spec.stages) {
            if (stage === '1') stageBlobs[stage] = baseBlob;
            if (stage === '2') stageBlobs[stage] = currentBlob;
            if (stage === '3') stageBlobs[stage] = incomingBlob;
        }
        setUnmergedIndexEntries(workspacePath, repoPath, stageBlobs);
    }

    await gitIntegration.refreshUnmergedFilesSnapshot(workspacePath);

    const unmergedFiles = await gitIntegration.getUnmergedFiles(workspacePath);
    const statusEntries = unmergedFiles
        .filter((file) => path.basename(file.path).startsWith('status_'))
        .map((file) => ({
            fileName: path.basename(file.path),
            status: file.status,
        }));

    assert.strictEqual(statusEntries.length, 7, `Expected 7 synthetic status files, got ${statusEntries.length}`);

    const seenStatuses = new Set(statusEntries.map((entry) => entry.status));
    for (const expectedStatus of Object.keys(STATUS_SPECS) as gitIntegration.GitUnmergedStatus[]) {
        assert.ok(seenStatuses.has(expectedStatus), `Expected getUnmergedFiles() to include status ${expectedStatus}`);
    }

    for (const [status, spec] of Object.entries(STATUS_SPECS) as [gitIntegration.GitUnmergedStatus, StatusSpec][]) {
        const filePath = path.join(workspacePath, `status_${status}.ipynb`);

        const detectedStatus = await gitIntegration.getUnmergedFileStatus(filePath);
        assert.strictEqual(detectedStatus, status, `Expected status ${status} for ${filePath}, got ${String(detectedStatus)}`);

        const versions = await gitIntegration.getThreeWayVersions(filePath);
        assert.ok(versions, `Expected non-null three-way versions for ${status}`);

        assert.strictEqual(
            versions!.base !== null,
            spec.expectedPresence.base,
            `Unexpected base-stage availability for ${status}`
        );
        assert.strictEqual(
            versions!.current !== null,
            spec.expectedPresence.current,
            `Unexpected current-stage availability for ${status}`
        );
        assert.strictEqual(
            versions!.incoming !== null,
            spec.expectedPresence.incoming,
            `Unexpected incoming-stage availability for ${status}`
        );
    }

    const fallbackUri = vscode.Uri.file(workspacePath);
    const extensionUri = vscode.workspace.workspaceFolders?.[0]?.uri ?? fallbackUri;
    const resolver = new NotebookConflictResolver(extensionUri);
    const discoverableConflicts = await resolver.findNotebooksWithConflicts();
    const discoverableNames = new Set(discoverableConflicts.map((entry) => path.basename(entry.uri.fsPath)));

    for (const [status, spec] of Object.entries(STATUS_SPECS) as [gitIntegration.GitUnmergedStatus, StatusSpec][]) {
        const fileName = `status_${status}.ipynb`;
        if (spec.shouldAppearInResolver) {
            assert.ok(discoverableNames.has(fileName), `Expected resolver discoverability to include ${fileName}`);
        } else {
            assert.ok(!discoverableNames.has(fileName), `Expected resolver discoverability to exclude ${fileName}`);
        }
    }

    logger.info('Unmerged status matrix regression test passed.');
}
