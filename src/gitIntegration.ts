/**
 * @file gitIntegration.ts
 * @description Git command-line integration for retrieving merge conflict data.
 * 
 * Provides:
 * - Detection of unmerged files (Git UU status)
 * - Retrieval of three-way merge versions from Git staging areas:
 *   - Stage 1 (:1:file) = base (common ancestor)
 *   - Stage 2 (:2:file) = local (ours/HEAD)
 *   - Stage 3 (:3:file) = remote (theirs/MERGE_HEAD)
 * - Branch name detection for UI display
 * - Git staging operations after resolution
 * 
 * NOTE: Most functions are VSCode-independent and can be used in headless tests.
 * Only getUnmergedFiles() uses VSCode workspace APIs (with optional fallback).
 */

import * as path from 'path';
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

export interface GitFileStatus {
    path: string;
    status: string; // 'UU' = unmerged, both modified
    isUnmerged: boolean;
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
        if (!gitRoot) return false;

        const relativePath = path.relative(gitRoot, filePath);
        const { stdout } = await execAsync('git status --porcelain', { cwd: gitRoot });
        
        const lines = stdout.split('\n');
        for (const line of lines) {
            // Format: "UU filename" for unmerged, both modified
            if (line.startsWith('UU ') && line.substring(3).trim() === relativePath) {
                return true;
            }
        }
        return false;
    } catch (error) {
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
        
        if (!gitRoot) return [];

        const { stdout } = await execAsync('git status --porcelain', { cwd: gitRoot });
        
        const unmergedFiles: GitFileStatus[] = [];
        const lines = stdout.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
            const status = line.substring(0, 2);
            const filePath = line.substring(3).trim();
            
            if (status === 'UU' || status === 'AA' || status === 'DD') {
                unmergedFiles.push({
                    path: path.join(gitRoot, filePath),
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

        const relativePath = path.relative(gitRoot, filePath);
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
 * Get the local version of a file from Git staging area (stage :2:)
 * This is the "ours" version (current branch)
 */
export async function getLocalVersion(filePath: string): Promise<string | null> {
    try {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) return null;

        const relativePath = path.relative(gitRoot, filePath);
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
 * Get the remote version of a file from Git staging area (stage :3:)
 * This is the "theirs" version (incoming branch)
 */
export async function getRemoteVersion(filePath: string): Promise<string | null> {
    try {
        const gitRoot = await getGitRoot(filePath);
        if (!gitRoot) return null;

        const relativePath = path.relative(gitRoot, filePath);
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
 * Get all three versions (base, local, remote) of a file
 */
export async function getThreeWayVersions(filePath: string): Promise<{
    base: string | null;
    local: string | null;
    remote: string | null;
} | null> {
    const isUnmerged = await isUnmergedFile(filePath);
    if (!isUnmerged) {
        return null;
    }

    const [base, local, remote] = await Promise.all([
        getBaseVersion(filePath),
        getLocalVersion(filePath),
        getRemoteVersion(filePath)
    ]);

    return { base, local, remote };
}

/**
 * Check if a file is a semantic conflict (unmerged but no textual markers)
 */
export async function isSemanticConflict(filePath: string, content: string): Promise<boolean> {
    const isUnmerged = await isUnmergedFile(filePath);
    if (!isUnmerged) return false;

    // Check if content has textual conflict markers
    const hasTextualMarkers = /<{7}|={7}|>{7}/.test(content);
    
    // Semantic conflict = unmerged status WITHOUT textual markers
    return !hasTextualMarkers;
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
