/**
 * @file gitIntegration.ts
 * @description Git command-line integration for retrieving merge conflict data.
 * 
 * Provides:
 * - Detection of unmerged files (Git unmerged status)
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
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { API as GitAPI, Change, GitExtension, Repository } from './typings/git';
import * as logger from '../../packages/core/src';

// VSCode is optional - only needed for workspace-aware helpers.
let vscode: typeof import('vscode') | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running in headless/test mode without VSCode
}

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
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

interface EnsureSupportedMergeToolIssue {
    scope: 'local' | 'global';
    key: string;
    value: string;
}

interface EnsureSupportedMergeToolPromptContext {
    gitRoot: string;
    issues: EnsureSupportedMergeToolIssue[];
    message: string;
    actions: string[];
}

interface EnsureSupportedMergeToolTestHooks {
    selectAction?: (
        context: EnsureSupportedMergeToolPromptContext
    ) => Promise<string | undefined> | string | undefined;
    onInfoMessage?: (message: string) => void;
    onWarningMessage?: (message: string) => void;
    onTerminalCommands?: (commands: string[]) => void;
}

interface EnsureSupportedMergeToolOptions {
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

class AggregateUnsupportedMergeToolError extends Error {
    constructor(public readonly errors: UnsupportedMergeToolError[]) {
        const roots = errors.map((error) => path.basename(error.gitRoot)).join(', ');
        super(`[MergeNB] Incompatible Git notebook config detected in multiple repositories: ${roots}`);
        this.name = 'AggregateUnsupportedMergeToolError';
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
                await execFileAsync('git', ['config', `--${scope}`, '--unset-all', key], { cwd: gitRoot });
            } catch {
                // Key may already be unset; ignore.
            }
        }

        const notebookSections = getNotebookSections(keys);
        for (const section of notebookSections) {
            try {
                await execFileAsync('git', ['config', `--${scope}`, '--remove-section', section], { cwd: gitRoot });
            } catch {
                // Section may not exist; ignore.
            }
        }
    }
}

function shellEscapeArg(value: string): string {
    if (/^[A-Za-z0-9_./-]+$/.test(value)) {
        return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
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
            commands.push(`git config --local --unset-all ${shellEscapeArg(key)}`);
        }
        for (const section of getNotebookSections(localKeys)) {
            commands.push(`git config --local --remove-section ${shellEscapeArg(section)}`);
        }
    }

    if (globalKeys.length > 0) {
        commands.push('# Global user settings');
        for (const key of globalKeys) {
            commands.push(`git config --global --unset-all ${shellEscapeArg(key)}`);
        }
        for (const section of getNotebookSections(globalKeys)) {
            commands.push(`git config --global --remove-section ${shellEscapeArg(section)}`);
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
    const unsupportedErrors: UnsupportedMergeToolError[] = [];

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
            unsupportedErrors.push(error);
        }
    }

    if (unsupportedErrors.length === 1) {
        throw unsupportedErrors[0];
    }

    if (unsupportedErrors.length > 1) {
        throw new AggregateUnsupportedMergeToolError(unsupportedErrors);
    }
}

function toGitPath(filePath: string): string {
    const converted = filePath.replace(/\\/g, '/');
    if (converted !== filePath) {
        logger.debug(`[GitIntegration] Path conversion: '${filePath}' -> '${converted}'`);
    }
    return converted;
}

/**
 * Resolve a path to its canonical form, expanding Windows 8.3 short names
 * (e.g. RUNNER~1 → runneradmin) so that path.relative() works correctly
 * when comparing paths from different sources (os.tmpdir vs git output).
 */
function resolveRealPathSync(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return p;
    }
}

