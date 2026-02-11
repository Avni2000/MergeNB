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
    console.log(`[RepoSetup] Running: ${cmd} (in ${cwd})`);
    try {
        const result = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        console.log(`[RepoSetup] Success: ${cmd}`);
        return result;
    } catch (error: any) {
        if(args[0] === 'merge') {
            // Merge conflicts are expected, so return the output even on non-zero exit.
            console.log(`[RepoSetup] Merge output (exit code ${error.status}):\n${error.stdout}`);
            return error.stdout || '';
        }
        // For other git commands, rethrow the error.
        console.error(`[RepoSetup] Git command failed: ${cmd}`);
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
    console.log(`[RepoSetup] Creating merge conflict repo in: ${tmpDir}`);

    git(tmpDir, 'init');
    git(tmpDir, 'config', 'user.email', '"test@mergenb.test"');
    git(tmpDir, 'config', 'user.name', '"MergeNB Test"');

    // Base commit
    console.log(`[RepoSetup] Setting up base commit from ${baseFile}`);
    fs.copyFileSync(baseFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"base"');

    const baseBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    console.log(`[RepoSetup] Base branch: ${baseBranch}`);

    // Current branch
    console.log(`[RepoSetup] Creating current branch from ${currentFile}`);
    git(tmpDir, 'checkout', '-b', 'current');
    fs.copyFileSync(currentFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"current"');

    // Incoming branch (off base)
    console.log(`[RepoSetup] Creating incoming branch from ${incomingFile}`);
    git(tmpDir, 'checkout', baseBranch);
    git(tmpDir, 'checkout', '-b', 'incoming');
    fs.copyFileSync(incomingFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"incoming"');

    // Merge → conflict
    console.log(`[RepoSetup] Merging incoming into current to create conflict...`);
    git(tmpDir, 'checkout', 'current');
    const mergeOutput = git(tmpDir, 'merge', 'incoming');
    
    // Check git status to verify conflict was created
    const statusOutput = git(tmpDir, 'status', '--porcelain');
    console.log(`[RepoSetup] Git status after merge:\n${statusOutput}`);
    
    if (!statusOutput.includes('UU')) {
        console.warn(`[RepoSetup] WARNING: No UU status found after merge! Merge may have succeeded or failed incorrectly.`);
        console.log(`[RepoSetup] Merge output was: ${mergeOutput}`);
    } else {
        console.log(`[RepoSetup] Merge conflict created successfully (found UU status)`);
    }

    return tmpDir;
}}

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
