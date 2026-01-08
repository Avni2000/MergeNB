import * as vscode from 'vscode';
import { NotebookConflictResolver, quickResolveAll } from './resolver';
import { hasConflictMarkers } from './conflictDetector';
import * as gitIntegration from './gitIntegration';

let resolver: NotebookConflictResolver;

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

export function activate(context: vscode.ExtensionContext) {
	console.log('MergeNB extension is now active');

	resolver = new NotebookConflictResolver(context.extensionUri);

	// Command: Resolve conflicts in current notebook
	context.subscriptions.push(
		vscode.commands.registerCommand('merge-nb.resolveConflicts', async () => {
			const uri = getActiveNotebookFileUri();
			if (uri) {
				await resolver.resolveConflicts(uri);
			} else {
				// Let user pick a notebook file
				const files = await resolver.findNotebooksWithConflicts();
				if (files.length === 0) {
					vscode.window.showInformationMessage('No notebooks with merge conflicts found.');
					return;
				}
				const picked = await vscode.window.showQuickPick(
					files.map(f => ({ label: vscode.workspace.asRelativePath(f), uri: f })),
					{ placeHolder: 'Select a notebook with conflicts' }
				);
				if (picked) {
					await resolver.resolveConflicts(picked.uri);
				}
			}
		})
	);

	// Command: Quick resolve all - accept local
	context.subscriptions.push(
		vscode.commands.registerCommand('merge-nb.acceptAllLocal', async () => {
			const uri = await getNotebookUri();
			if (uri) {
				await quickResolveAll(uri, 'local');
			}
		})
	);

	// Command: Quick resolve all - accept remote
	context.subscriptions.push(
		vscode.commands.registerCommand('merge-nb.acceptAllRemote', async () => {
			const uri = await getNotebookUri();
			if (uri) {
				await quickResolveAll(uri, 'remote');
			}
		})
	);

	// Command: Find all notebooks with conflicts
	context.subscriptions.push(
		vscode.commands.registerCommand('merge-nb.findConflicts', async () => {
			const files = await resolver.findNotebooksWithConflicts();
			if (files.length === 0) {
				vscode.window.showInformationMessage('No notebooks with merge conflicts found in workspace.');
				return;
			}
			
			const items = files.map(f => ({
				label: '$(notebook) ' + vscode.workspace.asRelativePath(f),
				uri: f
			}));
			
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: `Found ${files.length} notebook(s) with conflicts`,
				canPickMany: false
			});
			
			if (picked) {
				await resolver.resolveConflicts(picked.uri);
			}
		})
	);

	// Command: Resolve semantic conflicts
	context.subscriptions.push(
		vscode.commands.registerCommand('merge-nb.resolveSemanticConflicts', async () => {
			const uri = getActiveNotebookFileUri();
			if (uri) {
				await resolver.resolveSemanticConflicts(uri);
			} else {
				vscode.window.showWarningMessage('Please open a notebook file first.');
			}
		})
	);

	// Register file decoration for notebooks with conflicts
	context.subscriptions.push(
		vscode.window.registerFileDecorationProvider({
			provideFileDecoration: async (uri) => {
				if (!uri.fsPath.endsWith('.ipynb')) {
					return undefined;
				}
				try {
					// Check for textual conflicts first
					const data = await vscode.workspace.fs.readFile(uri);
					const content = new TextDecoder().decode(data);
					if (hasConflictMarkers(content)) {
						return {
							badge: '⚠',
							tooltip: 'Notebook has merge conflicts',
							color: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')
						};
					}

					// Check for semantic conflicts (Git UU status without markers)
					const isUnmerged = await gitIntegration.isUnmergedFile(uri.fsPath);
					if (isUnmerged) {
						return {
							badge: '◐',
							tooltip: 'Notebook has semantic conflicts (execution state differs)',
							color: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')
						};
					}
				} catch {
					// Ignore errors
				}
				return undefined;
			}
		})
	);
}

async function getNotebookUri(): Promise<vscode.Uri | undefined> {
	// First try to get the active notebook
	const activeUri = getActiveNotebookFileUri();
	if (activeUri) {
		return activeUri;
	}
	
	// Fall back to file picker
	const files = await vscode.workspace.findFiles('**/*.ipynb', '**/node_modules/**');
	if (files.length === 0) {
		vscode.window.showInformationMessage('No notebook files found.');
		return undefined;
	}
	
	const picked = await vscode.window.showQuickPick(
		files.map(f => ({ label: vscode.workspace.asRelativePath(f), uri: f })),
		{ placeHolder: 'Select a notebook' }
	);
	
	return picked?.uri;
}

export function deactivate() {}