async function resolveRealPath(p: string): Promise<string> {
    try {
        return await fs.promises.realpath(p);
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
    return toGitPath(path.relative(resolveRealPathSync(gitRoot), resolveRealPathSync(filePath)));
}

function normalizeForComparison(filePath: string): string {
    const withoutNamespacePrefix =
        process.platform === 'win32'
            ? filePath.startsWith('\\\\?\\UNC\\')
                ? `\\\\${filePath.slice('\\\\?\\UNC\\'.length)}`
                : filePath.startsWith('\\\\?\\')
                    ? filePath.slice('\\\\?\\'.length)
                    : filePath
            : filePath;
    const normalized = toGitPath(path.normalize(withoutNamespacePrefix));
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

interface NormalizedPathInfo {
    realPath: string;
    normalizedPath: string;
}

function getNormalizedPathInfo(filePath: string): NormalizedPathInfo {
    return {
        realPath: normalizeForComparison(resolveRealPathSync(filePath)),
        normalizedPath: normalizeForComparison(filePath)
    };
}

function pathsLikelySameFileToTarget(firstPath: string, targetPath: NormalizedPathInfo, repoPath?: string): boolean {
    const firstReal = normalizeForComparison(resolveRealPathSync(firstPath));
    if (firstReal === targetPath.realPath) {
        return true;
    }

    const firstNorm = normalizeForComparison(firstPath);
    if (firstNorm === targetPath.normalizedPath) {
        return true;
    }

    if (!repoPath) {
        return false;
    }

    const repoNorm = normalizeForComparison(repoPath);
    return pathHasSuffix(firstNorm, repoNorm) && pathHasSuffix(targetPath.normalizedPath, repoNorm);
}

function isRepoRelativePath(relativePath: string): boolean {
    if (!relativePath || relativePath === '.') {
        return false;
    }
    if (relativePath.startsWith('..')) {
        return false;
    }
    return path.isAbsolute(relativePath) === false;
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
    const relative = toGitPath(path.relative(resolveRealPathSync(rootPath), resolveRealPathSync(filePath)));
    return relative === '' || relative === '.' || isRepoRelativePath(relative);
}

export type GitUnmergedStatus = 'UU' | 'AA' | 'DD' | 'AU' | 'UA' | 'DU' | 'UD';

interface GitFileStatus {
    path: string;
    repoPath?: string;
    status: GitUnmergedStatus;
    isUnmerged: boolean;
}

interface UnmergedFilesCacheEntry {
    expiresAt: number;
    files: GitFileStatus[];
}

type GitStageNumber = '1' | '2' | '3';

interface GitFileContext {
    repository: Repository;
    gitRoot: string;
    relativePath: string;
}

interface GitCliFileContext {
    gitRoot: string;
    relativePath: string;
}

const GIT_STATUS_ADDED_BY_US = 12;
const GIT_STATUS_ADDED_BY_THEM = 13;
const GIT_STATUS_DELETED_BY_US = 14;
const GIT_STATUS_DELETED_BY_THEM = 15;
const GIT_STATUS_BOTH_ADDED = 16;
const GIT_STATUS_BOTH_DELETED = 17;
const GIT_STATUS_BOTH_MODIFIED = 18;

const UNMERGED_FILES_CACHE_TTL_MS = 500;
const UNMERGED_STATUSES = new Set<GitUnmergedStatus>(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
const unmergedFilesCacheByRoot = new Map<string, UnmergedFilesCacheEntry>();
const unmergedFilesSnapshotByRoot = new Map<string, GitFileStatus[]>();
const unmergedFilesFetchPromisesByRoot = new Map<string, Promise<GitFileStatus[]>>();
const unmergedRepoPathIndexByRoot = new Map<string, Map<string, GitFileStatus>>();
const repositoryCacheByRoot = new Map<string, Repository>();
const apiStrictWarningKeys = new Set<string>();
let gitApiPromise: Promise<GitAPI | null> | null = null;

function getGitRootCacheKey(gitRoot: string): string {
    return normalizeForComparison(resolveRealPathSync(gitRoot));
}

function warnApiStrictOnce(key: string, message: string): void {
    if (apiStrictWarningKeys.has(key)) {
        return;
    }
    apiStrictWarningKeys.add(key);
    logger.warn(`[GitIntegration] ${message}`);
}

async function getGitApi(): Promise<GitAPI | null> {
    if (gitApiPromise) {
        return gitApiPromise;
    }

    const request = (async () => {
        if (!vscode) {
            warnApiStrictOnce('api:missing-vscode', 'VS Code API unavailable; API-first unmerged support is disabled.');
            return null;
        }

        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!extension) {
            warnApiStrictOnce('api:missing-git-extension', 'vscode.git extension not found; API-first unmerged support is disabled.');
            return null;
        }

        if (!extension.isActive) {
            try {
                await extension.activate();
            } catch (error) {
                warnApiStrictOnce('api:activate-failed', `Failed to activate vscode.git extension: ${String(error)}`);
                return null;
            }
        }

        try {
            return extension.exports?.getAPI(1) ?? null;
        } catch (error) {
            warnApiStrictOnce('api:get-api-failed', `Failed to acquire vscode.git API: ${String(error)}`);
            return null;
        }
    })();

    gitApiPromise = request;
    const api = await request;
    if (!api) {
        // Allow retries on subsequent calls after transient failures/startup races.
        gitApiPromise = null;
    }
    return api;
}

function cacheRepository(repository: Repository): void {
    repositoryCacheByRoot.set(getGitRootCacheKey(repository.rootUri.fsPath), repository);
}

function getCachedUnmergedFilesForRoot(gitRoot: string): GitFileStatus[] | null {
    const cacheKey = getGitRootCacheKey(gitRoot);
    const cached = unmergedFilesCacheByRoot.get(cacheKey);
    if (!cached) {
        return null;
    }

    if (cached.expiresAt <= Date.now()) {
        unmergedFilesCacheByRoot.delete(cacheKey);
        if (!unmergedFilesSnapshotByRoot.has(cacheKey)) {
            unmergedRepoPathIndexByRoot.delete(cacheKey);
        }
        return null;
    }

    return cached.files;
}

function setSnapshotUnmergedFilesForRoot(gitRoot: string, files: GitFileStatus[]): void {
    const cacheKey = getGitRootCacheKey(gitRoot);
    unmergedFilesSnapshotByRoot.set(cacheKey, files);
    setRepoPathIndexForRoot(gitRoot, files);
}

function setCachedUnmergedFilesForRoot(gitRoot: string, files: GitFileStatus[]): void {
    const cacheKey = getGitRootCacheKey(gitRoot);
    unmergedFilesCacheByRoot.set(cacheKey, {
        expiresAt: Date.now() + UNMERGED_FILES_CACHE_TTL_MS,
        files
    });
    setRepoPathIndexForRoot(gitRoot, files);
}

function invalidateUnmergedCachesForRoot(gitRoot: string): void {
    const cacheKey = getGitRootCacheKey(gitRoot);
    unmergedFilesCacheByRoot.delete(cacheKey);
    unmergedFilesSnapshotByRoot.delete(cacheKey);
    unmergedRepoPathIndexByRoot.delete(cacheKey);
    unmergedFilesFetchPromisesByRoot.delete(cacheKey);
}

function setRepoPathIndexForRoot(gitRoot: string, files: GitFileStatus[]): void {
    const cacheKey = getGitRootCacheKey(gitRoot);
    const index = new Map<string, GitFileStatus>();
    for (const file of files) {
        if (!file.repoPath) {
            continue;
        }
        index.set(normalizeForComparison(file.repoPath), file);
    }
    unmergedRepoPathIndexByRoot.set(cacheKey, index);
}

function tryResolveStatusEntryFromIndex(gitRoot: string, filePath: string): GitFileStatus | null {
    const cacheKey = getGitRootCacheKey(gitRoot);
    const index = unmergedRepoPathIndexByRoot.get(cacheKey);
    if (!index || index.size === 0) {
        return null;
    }

    const candidatePaths = new Set<string>([
        gitRelativePath(gitRoot, filePath),
        toGitPath(path.relative(gitRoot, filePath))
    ]);

    for (const candidatePath of candidatePaths) {
        if (!isRepoRelativePath(candidatePath)) {
            continue;
        }
        const match = index.get(normalizeForComparison(candidatePath));
        if (match) {
            return match;
        }
    }

    return null;
}

function mapGitStatusToUnmergedStatus(status: number): GitUnmergedStatus | null {
    switch (status) {
        case GIT_STATUS_BOTH_MODIFIED:
            return 'UU';
        case GIT_STATUS_BOTH_ADDED:
            return 'AA';
        case GIT_STATUS_BOTH_DELETED:
            return 'DD';
        case GIT_STATUS_ADDED_BY_US:
            return 'AU';
        case GIT_STATUS_ADDED_BY_THEM:
            return 'UA';
        case GIT_STATUS_DELETED_BY_US:
            return 'DU';
        case GIT_STATUS_DELETED_BY_THEM:
            return 'UD';
        default:
            return null;
    }
}

function isUnmergedStatus(statusCode: string): statusCode is GitUnmergedStatus {
    return UNMERGED_STATUSES.has(statusCode as GitUnmergedStatus);
}

function resolveRepoPathFromChange(repository: Repository, change: Change): string | null {
    const candidatePaths = [
        change.uri?.fsPath,
        change.originalUri?.fsPath,
        change.renameUri?.fsPath
    ];

    for (const candidatePath of candidatePaths) {
        if (!candidatePath) {
            continue;
        }
        const relative = toGitPath(path.relative(repository.rootUri.fsPath, candidatePath));
        if (isRepoRelativePath(relative)) {
            return relative;
        }
    }

    return null;
}

function queryUnmergedFilesFromRepository(repository: Repository): GitFileStatus[] {
    cacheRepository(repository);
    const filesByRepoPath = new Map<string, GitFileStatus>();
    const mergeChanges = repository.state.mergeChanges;
    if (!mergeChanges) {
        return [];
    }

    for (const change of mergeChanges) {
        const unmergedStatus = mapGitStatusToUnmergedStatus(change.status);
        if (!unmergedStatus) {
            continue;
        }

        const repoPath = resolveRepoPathFromChange(repository, change);
        if (!repoPath) {
            continue;
        }

        const fullPath = path.join(repository.rootUri.fsPath, repoPath);
        filesByRepoPath.set(normalizeForComparison(repoPath), {
            path: fullPath,
            repoPath,
            status: unmergedStatus,
            isUnmerged: true
        });
    }

    return [...filesByRepoPath.values()];
}

async function queryUnmergedFilesFromGitCli(gitRoot: string): Promise<GitFileStatus[] | null> {
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['status', '--porcelain', '-z', '--untracked-files=no'],
            { cwd: gitRoot, encoding: 'utf8' }
        );
        const statusOutput = typeof stdout === 'string' ? stdout : String(stdout);
        if (!statusOutput) {
            return [];
        }

        const filesByRepoPath = new Map<string, GitFileStatus>();
        const entries = statusOutput.split('\0').filter(Boolean);
        for (const entry of entries) {
            if (entry.length < 4 || entry[2] !== ' ') {
                continue;
            }

            const statusCode = entry.slice(0, 2);
            if (!isUnmergedStatus(statusCode)) {
                continue;
            }

            const repoPath = toGitPath(entry.slice(3));
            if (!repoPath) {
                continue;
            }

            const fullPath = path.join(gitRoot, repoPath);
            filesByRepoPath.set(normalizeForComparison(repoPath), {
                path: fullPath,
                repoPath,
                status: statusCode,
                isUnmerged: true
            });
        }

        return [...filesByRepoPath.values()];
    } catch (error) {
        warnApiStrictOnce(
            `cli:unmerged-status-failed:${getGitRootCacheKey(gitRoot)}`,
            `Failed to query git status for ${gitRoot}: ${String(error)}`
        );
        return null;
    }
}

