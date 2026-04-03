import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as gitIntegration from '../gitIntegration';
import {
    AddOnlyResolutionAction,
    NotebookConflictResolver,
    setResolverPromptTestHooks,
} from '../resolver';
import { readTestConfig } from './testHarness';
import { git, gitAllowFailure, hashBlob, assertNoUnmergedConflict } from './gitTestUtils';
import * as logger from '../../../packages/core/src';

type AddOnlyStatus = 'AU' | 'UA';

function notebookContent(label: string): string {
    return `${JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { label },
        cells: [
            {
                cell_type: 'code',
                metadata: {},
                source: [`print("${label}")\\n`],
                execution_count: null,
                outputs: [],
            },
        ],
    }, null, 2)}\n`;
}

function setConflictStatus(
    cwd: string,
    status: AddOnlyStatus,
    blobs: { current: string; incoming: string; }
): void {
    const repoPath = 'conflict.ipynb';
    gitAllowFailure(cwd, ['update-index', '--force-remove', '--', repoPath]);

    const lines: string[] = [];
    if (status === 'AU') {
        // Added by Us: only stage 2 (current) present
        lines.push(`100644 ${blobs.current} 2\t${repoPath}`);
    } else {
        // Added by Them (UA): only stage 3 (incoming) present
        lines.push(`100644 ${blobs.incoming} 3\t${repoPath}`);
    }

    git(cwd, ['update-index', '--index-info'], `${lines.join('\n')}\n`);
}

async function resolveAddOnlyConflict(
    resolver: NotebookConflictResolver,
    uri: vscode.Uri,
    action: AddOnlyResolutionAction
): Promise<void> {
    setResolverPromptTestHooks({
        pickAddOnlyAction: () => action,
        confirmAction: () => true,
    });

    try {
        await resolver.resolveConflicts(uri);
    } finally {
        setResolverPromptTestHooks(undefined);
    }
}

async function assertApplyAndStageResult(
    cwd: string,
    resolver: NotebookConflictResolver,
    uri: vscode.Uri,
    expectedContent: string,
    context: string
): Promise<void> {
    await resolveAddOnlyConflict(resolver, uri, 'apply-and-stage');

    assert.ok(fs.existsSync(uri.fsPath), `Expected file to exist after apply-and-stage (${context})`);
    const actual = fs.readFileSync(uri.fsPath, 'utf8');
    assert.strictEqual(actual, expectedContent, `Unexpected file content after apply-and-stage (${context})`);

    assertNoUnmergedConflict(cwd, context);

    await gitIntegration.refreshUnmergedFilesSnapshot(cwd);
    const unmergedStatus = await gitIntegration.getUnmergedFileStatus(uri.fsPath);
    assert.strictEqual(unmergedStatus, null, `Expected no unmerged status after apply-and-stage (${context})`);
}

async function assertCancelResult(
    cwd: string,
    resolver: NotebookConflictResolver,
    uri: vscode.Uri,
    status: AddOnlyStatus,
    context: string
): Promise<void> {
    setResolverPromptTestHooks({
        pickAddOnlyAction: () => 'cancel',
    });

    try {
        await resolver.resolveConflicts(uri);
    } finally {
        setResolverPromptTestHooks(undefined);
    }

    // After cancel, the conflict should still be present
    await gitIntegration.refreshUnmergedFilesSnapshot(cwd);
    const unmergedStatus = await gitIntegration.getUnmergedFileStatus(uri.fsPath);
    assert.strictEqual(unmergedStatus, status, `Expected ${status} status to persist after cancel (${context})`);
}

export async function run(): Promise<void> {
    const config = readTestConfig();
    const workspacePath = config.workspacePath;
    const conflictPath = path.join(workspacePath, 'conflict.ipynb');
    const conflictUri = vscode.Uri.file(conflictPath);

    const fallbackUri = vscode.Uri.file(workspacePath);
    const extensionUri = vscode.workspace.workspaceFolders?.[0]?.uri ?? fallbackUri;
    const resolver = new NotebookConflictResolver(extensionUri);

    const currentContent = notebookContent('current-side');
    const incomingContent = notebookContent('incoming-side');
    const blobs = {
        current: hashBlob(workspacePath, currentContent),
        incoming: hashBlob(workspacePath, incomingContent),
    };

    // AU: apply-and-stage → writes current content
    setConflictStatus(workspacePath, 'AU', blobs);
    await gitIntegration.refreshUnmergedFilesSnapshot(workspacePath);
    await assertApplyAndStageResult(workspacePath, resolver, conflictUri, currentContent, 'AU apply-and-stage');

    // AU: cancel → conflict persists
    setConflictStatus(workspacePath, 'AU', blobs);
    await gitIntegration.refreshUnmergedFilesSnapshot(workspacePath);
    await assertCancelResult(workspacePath, resolver, conflictUri, 'AU', 'AU cancel');

    // UA: apply-and-stage → writes incoming content
    setConflictStatus(workspacePath, 'UA', blobs);
    await gitIntegration.refreshUnmergedFilesSnapshot(workspacePath);
    await assertApplyAndStageResult(workspacePath, resolver, conflictUri, incomingContent, 'UA apply-and-stage');

    // UA: cancel → conflict persists
    setConflictStatus(workspacePath, 'UA', blobs);
    await gitIntegration.refreshUnmergedFilesSnapshot(workspacePath);
    await assertCancelResult(workspacePath, resolver, conflictUri, 'UA', 'UA cancel');

    logger.info('AU/UA pick-one regression test passed.');
}
