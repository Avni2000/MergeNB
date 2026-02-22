/**
 * @file extension.ts
 * @description VS Code extension entry point for MergeNB.
 * 
 * Registers the `merge-nb.findConflicts` command which:
 * 1. Checks the active notebook for conflicts (semantic / Git UU status)
 * 2. If none active, scans workspace for all conflicted notebooks
 * 3. Presents a quick-pick menu to select which notebook to resolve
 * 4. Opens the browser-based conflict resolution UI
 * 
 * Also provides:
 * - Status bar tray showing workspace-level conflicted notebooks
 * - File decorations for notebooks with conflicts
 */

import * as vscode from 'vscode';
import { NotebookConflictResolver, ConflictedNotebook, onDidResolveConflict, onDidResolveConflictWithDetails } from './resolver';
import * as gitIntegration from './gitIntegration';
import { getWebServer } from './web';
import type { API as GitAPI, GitExtension, Repository } from './typings/git';

let resolver: NotebookConflictResolver;
let statusBarItem: vscode.StatusBarItem;
let statusBarVisible = false;
let statusBarRefreshVersion = 0;
let backgroundConflictMonitoringEnabled = true;
let lastResolvedDetails: {
	uri: string;
	resolvedNotebook: unknown;
	resolvedRows?: unknown[];
	markAsResolved: boolean;
	renumberExecutionCounts: boolean;
} | undefined;

// Event emitter to trigger decoration refresh
const decorationChangeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
const statusBarConflictPickerCommand = 'merge-nb.pickConflictFromStatusBar';
const conflictContextKey = 'mergeNB.hasConflicts';

type ConflictQuickPickItem = vscode.QuickPickItem & { uri: vscode.Uri };

/**
 * Get the file URI for the currently active notebook.
 * Handles both notebook editor and text editor cases.
 */
function getActiveNotebookFileUri(): vscode.Uri | undefined {
	// First check if there's an active notebook editor
	const notebookEditor = vscode.window.activeNotebookEditor;
	if (notebookEditor && notebookEditor.notebook.uri.fsPath.endsWith('.ipynb')) {
		return notebookEditor.notebook.uri;
	}
	
	// Fall back to text editor (when .ipynb is opened as JSON)
	const textEditor = vscode.window.activeTextEditor;
	if (textEditor && textEditor.document.uri.scheme === 'file' && textEditor.document.fileName.endsWith('.ipynb')) {
		return textEditor.document.uri;
	}
	
	return undefined;
}

function getQuickPickItems(files: ConflictedNotebook[], activeUri?: vscode.Uri): ConflictQuickPickItem[] {
	const activePath = activeUri?.fsPath;
	return [...files]
		.sort((a, b) => {
			const aActive = activePath && a.uri.fsPath === activePath ? 1 : 0;
			const bActive = activePath && b.uri.fsPath === activePath ? 1 : 0;
			if (aActive !== bActive) {
				return bActive - aActive;
			}
			return vscode.workspace.asRelativePath(a.uri).localeCompare(vscode.workspace.asRelativePath(b.uri));
		})
		.map((f) => ({
			label: `$(notebook) ${vscode.workspace.asRelativePath(f.uri)}`,
			description: activePath && f.uri.fsPath === activePath ? 'Active file' : undefined,
			detail: 'Notebook merge conflict (Git unmerged status)',
			uri: f.uri
		}));
}

async function ensureSupportedMergeTool(
	targetPath?: string,
	options?: { suppressIfAlreadyShown?: boolean }
): Promise<boolean> {
	try {
		await gitIntegration.ensureSupportedMergeTool(targetPath, options);
		return true;
	} catch (error) {
		console.error('[MergeNB] Unsupported merge tool configuration detected:', error);
		return false;
	}
}

async function pickNotebookConflict(
	files: ConflictedNotebook[],
	placeHolder: string,
	activeUri?: vscode.Uri
): Promise<vscode.Uri | undefined> {
	if (files.length === 0) {
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(
		getQuickPickItems(files, activeUri),
		{
			placeHolder,
			canPickMany: false,
			matchOnDescription: true,
			matchOnDetail: true
		}
	);

	return picked?.uri;
}

/**
 * Update the status bar based on all workspace notebook merge conflicts.
 */
async function updateStatusBar(): Promise<void> {
	if (!backgroundConflictMonitoringEnabled) {
		await vscode.commands.executeCommand('setContext', conflictContextKey, false);
		statusBarItem.hide();
		statusBarItem.backgroundColor = undefined;
		statusBarVisible = false;
		return;
	}

	const refreshVersion = ++statusBarRefreshVersion;
	let conflictedFiles: ConflictedNotebook[] = [];

	try {
		conflictedFiles = await resolver.findNotebooksWithConflicts();
	} catch (error) {
		console.error('[MergeNB] Failed to refresh status bar conflicts:', error);
	}

	if (refreshVersion !== statusBarRefreshVersion) {
		return;
	}

	const conflictCount = conflictedFiles.length;
	await vscode.commands.executeCommand('setContext', conflictContextKey, conflictCount > 0);

	if (conflictCount === 0) {
		statusBarItem.hide();
		statusBarItem.backgroundColor = undefined;
		statusBarVisible = false;
		return;
	}

	const conflictLabel = conflictCount === 1 ? '1 conflict' : `${conflictCount} conflicts`;
	statusBarItem.text = `$(git-merge) MergeNB: ${conflictLabel}`;
	statusBarItem.tooltip = `Select a conflicted notebook to resolve (${conflictCount} .ipynb merge conflict${conflictCount === 1 ? '' : 's'} found)`;
	statusBarItem.command = statusBarConflictPickerCommand;
	statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	statusBarItem.show();
	statusBarVisible = true;
}

async function getNotebookConflictDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
	if (!backgroundConflictMonitoringEnabled || !uri.fsPath.endsWith('.ipynb')) {
		return undefined;
	}

	try {
		// Fast check: is this file unmerged according to Git?
		const isUnmerged = await gitIntegration.isUnmergedFile(uri.fsPath);
		if (isUnmerged) {
			return {
				badge: '⚠',
				tooltip: 'Notebook has merge conflicts',
				color: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')
			};
		}
	} catch {
		// Ignore errors
	}

	return undefined;
}

