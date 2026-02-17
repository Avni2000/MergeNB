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
 * Workspace-aware helpers (e.g. getUnmergedFiles, ensureSupportedMergeTool with no path)
 * use VSCode APIs when available.
 */

import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

// VSCode is optional - only needed for workspace-aware helpers.
let vscode: typeof import('vscode') | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running in headless/test mode without VSCode
}

const execAsync = promisify(exec);
const nbdimeWarningShownRoots = new Set<string>();
const notebookConfigPattern = /(jupyter|ipynb|nbdiff|nbdime)/i;
const notebookToolValuePattern = /(jupyter|nbdiff|nbdime)/i;

type GitConfigScope = 'local' | 'global';

interface GitConfigEntry {
    key: string;
    value: string;
}

interface IncompatibleGitConfigIssue {
    scope: GitConfigScope;
    key: string;
    value: string;
}

export interface EnsureSupportedMergeToolIssue {
    scope: 'local' | 'global';
    key: string;
    value: string;
}

export interface EnsureSupportedMergeToolPromptContext {
    gitRoot: string;
    issues: EnsureSupportedMergeToolIssue[];
    message: string;
    actions: string[];
}

export interface EnsureSupportedMergeToolTestHooks {
    selectAction?: (
        context: EnsureSupportedMergeToolPromptContext
    ) => Promise<string | undefined> | string | undefined;
    onInfoMessage?: (message: string) => void;
    onWarningMessage?: (message: string) => void;
    onTerminalCommands?: (commands: string[]) => void;
}

export interface EnsureSupportedMergeToolOptions {
    suppressIfAlreadyShown?: boolean;
    testHooks?: EnsureSupportedMergeToolTestHooks;
}

const toolPointerKeys = new Set(['merge.tool', 'diff.tool']);

export class UnsupportedMergeToolError extends Error {
    constructor(public readonly gitRoot: string, public readonly issues: IncompatibleGitConfigIssue[]) {
        const summary = issues
            .map((issue) => `${issue.scope}:${issue.key}`)
            .join(', ');
        super(`[MergeNB] Incompatible Git notebook config detected: ${summary}`);
        this.name = 'UnsupportedMergeToolError';
    }
}

function getGitConfigWorkingDirectory(targetPath: string): string {
    try {
        return fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
    } catch {
        return path.dirname(targetPath);
    }
}

async function resolveGitRootForPath(targetPath: string): Promise<string | null> {
    try {
        const { stdout } = await execAsync('git rev-parse --show-toplevel', {
            cwd: getGitConfigWorkingDirectory(targetPath)
        });
        const root = stdout.trim();
        return root || null;
    } catch {
        return null;
    }
}

async function resolveGitRoots(gitRootOrPath?: string): Promise<string[]> {
    const roots = new Set<string>();

    if (gitRootOrPath) {
        const root = await resolveGitRootForPath(gitRootOrPath);
        if (root) {
            roots.add(root);
        }
        return [...roots];
    }

    const workspaceFolders = vscode?.workspace?.workspaceFolders ?? [];
    for (const folder of workspaceFolders) {
        const root = await resolveGitRootForPath(folder.uri.fsPath);
        if (root) {
            roots.add(root);
        }
    }

    return [...roots];
}

async function listGitConfigEntries(gitRoot: string, scope: GitConfigScope): Promise<GitConfigEntry[]> {
    try {
        const { stdout } = await execAsync(`git config --${scope} --null --list`, { cwd: gitRoot });
        return stdout
            .split('\0')
            .filter((entry) => entry.trim().length > 0)
            .map((entry) => {
                // `git config --null --list` may encode each record as either:
                // - key=value\0
                // - key\nvalue\0
                // depending on git output mode/platform.
                const equalsIndex = entry.indexOf('=');
                const newlineIndex = entry.indexOf('\n');
                const separator =
                    equalsIndex === -1
                        ? newlineIndex
                        : newlineIndex === -1
                            ? equalsIndex
                            : Math.min(equalsIndex, newlineIndex);
                if (separator === -1) {
                    return {
                        key: entry.trim(),
                        value: ''
                    };
                }
                return {
                    key: entry.slice(0, separator).trim(),
                    value: entry.slice(separator + 1).trim()
                };
            })
            .filter((entry) => entry.key.length > 0);
    } catch {
        return [];
    }
}

