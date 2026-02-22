/**
 * @file statusIndicatorsRegression.test.ts
 * @description Regression test for status bar + file decoration conflict indicators.
 *
 * Verifies indicators:
 * 1) appear on VS Code startup when workspace is already in merge-conflict state,
 * 2) appear again when a new conflict is created during the session,
 * 3) disappear when the conflict is resolved via `git add`.
 */

import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { readTestConfig } from './testHarness';

interface StatusBarState {
    visible: boolean;
    text?: string;
    command?: string;
}

interface FileDecorationState {
    hasDecoration: boolean;
    badge?: string;
    tooltip?: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function git(cwd: string, args: string[], allowFailure: boolean = false): string {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        });
    } catch (error: any) {
        const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
        const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
        if (allowFailure) {
            return `${stdout}\n${stderr}`.trim();
        }
        throw new Error(`Git command failed: git ${args.join(' ')}\n${stderr || error?.message || stdout}`);
    }
}

function hasUnmergedConflict(statusOutput: string): boolean {
    return statusOutput
        .split('\n')
        .map((line) => line.trim())
        .some((line) => line.startsWith('UU ') && line.includes('conflict.ipynb'));
}

async function getStatusBarState(): Promise<StatusBarState> {
    const state = await vscode.commands.executeCommand<StatusBarState>('merge-nb.getStatusBarState');
    if (!state) {
        throw new Error('merge-nb.getStatusBarState returned no value');
    }
    return state;
}

async function getDecorationState(filePath: string): Promise<FileDecorationState> {
    const state = await vscode.commands.executeCommand<FileDecorationState>(
        'merge-nb.getFileDecorationState',
        filePath
    );
    if (!state) {
        throw new Error('merge-nb.getFileDecorationState returned no value');
    }
    return state;
}

async function waitForIndicatorState(
    filePath: string,
    shouldShow: boolean,
    label: string,
    timeoutMs: number = 15000,
    pollMs: number = 250
): Promise<{ statusBar: StatusBarState; decoration: FileDecorationState; }> {
    const start = Date.now();
    let lastStatusBar = await getStatusBarState();
    let lastDecoration = await getDecorationState(filePath);

    while (Date.now() - start < timeoutMs) {
        lastStatusBar = await getStatusBarState();
        lastDecoration = await getDecorationState(filePath);

        const statusBarMatches = shouldShow
            ? lastStatusBar.visible && (lastStatusBar.text || '').includes('1 conflict')
            : !lastStatusBar.visible;
        const decorationMatches = shouldShow
            ? lastDecoration.hasDecoration
            : !lastDecoration.hasDecoration;

        if (statusBarMatches && decorationMatches) {
            return { statusBar: lastStatusBar, decoration: lastDecoration };
        }

        await sleep(pollMs);
    }

    throw new Error(
        `Timed out waiting for indicators (${label}) shouldShow=${shouldShow}. ` +
        `Last status bar: ${JSON.stringify(lastStatusBar)}, ` +
        `last decoration: ${JSON.stringify(lastDecoration)}`
    );
}

function ensureNoUnmergedConflict(workspacePath: string, context: string): void {
    const status = git(workspacePath, ['status', '--porcelain']);
    if (hasUnmergedConflict(status)) {
        throw new Error(`Expected no UU conflict ${context}, got:\n${status}`);
    }
}

function ensureHasUnmergedConflict(workspacePath: string, context: string): void {
    const status = git(workspacePath, ['status', '--porcelain']);
    if (!hasUnmergedConflict(status)) {
        throw new Error(`Expected UU conflict ${context}, got:\n${status}`);
    }
}

export async function run(): Promise<void> {
    console.log('Starting status indicators regression test...');

    const config = readTestConfig();
    const workspacePath = config.workspacePath;
    const conflictFile = path.join(workspacePath, 'conflict.ipynb');

    // Keep the conflict notebook active so editor-change listeners are active too.
    const doc = await vscode.workspace.openTextDocument(conflictFile);
    await vscode.window.showTextDocument(doc);
    await sleep(600);

    // a) Startup: workspace starts in conflict state (created by repoSetup merge).
    ensureHasUnmergedConflict(workspacePath, 'at startup');
    const startupIndicators = await waitForIndicatorState(conflictFile, true, 'startup conflict');
    assert(startupIndicators.decoration.badge === '⚠', `Expected warning badge, got ${startupIndicators.decoration.badge}`);

    // Resolve with git add: indicators should disappear.
    git(workspacePath, ['add', 'conflict.ipynb']);
    ensureNoUnmergedConflict(workspacePath, 'after initial git add');
    await waitForIndicatorState(conflictFile, false, 'after initial git add');

    // b) Recreate a merge conflict during the same VS Code session.
    git(workspacePath, ['merge', '--abort']);
    ensureNoUnmergedConflict(workspacePath, 'after merge --abort');
    const mergeOutput = git(workspacePath, ['merge', 'incoming'], true);
    console.log(`[statusIndicatorsRegression] merge output:\n${mergeOutput}`);
    ensureHasUnmergedConflict(workspacePath, 'after recreating conflict');
    await waitForIndicatorState(conflictFile, true, 'after recreating conflict');

    // c) Resolve recreated conflict with git add: indicators should disappear again.
    git(workspacePath, ['add', 'conflict.ipynb']);
    ensureNoUnmergedConflict(workspacePath, 'after final git add');
    await waitForIndicatorState(conflictFile, false, 'after final git add');

    console.log('Status indicator regression test passed.');
}