function registerGitStateWatchers(context: vscode.ExtensionContext): void {
	const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) {
		console.warn('[MergeNB] vscode.git extension was not found; Git state watchers are disabled.');
		return;
	}

	const watchedRepositories = new WeakSet<Repository>();
	const refreshRepositoryUnmergedSnapshot = (repository: Repository): void => {
		void (async () => {
			try {
				await gitIntegration.refreshUnmergedFilesSnapshot(repository.rootUri.fsPath);
				decorationChangeEmitter.fire(undefined);
				void updateStatusBar();
			} catch (error) {
				console.error('[MergeNB] Failed to refresh unmerged snapshot:', error);
			}
		})();
	};

	const attachRepositoryWatcher = (repository: Repository): void => {
		if (!repository?.state || watchedRepositories.has(repository)) {
			return;
		}
		watchedRepositories.add(repository);
		refreshRepositoryUnmergedSnapshot(repository);
		context.subscriptions.push(
			repository.state.onDidChange(() => {
				refreshRepositoryUnmergedSnapshot(repository);
			})
		);
	};

	const registerWithApi = (api: GitAPI): void => {
		for (const repository of api.repositories) {
			attachRepositoryWatcher(repository);
		}

		context.subscriptions.push(
			api.onDidOpenRepository((repository) => {
				attachRepositoryWatcher(repository);
			})
		);
	};

	const api = extension.exports?.getAPI(1);
	if (!api) {
		console.warn('[MergeNB] Git extension API unavailable; Git state watchers are disabled.');
		return;
	}

	registerWithApi(api);
}