function dedupeIssues(issues: IncompatibleGitConfigIssue[]): IncompatibleGitConfigIssue[] {
    const seen = new Set<string>();
    const deduped: IncompatibleGitConfigIssue[] = [];
    for (const issue of issues) {
        const key = `${issue.scope}:${issue.key}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(issue);
    }
    return deduped;
}

async function findIncompatibleGitConfig(gitRoot: string): Promise<IncompatibleGitConfigIssue[]> {
    const [localEntries, globalEntries] = await Promise.all([
        listGitConfigEntries(gitRoot, 'local'),
        listGitConfigEntries(gitRoot, 'global')
    ]);

    const issues: IncompatibleGitConfigIssue[] = [];
    const collectIssues = (scope: GitConfigScope, entries: GitConfigEntry[]): void => {
        for (const entry of entries) {
            const keyMatches = notebookConfigPattern.test(entry.key);
            const pointsToNotebookTool = toolPointerKeys.has(entry.key) && notebookToolValuePattern.test(entry.value);
            if (!keyMatches && !pointsToNotebookTool) {
                continue;
            }
            issues.push({
                scope,
                key: entry.key,
                value: entry.value
            });
        }
    };

    collectIssues('local', localEntries);
    collectIssues('global', globalEntries);
    return dedupeIssues(issues);
}

function getIssueScopes(issues: IncompatibleGitConfigIssue[]): GitConfigScope[] {
    const scopes = new Set<GitConfigScope>();
    for (const issue of issues) {
        scopes.add(issue.scope);
    }
    return [...scopes];
}

function getScopedIssueKeys(issues: IncompatibleGitConfigIssue[], scope: GitConfigScope): string[] {
    const keys = new Set<string>();
    for (const issue of issues) {
        if (issue.scope === scope) {
            keys.add(issue.key);
        }
    }
    return [...keys];
}

function getNotebookSections(keys: string[]): string[] {
    const sections = new Set<string>();
    for (const key of keys) {
        const keyParts = key.split('.');
        if (keyParts.length < 3) {
            continue;
        }
        const section = keyParts.slice(0, -1).join('.');
        if (!notebookConfigPattern.test(section)) {
            continue;
        }
        sections.add(section);
    }
    if (sections.has('mergetool.nbdime') === false) {
        sections.add('mergetool.nbdime');
    }
    if (sections.has('difftool.nbdime') === false) {
        sections.add('difftool.nbdime');
    }
    return [...sections];
}

async function applyGitConfigFix(
    gitRoot: string,
    scopes: GitConfigScope[],
    issues: IncompatibleGitConfigIssue[]
): Promise<void> {
    for (const scope of scopes) {
        const keys = getScopedIssueKeys(issues, scope);
        for (const key of keys) {
            try {
                await execAsync(`git config --${scope} --unset-all ${key}`, { cwd: gitRoot });
            } catch {
                // Key may already be unset; ignore.
            }
        }

        const notebookSections = getNotebookSections(keys);
        for (const section of notebookSections) {
            try {
                await execAsync(`git config --${scope} --remove-section ${section}`, { cwd: gitRoot });
            } catch {
                // Section may not exist; ignore.
            }
        }
    }
}

function getNbdimeDisableCommands(error: UnsupportedMergeToolError): string[] {
    const commands: string[] = [
        '# MergeNB detected incompatible Git notebook config (jupyter/ipynb/nbdiff/nbdime).',
        '# Review the commands below, then press Enter to run selected ones.'
    ];

    const localKeys = getScopedIssueKeys(error.issues, 'local');
    const globalKeys = getScopedIssueKeys(error.issues, 'global');

    if (localKeys.length > 0) {
        commands.push('# Local repository settings');
        for (const key of localKeys) {
            commands.push(`git config --local --unset-all ${key}`);
        }
        for (const section of getNotebookSections(localKeys)) {
            commands.push(`git config --local --remove-section ${section}`);
        }
    }

    if (globalKeys.length > 0) {
        commands.push('# Global user settings');
        for (const key of globalKeys) {
            commands.push(`git config --global --unset-all ${key}`);
        }
        for (const section of getNotebookSections(globalKeys)) {
            commands.push(`git config --global --remove-section ${section}`);
        }
    }

    commands.push('# Optional: uninstall nbdime if you no longer use it');
    commands.push('python -m pip uninstall nbdime');
    return commands;
}

function summarizeIssues(issues: IncompatibleGitConfigIssue[]): string {
    const keys = issues.map((issue) => issue.key);
    const uniqueKeys = [...new Set(keys)];
    const preview = uniqueKeys.slice(0, 3).join(', ');
    if (uniqueKeys.length <= 3) {
        return preview;
    }
    return `${preview} (+${uniqueKeys.length - 3} more)`;
}

async function showUnsupportedMergeToolGuidance(
    error: UnsupportedMergeToolError,
    options?: EnsureSupportedMergeToolOptions
): Promise<boolean> {
    const selectAction = options?.testHooks?.selectAction;
    if (!vscode && !selectAction) {
        return false;
    }
    if (options?.suppressIfAlreadyShown && nbdimeWarningShownRoots.has(error.gitRoot)) {
        return false;
    }
    if (options?.suppressIfAlreadyShown) {
        nbdimeWarningShownRoots.add(error.gitRoot);
    }

    const scopes = getIssueScopes(error.issues);
    const fixRepoChoice = 'Auto-fix repo config';
    const fixGlobalChoice = 'Auto-fix global config';
    const fixBothChoice = 'Auto-fix repo + global';
    const terminalChoice = 'Show terminal fix commands';
    const actions: string[] = [];

    if (scopes.length > 1) {
        actions.push(fixBothChoice);
    }
    if (scopes.includes('local')) {
        actions.push(fixRepoChoice);
    }
    if (scopes.includes('global')) {
        actions.push(fixGlobalChoice);
    }
    actions.push(terminalChoice);

    const message =
        `MergeNB found incompatible Git notebook config in ${path.basename(error.gitRoot)}: ${summarizeIssues(error.issues)}`;

    const selection = selectAction
        ? await selectAction({
            gitRoot: error.gitRoot,
            issues: error.issues,
            message,
            actions: [...actions]
        })
        : await vscode!.window.showErrorMessage(
            message,
            { modal: true },
            ...actions
        );

    if (!selection) {
        return false;
    }

    if (selection === terminalChoice) {
        const terminalCommands = getNbdimeDisableCommands(error);
        options?.testHooks?.onTerminalCommands?.(terminalCommands);
        if (!selectAction && vscode) {
            const terminal = vscode.window.createTerminal({ name: 'MergeNB notebook config fix', cwd: error.gitRoot });
            terminal.show(true);
            // Safety: avoid executing commands on paste; keep them commented out.  
            const safeLines = terminalCommands.map((line) => (line.startsWith('#') ? line : `# ${line}`));  
            terminal.sendText(safeLines.join('\n'), false);  
        }
        return false;
    }

    const scopesToFix: GitConfigScope[] =
        selection === fixBothChoice
            ? ['local', 'global']
            : selection === fixRepoChoice
                ? ['local']
                : ['global'];

    await applyGitConfigFix(error.gitRoot, scopesToFix, error.issues);
    const remainingIssues = await findIncompatibleGitConfig(error.gitRoot);
    if (remainingIssues.length === 0) {
        const infoMessage = 'MergeNB removed incompatible Git notebook config settings.';
        options?.testHooks?.onInfoMessage?.(infoMessage);
        if (!selectAction && vscode) {
            vscode.window.showInformationMessage(infoMessage);
        }
        return true;
    }

    const warningMessage =
        'MergeNB could not remove all incompatible Git notebook settings automatically. Use terminal fix commands and retry.';
    options?.testHooks?.onWarningMessage?.(warningMessage);
    if (!selectAction && vscode) {
        vscode.window.showWarningMessage(warningMessage);
    }
    return false;
}

