/**
 * Focused VS Code extension-host test for gitIntegration notebook-tool guard.
 *
 * This test does not use Playwright. It validates that:
 * - incompatible notebook Git config triggers modal guidance
 * - choosing auto-fix clears both local/global problematic config
 * - ensureSupportedMergeTool succeeds after cleanup
 */

import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as gitIntegration from '../gitIntegration';

type PromptCall = {
    message: string;
    actions: string[];
};

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function git(cwd: string, ...args: string[]): string {
    return execSync(`git ${args.join(' ')}`, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

function gitOrEmpty(cwd: string, ...args: string[]): string {
    try {
        return git(cwd, ...args);
    } catch {
        return '';
    }
}

function ensureKeyMissing(cwd: string, scope: '--local' | '--global', key: string): void {
    const value = gitOrEmpty(cwd, 'config', scope, '--get', key);
    assert(value.length === 0, `Expected ${scope} ${key} to be unset, got "${value}"`);
}

function ensureSectionMissing(cwd: string, scope: '--local' | '--global', sectionPrefix: string): void {
    const expression = `^${sectionPrefix.replace(/\./g, '\\.')}`;
    const values = gitOrEmpty(cwd, 'config', scope, '--get-regexp', expression);
    assert(values.length === 0, `Expected ${scope} ${sectionPrefix}.* section to be removed, got "${values}"`);
}

function configureIncompatibleNotebookSettings(workspacePath: string): void {
    // Local scope.
    git(workspacePath, 'config', '--local', 'merge.tool', 'nbdime');
    git(workspacePath, 'config', '--local', 'mergetool.nbdime.cmd', '"nbmerge-driver \"$LOCAL\" \"$REMOTE\" \"$BASE\" \"$MERGED\""');
    git(workspacePath, 'config', '--local', 'nbdime.autoresolve', 'false');

    // Global scope (isolated by GIT_CONFIG_GLOBAL in the runner).
    git(workspacePath, 'config', '--global', 'diff.tool', 'nbdime');
    git(workspacePath, 'config', '--global', 'difftool.nbdime.cmd', '"nbdiff-web \"$LOCAL\" \"$REMOTE\""');
    git(workspacePath, 'config', '--global', 'jupyter.merge.driver', 'enabled');
}

export async function run(): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert(workspacePath, 'Expected a workspace folder for nbdime guard test');

    const promptCalls: PromptCall[] = [];
    const infoMessages: string[] = [];
    const warningMessages: string[] = [];
    let terminalCommandsCaptured = false;

    configureIncompatibleNotebookSettings(workspacePath);

    await gitIntegration.ensureSupportedMergeTool(workspacePath, {
        testHooks: {
            selectAction: async (context) => {
                promptCalls.push({
                    message: context.message,
                    actions: context.actions
                });
                if (context.actions.includes('Auto-fix repo + global')) {
                    return 'Auto-fix repo + global';
                }
                if (context.actions.includes('Auto-fix repo config')) {
                    return 'Auto-fix repo config';
                }
                return context.actions[0];
            },
            onInfoMessage: (message) => {
                infoMessages.push(message);
            },
            onWarningMessage: (message) => {
                warningMessages.push(message);
            },
            onTerminalCommands: () => {
                terminalCommandsCaptured = true;
            }
        }
    });

    assert(promptCalls.length === 1, `Expected one guidance prompt, got ${promptCalls.length}`);
    const prompt = promptCalls[0];
    assert(
        prompt.actions.includes('Auto-fix repo + global'),
        `Expected "Auto-fix repo + global" action. Got: ${prompt.actions.join(', ')}`
    );
    assert(
        prompt.actions.includes('Show terminal fix commands'),
        `Expected "Show terminal fix commands" action. Got: ${prompt.actions.join(', ')}`
    );
    assert(
        prompt.message.includes('MergeNB found incompatible Git notebook config'),
        `Unexpected guidance prompt text: ${prompt.message}`
    );
    assert(
        infoMessages.some((message) => message.includes('removed incompatible Git notebook config')),
        `Expected success message after auto-fix, got: ${infoMessages.join(' | ')}`
    );
    assert(warningMessages.length === 0, `Did not expect warning message, got: ${warningMessages.join(' | ')}`);
    assert(!terminalCommandsCaptured, 'Terminal commands should not be captured when auto-fix action is chosen');

    ensureKeyMissing(workspacePath, '--local', 'merge.tool');
    ensureKeyMissing(workspacePath, '--global', 'diff.tool');
    ensureSectionMissing(workspacePath, '--local', 'mergetool.nbdime');
    ensureSectionMissing(workspacePath, '--global', 'difftool.nbdime');
    ensureSectionMissing(workspacePath, '--global', 'jupyter.merge');

    // Second call should be a no-op with no additional guidance prompts.
    await gitIntegration.ensureSupportedMergeTool(workspacePath, {
        testHooks: {
            selectAction: async (context) => {
                promptCalls.push({
                    message: context.message,
                    actions: context.actions
                });
                return 'Auto-fix repo + global';
            }
        }
    });
    assert(promptCalls.length === 1, 'Unexpected extra guidance prompt after auto-fix cleanup');
}