function getCachedRepositoryForPath(filePath: string): Repository | null {
    for (const repository of repositoryCacheByRoot.values()) {
        if (isPathWithinRoot(filePath, repository.rootUri.fsPath)) {
            return repository;
        }
    }
    return null;
}

async function getRepositoryForPath(filePath: string): Promise<Repository | null> {
    const cached = getCachedRepositoryForPath(filePath);
    if (cached) {
        return cached;
    }

    if (!vscode) {
        return null;
    }

    const gitApi = await getGitApi();
    if (!gitApi) {
        return null;
    }

    const directMatch = gitApi.getRepository(vscode.Uri.file(filePath));
    if (directMatch) {
        cacheRepository(directMatch);
        return directMatch;
    }

    for (const repository of gitApi.repositories) {
        cacheRepository(repository);
        if (isPathWithinRoot(filePath, repository.rootUri.fsPath)) {
            return repository;
        }
    }

    return null;
}

async function getRepositoriesForPathHint(pathHint?: string): Promise<Repository[]> {
    const gitApi = await getGitApi();
    if (!gitApi) {
        return [];
    }

    for (const repository of gitApi.repositories) {
        cacheRepository(repository);
    }

    if (!pathHint) {
        return [...gitApi.repositories];
    }

    const matched = await getRepositoryForPath(pathHint);
    return matched ? [matched] : [];
}

