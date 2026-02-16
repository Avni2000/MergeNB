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

type ShowErrorCall = {
    message: string;
    modal: boolean;
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

function restoreWindowMethod<T extends keyof typeof vscode.window>(
    key: T,
    original: (typeof vscode.window)[T]
): void {
    (vscode.window as unknown as Record<string, unknown>)[key] = original;
}

export async function run(): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert(workspacePath, 'Expected a workspace folder for nbdime guard test');

    const showErrorCalls: ShowErrorCall[] = [];
    const infoMessages: string[] = [];
    const warningMessages: string[] = [];
    let terminalCreated = false;

    configureIncompatibleNotebookSettings(workspacePath);

    const originalShowErrorMessage = vscode.window.showErrorMessage;
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalCreateTerminal = vscode.window.createTerminal;

    try {
        (vscode.window as unknown as Record<string, unknown>).showErrorMessage = async (
            message: string,
            ...items: unknown[]
        ): Promise<string | undefined> => {
            let modal = false;
            let actions: string[] = [];
            if (items.length > 0 && typeof items[0] === 'object' && items[0] !== null && 'modal' in (items[0] as object)) {
                const options = items[0] as { modal?: boolean };
                modal = options.modal === true;
                actions = items.slice(1).map((item) => String(item));
            } else {
                actions = items.map((item) => String(item));
            }

            showErrorCalls.push({ message, modal, actions });
            if (actions.includes('Auto-fix repo + global')) {
                return 'Auto-fix repo + global';
            }
            if (actions.includes('Auto-fix repo config')) {
                return 'Auto-fix repo config';
            }
            return actions[0];
        };

        (vscode.window as unknown as Record<string, unknown>).showInformationMessage = async (
            message: string
        ): Promise<string | undefined> => {
            infoMessages.push(message);
            return undefined;
        };

        (vscode.window as unknown as Record<string, unknown>).showWarningMessage = async (
            message: string
        ): Promise<string | undefined> => {
            warningMessages.push(message);
            return undefined;
        };

        (vscode.window as unknown as Record<string, unknown>).createTerminal = () => {
            terminalCreated = true;
            return {
                show: () => undefined,
                sendText: () => undefined,
                dispose: () => undefined,
                hide: () => undefined,
                processId: Promise.resolve(0),
                creationOptions: {},
                name: 'mock-terminal',
                exitStatus: undefined,
                state: { isInteractedWith: false },
            } as unknown as vscode.Terminal;
        };

        await gitIntegration.ensureSupportedMergeTool(workspacePath);

        assert(showErrorCalls.length === 1, `Expected one modal warning, got ${showErrorCalls.length}`);
        const warning = showErrorCalls[0];
        assert(warning.modal, 'Expected unsupported config warning to be modal');
        assert(
            warning.actions.includes('Auto-fix repo + global'),
            `Expected "Auto-fix repo + global" action. Got: ${warning.actions.join(', ')}`
        );
        assert(
            warning.actions.includes('Show terminal fix commands'),
            `Expected "Show terminal fix commands" action. Got: ${warning.actions.join(', ')}`
        );
        assert(
            infoMessages.some((message) => message.includes('removed incompatible Git notebook config')),
            `Expected success message after auto-fix, got: ${infoMessages.join(' | ')}`
        );
        assert(warningMessages.length === 0, `Did not expect warning message, got: ${warningMessages.join(' | ')}`);
        assert(!terminalCreated, 'Terminal should not be created when auto-fix action is chosen');

        ensureKeyMissing(workspacePath, '--local', 'merge.tool');
        ensureKeyMissing(workspacePath, '--global', 'diff.tool');
        ensureSectionMissing(workspacePath, '--local', 'mergetool.nbdime');
        ensureSectionMissing(workspacePath, '--global', 'difftool.nbdime');
        ensureSectionMissing(workspacePath, '--global', 'jupyter.merge');

        // Second call should be a no-op with no additional warning UI.
        await gitIntegration.ensureSupportedMergeTool(workspacePath);
        assert(showErrorCalls.length === 1, 'Unexpected extra modal warning after auto-fix cleanup');
    } finally {
        restoreWindowMethod('showErrorMessage', originalShowErrorMessage);
        restoreWindowMethod('showInformationMessage', originalShowInformationMessage);
        restoreWindowMethod('showWarningMessage', originalShowWarningMessage);
        restoreWindowMethod('createTerminal', originalCreateTerminal);
    }
}
