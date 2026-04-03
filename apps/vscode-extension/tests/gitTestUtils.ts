/**
 * @file gitTestUtils.ts
 * @description Shared git CLI helpers for VS Code regression tests.
 */

import { execFileSync } from 'child_process';

export function git(cwd: string, args: string[], input?: string): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}

export function gitAllowFailure(cwd: string, args: string[], input?: string): string {
    try {
        return git(cwd, args, input);
    } catch (error: any) {
        const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
        const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
        return `${stdout}\n${stderr}`.trim();
    }
}

export function hashBlob(cwd: string, content: string): string {
    return git(cwd, ['hash-object', '-w', '--stdin'], content).trim();
}

/** Returns true if the porcelain status output contains an unmerged entry for conflict.ipynb. */
export function hasUnmergedConflict(statusOutput: string): boolean {
    return statusOutput
        .split('\n')
        .map((line) => line.trim())
        .some((line) => /^(UU|AA|DD|AU|UA|DU|UD)\s+conflict\.ipynb$/.test(line));
}

/** Throws if conflict.ipynb has an unmerged status in the git index. */
export function assertNoUnmergedConflict(cwd: string, context: string): void {
    const status = git(cwd, ['status', '--porcelain', '--', 'conflict.ipynb']);
    if (hasUnmergedConflict(status)) {
        throw new Error(`Expected no unmerged status ${context}, got:\n${status}`);
    }
}
