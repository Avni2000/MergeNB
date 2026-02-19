/**
 * @file settings.ts
 * @description User-configurable extension settings for MergeNB.
 * 
 * Settings control auto-resolution behavior:
 * - autoResolveExecutionCount: Set execution_count to null (default: true)
 * - autoResolveKernelVersion: Use current kernel/Python version (default: true)  
 * - stripOutputs: Clear cell outputs during merge (default: true)
 * - autoResolveWhitespace: Auto-resolve whitespace-only source diffs (default: true)
 * - hideNonConflictOutputs: Hide outputs for non-conflicted cells in UI (default: false)
 * - showCellHeaders: Show cell type, execution count, cell index headers (default: false)
 * - enableUndoRedoHotkeys: Enable Ctrl+Z / Ctrl+Shift+Z in web UI (default: true)
 * - showBaseColumn: Show base branch column in 3-column view (default: false, true in headless/testing)
 * - theme: UI theme selection ('dark' | 'light', default: 'dark')
 * 
 * These reduce manual conflict resolution for common non-semantic differences.
 */

// Optional vscode import for headless testing support
let vscode: typeof import('vscode') | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running in headless mode (tests) - vscode not available
}

export interface MergeNBSettings {
    autoResolveExecutionCount: boolean;
    autoResolveKernelVersion: boolean;
    stripOutputs: boolean;
    autoResolveWhitespace: boolean;
    hideNonConflictOutputs: boolean;
    showCellHeaders: boolean;
    enableUndoRedoHotkeys: boolean;
    showBaseColumn: boolean;
    theme: 'dark' | 'light';
}

/** Default settings used in headless mode */
const DEFAULT_SETTINGS: MergeNBSettings = {
    autoResolveExecutionCount: true,
    autoResolveKernelVersion: true,
    stripOutputs: true,
    autoResolveWhitespace: true,
    hideNonConflictOutputs: false,
    showCellHeaders: false,
    enableUndoRedoHotkeys: true,
    showBaseColumn: true,
    theme: 'dark'
};

/**
 * Get current extension settings.
 * Returns default settings when running outside VS Code (headless/test mode).
 */
export function getSettings(): MergeNBSettings {
    if (!vscode) {
        return { ...DEFAULT_SETTINGS };
    }

    if (process.env.MERGENB_TEST_MODE === 'true') {
        // Start from DEFAULT_SETTINGS (ensures test-friendly defaults like showBaseColumn: true)
        // but honour any workspace-level overrides that the test explicitly set via
        // vscode.configuration.update(..., ConfigurationTarget.Workspace).
        const config = vscode.workspace.getConfiguration('mergeNB');
        const settings = { ...DEFAULT_SETTINGS };

        const applyWorkspaceOverride = <T>(key: string, setter: (v: T) => void): void => {
            const inspect = config.inspect<T>(key);
            if (inspect?.workspaceValue !== undefined) {
                setter(inspect.workspaceValue);
            }
        };

        applyWorkspaceOverride<boolean>('autoResolve.executionCount', v => { settings.autoResolveExecutionCount = v; });
        applyWorkspaceOverride<boolean>('autoResolve.kernelVersion', v => { settings.autoResolveKernelVersion = v; });
        applyWorkspaceOverride<boolean>('autoResolve.stripOutputs', v => { settings.stripOutputs = v; });
        applyWorkspaceOverride<boolean>('autoResolve.whitespace', v => { settings.autoResolveWhitespace = v; });
        applyWorkspaceOverride<boolean>('ui.hideNonConflictOutputs', v => { settings.hideNonConflictOutputs = v; });
        applyWorkspaceOverride<boolean>('ui.showCellHeaders', v => { settings.showCellHeaders = v; });
        applyWorkspaceOverride<boolean>('ui.enableUndoRedoHotkeys', v => { settings.enableUndoRedoHotkeys = v; });
        applyWorkspaceOverride<boolean>('ui.showBaseColumn', v => { settings.showBaseColumn = v; });
        applyWorkspaceOverride<'dark' | 'light'>('ui.theme', v => { settings.theme = v; });

        return settings;
    }

    const defaults: MergeNBSettings = {
        autoResolveExecutionCount: true,
        autoResolveKernelVersion: true,
        stripOutputs: true,
        autoResolveWhitespace: true,
        hideNonConflictOutputs: false,
        showCellHeaders: false,
        enableUndoRedoHotkeys: true,
        showBaseColumn: false,
        theme: 'dark',
    };

    const config = vscode.workspace.getConfiguration('mergeNB');

    return {
        autoResolveExecutionCount: config.get<boolean>('autoResolve.executionCount', defaults.autoResolveExecutionCount),
        autoResolveKernelVersion: config.get<boolean>('autoResolve.kernelVersion', defaults.autoResolveKernelVersion),
        stripOutputs: config.get<boolean>('autoResolve.stripOutputs', defaults.stripOutputs),
        autoResolveWhitespace: config.get<boolean>('autoResolve.whitespace', defaults.autoResolveWhitespace),
        hideNonConflictOutputs: config.get<boolean>('ui.hideNonConflictOutputs', defaults.hideNonConflictOutputs),
        showCellHeaders: config.get<boolean>('ui.showCellHeaders', defaults.showCellHeaders),
        enableUndoRedoHotkeys: config.get<boolean>('ui.enableUndoRedoHotkeys', defaults.enableUndoRedoHotkeys),
        showBaseColumn: config.get<boolean>('ui.showBaseColumn', defaults.showBaseColumn),
        theme: config.get<'dark' | 'light'>('ui.theme', defaults.theme),
    };
}


