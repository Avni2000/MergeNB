import * as vscode from 'vscode';

/**
 * Extension settings interface
 */
export interface MergeNBSettings {
    autoResolveExecutionCount: boolean;
    autoResolveKernelVersion: boolean;
    stripOutputs: boolean;
}

/**
 * Get current extension settings
 */
export function getSettings(): MergeNBSettings {
    const config = vscode.workspace.getConfiguration('mergeNB');
    
    return {
        autoResolveExecutionCount: config.get<boolean>('autoResolve.executionCount', true),
        autoResolveKernelVersion: config.get<boolean>('autoResolve.kernelVersion', true),
        stripOutputs: config.get<boolean>('autoResolve.stripOutputs', true)
    };
}

/**
 * Check if a specific auto-resolve setting is enabled
 */
export function isAutoResolveEnabled(setting: keyof MergeNBSettings): boolean {
    const settings = getSettings();
    return settings[setting];
}
