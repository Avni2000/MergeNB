/**
 * @file settingsMatrix.spec.ts
 * @description Playwright Test for MergeNB settings matrix.
 *
 * SECTION A: Backend logic tests -- directly test applyAutoResolutions and
 * analyzeSemanticConflictsFromMappings with synthetic data. 
 * 
 * SECTION B: UI integration tests -- Playwright-based scenarios that verify
 * settings flow correctly from VS Code config through to the React UI.
 */

import { test, expect } from './fixtures';
import type { Locator, Page } from 'playwright';
import {
    applyAutoResolutions,
    analyzeSemanticConflictsFromMappings,
    type Notebook,
    type NotebookCell,
    type NotebookSemanticConflict,
    type CellMapping,
} from '../../core/src';
import type { MergeNBSettings } from '../../../apps/vscode-extension/settings';
import * as logger from '../../core/src';
import {
    readSettingsFileSnapshot,
    restoreSettingsFileSnapshot,
    writeSettingsFile,
    type SettingsState,
} from '../../../apps/vscode-extension/tests/settingsFile';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Backend Logic Tests (Section A) ────────────────────────────────────────

test.describe('Settings Matrix - Backend Logic', () => {
    test.beforeAll(() => {
        logger.info('Starting settings matrix test...');
        logger.info('\n====== SECTION A: Backend Logic Tests ======');
    });

    test('A1: detection is settings-agnostic', async () => {
        logger.info('\n--- A1: detection is settings-agnostic ---');

        const base = makeCodeCell('x = 1', {
            execution_count: 1,
            outputs: [{ output_type: 'execute_result', data: { 'text/plain': '1' } }],
        });
        const current = makeCodeCell('x = 1  ', {     // trailing whitespace
            execution_count: 2,
            outputs: [{ output_type: 'execute_result', data: { 'text/plain': '2' } }],
        });
        const incoming = makeCodeCell('x = 1\t', {     // trailing tab
            execution_count: 3,
            outputs: [{ output_type: 'stream', text: '1\n', name: 'stdout' }],
        });

        const mappings: CellMapping[] = [{
            baseIndex: 0,
            currentIndex: 0,
            incomingIndex: 0,
            baseCell: base,
            currentCell: current,
            incomingCell: incoming,
        }];

        // Detect conflicts (no settings parameter)
        const allConflicts = analyzeSemanticConflictsFromMappings(mappings);

        // Verify detection found multiple conflict types
        const conflictTypes = allConflicts.map(c => c.type);
        expect(conflictTypes).toContain('execution-count-changed');
        expect(conflictTypes).toContain('outputs-changed');

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
        expect(resolveWithAutoOn.autoResolvedCount).not.toBe(resolveWithAutoOff.autoResolvedCount);
        logger.info('  pass: A1');
    });

    test('A2: kernel-only diff not swallowed', async () => {
        logger.info('\n--- A2: kernel-only diff not swallowed ---');

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
            semanticConflicts: [],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
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

        expect(result.autoResolvedDescriptions.length).toBeGreaterThan(0);
        expect(result.autoResolvedCount).toBe(0);
        expect(result.kernelAutoResolved).toBe(false);
        logger.info('  pass: A2');
    });

    test('A3: stripOutputs masks executionCount', async () => {
        logger.info('\n--- A3: stripOutputs masks executionCount ---');

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
            }],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
                baseCell: base, currentCell: current, incomingCell: incoming,
            }],
            current: makeNotebook([current]),
            incoming: makeNotebook([incoming]),
            base: makeNotebook([base]),
        };

        const result = applyAutoResolutions(conflict, settingsWith({
            stripOutputs: true,
            autoResolveExecutionCount: false,
        }));

        const resolvedCell = result.resolvedNotebook.cells[0];
        expect(resolvedCell.execution_count).not.toBeNull();
        logger.info('  pass: A3');
    });

    test('A4: stripOutputs strips remaining conflict outputs', async () => {
        logger.info('\n--- A4: stripOutputs strips remaining conflict outputs ---');

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
            }],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
                baseCell: base, currentCell: current, incomingCell: incoming,
            }],
            current: makeNotebook([current]),
            incoming: makeNotebook([incoming]),
            base: makeNotebook([base]),
        };

        const result = applyAutoResolutions(conflict, settingsWith({
            stripOutputs: true,
        }));

        expect(result.remainingConflicts.length).toBe(1);
        expect(result.resolvedNotebook.cells[0].outputs).toEqual([]);
        logger.info('  pass: A4');
    });

    test('A5: executionCount auto-resolve independent of stripOutputs', async () => {
        logger.info('\n--- A5: executionCount auto-resolve independent of stripOutputs ---');

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
        expect(on.autoResolvedCount).toBe(1);
        expect(on.remainingConflicts.length).toBe(0);
        expect(on.resolvedNotebook.cells[0].execution_count).toBeNull();

        // OFF: remains as conflict
        const off = applyAutoResolutions(conflict, settingsWith({
            autoResolveExecutionCount: false,
            stripOutputs: false,
        }));
        expect(off.autoResolvedCount).toBe(0);
        expect(off.remainingConflicts.length).toBe(1);
        logger.info('  pass: A5');
    });

    test('A6: whitespace auto-resolve toggles', async () => {
        logger.info('\n--- A6: whitespace auto-resolve toggles ---');

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
        expect(on.autoResolvedCount).toBe(1);
        expect(on.remainingConflicts.length).toBe(0);

        // OFF: remains as conflict
        const off = applyAutoResolutions(conflict, settingsWith({
            autoResolveWhitespace: false,
        }));
        expect(off.autoResolvedCount).toBe(0);
        expect(off.remainingConflicts.length).toBe(1);
        logger.info('  pass: A6');
    });

    test('A7: kernel auto-resolve ON', async () => {
        logger.info('\n--- A7: kernel auto-resolve ON ---');

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

        expect(result.kernelAutoResolved).toBe(true);
        expect(result.autoResolvedCount).toBeGreaterThan(0);
        expect(result.autoResolvedDescriptions.some(d => /kernel|python/i.test(d))).toBe(true);
        logger.info('  pass: A7');
    });

    test('A8: kernel auto-resolve OFF does not set kernelAutoResolved', async () => {
        logger.info('\n--- A8: kernel auto-resolve OFF does not set kernelAutoResolved ---');

        const cell = makeCodeCell('x = 1');
        const currentNb = makeNotebook([{ ...cell }], {
            kernelspec: { display_name: 'Python 3.10', language: 'python', name: 'python3' },
        });
        const incomingNb = makeNotebook([{ ...cell }], {
            kernelspec: { display_name: 'Python 3.11', language: 'python', name: 'python3' },
        });
        const baseNb = makeNotebook([{ ...cell }], {
            kernelspec: { display_name: 'Python 3.9', language: 'python', name: 'python3' },
        });

        const semanticConflict: NotebookSemanticConflict = {
            filePath: '/test/kernel-off-kernelspec.ipynb',
            semanticConflicts: [],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
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

        expect(result.kernelAutoResolved).toBe(false);
        expect(result.autoResolvedCount).toBe(0);
        expect(result.autoResolvedDescriptions.length).toBeGreaterThan(0);
        expect(result.autoResolvedDescriptions.some(d => /disabled/i.test(d))).toBe(true);
        logger.info('  pass: A8');
    });

    test('A9: language_info auto-resolve OFF does not set kernelAutoResolved', async () => {
        logger.info('\n--- A9: language_info auto-resolve OFF does not set kernelAutoResolved ---');

        const cell = makeCodeCell('x = 1');
        const currentNb = makeNotebook([{ ...cell }], {
            language_info: { name: 'python', version: '3.10.0' },
        });
        const incomingNb = makeNotebook([{ ...cell }], {
            language_info: { name: 'python', version: '3.11.0' },
        });
        const baseNb = makeNotebook([{ ...cell }], {
            language_info: { name: 'python', version: '3.9.0' },
        });

        const semanticConflict: NotebookSemanticConflict = {
            filePath: '/test/kernel-off-langinfo.ipynb',
            semanticConflicts: [],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
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

        expect(result.kernelAutoResolved).toBe(false);
        expect(result.autoResolvedCount).toBe(0);
        expect(result.autoResolvedDescriptions.some(d => /disabled/i.test(d))).toBe(true);
        logger.info('  pass: A9');
    });

    test('A10: kernel + language_info ON vs OFF', async () => {
        logger.info('\n--- A10: kernel + language_info ON vs OFF ---');

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

        const makeConflict = (filePath: string): NotebookSemanticConflict => ({
            filePath,
            semanticConflicts: [],
            cellMappings: [{
                baseIndex: 0, currentIndex: 0, incomingIndex: 0,
                baseCell: baseNb.cells[0],
                currentCell: currentNb.cells[0],
                incomingCell: incomingNb.cells[0],
            }],
            base: baseNb,
            current: currentNb,
            incoming: incomingNb,
        });

        const on = applyAutoResolutions(
            makeConflict('/test/kernel-both-on.ipynb'),
            settingsWith({ autoResolveKernelVersion: true })
        );

        expect(on.kernelAutoResolved).toBe(true);
        expect(on.autoResolvedCount).toBe(1);
        expect(on.autoResolvedDescriptions.some(d => /kernel version/i.test(d))).toBe(true);
        expect(on.autoResolvedDescriptions.some(d => /python version/i.test(d))).toBe(true);

        const off = applyAutoResolutions(
            makeConflict('/test/kernel-both-off.ipynb'),
            settingsWith({ autoResolveKernelVersion: false })
        );

        expect(off.kernelAutoResolved).toBe(false);
        expect(off.autoResolvedCount).toBe(0);
        expect(off.autoResolvedDescriptions.length).toBeGreaterThanOrEqual(2);
        expect(off.autoResolvedDescriptions.every(d => /disabled/i.test(d))).toBe(true);
        logger.info('  pass: A10');
    });

    test('A11: stripOutputs + autoResolveExecutionCount nulls execution_count on remaining conflicts', async () => {
        logger.info('\n--- A11: stripOutputs + autoResolveExecutionCount nulls execution_count on remaining conflicts ---');

        const base = makeCodeCell('x = 1', {
            execution_count: 1,
            outputs: [{ output_type: 'stream', text: 'old\n', name: 'stdout' }],
        });
        const current = makeCodeCell('x = 2', {
            execution_count: 5,
            outputs: [{ output_type: 'stream', text: 'curr\n', name: 'stdout' }],
        });
        const incoming = makeCodeCell('x = 3', {
            execution_count: 10,
            outputs: [{ output_type: 'stream', text: 'inc\n', name: 'stdout' }],
        });

        const conflict: NotebookSemanticConflict = {
            filePath: '/test/strip-exec-remaining.ipynb',
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
                baseCell: base, currentCell: current, incomingCell: incoming,
            }],
            current: makeNotebook([current]),
            incoming: makeNotebook([incoming]),
            base: makeNotebook([base]),
        };

        // Both flags on: outputs stripped and execution_count nulled
        const resultOn = applyAutoResolutions(conflict, settingsWith({
            stripOutputs: true,
            autoResolveExecutionCount: true,
        }));
        expect(resultOn.resolvedNotebook.cells[0].outputs).toEqual([]);
        expect(resultOn.resolvedNotebook.cells[0].execution_count).toBeNull();

        // stripOutputs on, autoResolveExecutionCount off: only outputs stripped
        const resultOff = applyAutoResolutions(conflict, settingsWith({
            stripOutputs: true,
            autoResolveExecutionCount: false,
        }));
        expect(resultOff.resolvedNotebook.cells[0].outputs).toEqual([]);
        expect(resultOff.resolvedNotebook.cells[0].execution_count).not.toBeNull();
        logger.info('  pass: A11');
    });
});

