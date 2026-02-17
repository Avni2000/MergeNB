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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`));
        }, timeoutMs);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function git(cwd: string, ...args: string[]): string {
    try {
        return execSync(`git ${args.join(' ')}`, {
            cwd,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
    } catch (error: any) {
        if (error?.status === 0) {
            return String(error.stdout || '').trim();
        }
        throw error;
    }
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

function ensureKeyValue(cwd: string, scope: '--local' | '--global', key: string, expectedValue: string): void {
    const value = git(cwd, 'config', scope, '--get', key);
    assert(value === expectedValue, `Expected ${scope} ${key}="${expectedValue}", got "${value}"`);
}

function ensureSectionMissing(cwd: string, scope: '--local' | '--global', sectionPrefix: string): void {
    const expression = `^${sectionPrefix.replace(/\./g, '\\.')}`;
    const values = gitOrEmpty(cwd, 'config', scope, '--get-regexp', expression);
    assert(values.length === 0, `Expected ${scope} ${sectionPrefix}.* section to be removed, got "${values}"`);
}

function ensureCommandsInclude(commands: string[], expectedCommands: string[]): void {
    for (const command of expectedCommands) {
        assert(
            commands.includes(command),
            `Expected terminal guidance to include command "${command}".\nGot:\n${commands.join('\n')}`
        );
    }
}

function configureIncompatibleNotebookSettings(workspacePath: string): void {
    // Local scope.
    git(workspacePath, 'config', '--local', 'merge.tool', 'nbdime');
    git(workspacePath, 'config', '--local', 'mergetool.nbdime.keepBackup', 'false');
    git(workspacePath, 'config', '--local', 'nbdime.autoresolve', 'false');

    // Global scope (isolated by GIT_CONFIG_GLOBAL in the runner).
    git(workspacePath, 'config', '--global', 'difftool.nbdime.prompt', 'false');
    git(workspacePath, 'config', '--global', 'jupyter.merge.driver', 'enabled');
}

export async function run(): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert(workspacePath, 'Expected a workspace folder for nbdime guard test');
    console.log(`[nbdimeGuard.test] workspacePath=${workspacePath}`);

    configureIncompatibleNotebookSettings(workspacePath);
    console.log('[nbdimeGuard.test] incompatible git settings configured');
    ensureKeyValue(workspacePath, '--local', 'merge.tool', 'nbdime');
    ensureKeyValue(workspacePath, '--local', 'mergetool.nbdime.keepBackup', 'false');
    ensureKeyValue(workspacePath, '--local', 'nbdime.autoresolve', 'false');
    ensureKeyValue(workspacePath, '--global', 'difftool.nbdime.prompt', 'false');
    ensureKeyValue(workspacePath, '--global', 'jupyter.merge.driver', 'enabled');

    const terminalPromptCalls: PromptCall[] = [];
    let terminalCommands: string[] | undefined;
    try {
        await withTimeout(
            gitIntegration.ensureSupportedMergeTool(workspacePath, {
                testHooks: {
                    selectAction: async (context) => {
                        terminalPromptCalls.push({
                            message: context.message,
                            actions: context.actions
                        });
                        return 'Show terminal fix commands';
                    },
                    onTerminalCommands: (commands) => {
                        terminalCommands = commands;
                    }
                }
            }),
            15000,
            'ensureSupportedMergeTool(terminal-guidance)'
        );
        throw new Error('Expected terminal guidance path to throw UnsupportedMergeToolError');
    } catch (error) {
        assert(
            error instanceof gitIntegration.UnsupportedMergeToolError,
            `Expected UnsupportedMergeToolError from terminal guidance path, got: ${String(error)}`
        );
    }
    console.log('[nbdimeGuard.test] terminal guidance path completed');

    assert(terminalPromptCalls.length === 1, `Expected one terminal guidance prompt, got ${terminalPromptCalls.length}`);
    const terminalPrompt = terminalPromptCalls[0];
    assert(
        terminalPrompt.actions.includes('Show terminal fix commands'),
        `Expected "Show terminal fix commands" action. Got: ${terminalPrompt.actions.join(', ')}`
    );
    assert(Array.isArray(terminalCommands), 'Expected terminal commands to be captured');
    ensureCommandsInclude(terminalCommands!, [
        'git config --local --unset-all merge.tool',
        'git config --local --unset-all mergetool.nbdime.keepbackup',
        'git config --local --unset-all nbdime.autoresolve',
        'git config --local --remove-section mergetool.nbdime',
        'git config --local --remove-section difftool.nbdime',
        'git config --global --unset-all difftool.nbdime.prompt',
        'git config --global --unset-all jupyter.merge.driver',
        'git config --global --remove-section mergetool.nbdime',
        'git config --global --remove-section difftool.nbdime',
        'git config --global --remove-section jupyter.merge',
    ]);

    // Terminal guidance only shows commands; it must not mutate config.
    ensureKeyValue(workspacePath, '--local', 'merge.tool', 'nbdime');
    ensureKeyValue(workspacePath, '--local', 'mergetool.nbdime.keepBackup', 'false');
    ensureKeyValue(workspacePath, '--local', 'nbdime.autoresolve', 'false');
    ensureKeyValue(workspacePath, '--global', 'difftool.nbdime.prompt', 'false');
    ensureKeyValue(workspacePath, '--global', 'jupyter.merge.driver', 'enabled');

    const promptCalls: PromptCall[] = [];
    const infoMessages: string[] = [];
    const warningMessages: string[] = [];
    let terminalCommandsCaptured = false;
    await withTimeout(
        gitIntegration.ensureSupportedMergeTool(workspacePath, {
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
        }),
        15000,
        'ensureSupportedMergeTool(auto-fix)'
    );
    console.log('[nbdimeGuard.test] ensureSupportedMergeTool auto-fix completed');

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
    ensureKeyMissing(workspacePath, '--local', 'nbdime.autoresolve');
    ensureKeyMissing(workspacePath, '--global', 'difftool.nbdime.prompt');
    ensureKeyMissing(workspacePath, '--global', 'jupyter.merge.driver');
    ensureSectionMissing(workspacePath, '--local', 'mergetool.nbdime');
    ensureSectionMissing(workspacePath, '--global', 'difftool.nbdime');
    ensureSectionMissing(workspacePath, '--global', 'jupyter.merge');
    console.log('[nbdimeGuard.test] config cleanup assertions completed');

    // Second call should be a no-op with no additional guidance prompts.
    const promptCallsBeforeNoOp = promptCalls.length;
    await withTimeout(
        gitIntegration.ensureSupportedMergeTool(workspacePath, {
            testHooks: {
                selectAction: async (context) => {
                    promptCalls.push({
                        message: context.message,
                        actions: context.actions
                    });
                    return 'Auto-fix repo + global';
                }
            }
        }),
        10000,
        'ensureSupportedMergeTool(no-op)'
    );
    const promptCallsFromNoOp = promptCalls.slice(promptCallsBeforeNoOp);
    assert(promptCallsFromNoOp.length === 0, 'Unexpected extra guidance prompt after auto-fix cleanup');
    console.log('[nbdimeGuard.test] completed');
}