function dedupeGitRoots(roots: string[]): string[] {
    const rootsByKey = new Map<string, string>();
    for (const root of roots) {
        rootsByKey.set(getGitRootCacheKey(root), root);
    }
    return [...rootsByKey.values()];
}

async function resolveGitRootsForPathHint(pathHint?: string): Promise<string[]> {
    const repositories = await getRepositoriesForPathHint(pathHint);
    const rootsFromApi = repositories.map((repository) => repository.rootUri.fsPath);
    const rootsFromCli = await resolveGitRoots(pathHint);
    return dedupeGitRoots([...rootsFromApi, ...rootsFromCli]);
}

async function queryUnmergedFilesForRoot(gitRoot: string): Promise<GitFileStatus[]> {
    const repository = await getRepositoryForPath(gitRoot);
    const apiFiles = repository ? queryUnmergedFilesFromRepository(repository) : [];
    if (!repository) {
        warnApiStrictOnce(
            `repo:missing:${getGitRootCacheKey(gitRoot)}`,
            `No VS Code Git repository found for ${gitRoot}; falling back to Git CLI for unmerged status.`
        );
    }

    const cliFiles = await queryUnmergedFilesFromGitCli(gitRoot);
    if (cliFiles !== null) {
        return cliFiles;
    }

    // CLI query failed; fall back to API results if available.
    return apiFiles;
}

