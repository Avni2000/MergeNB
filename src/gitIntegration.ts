/**
 * @file gitIntegration.ts
 * @description Git command-line integration for retrieving merge conflict data.
 * 
 * Provides:
 * - Detection of unmerged files (Git UU status)
 * - Retrieval of three-way merge versions from Git staging areas:
 *   - Stage 1 (:1:file) = base (common ancestor)
 *   - Stage 2 (:2:file) = current (ours/HEAD)
 *   - Stage 3 (:3:file) = incoming (theirs/MERGE_HEAD)
 * - Branch name detection for UI display
 * - Git staging operations after resolution
 * 
 * NOTE: Most functions are VSCode-independent and can be used in headless tests.
 * Only getUnmergedFiles() uses VSCode workspace APIs (with optional fallback).
 */

import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

// VSCode is optional - only needed for getUnmergedFiles with workspace folders
let vscode: typeof import('vscode') | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running in headless/test mode without VSCode
}

const execAsync = promisify(exec);

function toGitPath(filePath: string): string {
    const converted = filePath.replace(/\\/g, '/');
    if (converted !== filePath) {
        console.log(`[GitIntegration] Path conversion: '${filePath}' -> '${converted}'`);
    }
    return converted;
}

/**
 * Resolve a path to its canonical form, expanding Windows 8.3 short names
 * (e.g. RUNNER~1 → runneradmin) so that path.relative() works correctly
 * when comparing paths from different sources (os.tmpdir vs git output).
 */
function resolveRealPath(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return p;
    }
}

/**
 * Compute the git-relative path for a file, handling Windows short-path mismatches.
 * Both gitRoot (from `git rev-parse`) and filePath (from VSCode/os.tmpdir) are
 * resolved to their canonical long-name forms before computing the relative path.
 */
function gitRelativePath(gitRoot: string, filePath: string): string {
    return toGitPath(path.relative(resolveRealPath(gitRoot), resolveRealPath(filePath)));
}

function normalizeForComparison(filePath: string): string {
    const normalized = toGitPath(path.normalize(filePath));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function splitPathSegments(filePath: string): string[] {
    return normalizeForComparison(filePath)
        .split('/')
        .filter(Boolean);
}

function pathHasSuffix(targetPath: string, suffixPath: string): boolean {
    const targetSegments = splitPathSegments(targetPath);
    const suffixSegments = splitPathSegments(suffixPath);

    if (suffixSegments.length === 0 || suffixSegments.length > targetSegments.length) {
        return false;
    }

    for (let i = 1; i <= suffixSegments.length; i++) {
        if (targetSegments[targetSegments.length - i] !== suffixSegments[suffixSegments.length - i]) {
            return false;
        }
    }

    return true;
}

function pathsLikelySameFile(firstPath: string, secondPath: string, repoPath?: string): boolean {
    const firstReal = normalizeForComparison(resolveRealPath(firstPath));
    const secondReal = normalizeForComparison(resolveRealPath(secondPath));
    if (firstReal === secondReal) {
        return true;
    }

    const firstNorm = normalizeForComparison(firstPath);
    const secondNorm = normalizeForComparison(secondPath);
    if (firstNorm === secondNorm) {
        return true;
    }

    if (!repoPath) {
        return false;
    }

    const repoNorm = normalizeForComparison(repoPath);
    return pathHasSuffix(firstNorm, repoNorm) && pathHasSuffix(secondNorm, repoNorm);
}

function isUnmergedStatus(status: string): boolean {
    return status === 'UU' || status === 'AA' || status === 'DD';
}

function normalizeStatusPath(statusPath: string): string {
    let normalized = statusPath.trim();

    if (normalized.startsWith('"') && normalized.endsWith('"')) {
        normalized = normalized.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }

    return toGitPath(normalized);
}

export interface GitFileStatus {
    path: string;
    repoPath?: string;
    status: string; // 'UU' = unmerged, both modified
    isUnmerged: boolean;
}

async function resolveStatusPathForFile(gitRoot: string, filePath: string): Promise<string | null> {
    const unmergedFiles = await getUnmergedFiles(gitRoot);

    for (const file of unmergedFiles) {
        if (pathsLikelySameFile(file.path, filePath, file.repoPath)) {
            return file.repoPath || null;
        }
    }

    return null;
}

async function resolveGitPathForFile(gitRoot: string, filePath: string): Promise<string | null> {
    const relativePath = gitRelativePath(gitRoot, filePath);
    if (relativePath && relativePath !== '.' && !relativePath.startsWith('..')) {
        return relativePath;
    }

    const statusPath = await resolveStatusPathForFile(gitRoot, filePath);
    if (statusPath) {
        console.log(`[GitIntegration] Resolved git-relative path from status entries: ${statusPath}`);
        return statusPath;
    }

    console.warn(`[GitIntegration] Could not resolve git-relative path for ${filePath}`);
    return null;
}

/**
 * Get the Git repository root for a given file path
 */
export async function getGitRoot(filePath: string): Promise<string | null> {
    try {
        const dir = path.dirname(filePath);
        const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: dir });
        return stdout.trim();
    } catch (error) {
        return null;
    }
}

/**
 * Check if a file has unmerged status (UU) in Git
 */
export async function isUnmergedFile(filePath: string): Promise<boolean> {
    try {
        const gitRoot = await getGitRoot(filePath);
        console.log(`[GitIntegration] Checking if unmerged: ${filePath} (gitRoot: ${gitRoot})`);
        if (!gitRoot) {
            console.log(`[GitIntegration] No git root found for ${filePath}`);
            return false;
        }

        const statusPath = await resolveStatusPathForFile(gitRoot, filePath);
        if (statusPath) {
            console.log(`[GitIntegration] MATCHED: ${filePath} is unmerged at ${statusPath}`);
            return true;
        }

        console.log(`[GitIntegration] No unmerged status found for ${filePath}`);
        return false;
    } catch (error) {
        console.error(`[GitIntegration] Error in isUnmergedFile: ${error}`);
        return false;
    }
}

