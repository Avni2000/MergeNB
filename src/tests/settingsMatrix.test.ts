/**
 * @file settingsMatrix.test.ts
 * @description Settings matrix tests for MergeNB.
 *
 * SECTION A: Backend logic tests -- directly test applyAutoResolutions and
 * analyzeSemanticConflictsFromMappings with synthetic data. 
 * 
 * SECTION B: UI integration tests -- Playwright-based scenarios that verify
 * settings flow correctly from VS Code config through to the React UI.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Locator, Page } from 'playwright';
import {
    applyAutoResolutions,
    analyzeSemanticConflictsFromMappings,
} from '../conflictDetector';
import type { MergeNBSettings } from '../settings';
import type {
    Notebook,
    NotebookCell,
    NotebookSemanticConflict,
    CellMapping,
} from '../types';
import {
    readTestConfig,
    setupConflictResolver,
} from './testHarness';
import type { TestConfig } from './testHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

type SettingsState = Record<SettingKey, boolean | Theme>;

const BASE_UI_SETTINGS: SettingsState = {
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

function buildUISettings(overrides: Partial<SettingsState>): SettingsState {
    return { ...BASE_UI_SETTINGS, ...overrides };
}

/** All-false/off backend settings baseline. */
const ALL_OFF: MergeNBSettings = {
    autoResolveExecutionCount: false,
    autoResolveKernelVersion: false,
    stripOutputs: false,
    autoResolveWhitespace: false,
    hideNonConflictOutputs: false,
    showCellHeaders: false,
    enableUndoRedoHotkeys: true,
    showBaseColumn: true,
    theme: 'dark',
};

function settingsWith(overrides: Partial<MergeNBSettings>): MergeNBSettings {
    return { ...ALL_OFF, ...overrides };
}

function makeNotebook(
    cells: NotebookCell[],
    metadata?: Notebook['metadata']
): Notebook {
    return {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: metadata ?? {},
        cells,
    };
}

function makeCodeCell(
    source: string,
    opts?: { execution_count?: number | null; outputs?: any[] }
): NotebookCell {
    return {
        cell_type: 'code',
        source,
        metadata: {},
        execution_count: opts?.execution_count ?? null,
        outputs: opts?.outputs ?? [],
    };
}

async function applyVSCodeSettings(
    config: vscode.WorkspaceConfiguration,
    settings: SettingsState
): Promise<void> {
    for (const key of SETTING_KEYS) {
        await config.update(key, settings[key], vscode.ConfigurationTarget.Workspace);
    }
}

