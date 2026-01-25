/**
 * @file settings.ts
 * @description User-configurable extension settings for MergeNB.
 * 
 * Settings control auto-resolution behavior:
 * - autoResolveExecutionCount: Set execution_count to null (default: true)
 * - autoResolveKernelVersion: Use current kernel/Python version (default: true)  
 * - stripOutputs: Clear cell outputs during merge (default: true)
 * - hideNonConflictOutputs: Hide outputs for non-conflicted cells in UI (default: true)
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
    hideNonConflictOutputs: boolean;
}

/** Default settings used in headless mode */
const DEFAULT_SETTINGS: MergeNBSettings = {
    autoResolveExecutionCount: true,
    autoResolveKernelVersion: true,
    stripOutputs: true,
    hideNonConflictOutputs: true
};

/**
 * Get current extension settings.
 * Returns default settings when running outside VS Code (headless/test mode).
 */
export function getSettings(): MergeNBSettings {
    if (!vscode) {
        return { ...DEFAULT_SETTINGS };
    }
    
    const config = vscode.workspace.getConfiguration('mergeNB');
    
    return {
        autoResolveExecutionCount: config.get<boolean>('autoResolve.executionCount', true),
        autoResolveKernelVersion: config.get<boolean>('autoResolve.kernelVersion', true),
        stripOutputs: config.get<boolean>('autoResolve.stripOutputs', true),
        hideNonConflictOutputs: config.get<boolean>('ui.hideNonConflictOutputs', true)
    };
}

/**
 * Check if a specific auto-resolve setting is enabled
 */
export function isAutoResolveEnabled(setting: keyof MergeNBSettings): boolean {
    const settings = getSettings();
    return settings[setting];
}
