/**
 * @file settingsMatrix.test.ts
 * @description End-to-end settings matrix test for MergeNB using VS Code test host + Playwright.
 *
 * This test exercises every contributed setting through real extension wiring:
 * VS Code configuration -> resolver -> web payload -> React UI behavior.
 */

import * as vscode from 'vscode';
import type { Locator, Page } from 'playwright';
import {
    readTestConfig,
    setupConflictResolver,
} from './testHarness';

type Theme = 'dark' | 'light';
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

type SettingsState = Record<SettingKey, boolean | Theme>;

type AutoSummary = {
    conflictCount: number;
    bannerText: string | null;
};

const SETTING_KEYS: SettingKey[] = [
    'autoResolve.executionCount',
    'autoResolve.kernelVersion',
    'autoResolve.stripOutputs',
    'autoResolve.whitespace',
    'ui.hideNonConflictOutputs',
    'ui.showCellHeaders',
    'ui.enableUndoRedoHotkeys',
    'ui.showBaseColumn',
    'ui.theme',
];

const BASE_SETTINGS: SettingsState = {
    'autoResolve.executionCount': false,
    'autoResolve.kernelVersion': false,
    'autoResolve.stripOutputs': false,
    'autoResolve.whitespace': false,
    'ui.hideNonConflictOutputs': false,
    'ui.showCellHeaders': false,
    'ui.enableUndoRedoHotkeys': true,
    'ui.showBaseColumn': true,
    'ui.theme': 'dark',
};

