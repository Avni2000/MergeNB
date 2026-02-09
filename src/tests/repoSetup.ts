/**
 * @file repoSetup.ts
 * @description Creates temporary git repositories with merge conflicts from
 *              notebook triplets (base / current / incoming).
 *
 * Extracted from the old runIntegrationTest.ts so it can be reused by any
 * runner without duplicating plumbing code.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

/** Run a git command in `cwd`, tolerating expected non-zero exits (e.g. merge). */
function git(cwd: string, ...args: string[]): string {
    const cmd = `git ${args.join(' ')}`;
    try {
        return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error: any) {
        if(args[0] === 'merge') {
            // Merge conflicts are expected, so return the output even on non-zero exit.
            return error.stdout || '';
        }
        // For other git commands, rethrow the error.
        throw new Error(`Git command failed: ${cmd}\n${error.stderr || error.message}`);
    }
}

/**
 * Create a temporary git repo whose working tree has a `conflict.ipynb` with
 * merge conflicts between a *current* and *incoming* branch (base is the
 * common ancestor).
 *
 * @param baseFile     Absolute path to the base notebook
 * @param currentFile  Absolute path to the current-branch notebook
 * @param incomingFile Absolute path to the incoming-branch notebook
 * @returns            Absolute path to the temporary repository
 */
export function createMergeConflictRepo(
    baseFile: string,
    currentFile: string,
    incomingFile: string,
): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergeNB-integration-'));

    git(tmpDir, 'init');
    git(tmpDir, 'config', 'user.email', '"test@mergenb.test"');
    git(tmpDir, 'config', 'user.name', '"MergeNB Test"');

    // Base commit
    fs.copyFileSync(baseFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"base"');

    const baseBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

    // Current branch
    git(tmpDir, 'checkout', '-b', 'current');
    fs.copyFileSync(currentFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"current"');

    // Incoming branch (off base)
    git(tmpDir, 'checkout', baseBranch);
    git(tmpDir, 'checkout', '-b', 'incoming');
    fs.copyFileSync(incomingFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"incoming"');

    // Merge → conflict
    git(tmpDir, 'checkout', 'current');
    git(tmpDir, 'merge', 'incoming');

    return tmpDir;
}

/** Write the test config that the VS Code test module reads at runtime. */
export function writeTestConfig(
    workspacePath: string,
    testName: string,
    params?: Record<string, unknown>,
): string {
    const configPath = path.join(os.tmpdir(), 'mergenb-test-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ workspacePath, testName, params }));
    return configPath;
}

/** Silently remove a directory tree and/or file. */
export function cleanup(dirOrFile: string): void {
    try {
        const stat = fs.statSync(dirOrFile);
        if (stat.isDirectory()) {
            fs.rmSync(dirOrFile, { recursive: true, force: true });
        } else {
            fs.unlinkSync(dirOrFile);
        }
    } catch { /* ignore */ }
}
