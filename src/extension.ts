/**
 * @file extension.ts
 * @description VS Code extension entry point for MergeNB.
 * 
 * Registers the `merge-nb.findConflicts` command which:
 * 1. Checks the active notebook for conflicts (textual or semantic)
 * 2. If none active, scans workspace for all conflicted notebooks
 * 3. Presents a quick-pick menu to select which notebook to resolve
 * 4. Opens the conflict resolution webview panel
 */

import * as vscode from 'vscode';
import { NotebookConflictResolver, ConflictedNotebook } from './resolver';
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

	// Command: Find all notebooks with conflicts (both textual and semantic)
	context.subscriptions.push(
		vscode.commands.registerCommand('merge-nb.findConflicts', async () => {
			// First check if current notebook has conflicts
			const activeUri = getActiveNotebookFileUri();
			if (activeUri) {
				const conflict = await resolver.hasAnyConflicts(activeUri);
				if (conflict) {
					await resolver.resolveConflicts(activeUri);
					return;
				}
			}

			// Find all notebooks with conflicts
			const files = await resolver.findNotebooksWithConflicts();
			if (files.length === 0) {
				vscode.window.showInformationMessage('No notebooks with merge conflicts found in workspace.');
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
							tooltip: 'Notebook has merge conflicts (textual markers)',
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

export function deactivate() {}