async function refreshUnmergedFilesSnapshotForRoot(gitRoot: string): Promise<GitFileStatus[]> {
    const cacheKey = getGitRootCacheKey(gitRoot);
    const inFlight = unmergedFilesFetchPromisesByRoot.get(cacheKey);
    if (inFlight) {
        const files = await inFlight;
        setSnapshotUnmergedFilesForRoot(gitRoot, files);
        return files;
    }

    const fetchPromise = (async (): Promise<GitFileStatus[]> => {
        const files = await queryUnmergedFilesForRoot(gitRoot);
        setCachedUnmergedFilesForRoot(gitRoot, files);
        return files;
    })();

    unmergedFilesFetchPromisesByRoot.set(cacheKey, fetchPromise);
    try {
        const files = await fetchPromise;
        setSnapshotUnmergedFilesForRoot(gitRoot, files);
        return files;
    } finally {
        unmergedFilesFetchPromisesByRoot.delete(cacheKey);
    }
}

async function getUnmergedFilesForRoot(gitRoot: string): Promise<GitFileStatus[]> {
    const cached = getCachedUnmergedFilesForRoot(gitRoot);
    if (cached) {
        return cached;
    }

    const cacheKey = getGitRootCacheKey(gitRoot);
    const inFlight = unmergedFilesFetchPromisesByRoot.get(cacheKey);
    if (inFlight) {
        return inFlight;
    }

    const fetchPromise = (async (): Promise<GitFileStatus[]> => {
        const files = await queryUnmergedFilesForRoot(gitRoot);
        setCachedUnmergedFilesForRoot(gitRoot, files);
        return files;
    })();

    unmergedFilesFetchPromisesByRoot.set(cacheKey, fetchPromise);
    try {
        return await fetchPromise;
    } finally {
        unmergedFilesFetchPromisesByRoot.delete(cacheKey);
    }
}

/**
 * Refresh cached unmerged status per repository root.
 * Uses Git CLI as source-of-truth for unmerged entries, with VS Code API fallback.
 * Intended to be called from Git state listeners and at extension startup.
 */
