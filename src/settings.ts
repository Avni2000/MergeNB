/**
 * @file settings.ts
 * @description User-configurable extension settings for MergeNB.
 * 
 * Settings control auto-resolution behavior:
 * - autoResolveExecutionCount: Set execution_count to null (default: true)
 * - autoResolveKernelVersion: Use current kernel/Python version (default: true)  
 * - stripOutputs: Clear cell outputs during merge (default: true)
 * - autoResolveWhitespace: Auto-resolve whitespace-only source diffs (default: true)
 * - hideNonConflictOutputs: Hide outputs for non-conflicted cells in UI (default: true)
 * - enableUndoRedoHotkeys: Enable Ctrl+Z / Ctrl+Shift+Z in web UI (default: true)
 * - showBaseColumn: Show base branch column in 3-column view (default: false, true in headless/testing)
 * - theme: UI theme selection ('dark' | 'elegant', default: 'elegant')
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
    enableUndoRedoHotkeys: boolean;
    showBaseColumn: boolean;
    theme: 'dark' | 'elegant';
}

/** Default settings used in headless mode */
const DEFAULT_SETTINGS: MergeNBSettings = {
    autoResolveExecutionCount: true,
    autoResolveKernelVersion: true,
    stripOutputs: true,
    autoResolveWhitespace: true,
    hideNonConflictOutputs: true,
    enableUndoRedoHotkeys: true,
    showBaseColumn: true,
    theme: 'elegant'
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
        return { ...DEFAULT_SETTINGS };
    }

    const defaults: MergeNBSettings = {
        autoResolveExecutionCount: true,
        autoResolveKernelVersion: true,
        stripOutputs: true,
        autoResolveWhitespace: true,
        hideNonConflictOutputs: true,
        enableUndoRedoHotkeys: true,
        showBaseColumn: false,
        theme: 'elegant',
    };

    const config = vscode.workspace.getConfiguration('mergeNB');

    return {
        autoResolveExecutionCount: config.get<boolean>('autoResolve.executionCount', defaults.autoResolveExecutionCount),
        autoResolveKernelVersion: config.get<boolean>('autoResolve.kernelVersion', defaults.autoResolveKernelVersion),
        stripOutputs: config.get<boolean>('autoResolve.stripOutputs', defaults.stripOutputs),
        autoResolveWhitespace: config.get<boolean>('autoResolve.whitespace', defaults.autoResolveWhitespace),
        hideNonConflictOutputs: config.get<boolean>('ui.hideNonConflictOutputs', defaults.hideNonConflictOutputs),
        enableUndoRedoHotkeys: config.get<boolean>('ui.enableUndoRedoHotkeys', defaults.enableUndoRedoHotkeys),
        showBaseColumn: config.get<boolean>('ui.showBaseColumn', defaults.showBaseColumn),
        theme: config.get<'dark' | 'elegant'>('ui.theme', defaults.theme),
    };
}

/**
 * Check if a specific auto-resolve setting is enabled.
 * Only checks actual auto-resolve settings, not UI settings.
 */
export function isAutoResolveEnabled(
    setting: 'autoResolveExecutionCount' | 'autoResolveKernelVersion' | 'stripOutputs' | 'autoResolveWhitespace'
): boolean {
    const settings = getSettings();
    return settings[setting];
}
