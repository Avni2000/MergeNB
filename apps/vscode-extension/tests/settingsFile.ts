/**
 * @file settingsFile.ts
 * @description Helpers for reading/writing MergeNB settings in the user config file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigFilePath } from '../settings';
import type { MergeNBSettings } from '../settings';

type Theme = MergeNBSettings['theme'];
type SettingKey =
    | 'autoResolve.executionCount'
    | 'autoResolve.kernelVersion'
    | 'autoResolve.stripOutputs'
    | 'autoResolve.whitespace'
    | 'ui.hideNonConflictOutputs'
    | 'ui.showCellHeaders'
    | 'ui.enableUndoRedoHotkeys'
    | 'ui.showBaseColumn'
    | 'ui.theme';

export type SettingsState = Partial<Record<SettingKey, boolean | Theme>>;

interface SettingsFileSnapshot {
    exists: boolean;
    contents: string | null;
}

export function readSettingsFileSnapshot(): SettingsFileSnapshot {
    const configPath = getConfigFilePath();
    try {
        const contents = fs.readFileSync(configPath, 'utf8');
        return { exists: true, contents };
    } catch {
        return { exists: false, contents: null };
    }
}

export function restoreSettingsFileSnapshot(snapshot: SettingsFileSnapshot): void {
    const configPath = getConfigFilePath();
    if (!snapshot.exists) {
        try {
            fs.rmSync(configPath, { force: true });
        } catch { /* ignore */ }
        return;
    }

    try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, snapshot.contents ?? '', 'utf8');
    } catch { /* ignore */ }
}

export function writeSettingsFile(
    settings: SettingsState,
    options: { merge?: boolean } = {}
): void {
    const configPath = getConfigFilePath();
    const existing = options.merge ? readSettingsFileData(configPath) : {};
    const next = applySettings(existing, settings);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
}

function readSettingsFileData(configPath: string): Record<string, unknown> {
    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function applySettings(
    base: Record<string, unknown>,
    settings: SettingsState
): Record<string, unknown> {
    const next: Record<string, unknown> = { ...base };
    const autoResolve = (next.autoResolve && typeof next.autoResolve === 'object')
        ? { ...(next.autoResolve as Record<string, unknown>) }
        : {};
    const ui = (next.ui && typeof next.ui === 'object')
        ? { ...(next.ui as Record<string, unknown>) }
        : {};

    for (const [key, value] of Object.entries(settings)) {
        if (value === undefined) continue;
        delete next[key];
        if (key.startsWith('autoResolve.')) {
            const prop = key.replace('autoResolve.', '');
            autoResolve[prop] = value;
            continue;
        }
        if (key.startsWith('ui.')) {
            const prop = key.replace('ui.', '');
            ui[prop] = value;
            continue;
        }
    }

    if (Object.keys(autoResolve).length > 0) {
        next.autoResolve = autoResolve;
    }
    if (Object.keys(ui).length > 0) {
        next.ui = ui;
    }

    return next;
}
