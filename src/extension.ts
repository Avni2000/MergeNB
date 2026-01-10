/**
 * @file extension.ts
 * @description VS Code extension entry point for MergeNB.
 * 
 * Registers the `merge-nb.findConflicts` command which:
 * 1. Checks the active notebook for conflicts (textual or semantic)
 * 2. If none active, scans workspace for all conflicted notebooks
 * 3. Presents a quick-pick menu to select which notebook to resolve
 * 4. Opens the conflict resolution webview panel
 * 
 * Also provides:
 * - Status bar button for quick access when viewing conflicted files
 * - File decorations for notebooks with conflicts
 */

import * as vscode from 'vscode';
import { NotebookConflictResolver, ConflictedNotebook } from './resolver';
import { hasConflictMarkers } from './conflictDetector';
import * as gitIntegration from './gitIntegration';

let resolver: NotebookConflictResolver;
let statusBarItem: vscode.StatusBarItem;
let currentFileHasConflicts = false;
let fileDecorationProvider: vscode.Disposable | undefined;

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
		currentFileHasConflicts = false;
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
		currentFileHasConflicts = true;
	} else {
		statusBarItem.hide();
		currentFileHasConflicts = false;
	}
}

export function activate(context: vscode.ExtensionContext) {
	console.log('MergeNB extension is now active');

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
	updateStatusBar();

	// Command: Find all notebooks with conflicts (both textual and semantic)
	context.subscriptions.push(
		vscode.commands.registerCommand('merge-nb.findConflicts', async () => {
			// First check if current notebook has conflicts
			const activeUri = getActiveNotebookFileUri();
			if (activeUri) {
				const isUnmerged = await gitIntegration.isUnmergedFile(activeUri.fsPath);
				if (isUnmerged) {
					await resolver.resolveConflicts(activeUri);
					return;
				}
			}

			// Find all notebooks with conflicts (fast - only queries git status)
			const files = await resolver.findNotebooksWithConflicts();
			if (files.length === 0) {
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
				let icon = '$(notebook)';
				let detail = '';
				
				if (f.hasTextualConflicts) {
					icon = '$(warning)';
					detail = 'Textual conflicts (<<<<<<< markers)';
				} else if (f.hasSemanticConflicts) {
					icon = '$(git-compare)';
					detail = 'Semantic conflicts (Git UU status)';
				}
				
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

	// Register file decoration for notebooks with conflicts
	const decorationProvider = vscode.window.registerFileDecorationProvider({
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
	fileDecorationProvider = decorationProvider;
	
	// Watch for file system changes to update decorations when conflicts are resolved
	const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.ipynb');
	context.subscriptions.push(
		fileWatcher,
		fileWatcher.onDidChange(uri => {
			// Trigger decoration refresh for the changed file
			if (fileDecorationProvider) {
				vscode.commands.executeCommand('_workbench.reloadDecorations', uri);
			}
			updateStatusBar();
		}),
		fileWatcher.onDidCreate(uri => {
			if (fileDecorationProvider) {
				vscode.commands.executeCommand('_workbench.reloadDecorations', uri);
			}
			updateStatusBar();
		}),
		fileWatcher.onDidDelete(uri => {
			if (fileDecorationProvider) {
				vscode.commands.executeCommand('_workbench.reloadDecorations', uri);
			}
			updateStatusBar();
		})
	);
	
	// Also watch for Git repository changes
	const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/index');
	context.subscriptions.push(
		gitWatcher,
		gitWatcher.onDidChange(async () => {
			// Git index changed, refresh all notebook decorations
			const notebooks = await vscode.workspace.findFiles('**/*.ipynb');
			for (const uri of notebooks) {
				vscode.commands.executeCommand('_workbench.reloadDecorations', uri);
			}
			updateStatusBar();
		})
	);
}

export function deactivate() {
	fileDecorationProvider = undefined;
}