export async function refreshUnmergedFilesSnapshot(workspaceFolderOrPath?: any): Promise<void> {
    const pathHint =
        typeof workspaceFolderOrPath === 'string'
            ? workspaceFolderOrPath
            : workspaceFolderOrPath?.uri?.fsPath;
    const roots = await resolveGitRootsForPathHint(pathHint);
    if (roots.length === 0) {
        return;
    }

    await Promise.all(roots.map((root) => refreshUnmergedFilesSnapshotForRoot(root)));
}

async function resolveStatusEntryForFile(gitRoot: string, filePath: string): Promise<GitFileStatus | null> {
    const unmergedFiles = await getUnmergedFilesForRoot(gitRoot);

    const indexedMatch = tryResolveStatusEntryFromIndex(gitRoot, filePath);
    if (indexedMatch) {
        return indexedMatch;
    }

    const targetPath = getNormalizedPathInfo(filePath);
    for (const file of unmergedFiles) {
        if (pathsLikelySameFileToTarget(file.path, targetPath, file.repoPath)) {
            return file;
        }
    }

    return null;
}

async function resolveGitPathForFile(gitRoot: string, filePath: string): Promise<string | null> {
    const relativePath = gitRelativePath(gitRoot, filePath);
    if (isRepoRelativePath(relativePath)) {
        return relativePath;
    }

    const statusEntry = await resolveStatusEntryForFile(gitRoot, filePath);
    if (statusEntry?.repoPath) {
        return statusEntry.repoPath;
    }

    return null;
}

async function resolveGitFileContext(filePath: string): Promise<GitFileContext | null> {
    const repository = await getRepositoryForPath(filePath);
    if (!repository) {
        warnApiStrictOnce(
            `repo:file-context:${normalizeForComparison(filePath)}`,
            `No VS Code Git repository found for ${filePath}; stage content reads are unavailable.`
        );
        return null;
    }

    const gitRoot = repository.rootUri.fsPath;
    const relativePath = await resolveGitPathForFile(gitRoot, filePath);
    if (!relativePath) {
        return null;
    }

    return {
        repository,
        gitRoot,
        relativePath
    };
}

async function resolveCliFileContext(filePath: string): Promise<GitCliFileContext | null> {
    const gitRoot = await resolveGitRootForPath(filePath);
    if (!gitRoot) {
        return null;
    }

    const resolvedPath = await resolveGitPathForFile(gitRoot, filePath);
    if (resolvedPath) {
        return {
            gitRoot,
            relativePath: resolvedPath
        };
    }

    const relativePath = toGitPath(path.relative(gitRoot, filePath));
    if (!isRepoRelativePath(relativePath)) {
        return null;
    }

    return {
        gitRoot,
        relativePath
    };
}

async function getVersionForStage(context: GitFileContext, stage: GitStageNumber): Promise<string | null> {
    try {
        return await context.repository.show(`:${stage}`, context.relativePath);
    } catch {
        return null;
    }
}

async function getVersionForStageCli(context: GitCliFileContext, stage: GitStageNumber): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['show', `:${stage}:${context.relativePath}`],
            { cwd: context.gitRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
        );
        return typeof stdout === 'string' ? stdout : String(stdout);
    } catch {
        return null;
    }
}

function getStagePathCandidates(gitRoot: string, filePath: string, preferredPath?: string): string[] {
    const candidates: string[] = [];

    const pushCandidate = (candidate: string | undefined): void => {
        if (!candidate || candidates.includes(candidate)) {
            return;
        }
        candidates.push(candidate);
    };

    if (preferredPath && isRepoRelativePath(preferredPath)) {
        pushCandidate(preferredPath);
    }

    const directRelative = toGitPath(path.relative(gitRoot, filePath));
    if (isRepoRelativePath(directRelative)) {
        pushCandidate(directRelative);
    }

    const realRelative = toGitPath(path.relative(resolveRealPathSync(gitRoot), resolveRealPathSync(filePath)));
    if (isRepoRelativePath(realRelative)) {
        pushCandidate(realRelative);
    }

    pushCandidate(filePath);

    const realFilePath = resolveRealPathSync(filePath);
    if (realFilePath !== filePath) {
        pushCandidate(realFilePath);
    }

    return candidates;
}