export async function ensureSupportedMergeTool(
    gitRootOrPath?: string,
    options?: EnsureSupportedMergeToolOptions
): Promise<void> {
    const gitRoots = await resolveGitRoots(gitRootOrPath);
    for (const gitRoot of gitRoots) {
        const issues = await findIncompatibleGitConfig(gitRoot);
        if (issues.length === 0) {
            continue;
        }

        const error = new UnsupportedMergeToolError(gitRoot, issues);
        const fixed = await showUnsupportedMergeToolGuidance(error, {
            suppressIfAlreadyShown: options?.suppressIfAlreadyShown,
            testHooks: options?.testHooks
        });
        if (!fixed) {
            throw error;
        }
    }
}

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
    return resolveGitRootForPath(filePath);
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
    const candidateRoots = new Set<string>();
    if (typeof workspaceFolderOrPath === 'string') {
        candidateRoots.add(workspaceFolderOrPath);
    } else if (workspaceFolderOrPath?.uri?.fsPath) {
        candidateRoots.add(workspaceFolderOrPath.uri.fsPath);
    } else {
        for (const folder of vscode?.workspace?.workspaceFolders ?? []) {
            candidateRoots.add(folder.uri.fsPath);
        }
    }

    if (candidateRoots.size === 0) {
        console.log('[GitIntegration] getUnmergedFiles: no workspace roots found, returning empty');
        return [];
    }

    const gitRoots = new Set<string>();
    for (const candidate of candidateRoots) {
        const gitRoot = await resolveGitRootForPath(candidate);
        if (gitRoot) {
            gitRoots.add(gitRoot);
        }
    }

    if (gitRoots.size === 0) {
        console.log('[GitIntegration] getUnmergedFiles: no git roots found, returning empty');
        return [];
    }

    const unmergedFiles: GitFileStatus[] = [];
    for (const gitRoot of gitRoots) {
        try {
            const { stdout } = await execAsync('git status --porcelain', { cwd: gitRoot });
            console.log(`[GitIntegration] getUnmergedFiles git status output for ${gitRoot}:\n${stdout}`);

            const lines = stdout.split('\n').filter((line) => line.trim());
            console.log(`[GitIntegration] getUnmergedFiles: ${lines.length} non-empty lines in ${gitRoot}`);

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
        } catch (error) {
            console.error(`[GitIntegration] Error getting unmerged files for ${gitRoot}:`, error);
        }
    }

    return unmergedFiles;
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