// ─── UI Integration Tests (Section B) ───────────────────────────────────────

test.describe('Settings Matrix - UI Integration', () => {
    test.beforeAll(() => {
        logger.info('\n====== SECTION B: UI Integration Tests ======');
    });

    test.afterAll(() => {
        logger.info('\n=== SETTINGS MATRIX TEST COMPLETE ===');
    });

    test('B1: Theme applied (light)', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();
        try {
            logger.info('\n=== UI Scenario: ui-theme-light ===');
            writeSettingsFile(buildUISettings({ 'ui.theme': 'light' }));

            const workspacePath = conflictRepo({
                base: '08_settings_base.ipynb',
                current: '08_settings_current.ipynb',
                incoming: '08_settings_incoming.ipynb',
            });
            const session = await conflictSession(workspacePath);
            const { page } = session;

            const theme = await getTheme(page);
            expect(theme).toBe('light');
            logger.info('  pass: ui-theme-light');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('B2a: Base column visibility (off)', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();
        try {
            logger.info('\n=== UI Scenario: ui-base-column-off ===');
            writeSettingsFile(buildUISettings({ 'ui.showBaseColumn': false }));

            const workspacePath = conflictRepo({
                base: '08_settings_base.ipynb',
                current: '08_settings_current.ipynb',
                incoming: '08_settings_incoming.ipynb',
            });
            const session = await conflictSession(workspacePath);
            const { page } = session;

            const baseLabels = await page.locator('.column-label.base').count();
            expect(baseLabels).toBe(0);

            const baseCells = await page.locator('.merge-row.conflict-row .base-column').count();
            expect(baseCells).toBe(0);

            const allBaseBtn = await page.locator('button:has-text("All Base")').count();
            expect(allBaseBtn).toBe(0);
            logger.info('  pass: ui-base-column-off');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('B2b: Base column visibility (on)', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();
        try {
            logger.info('\n=== UI Scenario: ui-base-column-on ===');
            writeSettingsFile(buildUISettings({ 'ui.showBaseColumn': true }));

            const workspacePath = conflictRepo({
                base: '08_settings_base.ipynb',
                current: '08_settings_current.ipynb',
                incoming: '08_settings_incoming.ipynb',
            });
            const session = await conflictSession(workspacePath);
            const { page } = session;

            const baseLabels = await page.locator('.column-label.base').count();
            expect(baseLabels).toBeGreaterThan(0);

            const allBaseBtn = await page.locator('button:has-text("All Base")').count();
            expect(allBaseBtn).toBeGreaterThan(0);
            logger.info('  pass: ui-base-column-on');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('B3a: Cell headers visibility (off)', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();
        try {
            logger.info('\n=== UI Scenario: ui-cell-headers-off ===');
            writeSettingsFile(buildUISettings({ 'ui.showCellHeaders': false, 'ui.showBaseColumn': true }));

            const workspacePath = conflictRepo({
                base: '08_settings_base.ipynb',
                current: '08_settings_current.ipynb',
                incoming: '08_settings_incoming.ipynb',
            });
            const session = await conflictSession(workspacePath);
            const { page } = session;

            const headers = await page.locator('.cell-header').count();
            expect(headers).toBe(0);
            logger.info('  pass: ui-cell-headers-off');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('B3b: Cell headers visibility (on)', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();
        try {
            logger.info('\n=== UI Scenario: ui-cell-headers-on ===');
            writeSettingsFile(buildUISettings({ 'ui.showCellHeaders': true, 'ui.showBaseColumn': true }));

            const workspacePath = conflictRepo({
                base: '08_settings_base.ipynb',
                current: '08_settings_current.ipynb',
                incoming: '08_settings_incoming.ipynb',
            });
            const session = await conflictSession(workspacePath);
            const { page } = session;

            const headers = await page.locator('.cell-header').count();
            expect(headers).toBeGreaterThan(0);
            logger.info('  pass: ui-cell-headers-on');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('B4a: Hide non-conflict outputs', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();
        try {
            logger.info('\n=== UI Scenario: ui-hide-non-conflict-outputs ===');
            writeSettingsFile(buildUISettings({
                'ui.hideNonConflictOutputs': true,
                'ui.showBaseColumn': true,
            }));

            const workspacePath = conflictRepo({
                base: '08_settings_base.ipynb',
                current: '08_settings_current.ipynb',
                incoming: '08_settings_incoming.ipynb',
            });
            const session = await conflictSession(workspacePath);
            const { page } = session;

            const stableRow = await findStableIdenticalRow(page);
            const stableOutputs = await stableRow.locator('.cell-outputs').count();
            expect(stableOutputs).toBe(0);

            const conflictRow = await findOutputConflictRow(page);
            const conflictOutputs = await conflictRow.locator('.current-column .cell-outputs').count();
            expect(conflictOutputs).toBeGreaterThan(0);
            logger.info('  pass: ui-hide-non-conflict-outputs');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('B4b: Show non-conflict outputs', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();
        try {
            logger.info('\n=== UI Scenario: ui-show-non-conflict-outputs ===');
            writeSettingsFile(buildUISettings({
                'ui.hideNonConflictOutputs': false,
                'ui.showBaseColumn': true,
            }));

            const workspacePath = conflictRepo({
                base: '08_settings_base.ipynb',
                current: '08_settings_current.ipynb',
                incoming: '08_settings_incoming.ipynb',
            });
            const session = await conflictSession(workspacePath);
            const { page } = session;

            const stableRow = await findStableIdenticalRow(page);
            const stableOutputs = await stableRow.locator('.cell-outputs').count();
            expect(stableOutputs).toBeGreaterThan(0);
            logger.info('  pass: ui-show-non-conflict-outputs');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('B5: Undo/redo hotkeys enabled', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();
        try {
            logger.info('\n=== UI Scenario: ui-hotkeys-enabled ===');
            writeSettingsFile(buildUISettings({
                'ui.enableUndoRedoHotkeys': true,
                'ui.showBaseColumn': true,
            }));

            const workspacePath = conflictRepo({
                base: '08_settings_base.ipynb',
                current: '08_settings_current.ipynb',
                incoming: '08_settings_incoming.ipynb',
            });
            const session = await conflictSession(workspacePath);
            const { page } = session;

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
            logger.info('  pass: ui-hotkeys-enabled');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('B6: Undo/redo hotkeys disabled', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();
        try {
            logger.info('\n=== UI Scenario: ui-hotkeys-disabled ===');
            writeSettingsFile(buildUISettings({
                'ui.enableUndoRedoHotkeys': false,
                'ui.showBaseColumn': true,
            }));

            const workspacePath = conflictRepo({
                base: '08_settings_base.ipynb',
                current: '08_settings_current.ipynb',
                incoming: '08_settings_incoming.ipynb',
            });
            const session = await conflictSession(workspacePath);
            const { page } = session;

            const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
            const row = await findExecutionConflictRow(page);

            await row.locator('.btn-current').click();
            await row.locator('.resolved-content-input').waitFor({ timeout: 5000 });

            await page.click('.header-title');
            await page.keyboard.press(`${mod}+Z`);

            // Resolution should remain (hotkeys disabled)
            await expect(row.locator('.resolved-content-input')).toBeVisible({ timeout: 500 });

            const stillResolved = await row.locator('.resolved-content-input').count();
            expect(stillResolved).toBeGreaterThan(0);
            logger.info('  pass: ui-hotkeys-disabled');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('B7: Payload completeness -- all 5 UI settings reach the browser', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();
        try {
            logger.info('\n=== UI Scenario: ui-payload-completeness ===');
            writeSettingsFile(buildUISettings({
                'ui.hideNonConflictOutputs': true,
                'ui.showCellHeaders': true,
                'ui.enableUndoRedoHotkeys': false,
                'ui.showBaseColumn': false,
                'ui.theme': 'light',
            }));

            const workspacePath = conflictRepo({
                base: '08_settings_base.ipynb',
                current: '08_settings_current.ipynb',
                incoming: '08_settings_incoming.ipynb',
            });
            const session = await conflictSession(workspacePath);
            const { page } = session;

            await page.locator('#root').waitFor({ timeout: 10000 });

            // theme
            const theme = await page.locator('#root').getAttribute('data-theme');
            expect(theme).toBe('light');

            // showBaseColumn=false
            const baseLabels = await page.locator('.column-label.base').count();
            expect(baseLabels).toBe(0);

            // showCellHeaders=true
            const headers = await page.locator('.cell-header').count();
            expect(headers).toBeGreaterThan(0);

            // hideNonConflictOutputs=true
            const stableRow = await findStableIdenticalRow(page);
            const stableOutputs = await stableRow.locator('.cell-outputs').count();
            expect(stableOutputs).toBe(0);

            // enableUndoRedoHotkeys=false -- undo should not revert
            const conflictRow = await findExecutionConflictRow(page);
            await conflictRow.locator('.btn-current').click();
            await conflictRow.locator('.resolved-content-input').waitFor({ timeout: 5000 });
            await page.click('.header-title');
            const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.keyboard.press(`${mod}+Z`);
            await expect(conflictRow.locator('.resolved-content-input')).toBeVisible({ timeout: 500 });
            const stillResolved = await conflictRow.locator('.resolved-content-input').count();
            expect(stillResolved).toBeGreaterThan(0);

            logger.info('  pass: ui-payload-completeness');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });
});
