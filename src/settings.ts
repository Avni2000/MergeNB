/**
 * @file settings.ts
 * @description User-configurable extension settings for MergeNB.
 * 
 * Settings control auto-resolution behavior:
 * - autoResolveExecutionCount: Set execution_count to null (default: true)
 * - autoResolveKernelVersion: Use local kernel/Python version (default: true)  
 * - stripOutputs: Clear cell outputs during merge (default: true)
 * - hideNonConflictOutputs: Hide outputs for non-conflicted cells in UI (default: true)
 * 
 * These reduce manual conflict resolution for common non-semantic differences.
 */

import * as vscode from 'vscode';

export interface MergeNBSettings {
    autoResolveExecutionCount: boolean;
    autoResolveKernelVersion: boolean;
    stripOutputs: boolean;
    hideNonConflictOutputs: boolean;
}

/**
 * Get current extension settings
 */
export function getSettings(): MergeNBSettings {
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
