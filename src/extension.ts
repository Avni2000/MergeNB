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
 * - Status bar button for quick access when viewing conflicted files
 * - File decorations for notebooks with conflicts
 */

import * as vscode from 'vscode';
import { NotebookConflictResolver, ConflictedNotebook, onDidResolveConflict, onDidResolveConflictWithDetails } from './resolver';
import * as gitIntegration from './gitIntegration';
import { getWebServer } from './web';

let resolver: NotebookConflictResolver;
let statusBarItem: vscode.StatusBarItem;
let statusBarVisible = false;
let lastResolvedDetails: {
	uri: string;
	resolvedNotebook: unknown;
	resolvedRows?: unknown[];
	markAsResolved: boolean;
	renumberExecutionCounts: boolean;
} | undefined;

// Event emitter to trigger decoration refresh
const decorationChangeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

interface GitRepositoryState {
	onDidChange: vscode.Event<void>;
}

interface GitRepository {
	state?: GitRepositoryState;
}

interface GitAPI {
	repositories: GitRepository[];
	onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtensionExports {
	getAPI(version: 1): GitAPI;
}

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

/**
 * Update the status bar based on the current active file.
 */
async function updateStatusBar(): Promise<void> {
	const activeUri = getActiveNotebookFileUri();
	
	if (!activeUri) {
		statusBarItem.hide();
		statusBarVisible = false;
		return;
	}

	// Quick check: is this file unmerged according to Git?
	const isUnmerged = await gitIntegration.isUnmergedFile(activeUri.fsPath);
	
	if (isUnmerged) {
		statusBarItem.text = '$(git-merge) MergeNB: Resolve Conflicts';
		statusBarItem.tooltip = 'Click to resolve merge conflicts in this notebook';
		statusBarItem.command = 'merge-nb.findConflicts';
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		statusBarItem.show();
		statusBarVisible = true;
	} else {
		statusBarItem.hide();
		statusBarVisible = false;
	}
}

function registerGitStateWatchers(context: vscode.ExtensionContext): boolean {
	const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
	if (!extension) {
		return false;
	}

	const watchedRepositories = new WeakSet<GitRepository>();
	const attachRepositoryWatcher = (repository: GitRepository): void => {
		if (!repository?.state || watchedRepositories.has(repository)) {
			return;
		}
		watchedRepositories.add(repository);
		context.subscriptions.push(
			repository.state.onDidChange(() => {
				decorationChangeEmitter.fire(undefined);
				void updateStatusBar();
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
				decorationChangeEmitter.fire(undefined);
				void updateStatusBar();
			})
		);
	};

	const onGitReady = (exports: GitExtensionExports | undefined): void => {
		if (!exports?.getAPI) {
			return;
		}
		registerWithApi(exports.getAPI(1));
	};

	if (extension.isActive) {
		onGitReady(extension.exports);
		return true;
	}

	extension.activate().then(
		(exports) => onGitReady(exports as GitExtensionExports | undefined),
		(err) => console.warn('[MergeNB] Git extension activation failed:', err)
	);
	return false;
}

export function activate(context: vscode.ExtensionContext) {
	console.log('MergeNB extension is now active');
	const isTestMode = process.env.MERGENB_TEST_MODE === 'true';

	resolver = new NotebookConflictResolver(context.extensionUri);

	// Create status bar item (right side, high priority to be visible)
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(statusBarItem);

	// Update status bar when active editor changes
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
		vscode.window.onDidChangeActiveNotebookEditor(() => updateStatusBar())
	);

	// Initial status bar update
	void updateStatusBar();
	const usingGitApiWatchers = registerGitStateWatchers(context);
	
	// Listen for resolution success events
	context.subscriptions.push(
		onDidResolveConflict.event((uri: vscode.Uri) => {
			
			// Trigger decoration refresh
			decorationChangeEmitter.fire(uri);
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
				await resolver.resolveConflicts(files[0].uri);
				return;
			}
			
			// Create descriptive labels showing conflict type
			const items = files.map((f: ConflictedNotebook) => {
				const icon = '$(git-compare)';
				const detail = 'Semantic conflicts (Git UU status)';
				
				return {
					label: `${icon} ${vscode.workspace.asRelativePath(f.uri)}`,
					detail,
					uri: f.uri
				};
			});
			
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: `Found ${files.length} notebook(s) with conflicts`,
				canPickMany: false
			});
			
			if (picked) {
				await resolver.resolveConflicts(picked.uri);
			}
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
				};
			})
		);
	}

	// Register file decoration for notebooks with conflicts
	const decorationProvider = vscode.window.registerFileDecorationProvider({
		onDidChangeFileDecorations: decorationChangeEmitter.event,
		provideFileDecoration: async (uri) => {
			if (!uri.fsPath.endsWith('.ipynb')) {
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
	
	// Fallback for environments where the built-in Git extension API is unavailable.
	if (!usingGitApiWatchers) {
		const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/index');
		context.subscriptions.push(
			gitWatcher,
			gitWatcher.onDidChange(() => {
				decorationChangeEmitter.fire(undefined);
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
