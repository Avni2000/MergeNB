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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';

// Optional vscode import for headless testing support
let vscode: typeof import('vscode') | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running in headless mode (tests) - vscode not available
}

export type { MergeNBSettings } from '../../packages/core/src';
import type { MergeNBSettings } from '../../packages/core/src';

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

const CONFIG_ENV_VAR = 'MERGENB_CONFIG_PATH';

/** Async-context-scoped config paths — allows parallel headless tests in one process. */
interface ConfigContext {
    configPath?: string;
    testConfigPath?: string;
}
export const configContext = new AsyncLocalStorage<ConfigContext>();

export function getConfigFilePath(): string {
    const ctx = configContext.getStore();
    if (ctx?.configPath) {
        return ctx.configPath;
    }

    const override = process.env[CONFIG_ENV_VAR];
    if (override && override.trim()) {
        return path.resolve(override.trim());
    }

    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    if (xdgConfigHome && xdgConfigHome.trim()) {
        return path.join(xdgConfigHome.trim(), 'mergenb', 'config.json');
    }

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || process.env.LOCALAPPDATA;
        if (appData && appData.trim()) {
            return path.join(appData.trim(), 'mergenb', 'config.json');
        }
    }

    return path.join(os.homedir(), '.config', 'mergenb', 'config.json');
}

function readConfigFileSettings(): Partial<MergeNBSettings> {
    const configPath = getConfigFilePath();
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        return {};
    }

    if (!raw || typeof raw !== 'object') {
        return {};
    }

    const data = raw as Record<string, unknown>;
    const autoResolve = (data.autoResolve && typeof data.autoResolve === 'object')
        ? data.autoResolve as Record<string, unknown>
        : {};
    const ui = (data.ui && typeof data.ui === 'object')
        ? data.ui as Record<string, unknown>
        : {};

    const result: Partial<MergeNBSettings> = {};

    const pickBoolean = (_flatKey: string, nestedValue: unknown): boolean | undefined => {
        if (typeof nestedValue === 'boolean') return nestedValue as boolean;
        return undefined;
    };

    const pickTheme = (_flatKey: string, nestedValue: unknown): 'dark' | 'light' | undefined => {
        if (nestedValue === 'dark' || nestedValue === 'light') return nestedValue;
        return undefined;
    };

    const execCount = pickBoolean('autoResolve.executionCount', autoResolve.executionCount);
    if (execCount !== undefined) result.autoResolveExecutionCount = execCount;

    const kernelVersion = pickBoolean('autoResolve.kernelVersion', autoResolve.kernelVersion);
    if (kernelVersion !== undefined) result.autoResolveKernelVersion = kernelVersion;

    const stripOutputs = pickBoolean('autoResolve.stripOutputs', autoResolve.stripOutputs);
    if (stripOutputs !== undefined) result.stripOutputs = stripOutputs;

    const whitespace = pickBoolean('autoResolve.whitespace', autoResolve.whitespace);
    if (whitespace !== undefined) result.autoResolveWhitespace = whitespace;

    const hideOutputs = pickBoolean('ui.hideNonConflictOutputs', ui.hideNonConflictOutputs);
    if (hideOutputs !== undefined) result.hideNonConflictOutputs = hideOutputs;

    const showHeaders = pickBoolean('ui.showCellHeaders', ui.showCellHeaders);
    if (showHeaders !== undefined) result.showCellHeaders = showHeaders;

    const undoRedo = pickBoolean('ui.enableUndoRedoHotkeys', ui.enableUndoRedoHotkeys);
    if (undoRedo !== undefined) result.enableUndoRedoHotkeys = undoRedo;

    const showBase = pickBoolean('ui.showBaseColumn', ui.showBaseColumn);
    if (showBase !== undefined) result.showBaseColumn = showBase;

    const theme = pickTheme('ui.theme', ui.theme);
    if (theme) result.theme = theme;

    return result;
}

/**
 * Get current extension settings.
 * Returns default settings when running outside VS Code (headless/test mode).
 */
export function getSettings(): MergeNBSettings {
    const fileOverrides = readConfigFileSettings();
    if (!vscode) {
        return { ...DEFAULT_SETTINGS, ...fileOverrides };
    }

    if (process.env.MERGENB_TEST_MODE === 'true') {
        // Headless/test mode: use test-friendly defaults plus config file overrides.
        return { ...DEFAULT_SETTINGS, ...fileOverrides };
    }

    const defaults: MergeNBSettings = { ...DEFAULT_SETTINGS, showBaseColumn: false };

    const config = vscode.workspace.getConfiguration('mergeNB');
    const mergedDefaults = { ...defaults, ...fileOverrides };

    const resolveConfigValue = <T>(key: string, fallback: T): T => {
        const inspected = config.inspect<T>(key);
        if (!inspected) return fallback;
        if (inspected.workspaceFolderValue !== undefined) return inspected.workspaceFolderValue;
        if (inspected.workspaceValue !== undefined) return inspected.workspaceValue;
        if (inspected.globalValue !== undefined) return inspected.globalValue;
        return fallback;
    };

    return {
        autoResolveExecutionCount: resolveConfigValue<boolean>('autoResolve.executionCount', mergedDefaults.autoResolveExecutionCount),
        autoResolveKernelVersion: resolveConfigValue<boolean>('autoResolve.kernelVersion', mergedDefaults.autoResolveKernelVersion),
        stripOutputs: resolveConfigValue<boolean>('autoResolve.stripOutputs', mergedDefaults.stripOutputs),
        autoResolveWhitespace: resolveConfigValue<boolean>('autoResolve.whitespace', mergedDefaults.autoResolveWhitespace),
        hideNonConflictOutputs: resolveConfigValue<boolean>('ui.hideNonConflictOutputs', mergedDefaults.hideNonConflictOutputs),
        showCellHeaders: resolveConfigValue<boolean>('ui.showCellHeaders', mergedDefaults.showCellHeaders),
        enableUndoRedoHotkeys: resolveConfigValue<boolean>('ui.enableUndoRedoHotkeys', mergedDefaults.enableUndoRedoHotkeys),
        showBaseColumn: resolveConfigValue<boolean>('ui.showBaseColumn', mergedDefaults.showBaseColumn),
        theme: resolveConfigValue<'dark' | 'light'>('ui.theme', mergedDefaults.theme),
    };
}