/**
 * Get all unmerged files in the workspace.
 * Can be called with a VSCode WorkspaceFolder, a string path, or no argument.
 */
export async function getUnmergedFiles(workspaceFolderOrPath?: any): Promise<GitFileStatus[]> {
    try {
        let gitRoot: string | undefined;
        
        // Handle different argument types
        if (typeof workspaceFolderOrPath === 'string') {
            gitRoot = workspaceFolderOrPath;
        } else if (workspaceFolderOrPath?.uri?.fsPath) {
            // VSCode WorkspaceFolder
            gitRoot = workspaceFolderOrPath.uri.fsPath;
        } else if (vscode?.workspace?.workspaceFolders?.[0]?.uri?.fsPath) {
            // Fallback to first VSCode workspace folder
            gitRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        }
        
        console.log(`[GitIntegration] getUnmergedFiles: gitRoot = ${gitRoot}`);
        if (!gitRoot) {
            console.log(`[GitIntegration] getUnmergedFiles: no gitRoot, returning empty`);
            return [];
        }

        const { stdout } = await execAsync('git status --porcelain', { cwd: gitRoot });
        console.log(`[GitIntegration] getUnmergedFiles git status output:\n${stdout}`);
        
        const unmergedFiles: GitFileStatus[] = [];
        const lines = stdout.split('\n').filter(line => line.trim());
        console.log(`[GitIntegration] getUnmergedFiles: ${lines.length} non-empty lines`);
        
        for (const line of lines) {
            const status = line.substring(0, 2);
            const filePath = normalizeStatusPath(line.substring(3));
            console.log(`[GitIntegration]   Line: "${line}" -> status="${status}" path="${filePath}"`);
            
            if (isUnmergedStatus(status)) {
                const fullPath = path.join(gitRoot, filePath);
                console.log(`[GitIntegration]   -> UNMERGED: ${fullPath}`);
                unmergedFiles.push({
                    path: fullPath,
                    repoPath: filePath,
                    status,
                    isUnmerged: true
                });
            }
        }
        
        return unmergedFiles;
    } catch (error) {
        console.error('Error getting unmerged files:', error);
        return [];
    }
}

/**
 * Get the base version of a file from Git staging area (stage :1:)
 * This is the common ancestor version before the merge
 */
export async function getBaseVersion(filePath: string): Promise<string | null> {
    try {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) return null;

        const relativePath = await resolveGitPathForFile(gitRoot, filePath);
        if (!relativePath) return null;
        const { stdout } = await execAsync(`git show :1:"${relativePath}"`, { 
            cwd: gitRoot,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large notebooks
        });
        
        return stdout;
    } catch (error) {
        // File might not exist in base (newly added in both branches)
        return null;
    }
}

/**
 * Get the current version of a file from Git staging area (stage :2:)
 * This is the "ours" version (current branch)
 */
export async function getcurrentVersion(filePath: string): Promise<string | null> {
    try {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) return null;

        const relativePath = await resolveGitPathForFile(gitRoot, filePath);
        if (!relativePath) return null;
        const { stdout } = await execAsync(`git show :2:"${relativePath}"`, { 
            cwd: gitRoot,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
        });
        
        return stdout;
    } catch (error) {
        return null;
    }
}

/**
 * Get the incoming version of a file from Git staging area (stage :3:)
 * This is the "theirs" version (incoming branch)
 */
export async function getincomingVersion(filePath: string): Promise<string | null> {
    try {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) return null;

        const relativePath = await resolveGitPathForFile(gitRoot, filePath);
        if (!relativePath) return null;
        const { stdout } = await execAsync(`git show :3:"${relativePath}"`, { 
            cwd: gitRoot,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
        });
        
        return stdout;
    } catch (error) {
        return null;
    }
}

/**
 * Get all three versions (base, current, incoming) of a file
 */
export async function getThreeWayVersions(filePath: string): Promise<{
    base: string | null;
    current: string | null;
    incoming: string | null;
} | null> {
    const [base, current, incoming] = await Promise.all([
        getBaseVersion(filePath),
        getcurrentVersion(filePath),
        getincomingVersion(filePath)
    ]);

    if (base === null && current === null && incoming === null) {
        return null;
    }

    return { base, current, incoming };
}

/**
 * Check if a file is a semantic conflict (unmerged status)
 */
export async function isSemanticConflict(filePath: string, content: string): Promise<boolean> {
    return await isUnmergedFile(filePath);
}

/**
 * Get current branch name
 */
export async function getCurrentBranch(filePath: string): Promise<string | null> {
    try {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) return null;

        const { stdout } = await execAsync('git branch --show-current', { cwd: gitRoot });
        return stdout.trim() || null;
    } catch (error) {
        return null;
    }
}

/**
 * Get the branch being merged into current branch
 */
export async function getMergeBranch(filePath: string): Promise<string | null> {
    try {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) return null;

        const { stdout } = await execAsync('git rev-parse MERGE_HEAD', { cwd: gitRoot });
        const mergeHead = stdout.trim();
        
        // Try to get branch name
        try {
            const { stdout: branchName } = await execAsync(
                `git name-rev --name-only ${mergeHead}`, 
                { cwd: gitRoot }
            );
            return branchName.trim();
        } catch {
            return mergeHead.substring(0, 7); // Short hash as fallback
        }
    } catch (error) {
        return null;
    }
}