async function stageFileWithGitCli(gitRoot: string, pathCandidates: string[]): Promise<boolean> {
    let lastError: unknown;
    for (const candidate of pathCandidates) {
        try {
            await execFileAsync('git', ['add', '--', candidate], { cwd: gitRoot });
            return true;
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError) {
        logger.error(`[GitIntegration] Failed to stage via Git CLI in ${gitRoot}: ${String(lastError)}`);
    }
    return false;
}

/**
 * Get a file's explicit Git unmerged status code.
 */
export async function getUnmergedFileStatus(filePath: string): Promise<GitUnmergedStatus | null> {
    try {
        const repository = await getRepositoryForPath(filePath);
        const gitRoot = repository?.rootUri.fsPath ?? await resolveGitRootForPath(filePath);
        if (!gitRoot) {
            warnApiStrictOnce(
                `repo:status:${normalizeForComparison(filePath)}`,
                `No Git repository found for ${filePath}; cannot determine unmerged status.`
            );
            return null;
        }

        const statusEntry = await resolveStatusEntryForFile(gitRoot, filePath);
        return statusEntry?.status ?? null;
    } catch (error) {
        logger.error(`[GitIntegration] Error in getUnmergedFileStatus: ${String(error)}`);
        return null;
    }
}

/**
 * Check whether a file has any Git unmerged status.
 */
export async function isUnmergedFile(filePath: string): Promise<boolean> {
    return (await getUnmergedFileStatus(filePath)) !== null;
}

/**
 * Get all unmerged files in the workspace.
 * Can be called with a VSCode WorkspaceFolder, a string path, or no argument.
 */
export async function getUnmergedFiles(workspaceFolderOrPath?: any): Promise<GitFileStatus[]> {
    const pathHint =
        typeof workspaceFolderOrPath === 'string'
            ? workspaceFolderOrPath
            : workspaceFolderOrPath?.uri?.fsPath;
    const roots = await resolveGitRootsForPathHint(pathHint);
    if (roots.length === 0) {
        return [];
    }

    const unmergedFilesPerRoot = await Promise.all(roots.map((root) => getUnmergedFilesForRoot(root)));

    const resolvedRealPathCache = new Map<string, Promise<string>>();
    const resolveRealPathCached = (targetPath: string): Promise<string> => {
        const cached = resolvedRealPathCache.get(targetPath);
        if (cached) {
            return cached;
        }
        const request = resolveRealPath(targetPath);
        resolvedRealPathCache.set(targetPath, request);
        return request;
    };

    const unmergedFiles: GitFileStatus[] = [];
    const seenPaths = new Set<string>();
    for (const files of unmergedFilesPerRoot) {
        for (const file of files) {
            let key: string;

            // Prefer repoPath + canonical root to dedupe reliably even when the file
            // is staged-only and missing from the working tree (realpath would fail).
            if (file.repoPath && isRepoRelativePath(file.repoPath)) {
                const depth = splitPathSegments(file.repoPath).length;
                const rootPath = depth > 0
                    ? path.resolve(file.path, ...Array(depth).fill('..'))
                    : path.dirname(file.path);
                const rootKey = normalizeForComparison(await resolveRealPathCached(rootPath));
                key = `${rootKey}\0${normalizeForComparison(file.repoPath)}`;
            } else {
                key = normalizeForComparison(await resolveRealPathCached(file.path));
            }

            if (seenPaths.has(key)) {
                continue;
            }
            seenPaths.add(key);
            unmergedFiles.push(file);
        }
    }
    return unmergedFiles;
}

/**
 * Get the current version of a file from Git staging area (stage :2:).
 */
export async function getCurrentVersion(filePath: string): Promise<string | null> {
    const context = await resolveGitFileContext(filePath);
    if (context) {
        const apiVersion = await getVersionForStage(context, '2');
        if (apiVersion !== null) {
            return apiVersion;
        }
    }
    const cliContext = await resolveCliFileContext(filePath);
    return cliContext ? getVersionForStageCli(cliContext, '2') : null;
}

/**
 * Get the incoming version of a file from Git staging area (stage :3:).
 */
export async function getIncomingVersion(filePath: string): Promise<string | null> {
    const context = await resolveGitFileContext(filePath);
    if (context) {
        const apiVersion = await getVersionForStage(context, '3');
        if (apiVersion !== null) {
            return apiVersion;
        }
    }
    const cliContext = await resolveCliFileContext(filePath);
    return cliContext ? getVersionForStageCli(cliContext, '3') : null;
}

/**
 * Get all three versions (base, current, incoming) of a file.
 */
export async function getThreeWayVersions(filePath: string): Promise<{
    base: string | null;
    current: string | null;
    incoming: string | null;
} | null> {
    const context = await resolveGitFileContext(filePath);
    let cliContext: GitCliFileContext | null = null;

    let base: string | null = null;
    let current: string | null = null;
    let incoming: string | null = null;

    if (context) {
        [base, current, incoming] = await Promise.all([
            getVersionForStage(context, '1'),
            getVersionForStage(context, '2'),
            getVersionForStage(context, '3')
        ]);
    }

    const needsCliFallback = !context || base === null || current === null || incoming === null;
    if (needsCliFallback) {
        cliContext = await resolveCliFileContext(filePath);
    }

    if (!context && !cliContext) {
        return null;
    }

    if (cliContext) {
        const [cliBase, cliCurrent, cliIncoming] = await Promise.all([
            base === null ? getVersionForStageCli(cliContext, '1') : Promise.resolve(base),
            current === null ? getVersionForStageCli(cliContext, '2') : Promise.resolve(current),
            incoming === null ? getVersionForStageCli(cliContext, '3') : Promise.resolve(incoming)
        ]);

        base = cliBase;
        current = cliCurrent;
        incoming = cliIncoming;
    }

    if (base === null && current === null && incoming === null) {
        return null;
    }

    return { base, current, incoming };
}

export async function stageFile(filePath: string): Promise<boolean> {
    const context = await resolveGitFileContext(filePath);
    if (context) {
        try {
            await context.repository.add([context.relativePath]);
            invalidateUnmergedCachesForRoot(context.gitRoot);
            return true;
        } catch (error) {
            const stagedViaCli = await stageFileWithGitCli(
                context.gitRoot,
                getStagePathCandidates(context.gitRoot, filePath, context.relativePath)
            );
            if (stagedViaCli) {
                invalidateUnmergedCachesForRoot(context.gitRoot);
                return true;
            }
            logger.error(`[GitIntegration] Failed to stage ${filePath}: ${String(error)}`);
            return false;
        }
    }

    const cliContext = await resolveCliFileContext(filePath);
    if (!cliContext) {
        return false;
    }

    const stagedViaCli = await stageFileWithGitCli(
        cliContext.gitRoot,
        getStagePathCandidates(cliContext.gitRoot, filePath, cliContext.relativePath)
    );
    if (stagedViaCli) {
        invalidateUnmergedCachesForRoot(cliContext.gitRoot);
    }
    return stagedViaCli;
}

/**
 * Get current branch name.
 */
export async function getCurrentBranch(filePath: string): Promise<string | null> {
    const repository = await getRepositoryForPath(filePath);
    const apiBranch = repository?.state.HEAD?.name;
    if (apiBranch) {
        return apiBranch;
    }

    const gitRoot = repository?.rootUri.fsPath ?? await resolveGitRootForPath(filePath);
    if (!gitRoot) {
        return null;
    }

    try {
        const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: gitRoot, encoding: 'utf8' });
        const branch = typeof stdout === 'string' ? stdout.trim() : String(stdout).trim();
        return branch || null;
    } catch {
        return null;
    }
}

/**
 * Get the branch being merged into current branch.
 */
export async function getMergeBranch(filePath: string): Promise<string | null> {
    try {
        const repository = await getRepositoryForPath(filePath);
        const gitRoot = repository?.rootUri.fsPath ?? await resolveGitRootForPath(filePath);
        if (!gitRoot) {
            return null;
        }

        const { stdout } = await execAsync('git rev-parse MERGE_HEAD', { cwd: gitRoot });
        const mergeHead = stdout.trim();

        try {
            const { stdout: branchName } = await execAsync(
                `git name-rev --name-only ${mergeHead}`,
                { cwd: gitRoot }
            );
            return branchName.trim();
        } catch {
            return mergeHead.substring(0, 7);
        }
    } catch {
        return null;
    }
}
