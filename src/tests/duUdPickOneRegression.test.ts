import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import * as gitIntegration from '../gitIntegration';
import {
    DeleteVsModifyResolutionAction,
    NotebookConflictResolver,
    setResolverPromptTestHooks,
} from '../resolver';
import { readTestConfig } from './testHarness';

type GitStage = '1' | '2' | '3';
type DeleteConflictStatus = 'DU' | 'UD';

function git(cwd: string, args: string[], input?: string): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}

function gitAllowFailure(cwd: string, args: string[], input?: string): string {
    try {
        return git(cwd, args, input);
    } catch (error: any) {
        const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
        const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
        return `${stdout}\n${stderr}`.trim();
    }
}

function hashBlob(cwd: string, content: string): string {
    return git(cwd, ['hash-object', '-w', '--stdin'], content).trim();
}

function notebookContent(label: string): string {
    return `${JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { label },
        cells: [
            {
                cell_type: 'code',
                metadata: {},
                source: [`print(\"${label}\")\\n`],
                execution_count: null,
                outputs: [],
            },
        ],
    }, null, 2)}\n`;
}

function hasUnmergedStatusForConflict(statusOutput: string): boolean {
    return statusOutput
        .split('\n')
        .map((line) => line.trim())
        .some((line) => /^(UU|AA|DD|AU|UA|DU|UD)\s+conflict\.ipynb$/.test(line));
}

function assertNoUnmergedStatus(cwd: string, context: string): void {
    const status = git(cwd, ['status', '--porcelain', '--', 'conflict.ipynb']);
    if (hasUnmergedStatusForConflict(status)) {
        throw new Error(`Expected no unmerged status ${context}, got:\n${status}`);
    }
}

function setConflictStatus(
    cwd: string,
    status: DeleteConflictStatus,
    blobs: { base: string; current: string; incoming: string; }
): void {
    const repoPath = 'conflict.ipynb';
    gitAllowFailure(cwd, ['update-index', '--force-remove', '--', repoPath]);

    const lines: string[] = [];
    if (status === 'DU') {
        lines.push(`100644 ${blobs.base} 1\t${repoPath}`);
        lines.push(`100644 ${blobs.incoming} 3\t${repoPath}`);
    } else {
        lines.push(`100644 ${blobs.base} 1\t${repoPath}`);
        lines.push(`100644 ${blobs.current} 2\t${repoPath}`);
    }

    git(cwd, ['update-index', '--index-info'], `${lines.join('\n')}\n`);
}

async function resolveDeleteConflict(
    resolver: NotebookConflictResolver,
    uri: vscode.Uri,
    action: DeleteVsModifyResolutionAction
): Promise<void> {
    setResolverPromptTestHooks({
        pickDeleteVsModifyAction: () => action,
        confirmAction: () => true,
    });

    try {
        await resolver.resolveConflicts(uri);
    } finally {
        setResolverPromptTestHooks(undefined);
    }
}

async function assertKeepContentResult(
    cwd: string,
    resolver: NotebookConflictResolver,
    uri: vscode.Uri,
    expectedContent: string,
    context: string
): Promise<void> {
    await resolveDeleteConflict(resolver, uri, 'keep-content');

    assert.ok(fs.existsSync(uri.fsPath), `Expected file to exist after keep-content (${context})`);
    const actual = fs.readFileSync(uri.fsPath, 'utf8');
    assert.strictEqual(actual, expectedContent, `Unexpected file content after keep-content (${context})`);

    assertNoUnmergedStatus(cwd, context);
    const statusLine = git(cwd, ['status', '--porcelain', '--', 'conflict.ipynb']).trim();
    assert.ok(statusLine.startsWith('M '), `Expected staged modification after keep-content (${context}), got: ${statusLine}`);

    const unmergedStatus = await gitIntegration.getUnmergedFileStatus(uri.fsPath);
    assert.strictEqual(unmergedStatus, null, `Expected no unmerged status after keep-content (${context})`);
}

async function assertKeepDeleteResult(
    cwd: string,
    resolver: NotebookConflictResolver,
    uri: vscode.Uri,
    context: string
): Promise<void> {
    // Ensure there is an on-disk file for deletion path coverage.
    fs.writeFileSync(uri.fsPath, '{"placeholder": true}\n', 'utf8');

    await resolveDeleteConflict(resolver, uri, 'keep-delete');

    assert.ok(!fs.existsSync(uri.fsPath), `Expected file to be deleted after keep-delete (${context})`);
    assertNoUnmergedStatus(cwd, context);

    const statusLine = git(cwd, ['status', '--porcelain', '--', 'conflict.ipynb']).trim();
    assert.ok(statusLine.startsWith('D '), `Expected staged deletion after keep-delete (${context}), got: ${statusLine}`);

    const unmergedStatus = await gitIntegration.getUnmergedFileStatus(uri.fsPath);
    assert.strictEqual(unmergedStatus, null, `Expected no unmerged status after keep-delete (${context})`);
}

export async function run(): Promise<void> {
    const config = readTestConfig();
    const workspacePath = config.workspacePath;
    const conflictPath = path.join(workspacePath, 'conflict.ipynb');
    const conflictUri = vscode.Uri.file(conflictPath);

    const fallbackUri = vscode.Uri.file(workspacePath);
    const extensionUri = vscode.workspace.workspaceFolders?.[0]?.uri ?? fallbackUri;
    const resolver = new NotebookConflictResolver(extensionUri);

    const baseContent = notebookContent('base-side');
    const currentContent = notebookContent('current-side');
    const incomingContent = notebookContent('incoming-side');
    const blobs = {
        base: hashBlob(workspacePath, baseContent),
        current: hashBlob(workspacePath, currentContent),
        incoming: hashBlob(workspacePath, incomingContent),
    };

    setConflictStatus(workspacePath, 'DU', blobs);
    await gitIntegration.refreshUnmergedFilesSnapshot(workspacePath);
    await assertKeepContentResult(workspacePath, resolver, conflictUri, incomingContent, 'DU keep-content');

    setConflictStatus(workspacePath, 'DU', blobs);
    await gitIntegration.refreshUnmergedFilesSnapshot(workspacePath);
    await assertKeepDeleteResult(workspacePath, resolver, conflictUri, 'DU keep-delete');

    setConflictStatus(workspacePath, 'UD', blobs);
    await gitIntegration.refreshUnmergedFilesSnapshot(workspacePath);
    await assertKeepContentResult(workspacePath, resolver, conflictUri, currentContent, 'UD keep-content');

    setConflictStatus(workspacePath, 'UD', blobs);
    await gitIntegration.refreshUnmergedFilesSnapshot(workspacePath);
    await assertKeepDeleteResult(workspacePath, resolver, conflictUri, 'UD keep-delete');

    console.log('DU/UD pick-one regression test passed.');
}