function buildSettings(overrides: Partial<SettingsState>): SettingsState {
    return { ...BASE_SETTINGS, ...overrides };
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

async function applySettings(config: vscode.WorkspaceConfiguration, settings: SettingsState): Promise<void> {
    for (const key of SETTING_KEYS) {
        await config.update(key, settings[key], vscode.ConfigurationTarget.Workspace);
    }
}

async function runScenario(
    scenarioName: string,
    settings: SettingsState,
    config: import('./testHelpers').TestConfig,
    callback: (page: Page) => Promise<void>
): Promise<void> {
    console.log(`\n=== Scenario: ${scenarioName} ===`);

    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    await applySettings(mergeNBConfig, settings);

    const session = await setupConflictResolver(config);
    const { page, browser } = session;

    try {
        await callback(page);
        console.log(`✓ Scenario passed: ${scenarioName}`);
    } finally {
        try {
            await page.close();
        } catch {
            // ignore cleanup errors
        }
        try {
            await browser.close();
        } catch {
            // ignore cleanup errors
        }
    }
}

async function getTheme(page: Page): Promise<string | null> {
    await page.locator('#root').waitFor({ timeout: 10000 });
    return page.locator('#root').getAttribute('data-theme');
}

async function findStableIdenticalRow(page: Page): Promise<Locator> {
    const row = page
        .locator('.merge-row.identical-row')
        .filter({ hasText: 'STABLE_OUTPUT_SENTINEL' })
        .first();
    await row.waitFor({ timeout: 10000 });
    return row;
}


async function findOutputConflictRow(page: Page): Promise<Locator> {
    const row = page
        .locator('.merge-row.conflict-row')
        .filter({ hasText: 'OUTPUT_DIFF_SENTINEL' })
        .first();
    await row.waitFor({ timeout: 10000 });
    return row;
}

async function findExecutionConflictRow(page: Page): Promise<Locator> {
    const row = page
        .locator('.merge-row.conflict-row')
        .filter({ hasText: 'EXEC_COUNT_SENTINEL' })
        .first();
    await row.waitFor({ timeout: 10000 });
    return row;
}

async function getAutoSummary(page: Page): Promise<AutoSummary> {
    await page.locator('.header-title').waitFor({ timeout: 10000 });
    const conflictCount = await page.locator('.merge-row.conflict-row').count();
    const banner = page.locator('.auto-resolve-banner .text').first();
    const bannerExists = (await banner.count()) > 0;
    const bannerText = bannerExists ? ((await banner.textContent()) ?? '').trim() : null;
    return { conflictCount, bannerText };
}

export async function run(): Promise<void> {
    console.log('Starting settings matrix integration test...');

    const testConfig = readTestConfig();
    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    const previousValues: Partial<Record<SettingKey, boolean | Theme | undefined>> = {};

    for (const key of SETTING_KEYS) {
        previousValues[key] = mergeNBConfig.get<boolean | Theme>(key);
    }

    try {
        // 1) UI matrix: theme=light, base column off, headers off, outputs visible.
        await runScenario(
            'ui-light-no-base-no-headers',
            buildSettings({
                'ui.theme': 'light',
                'ui.showBaseColumn': false,
                'ui.showCellHeaders': false,
                'ui.hideNonConflictOutputs': false,
            }),
            testConfig,
            async (page) => {
                const theme = await getTheme(page);
                assert(theme === 'light', `Expected theme=light, got ${theme}`);

                const allBaseButtonCount = await page.locator('button:has-text("All Base")').count();
                assert(allBaseButtonCount === 0, 'All Base button should be hidden when showBaseColumn=false');

                const baseLabelCount = await page.locator('.column-label.base').count();
                assert(baseLabelCount === 0, 'Base column label should be hidden when showBaseColumn=false');

                const baseColumnCount = await page.locator('.merge-row.conflict-row .base-column').count();
                assert(baseColumnCount === 0, 'Base column cells should be hidden when showBaseColumn=false');

                const headers = await page.locator('.cell-header').count();
                assert(headers === 0, 'Cell headers should be hidden when ui.showCellHeaders=false');

                const stableRow = await findStableIdenticalRow(page);
                const stableOutputs = await stableRow.locator('.cell-outputs').count();
                assert(stableOutputs > 0, 'Non-conflict outputs should be visible when hideNonConflictOutputs=false');
            }
        );

        // 2) UI matrix: theme=dark, base column on, headers on.
        await runScenario(
            'ui-dark-with-base-with-headers',
            buildSettings({
                'ui.theme': 'dark',
                'ui.showBaseColumn': true,
                'ui.showCellHeaders': true,
                'ui.hideNonConflictOutputs': false,
            }),
            testConfig,
            async (page) => {
                const theme = await getTheme(page);
                assert(theme === 'dark', `Expected theme=dark, got ${theme}`);

                const allBaseButtonCount = await page.locator('button:has-text("All Base")').count();
                assert(allBaseButtonCount > 0, 'All Base button should be visible when showBaseColumn=true');

                const baseLabelCount = await page.locator('.column-label.base').count();
                assert(baseLabelCount > 0, 'Base column label should be visible when showBaseColumn=true');

                const baseColumnCount = await page.locator('.merge-row.conflict-row .base-column').count();
                assert(baseColumnCount > 0, 'Base column cells should be visible when showBaseColumn=true');

                const headers = await page.locator('.cell-header').count();
                assert(headers > 0, 'Cell headers should be visible when ui.showCellHeaders=true');
            }
        );

        // 3) UI matrix: hide outputs for non-conflict rows only.
        await runScenario(
            'ui-hide-non-conflict-outputs',
            buildSettings({
                'ui.hideNonConflictOutputs': true,
                'ui.showBaseColumn': true,
                'ui.showCellHeaders': true,
            }),
            testConfig,
            async (page) => {
                const stableRow = await findStableIdenticalRow(page);
                const stableOutputs = await stableRow.locator('.cell-outputs').count();
                assert(stableOutputs === 0, 'Non-conflict outputs should be hidden when hideNonConflictOutputs=true');

                const outputConflictRow = await findOutputConflictRow(page);
                const conflictOutputs = await outputConflictRow.locator('.current-column .cell-outputs').count();
                assert(conflictOutputs > 0, 'Conflict-row outputs must remain visible when hideNonConflictOutputs=true');
            }
        );

        // 4) Hotkeys enabled: Ctrl/Cmd+Z undoes row resolution.
        await runScenario(
            'hotkeys-enabled',
            buildSettings({
                'ui.enableUndoRedoHotkeys': true,
                'ui.showBaseColumn': true,
            }),
            testConfig,
            async (page) => {
                const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
                const row = await findExecutionConflictRow(page);

                await row.locator('.btn-current').click();
                await row.locator('.resolved-content-input').waitFor({ timeout: 5000 });

                await page.click('.header-title');
                await page.keyboard.press(`${primaryModifier}+Z`);
                await row.locator('.resolved-content-input').waitFor({ state: 'detached', timeout: 5000 });

                await page.click('.header-title');
                await page.keyboard.press(`${primaryModifier}+Shift+Z`);
                await row.locator('.resolved-content-input').waitFor({ timeout: 5000 });
            }
        );

        // 5) Hotkeys disabled: Ctrl/Cmd+Z should not undo row resolution.
        await runScenario(
            'hotkeys-disabled',
            buildSettings({
                'ui.enableUndoRedoHotkeys': false,
                'ui.showBaseColumn': true,
            }),
            testConfig,
            async (page) => {
                const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
                const row = await findExecutionConflictRow(page);

                await row.locator('.btn-current').click();
                await row.locator('.resolved-content-input').waitFor({ timeout: 5000 });

                await page.click('.header-title');
                await page.keyboard.press(`${primaryModifier}+Z`);
                await page.waitForTimeout(400);

                const stillResolved = await row.locator('.resolved-content-input').count();
                assert(stillResolved > 0, 'Resolution should remain when undo hotkeys are disabled');
            }
        );

        // 6) Auto-resolve baseline (all auto settings off).
        let baselineConflictCount = 0;
        await runScenario(
            'auto-baseline-all-off',
            buildSettings({
                'autoResolve.executionCount': false,
                'autoResolve.kernelVersion': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
                'ui.showBaseColumn': true,
                'ui.hideNonConflictOutputs': false,
            }),
            testConfig,
            async (page) => {
                const summary = await getAutoSummary(page);
                baselineConflictCount = summary.conflictCount;
                assert(summary.conflictCount >= 3, `Expected at least 3 conflicts with all auto settings off, got ${summary.conflictCount}`);
                assert(!summary.bannerText, 'Auto-resolve banner should be absent when all auto settings are disabled');
            }
        );

        // 7) autoResolve.executionCount
        await runScenario(
            'auto-execution-count',
            buildSettings({
                'autoResolve.executionCount': true,
                'autoResolve.kernelVersion': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
            }),
            testConfig,
            async (page) => {
                const summary = await getAutoSummary(page);
                assert(summary.bannerText !== null, 'Expected auto-resolve banner for execution_count setting');
                assert(/Execution count set to null/i.test(summary.bannerText), `Unexpected execution_count banner text: ${summary.bannerText}`);
                assert(summary.conflictCount < baselineConflictCount,
                    `Expected fewer conflicts with execution-count auto-resolve (baseline=${baselineConflictCount}, now=${summary.conflictCount})`);
            }
        );

        // 8) autoResolve.stripOutputs
        await runScenario(
            'auto-strip-outputs',
            buildSettings({
                'autoResolve.executionCount': false,
                'autoResolve.kernelVersion': false,
                'autoResolve.stripOutputs': true,
                'autoResolve.whitespace': false,
            }),
            testConfig,
            async (page) => {
                const summary = await getAutoSummary(page);
                assert(summary.bannerText !== null, 'Expected auto-resolve banner for stripOutputs setting');
                assert(/Outputs (cleared|stripped)/i.test(summary.bannerText), `Unexpected stripOutputs banner text: ${summary.bannerText}`);

                const outputConflictRow = await findOutputConflictRow(page);
                const currentOutputs = await outputConflictRow.locator('.current-column .cell-outputs').count();
                const incomingOutputs = await outputConflictRow.locator('.incoming-column .cell-outputs').count();
                assert(currentOutputs === 0, 'Current-side outputs should be stripped when autoResolve.stripOutputs=true');
                assert(incomingOutputs > 0, 'Incoming-side outputs should remain visible in conflict view');
            }
        );

        // 9) autoResolve.whitespace
        await runScenario(
            'auto-whitespace',
            buildSettings({
                'autoResolve.executionCount': false,
                'autoResolve.kernelVersion': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': true,
            }),
            testConfig,
            async (page) => {
                const summary = await getAutoSummary(page);
                assert(summary.bannerText !== null, 'Expected auto-resolve banner for whitespace setting');
                assert(/Whitespace-only/i.test(summary.bannerText), `Unexpected whitespace banner text: ${summary.bannerText}`);
                assert(summary.conflictCount < baselineConflictCount,
                    `Expected fewer conflicts with whitespace auto-resolve (baseline=${baselineConflictCount}, now=${summary.conflictCount})`);
            }
        );

        // 10) autoResolve.kernelVersion
        await runScenario(
            'auto-kernel-version',
            buildSettings({
                'autoResolve.executionCount': false,
                'autoResolve.kernelVersion': true,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
            }),
            testConfig,
            async (page) => {
                const summary = await getAutoSummary(page);
                assert(summary.bannerText !== null, 'Expected auto-resolve banner for kernel version setting');
                assert(/Kernel version|Python version/i.test(summary.bannerText),
                    `Unexpected kernelVersion banner text: ${summary.bannerText}`);
                assert(summary.conflictCount === baselineConflictCount,
                    `Kernel metadata auto-resolve should not change cell conflict count (baseline=${baselineConflictCount}, now=${summary.conflictCount})`);
            }
        );

        console.log('\n=== SETTINGS MATRIX TEST PASSED ===');
    } finally {
        for (const key of SETTING_KEYS) {
            await mergeNBConfig.update(
                key,
                previousValues[key],
                vscode.ConfigurationTarget.Workspace
            );
        }
    }
}