export function activate(context: vscode.ExtensionContext) {
	console.log('MergeNB extension is now active');
	const isTestMode = process.env.MERGENB_TEST_MODE === 'true';
	const isNbdimeGuardTest = process.env.MERGENB_NBDIME_GUARD_CI === 'true';
	backgroundConflictMonitoringEnabled = !isNbdimeGuardTest;

	resolver = new NotebookConflictResolver(context.extensionUri);
	if (!isNbdimeGuardTest) {
		void ensureSupportedMergeTool(undefined, { suppressIfAlreadyShown: true });
	}

	// Create status bar item (right side, high priority to be visible)
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(statusBarItem);

	if (backgroundConflictMonitoringEnabled) {
		// Update status bar when active editor changes
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
			vscode.window.onDidChangeActiveNotebookEditor(() => updateStatusBar())
		);

		registerGitStateWatchers(context);
		// Initial status bar update
		void updateStatusBar();
	}
	
	// Listen for resolution success events
	context.subscriptions.push(
		onDidResolveConflict.event((uri: vscode.Uri) => {
			if (!backgroundConflictMonitoringEnabled) {
				return;
			}

			// Trigger decoration refresh
			decorationChangeEmitter.fire(uri);
			void updateStatusBar();
		})
	);

	context.subscriptions.push(
		onDidResolveConflictWithDetails.event((details) => {
			lastResolvedDetails = {
				uri: details.uri.fsPath,
				resolvedNotebook: details.resolvedNotebook,
				resolvedRows: details.resolvedRows,
				markAsResolved: details.markAsResolved,
				renumberExecutionCounts: details.renumberExecutionCounts
			};
		})
	);

	// Command: Find all notebooks with conflicts (semantic / Git UU status)
	context.subscriptions.push(
		vscode.commands.registerCommand('merge-nb.findConflicts', async () => {
			console.log('[Extension] merge-nb.findConflicts command triggered');
			// First check if current notebook has conflicts
			const activeUri = getActiveNotebookFileUri();
			console.log(`[Extension] Active URI: ${activeUri?.fsPath}`);
			if (activeUri) {
				console.log(`[Extension] Checking if ${activeUri.fsPath} is unmerged...`);
				const isUnmerged = await gitIntegration.isUnmergedFile(activeUri.fsPath);
				console.log(`[Extension] isUnmerged result: ${isUnmerged}`);
				if (isUnmerged) {
					if (!(await ensureSupportedMergeTool(activeUri.fsPath))) {
						return;
					}
					console.log(`[Extension] Resolving conflicts in active file`);
					await resolver.resolveConflicts(activeUri);
					return;
				}
			}

			// Find all notebooks with conflicts (fast - only queries git status)
			console.log('[Extension] Scanning workspace for conflicts...');
			const files = await resolver.findNotebooksWithConflicts();
			console.log(`[Extension] Found ${files.length} conflicted notebook(s)`);
			if (files.length === 0) {
				console.log('[Extension] No conflicts found');
				vscode.window.showInformationMessage('No notebooks with merge conflicts found in workspace.');
				return;
			}
			
			// If only one conflicted notebook, open it directly
			if (files.length === 1) {
				if (!(await ensureSupportedMergeTool(files[0].uri.fsPath))) {
					return;
				}
				await resolver.resolveConflicts(files[0].uri);
				return;
			}
			
			const pickedUri = await pickNotebookConflict(
				files,
				`Found ${files.length} notebook(s) with conflicts`,
				activeUri
			);

			if (pickedUri) {
				if (!(await ensureSupportedMergeTool(pickedUri.fsPath))) {
					return;
				}
				await resolver.resolveConflicts(pickedUri);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(statusBarConflictPickerCommand, async () => {
			const files = await resolver.findNotebooksWithConflicts();
			if (files.length === 0) {
				vscode.window.showInformationMessage('No notebooks with merge conflicts found in workspace.');
				void updateStatusBar();
				return;
			}

			const pickedUri = await pickNotebookConflict(
				files,
				`Select notebook to resolve (${files.length} conflict${files.length === 1 ? '' : 's'})`,
				getActiveNotebookFileUri()
			);
			if (!pickedUri) {
				return;
			}

			if (!(await ensureSupportedMergeTool(pickedUri.fsPath))) {
				return;
			}

			await resolver.resolveConflicts(pickedUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('merge-nb.resolveCurrentFile', async () => {
			const activeUri = getActiveNotebookFileUri();
			if (!activeUri) {
				vscode.window.showInformationMessage('Open a conflicted .ipynb file to resolve it.');
				return;
			}

			const isUnmerged = await gitIntegration.isUnmergedFile(activeUri.fsPath);
			if (!isUnmerged) {
				vscode.window.showInformationMessage('No merge conflicts found in the active notebook.');
				return;
			}

			if (!(await ensureSupportedMergeTool(activeUri.fsPath))) {
				return;
			}

			await resolver.resolveConflicts(activeUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('merge-nb.getLastResolutionDetails', () => {
			return lastResolvedDetails;
		})
	);

	if (isTestMode) {
		context.subscriptions.push(
			vscode.commands.registerCommand('merge-nb.getWebServerPort', () => {
				const webServer = getWebServer();
				return webServer.isRunning() ? webServer.getPort() : 0;
			})
		);
		context.subscriptions.push(
			vscode.commands.registerCommand('merge-nb.getStatusBarState', () => {
				return {
					visible: statusBarVisible,
					text: statusBarItem.text,
					command: statusBarItem.command
				};
			})
		);
		context.subscriptions.push(
			vscode.commands.registerCommand('merge-nb.getFileDecorationState', async (target?: string | vscode.Uri) => {
				const uri =
					target instanceof vscode.Uri
						? target
						: typeof target === 'string'
							? vscode.Uri.file(target)
							: getActiveNotebookFileUri();

				if (!uri) {
					return { hasDecoration: false };
				}

				const decoration = await getNotebookConflictDecoration(uri);
				if (!decoration) {
					return { hasDecoration: false };
				}

				return {
					hasDecoration: true,
					badge: decoration.badge,
					tooltip: typeof decoration.tooltip === 'string' ? decoration.tooltip : undefined
				};
			})
		);
	}

	if (backgroundConflictMonitoringEnabled) {
		// Register file decoration for notebooks with conflicts
		const decorationProvider = vscode.window.registerFileDecorationProvider({
			onDidChangeFileDecorations: decorationChangeEmitter.event,
			provideFileDecoration: getNotebookConflictDecoration
		});
		
		context.subscriptions.push(decorationProvider);
		
		// Watch for file system changes to update decorations when conflicts are resolved
		const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.ipynb');
		context.subscriptions.push(
			fileWatcher,
			fileWatcher.onDidChange(uri => {
				decorationChangeEmitter.fire(uri);
				void updateStatusBar();
			}),
			fileWatcher.onDidCreate(uri => {
				decorationChangeEmitter.fire(uri);
				void updateStatusBar();
			}),
			fileWatcher.onDidDelete(uri => {
				decorationChangeEmitter.fire(uri);
				void updateStatusBar();
			})
		);
	}
	
}

export function deactivate() {
	// Stop the web server if it's running
	const webServer = getWebServer();
	if (webServer.isRunning()) {
		webServer.stop();
	}
}