async function runUIScenario(
    scenarioName: string,
    settings: SettingsState,
    testConfig: TestConfig,
    callback: (page: Page) => Promise<void>
): Promise<void> {
    console.log(`\n=== UI Scenario: ${scenarioName} ===`);

    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    await applyVSCodeSettings(mergeNBConfig, settings);

    const session = await setupConflictResolver(testConfig);
    const { page, browser } = session;

    try {
        await callback(page);
        console.log(`  pass: ${scenarioName}`);
    } finally {
        try { await page.close(); } catch { /* ignore */ }
        try { await browser.close(); } catch { /* ignore */ }
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

// ===========================================================================
// Main test runner
// ===========================================================================

export async function run(): Promise<void> {
    console.log('Starting settings matrix test...');

    // -----------------------------------------------------------------------
    // SECTION A -- Backend logic tests (direct function calls, no browser)
    // -----------------------------------------------------------------------
    console.log('\n====== SECTION A: Backend Logic Tests ======');

    // --- A1: analyzeSemanticConflictsFromMappings is settings-agnostic ---
    //
    // Detection should find all conflicts without filtering based on settings.
    // All settings-based filtering happens in applyAutoResolutions.
    // This test verifies that detection is exhaustive and settings-independent.
    {
        console.log('\n--- A1: detection is settings-agnostic ---');

        const base = makeCodeCell('x = 1', {
            execution_count: 1,
            outputs: [{ output_type: 'execute_result', data: { 'text/plain': '1' } }],
        });
        const current = makeCodeCell('x = 1  ', {     // trailing whitespace
            execution_count: 2,
            outputs: [{ output_type: 'execute_result', data: { 'text/plain': '1' } }],
        });
        const incoming = makeCodeCell('x = 1\t', {     // trailing tab
            execution_count: 3,
            outputs: [{ output_type: 'stream', text: '1\n', name: 'stdout' }],
        });

        const mappings: CellMapping[] = [{
            baseIndex: 0,
            currentIndex: 0,
            incomingIndex: 0,
            matchConfidence: 1,
            baseCell: base,
            currentCell: current,
            incomingCell: incoming,
        }];

        // Detect conflicts (no settings parameter)
        const allConflicts = analyzeSemanticConflictsFromMappings(mappings);

        // Verify detection found multiple conflict types
        const conflictTypes = allConflicts.map(c => c.type);
        assert.ok(
            conflictTypes.includes('execution-count-changed'),
            'Should detect execution-count-changed'
        );
        assert.ok(
            conflictTypes.includes('outputs-changed'),
            'Should detect outputs-changed'
        );

        // Now verify that different settings DO affect auto-resolution
        const resolveWithAutoOn = applyAutoResolutions(
            {
                filePath: '/test/a1.ipynb',
                semanticConflicts: allConflicts,
                cellMappings: mappings,
                current: makeNotebook([current]),
                incoming: makeNotebook([incoming]),
                base: makeNotebook([base]),
            },
            settingsWith({
                autoResolveExecutionCount: true,
                stripOutputs: true,
            })
        );

        const resolveWithAutoOff = applyAutoResolutions(
            {
                filePath: '/test/a1.ipynb',
                semanticConflicts: allConflicts,
                cellMappings: mappings,
                current: makeNotebook([current]),
                incoming: makeNotebook([incoming]),
                base: makeNotebook([base]),
            },
            settingsWith({
                autoResolveExecutionCount: false,
                stripOutputs: false,
            })
        );

        // Different settings should yield different resolution results
        assert.notStrictEqual(
            resolveWithAutoOn.autoResolvedCount,
            resolveWithAutoOff.autoResolvedCount,
            'Settings should affect auto-resolution counts'
        );
        console.log('  pass: A1');
    }

    // --- A2: kernel-only diff silently swallowed when setting is off ---
    //
    // BUG: When the only difference between current and incoming is notebook-
    // level metadata (kernelspec / language_info) and autoResolveKernelVersion
    // is false, applyAutoResolutions returns remainingConflicts=[] AND
    // autoResolvedCount=0.  In resolver.ts:297 this triggers the early exit
    // "no conflicts detected", silently dropping the metadata diff.
    //
    // The kernel diff should either surface as a remaining conflict or be
    // counted so the resolver doesn't exit early.
    {
        console.log('\n--- A2: kernel-only diff not swallowed ---');

        const cell = makeCodeCell('x = 1');
        const currentNb = makeNotebook([{ ...cell }], {
            kernelspec: { display_name: 'Python 3.10', language: 'python', name: 'python3' },
            language_info: { name: 'python', version: '3.10.0' },
        });
        const incomingNb = makeNotebook([{ ...cell }], {
            kernelspec: { display_name: 'Python 3.11', language: 'python', name: 'python3' },
            language_info: { name: 'python', version: '3.11.0' },
        });
        const baseNb = makeNotebook([{ ...cell }], {
            kernelspec: { display_name: 'Python 3.9', language: 'python', name: 'python3' },
            language_info: { name: 'python', version: '3.9.0' },
        });

        const semanticConflict: NotebookSemanticConflict = {
            filePath: '/test/kernel-only.ipynb',
            semanticConflicts: [],      // no cell-level conflicts
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
                matchConfidence: 1,
                baseCell: baseNb.cells[0],
                currentCell: currentNb.cells[0],
                incomingCell: incomingNb.cells[0],
            }],
            base: baseNb,
            current: currentNb,
            incoming: incomingNb,
        };

        const result = applyAutoResolutions(
            semanticConflict,
            settingsWith({ autoResolveKernelVersion: false })
        );

        // With the setting OFF, the kernel diff must not vanish.  Either it
        // lands in remainingConflicts or increments autoResolvedCount so the
        // resolver knows something happened.
        const surfaced =
            result.remainingConflicts.length > 0 ||
            result.autoResolvedCount > 0;

        assert.ok(
            surfaced,
            'BUG: kernel-only metadata diff is silently swallowed when ' +
            'autoResolveKernelVersion=false -- remainingConflicts=' +
            result.remainingConflicts.length +
            ', autoResolvedCount=' + result.autoResolvedCount +
            '.  Resolver will exit with "no conflicts detected".'
        );
        console.log('  pass: A2');
    }

    // --- A3: stripOutputs masks autoResolveExecutionCount ---
    //
    // BUG (conflictDetector.ts:456-457): When stripOutputs auto-resolves an
    // outputs-changed conflict (source identical), it ALSO sets
    //   resolvedNotebook.cells[i].execution_count = null
    // regardless of the autoResolveExecutionCount flag.  This means
    // autoResolveExecutionCount=false is effectively dead when stripOutputs
    // is true and the cell has an output diff.
    {
        console.log('\n--- A3: stripOutputs masks executionCount ---');

        const source = 'print("hello")';
        const base = makeCodeCell(source, {
            execution_count: 1,
            outputs: [{ output_type: 'stream', text: 'hello\n', name: 'stdout' }],
        });
        const current = makeCodeCell(source, {
            execution_count: 5,
            outputs: [{ output_type: 'stream', text: 'hello world\n', name: 'stdout' }],
        });
        const incoming = makeCodeCell(source, {
            execution_count: 10,
            outputs: [{ output_type: 'stream', text: 'hello!\n', name: 'stdout' }],
        });

        const conflict: NotebookSemanticConflict = {
            filePath: '/test/strip-masks-exec.ipynb',
            semanticConflicts: [{
                type: 'outputs-changed',
                baseCellIndex: 0,
                currentCellIndex: 0,
                incomingCellIndex: 0,
                baseContent: base,
                currentContent: current,
                incomingContent: incoming,
                description: 'outputs differ',
            }],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
                matchConfidence: 1,
                baseCell: base, currentCell: current, incomingCell: incoming,
            }],
            current: makeNotebook([current]),
            incoming: makeNotebook([incoming]),
            base: makeNotebook([base]),
        };

        const result = applyAutoResolutions(conflict, settingsWith({
            stripOutputs: true,
            autoResolveExecutionCount: false,   // explicitly OFF
        }));

        // stripOutputs should clear outputs but must NOT override
        // autoResolveExecutionCount.  The execution_count should be preserved.
        const resolvedCell = result.resolvedNotebook.cells[0];
        assert.notStrictEqual(
            resolvedCell.execution_count,
            null,
            'BUG: stripOutputs=true nulls execution_count even when ' +
            'autoResolveExecutionCount=false -- execution_count=' +
            resolvedCell.execution_count
        );
        console.log('  pass: A3');
    }

    // --- A4: stripOutputs side-effect on remaining conflicts ---
    //
    // When stripOutputs=true, outputs are stripped even from conflicts that
    // were NOT auto-resolved (conflictDetector.ts:549-560).  This validates
    // that the side-effect is present and consistent.
    {
        console.log('\n--- A4: stripOutputs strips remaining conflict outputs ---');

        const base = makeCodeCell('x = 1', {
            outputs: [{ output_type: 'stream', text: 'old\n', name: 'stdout' }],
        });
        const current = makeCodeCell('x = 2', {
            outputs: [{ output_type: 'stream', text: 'curr\n', name: 'stdout' }],
        });
        const incoming = makeCodeCell('x = 3', {
            outputs: [{ output_type: 'stream', text: 'inc\n', name: 'stdout' }],
        });

        const conflict: NotebookSemanticConflict = {
            filePath: '/test/strip-remaining.ipynb',
            semanticConflicts: [{
                type: 'cell-modified',
                baseCellIndex: 0,
                currentCellIndex: 0,
                incomingCellIndex: 0,
                baseContent: base,
                currentContent: current,
                incomingContent: incoming,
                description: 'source differs',
            }],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
                matchConfidence: 1,
                baseCell: base, currentCell: current, incomingCell: incoming,
            }],
            current: makeNotebook([current]),
            incoming: makeNotebook([incoming]),
            base: makeNotebook([base]),
        };

        const result = applyAutoResolutions(conflict, settingsWith({
            stripOutputs: true,
        }));

        assert.strictEqual(
            result.remainingConflicts.length, 1,
            'cell-modified conflict with different source should remain unresolved'
        );
        assert.deepStrictEqual(
            result.resolvedNotebook.cells[0].outputs, [],
            'Remaining conflict outputs should be stripped when stripOutputs=true'
        );
        console.log('  pass: A4');
    }

    // --- A5: executionCount auto-resolve independent when stripOutputs=false ---
    {
        console.log('\n--- A5: executionCount auto-resolve independent of stripOutputs ---');

        const base = makeCodeCell('a = 1', { execution_count: 1 });
        const current = makeCodeCell('a = 1', { execution_count: 5 });
        const incoming = makeCodeCell('a = 1', { execution_count: 10 });

        const conflict: NotebookSemanticConflict = {
            filePath: '/test/exec-count-toggle.ipynb',
            semanticConflicts: [{
                type: 'execution-count-changed',
                baseCellIndex: 0,
                currentCellIndex: 0,
                incomingCellIndex: 0,
                baseContent: base,
                currentContent: current,
                incomingContent: incoming,
            }],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
                matchConfidence: 1,
                baseCell: base, currentCell: current, incomingCell: incoming,
            }],
            current: makeNotebook([current]),
            incoming: makeNotebook([incoming]),
            base: makeNotebook([base]),
        };

        // ON: auto-resolves
        const on = applyAutoResolutions(conflict, settingsWith({
            autoResolveExecutionCount: true,
            stripOutputs: false,
        }));
        assert.strictEqual(on.autoResolvedCount, 1,
            'Should auto-resolve 1 execution-count conflict');
        assert.strictEqual(on.remainingConflicts.length, 0,
            'No remaining conflicts when exec count auto-resolved');
        assert.strictEqual(on.resolvedNotebook.cells[0].execution_count, null,
            'execution_count should be null after auto-resolve');

        // OFF: remains as conflict
        const off = applyAutoResolutions(conflict, settingsWith({
            autoResolveExecutionCount: false,
            stripOutputs: false,
        }));
        assert.strictEqual(off.autoResolvedCount, 0,
            'Should not auto-resolve when autoResolveExecutionCount=false');
        assert.strictEqual(off.remainingConflicts.length, 1,
            'Execution count conflict should remain unresolved');
        console.log('  pass: A5');
    }

    // --- A6: whitespace auto-resolve toggles ---
    {
        console.log('\n--- A6: whitespace auto-resolve toggles ---');

        const base = makeCodeCell('x = 1\n');
        const current = makeCodeCell('x = 1  \n');     // trailing space
        const incoming = makeCodeCell('x = 1\t\n');     // trailing tab

        const conflict: NotebookSemanticConflict = {
            filePath: '/test/whitespace-toggle.ipynb',
            semanticConflicts: [{
                type: 'cell-modified',
                baseCellIndex: 0,
                currentCellIndex: 0,
                incomingCellIndex: 0,
                baseContent: base,
                currentContent: current,
                incomingContent: incoming,
            }],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
                matchConfidence: 1,
                baseCell: base, currentCell: current, incomingCell: incoming,
            }],
            current: makeNotebook([current]),
            incoming: makeNotebook([incoming]),
            base: makeNotebook([base]),
        };

        // ON: whitespace-only diff auto-resolved
        const on = applyAutoResolutions(conflict, settingsWith({
            autoResolveWhitespace: true,
        }));
        assert.strictEqual(on.autoResolvedCount, 1,
            'Whitespace diff should be auto-resolved when setting is on');
        assert.strictEqual(on.remainingConflicts.length, 0,
            'No remaining conflicts for whitespace-only diff');

        // OFF: remains as conflict
        const off = applyAutoResolutions(conflict, settingsWith({
            autoResolveWhitespace: false,
        }));
        assert.strictEqual(off.autoResolvedCount, 0,
            'Whitespace diff should not be auto-resolved when setting is off');
        assert.strictEqual(off.remainingConflicts.length, 1,
            'Whitespace diff should remain as conflict');
        console.log('  pass: A6');
    }

    // --- A7: kernel auto-resolve ON correctly resolves ---
    {
        console.log('\n--- A7: kernel auto-resolve ON ---');

        const cell = makeCodeCell('x = 1');
        const currentNb = makeNotebook([{ ...cell }], {
            kernelspec: { display_name: 'Python 3.10', language: 'python', name: 'python3' },
            language_info: { name: 'python', version: '3.10.0' },
        });
        const incomingNb = makeNotebook([{ ...cell }], {
            kernelspec: { display_name: 'Python 3.11', language: 'python', name: 'python3' },
            language_info: { name: 'python', version: '3.11.0' },
        });
        const baseNb = makeNotebook([{ ...cell }], {
            kernelspec: { display_name: 'Python 3.9', language: 'python', name: 'python3' },
            language_info: { name: 'python', version: '3.9.0' },
        });

        const semanticConflict: NotebookSemanticConflict = {
            filePath: '/test/kernel-on.ipynb',
            semanticConflicts: [],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
                matchConfidence: 1,
                baseCell: baseNb.cells[0],
                currentCell: currentNb.cells[0],
                incomingCell: incomingNb.cells[0],
            }],
            base: baseNb,
            current: currentNb,
            incoming: incomingNb,
        };

        const result = applyAutoResolutions(
            semanticConflict,
            settingsWith({ autoResolveKernelVersion: true })
        );

        assert.ok(result.kernelAutoResolved,
            'Kernel should be auto-resolved when autoResolveKernelVersion=true');
        assert.ok(result.autoResolvedCount > 0,
            'autoResolvedCount should be >0 for kernel auto-resolution');
        assert.ok(
            result.autoResolvedDescriptions.some(d => /kernel|python/i.test(d)),
            'Expected kernel/python description, got: ' +
            result.autoResolvedDescriptions.join(', ')
        );
        console.log('  pass: A7');
    }

    // -----------------------------------------------------------------------
    // SECTION B -- UI integration tests (Playwright against real web UI)
    // -----------------------------------------------------------------------
    console.log('\n====== SECTION B: UI Integration Tests ======');

    const testConfig = readTestConfig();
    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    const previousValues: Partial<Record<SettingKey, boolean | Theme | undefined>> = {};

    for (const key of SETTING_KEYS) {
        previousValues[key] = mergeNBConfig.get<boolean | Theme>(key);
    }

    try {
        // B1: Theme applied
        await runUIScenario(
            'ui-theme-light',
            buildUISettings({ 'ui.theme': 'light' }),
            testConfig,
            async (page) => {
                const theme = await getTheme(page);
                assert.strictEqual(theme, 'light',
                    `Expected data-theme=light, got ${theme}`);
            }
        );

        // B2: Base column visibility
        await runUIScenario(
            'ui-base-column-off',
            buildUISettings({ 'ui.showBaseColumn': false }),
            testConfig,
            async (page) => {
                const baseLabels = await page.locator('.column-label.base').count();
                assert.strictEqual(baseLabels, 0,
                    'Base column label should be absent when showBaseColumn=false');

                const baseCells = await page.locator('.merge-row.conflict-row .base-column').count();
                assert.strictEqual(baseCells, 0,
                    'Base column cells should be absent when showBaseColumn=false');

                const allBaseBtn = await page.locator('button:has-text("All Base")').count();
                assert.strictEqual(allBaseBtn, 0,
                    '"All Base" button should be absent when showBaseColumn=false');
            }
        );

        await runUIScenario(
            'ui-base-column-on',
            buildUISettings({ 'ui.showBaseColumn': true }),
            testConfig,
            async (page) => {
                const baseLabels = await page.locator('.column-label.base').count();
                assert.ok(baseLabels > 0,
                    'Base column label should be visible when showBaseColumn=true');

                const allBaseBtn = await page.locator('button:has-text("All Base")').count();
                assert.ok(allBaseBtn > 0,
                    '"All Base" button should be visible when showBaseColumn=true');
            }
        );

        // B3: Cell headers visibility
        await runUIScenario(
            'ui-cell-headers-off',
            buildUISettings({ 'ui.showCellHeaders': false, 'ui.showBaseColumn': true }),
            testConfig,
            async (page) => {
                const headers = await page.locator('.cell-header').count();
                assert.strictEqual(headers, 0,
                    'Cell headers should be absent when showCellHeaders=false');
            }
        );

        await runUIScenario(
            'ui-cell-headers-on',
            buildUISettings({ 'ui.showCellHeaders': true, 'ui.showBaseColumn': true }),
            testConfig,
            async (page) => {
                const headers = await page.locator('.cell-header').count();
                assert.ok(headers > 0,
                    'Cell headers should be visible when showCellHeaders=true');
            }
        );

        // B4: Hide non-conflict outputs
        await runUIScenario(
            'ui-hide-non-conflict-outputs',
            buildUISettings({
                'ui.hideNonConflictOutputs': true,
                'ui.showBaseColumn': true,
            }),
            testConfig,
            async (page) => {
                const stableRow = await findStableIdenticalRow(page);
                const stableOutputs = await stableRow.locator('.cell-outputs').count();
                assert.strictEqual(stableOutputs, 0,
                    'Non-conflict outputs should be hidden when hideNonConflictOutputs=true');

                const conflictRow = await findOutputConflictRow(page);
                const conflictOutputs = await conflictRow
                    .locator('.current-column .cell-outputs').count();
                assert.ok(conflictOutputs > 0,
                    'Conflict-row outputs must remain visible');
            }
        );

        await runUIScenario(
            'ui-show-non-conflict-outputs',
            buildUISettings({
                'ui.hideNonConflictOutputs': false,
                'ui.showBaseColumn': true,
            }),
            testConfig,
            async (page) => {
                const stableRow = await findStableIdenticalRow(page);
                const stableOutputs = await stableRow.locator('.cell-outputs').count();
                assert.ok(stableOutputs > 0,
                    'Non-conflict outputs should be visible when hideNonConflictOutputs=false');
            }
        );

        // B5: Undo/redo hotkeys enabled
        await runUIScenario(
            'ui-hotkeys-enabled',
            buildUISettings({
                'ui.enableUndoRedoHotkeys': true,
                'ui.showBaseColumn': true,
            }),
            testConfig,
            async (page) => {
                const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
                const row = await findExecutionConflictRow(page);

                await row.locator('.btn-current').click();
                await row.locator('.resolved-content-input').waitFor({ timeout: 5000 });

                await page.click('.header-title');
                await page.keyboard.press(`${mod}+Z`);
                await row.locator('.resolved-content-input').waitFor({
                    state: 'detached', timeout: 5000,
                });

                await page.click('.header-title');
                await page.keyboard.press(`${mod}+Shift+Z`);
                await row.locator('.resolved-content-input').waitFor({ timeout: 5000 });
            }
        );

        // B6: Undo/redo hotkeys disabled
        await runUIScenario(
            'ui-hotkeys-disabled',
            buildUISettings({
                'ui.enableUndoRedoHotkeys': false,
                'ui.showBaseColumn': true,
            }),
            testConfig,
            async (page) => {
                const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
                const row = await findExecutionConflictRow(page);

                await row.locator('.btn-current').click();
                await row.locator('.resolved-content-input').waitFor({ timeout: 5000 });

                await page.click('.header-title');
                await page.keyboard.press(`${mod}+Z`);
                await page.waitForTimeout(400);

                const stillResolved = await row.locator('.resolved-content-input').count();
                assert.ok(stillResolved > 0,
                    'Resolution should remain when undo hotkeys are disabled');
            }
        );

        // B7: Payload completeness -- all 5 UI settings reach the browser
        //
        // Set every UI setting to a non-default value and verify each one
        // has observable effects, proving the full pipeline (VS Code config ->
        // resolver -> WebSocket -> React) is intact for every setting.
        await runUIScenario(
            'ui-payload-completeness',
            buildUISettings({
                'ui.hideNonConflictOutputs': true,
                'ui.showCellHeaders': true,
                'ui.enableUndoRedoHotkeys': false,
                'ui.showBaseColumn': false,
                'ui.theme': 'light',
            }),
            testConfig,
            async (page) => {
                await page.locator('#root').waitFor({ timeout: 10000 });

                // theme
                const theme = await page.locator('#root').getAttribute('data-theme');
                assert.strictEqual(theme, 'light',
                    'ui.theme=light did not reach browser');

                // showBaseColumn=false
                const baseLabels = await page.locator('.column-label.base').count();
                assert.strictEqual(baseLabels, 0,
                    'ui.showBaseColumn=false did not reach browser');

                // showCellHeaders=true
                const headers = await page.locator('.cell-header').count();
                assert.ok(headers > 0,
                    'ui.showCellHeaders=true did not reach browser');

                // hideNonConflictOutputs=true
                const stableRow = await findStableIdenticalRow(page);
                const stableOutputs = await stableRow.locator('.cell-outputs').count();
                assert.strictEqual(stableOutputs, 0,
                    'ui.hideNonConflictOutputs=true did not reach browser');

                // enableUndoRedoHotkeys=false -- undo should not revert
                const conflictRow = await findExecutionConflictRow(page);
                await conflictRow.locator('.btn-current').click();
                await conflictRow.locator('.resolved-content-input').waitFor({ timeout: 5000 });
                await page.click('.header-title');
                const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
                await page.keyboard.press(`${mod}+Z`);
                await page.waitForTimeout(400);
                const stillResolved = await conflictRow
                    .locator('.resolved-content-input').count();
                assert.ok(stillResolved > 0,
                    'ui.enableUndoRedoHotkeys=false did not reach browser');
            }
        );

        console.log('\n=== SETTINGS MATRIX TEST COMPLETE ===');
    } finally {
        // Restore previous workspace settings
        for (const key of SETTING_KEYS) {
            await mergeNBConfig.update(
                key,
                previousValues[key],
                vscode.ConfigurationTarget.Workspace
            );
        }
    }
}
