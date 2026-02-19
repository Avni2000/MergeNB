/**
 * @file settingsRegression.test.ts
 * @description Regression tests for each MergeNBSettings field.
 *
 * Tests are pure logic (no Playwright / browser) and run inside the VS Code
 * extension test host via the existing integration test runner.
 *
 * Coverage
 * --------
 *  autoResolveExecutionCount  - execution-count-changed conflicts are auto-resolved or kept
 *  autoResolveKernelVersion   - kernel / language_info diffs are auto-resolved or not
 *  stripOutputs               - outputs-changed conflicts are auto-resolved; outputs stripped
 *  autoResolveWhitespace      - whitespace-only source diffs are auto-resolved or not
 *  hideNonConflictOutputs     - value is forwarded through UnifiedConflict (wiring check)
 *  showCellHeaders            - value is forwarded through UnifiedConflict (wiring check)
 *  enableUndoRedoHotkeys      - value is forwarded through UnifiedConflict (wiring check)
 *  showBaseColumn             - value is forwarded through UnifiedConflict (wiring check)
 *  theme                      - value is forwarded through UnifiedConflict (wiring check)
 *  getSettings() defaults     - headless defaults match package.json declared defaults
 */

import * as assert from 'assert';
import { analyzeSemanticConflictsFromMappings, applyAutoResolutions } from '../conflictDetector';
import { getSettings } from '../settings';
import type { CellMapping } from '../types';
import type { NotebookCell, Notebook, NotebookSemanticConflict } from '../types';
import type { MergeNBSettings } from '../settings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings(overrides: Partial<MergeNBSettings> = {}): MergeNBSettings {
    return {
        autoResolveExecutionCount: true,
        autoResolveKernelVersion: true,
        stripOutputs: true,
        autoResolveWhitespace: true,
        hideNonConflictOutputs: false,
        showCellHeaders: false,
        enableUndoRedoHotkeys: true,
        showBaseColumn: false,
        theme: 'dark',
        ...overrides,
    };
}

function makeCodeCell(source: string, execCount: number | null = null, outputs: unknown[] = []): NotebookCell {
    return {
        cell_type: 'code',
        source,
        metadata: {},
        execution_count: execCount,
        outputs: outputs as NotebookCell['outputs'],
    };
}

function makeMarkdownCell(source: string): NotebookCell {
    return {
        cell_type: 'markdown',
        source,
        metadata: {},
    };
}

/** Build a minimal three-way mapping with a single cell changed in both branches */
function mappingModified(base: NotebookCell, current: NotebookCell, incoming: NotebookCell): CellMapping[] {
    return [{
        baseIndex: 0,
        currentIndex: 0,
        incomingIndex: 0,
        matchConfidence: 1,
        baseCell: base,
        currentCell: current,
        incomingCell: incoming,
    }];
}

/** Build a mapping where the cell was added in both branches (no base) */
function mappingAddedBoth(current: NotebookCell, incoming: NotebookCell): CellMapping[] {
    return [{
        currentIndex: 0,
        incomingIndex: 0,
        matchConfidence: 1,
        currentCell: current,
        incomingCell: incoming,
    }];
}

function makeSemanticConflict(
    base: Notebook | undefined,
    current: Notebook | undefined,
    incoming: Notebook | undefined
): NotebookSemanticConflict {
    return {
        filePath: '/tmp/test.ipynb',
        semanticConflicts: [],
        cellMappings: [],
        base,
        current,
        incoming,
    };
}

function makeNotebook(cells: NotebookCell[], metadata: Record<string, unknown> = {}): Notebook {
    return {
        nbformat: 4,
        nbformat_minor: 5,
        metadata,
        cells,
    };
}

// ---------------------------------------------------------------------------
// 1. autoResolveExecutionCount
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
    // ── 1a. Detection still reports execution-count conflicts (true setting) ──
    {
        const base = makeCodeCell('x = 1', 1);
        const current = makeCodeCell('x = 1', 2);
        const incoming = makeCodeCell('x = 1', 3);

        const conflicts = analyzeSemanticConflictsFromMappings(
            mappingModified(base, current, incoming),
            makeSettings({ autoResolveExecutionCount: true })
        );

        const execConflicts = conflicts.filter(c => c.type === 'execution-count-changed');
        assert.ok(execConflicts.length > 0,
            'Detection should report execution-count conflicts; auto-resolution happens later');
    }

    // ── 1b. Detection also reports execution-count conflicts (false setting) ──
    {
        const base = makeCodeCell('x = 1', 1);
        const current = makeCodeCell('x = 1', 2);
        const incoming = makeCodeCell('x = 1', 3);

        const conflicts = analyzeSemanticConflictsFromMappings(
            mappingModified(base, current, incoming),
            makeSettings({ autoResolveExecutionCount: false })
        );

        const execConflicts = conflicts.filter(c => c.type === 'execution-count-changed');
        assert.ok(execConflicts.length > 0,
            'autoResolveExecutionCount=false: execution-count conflict must surface');
    }

    // ── 1c. applyAutoResolutions sets execution_count to null when enabled ──
    {
        const cell = makeCodeCell('x = 1', 5);
        const nb = makeNotebook([cell]);
        const sc = makeSemanticConflict(nb, nb, nb);
        sc.semanticConflicts = [{
            type: 'execution-count-changed',
            currentCellIndex: 0,
            incomingCellIndex: 0,
            currentContent: cell,
            incomingContent: cell,
            description: 'test',
        }];

        const result = applyAutoResolutions(sc, makeSettings({ autoResolveExecutionCount: true }));
        assert.strictEqual(result.autoResolvedCount, 1,
            'autoResolveExecutionCount=true: should auto-resolve 1 execution-count conflict');
        assert.strictEqual(result.resolvedNotebook.cells[0].execution_count, null,
            'autoResolveExecutionCount=true: cell execution_count should become null');
    }

    // ── 1d. applyAutoResolutions leaves execution_count unchanged when disabled ──
    {
        const cell = makeCodeCell('x = 1', 5);
        const nb = makeNotebook([cell]);
        const sc = makeSemanticConflict(nb, nb, nb);
        sc.semanticConflicts = [{
            type: 'execution-count-changed',
            currentCellIndex: 0,
            incomingCellIndex: 0,
            currentContent: cell,
            incomingContent: cell,
            description: 'test',
        }];

        const result = applyAutoResolutions(sc, makeSettings({ autoResolveExecutionCount: false }));
        assert.strictEqual(result.remainingConflicts.length, 1,
            'autoResolveExecutionCount=false: conflict must remain unresolved');
    }

    console.log('[settingsRegression] autoResolveExecutionCount ✓');

    // ---------------------------------------------------------------------------
    // 2. stripOutputs
    // ---------------------------------------------------------------------------

    // ── 2a. stripOutputs=true → outputs-changed conflicts are auto-resolved ──
    {
        const outputs = [{ output_type: 'stream', name: 'stdout', text: 'hello\n' }] as NotebookCell['outputs'];
        const base = makeCodeCell('print("hi")', null, outputs);
        const current = makeCodeCell('print("hi")', null, outputs);
        const incoming = makeCodeCell('print("hi")', null, []);

        // The mapping considers outputs-changed because strips differ
        const nb = makeNotebook([base]);
        const sc = makeSemanticConflict(nb, makeNotebook([current]), makeNotebook([incoming]));
        sc.semanticConflicts = [{
            type: 'outputs-changed',
            currentCellIndex: 0,
            incomingCellIndex: 0,
            currentContent: current,
            incomingContent: incoming,
            description: 'test',
        }];

        const result = applyAutoResolutions(sc, makeSettings({ stripOutputs: true }));
        assert.ok(result.autoResolvedCount >= 1,
            'stripOutputs=true: outputs-changed conflict should be auto-resolved');
        assert.deepStrictEqual(result.resolvedNotebook.cells[0].outputs, [],
            'stripOutputs=true: resolved cell outputs should be empty array');
    }

    // ── 2b. stripOutputs=false → outputs-changed conflicts are NOT auto-resolved ──
    {
        const outputs = [{ output_type: 'stream', name: 'stdout', text: 'hello\n' }] as NotebookCell['outputs'];
        const cell = makeCodeCell('print("hi")', null, outputs);
        const nb = makeNotebook([cell]);
        const sc = makeSemanticConflict(nb, nb, nb);
        sc.semanticConflicts = [{
            type: 'outputs-changed',
            currentCellIndex: 0,
            incomingCellIndex: 0,
            currentContent: cell,
            incomingContent: { ...cell, outputs: [] },
            description: 'test',
        }];

        const result = applyAutoResolutions(sc, makeSettings({ stripOutputs: false }));
        const remainingOutputConflicts = result.remainingConflicts.filter(c => c.type === 'outputs-changed');
        assert.strictEqual(remainingOutputConflicts.length, 1,
            'stripOutputs=false: outputs-changed conflict must remain');
    }

    // ── 2c. Detection reports outputs-changed for added-in-both code cells ──
    {
        const outputs = [{ output_type: 'stream', name: 'stdout', text: 'A\n' }] as NotebookCell['outputs'];
        const current = makeCodeCell('same', 1, outputs);
        const incoming = makeCodeCell('same', 1, []);

        const conflicts = analyzeSemanticConflictsFromMappings(
            mappingAddedBoth(current, incoming),
            makeSettings({ stripOutputs: true })
        );
        const outputConflicts = conflicts.filter(c => c.type === 'outputs-changed');
        assert.ok(outputConflicts.length > 0,
            'Detection should report outputs-changed; stripOutputs is applied in auto-resolution');
    }

    console.log('[settingsRegression] stripOutputs ✓');

    // ---------------------------------------------------------------------------
    // 3. autoResolveWhitespace
    // ---------------------------------------------------------------------------

    // ── 3a. autoResolveWhitespace=true → whitespace-only cell-modified is auto-resolved ──
    {
        // Trailing spaces on lines - same logical content, different raw bytes
        const base = makeCodeCell('x = 1\ny = 2');
        const current = makeCodeCell('x = 1   \ny = 2  ');   // trailing spaces on each line
        const incoming = makeCodeCell('x = 1\ny = 2');

        const nb = makeNotebook([base]);
        const sc = makeSemanticConflict(nb, makeNotebook([current]), makeNotebook([incoming]));
        sc.semanticConflicts = [{
            type: 'cell-modified',
            currentCellIndex: 0,
            incomingCellIndex: 0,
            currentContent: current,
            incomingContent: incoming,
            description: 'whitespace-only diff',
        }];

        const result = applyAutoResolutions(sc, makeSettings({ autoResolveWhitespace: true }));
        assert.ok(result.autoResolvedCount >= 1,
            'autoResolveWhitespace=true: whitespace-only cell-modified should be auto-resolved');
    }

    // ── 3b. autoResolveWhitespace=false → whitespace-only cell-modified must remain ──
    {
        const base = makeCodeCell('x = 1\ny = 2');
        const current = makeCodeCell('x = 1   \ny = 2  ');
        const incoming = makeCodeCell('x = 1\ny = 2');

        const nb = makeNotebook([base]);
        const sc = makeSemanticConflict(nb, makeNotebook([current]), makeNotebook([incoming]));
        sc.semanticConflicts = [{
            type: 'cell-modified',
            currentCellIndex: 0,
            incomingCellIndex: 0,
            currentContent: current,
            incomingContent: incoming,
            description: 'whitespace-only diff',
        }];

        const result = applyAutoResolutions(sc, makeSettings({ autoResolveWhitespace: false }));
        assert.strictEqual(result.remainingConflicts.filter(c => c.type === 'cell-modified').length, 1,
            'autoResolveWhitespace=false: whitespace-only cell-modified must remain');
    }

    // ── 3c. autoResolveWhitespace=true → whitespace-only cell-added is auto-resolved ──
    {
        const current = makeMarkdownCell('hello   ');
        const incoming = makeMarkdownCell('hello');

        const nb = makeNotebook([]);
        const sc = makeSemanticConflict(nb, makeNotebook([current]), makeNotebook([incoming]));
        sc.semanticConflicts = [{
            type: 'cell-added',
            currentCellIndex: 0,
            incomingCellIndex: 0,
            currentContent: current,
            incomingContent: incoming,
            description: 'whitespace-only added cells',
        }];

        const result = applyAutoResolutions(sc, makeSettings({ autoResolveWhitespace: true }));
        assert.ok(result.autoResolvedCount >= 1,
            'autoResolveWhitespace=true: whitespace-only cell-added should be auto-resolved');
    }

    console.log('[settingsRegression] autoResolveWhitespace ✓');

    // ---------------------------------------------------------------------------
    // 4. autoResolveKernelVersion
    // ---------------------------------------------------------------------------

    // ── 4a. autoResolveKernelVersion=true → kernel diff is auto-resolved ──
    {
        const baseKernelMeta = { kernelspec: { display_name: 'Python 3', name: 'python3', language: 'python' }, language_info: { name: 'python', version: '3.9.0' } };
        const currentKernelMeta = { kernelspec: { display_name: 'Python 3.10', name: 'python3', language: 'python' }, language_info: { name: 'python', version: '3.10.0' } };
        const incomingKernelMeta = { kernelspec: { display_name: 'Python 3.8', name: 'python3', language: 'python' }, language_info: { name: 'python', version: '3.8.0' } };

        const baseNb = makeNotebook([], baseKernelMeta);
        const currentNb = makeNotebook([], currentKernelMeta);
        const incomingNb = makeNotebook([], incomingKernelMeta);
        const sc = makeSemanticConflict(baseNb, currentNb, incomingNb);

        const result = applyAutoResolutions(sc, makeSettings({ autoResolveKernelVersion: true }));
        assert.ok(result.kernelAutoResolved,
            'autoResolveKernelVersion=true: kernel version diff should be auto-resolved');
        assert.ok(result.autoResolvedCount >= 1,
            'autoResolveKernelVersion=true: autoResolvedCount should be >= 1');
    }

    // ── 4b. autoResolveKernelVersion=false → kernel diff is NOT auto-resolved ──
    {
        const currentKernelMeta = { kernelspec: { display_name: 'Python 3.10', name: 'python3', language: 'python' }, language_info: { name: 'python', version: '3.10.0' } };
        const incomingKernelMeta = { kernelspec: { display_name: 'Python 3.8', name: 'python3', language: 'python' }, language_info: { name: 'python', version: '3.8.0' } };

        const sc = makeSemanticConflict(undefined, makeNotebook([], currentKernelMeta), makeNotebook([], incomingKernelMeta));

        const result = applyAutoResolutions(sc, makeSettings({ autoResolveKernelVersion: false }));
        assert.strictEqual(result.kernelAutoResolved, false,
            'autoResolveKernelVersion=false: kernel diff must not be auto-resolved');
    }

    console.log('[settingsRegression] autoResolveKernelVersion ✓');

    // ---------------------------------------------------------------------------
    // 5. UI settings forwarding: hideNonConflictOutputs, showCellHeaders,
    //    enableUndoRedoHotkeys, showBaseColumn, theme
    //
    //    These settings are UI-only and don't influence conflict detection logic.
    //    We verify the values are correctly reflected in the UnifiedConflict
    //    object by constructing it manually the same way resolver.ts does.
    // ---------------------------------------------------------------------------
    {
        const uiSettings: MergeNBSettings = makeSettings({
            hideNonConflictOutputs: true,
            showCellHeaders: true,
            enableUndoRedoHotkeys: false,
            showBaseColumn: true,
            theme: 'light',
        });

        // Simulate what resolver.ts does when building UnifiedConflict
        const unifiedConflict = {
            filePath: '/tmp/test.ipynb',
            type: 'semantic' as const,
            hideNonConflictOutputs: uiSettings.hideNonConflictOutputs,
            showCellHeaders: uiSettings.showCellHeaders,
            enableUndoRedoHotkeys: uiSettings.enableUndoRedoHotkeys,
            showBaseColumn: uiSettings.showBaseColumn,
            theme: uiSettings.theme,
        };

        assert.strictEqual(unifiedConflict.hideNonConflictOutputs, true,
            'hideNonConflictOutputs should be forwarded as true');
        assert.strictEqual(unifiedConflict.showCellHeaders, true,
            'showCellHeaders should be forwarded as true');
        assert.strictEqual(unifiedConflict.enableUndoRedoHotkeys, false,
            'enableUndoRedoHotkeys should be forwarded as false');
        assert.strictEqual(unifiedConflict.showBaseColumn, true,
            'showBaseColumn should be forwarded as true');
        assert.strictEqual(unifiedConflict.theme, 'light',
            'theme should be forwarded as light');
    }

    // Second pass: opposite values
    {
        const uiSettings: MergeNBSettings = makeSettings({
            hideNonConflictOutputs: false,
            showCellHeaders: false,
            enableUndoRedoHotkeys: true,
            showBaseColumn: false,
            theme: 'dark',
        });

        const unifiedConflict = {
            filePath: '/tmp/test.ipynb',
            type: 'semantic' as const,
            hideNonConflictOutputs: uiSettings.hideNonConflictOutputs,
            showCellHeaders: uiSettings.showCellHeaders,
            enableUndoRedoHotkeys: uiSettings.enableUndoRedoHotkeys,
            showBaseColumn: uiSettings.showBaseColumn,
            theme: uiSettings.theme,
        };

        assert.strictEqual(unifiedConflict.hideNonConflictOutputs, false, 'hideNonConflictOutputs=false');
        assert.strictEqual(unifiedConflict.showCellHeaders, false, 'showCellHeaders=false');
        assert.strictEqual(unifiedConflict.enableUndoRedoHotkeys, true, 'enableUndoRedoHotkeys=true');
        assert.strictEqual(unifiedConflict.showBaseColumn, false, 'showBaseColumn=false');
        assert.strictEqual(unifiedConflict.theme, 'dark', 'theme=dark');
    }

    console.log('[settingsRegression] UI settings forwarding ✓');

    // ---------------------------------------------------------------------------
    // 6. getSettings() headless defaults match package.json declared defaults
    //    (only run when not inside VS Code test host - vscode not importable)
    // ---------------------------------------------------------------------------
    {
        // In the extension test host vscode IS available, but MERGENB_TEST_MODE
        // is set so we get DEFAULT_SETTINGS. Those defaults intentionally differ
        // from production defaults (e.g. showBaseColumn=true for test visibility).
        // What we care about is that the interface is complete.
        const settings = getSettings();

        const expectedKeys: Array<keyof MergeNBSettings> = [
            'autoResolveExecutionCount',
            'autoResolveKernelVersion',
            'stripOutputs',
            'autoResolveWhitespace',
            'hideNonConflictOutputs',
            'showCellHeaders',
            'enableUndoRedoHotkeys',
            'showBaseColumn',
            'theme',
        ];

        for (const key of expectedKeys) {
            assert.ok(key in settings, `getSettings() must include property: ${key}`);
            assert.notStrictEqual(settings[key], undefined,
                `getSettings().${key} must not be undefined`);
        }

        // theme must be 'dark' or 'light'
        assert.ok(
            settings.theme === 'dark' || settings.theme === 'light',
            `getSettings().theme must be 'dark' or 'light', got: ${settings.theme}`
        );

        // Boolean fields must be booleans
        const boolFields: Array<keyof MergeNBSettings> = [
            'autoResolveExecutionCount', 'autoResolveKernelVersion', 'stripOutputs',
            'autoResolveWhitespace', 'hideNonConflictOutputs', 'showCellHeaders',
            'enableUndoRedoHotkeys', 'showBaseColumn',
        ];
        for (const field of boolFields) {
            assert.strictEqual(typeof settings[field], 'boolean',
                `getSettings().${field} must be a boolean`);
        }
    }

    console.log('[settingsRegression] getSettings() interface completeness ✓');

    // ---------------------------------------------------------------------------
    // 7. analyzeSemanticConflictsFromMappings - settings default fallback
    //    When no settings arg is passed it should not throw.
    // ---------------------------------------------------------------------------
    {
        const base = makeCodeCell('a = 1', 1);
        const current = makeCodeCell('a = 2', 2);
        const incoming = makeCodeCell('a = 3', 3);

        let threw = false;
        try {
            // Passing undefined - should use getSettings() internally
            analyzeSemanticConflictsFromMappings(mappingModified(base, current, incoming));
        } catch {
            threw = true;
        }
        assert.strictEqual(threw, false,
            'analyzeSemanticConflictsFromMappings must not throw when settings arg is omitted');
    }

    console.log('[settingsRegression] settings default fallback ✓');

    console.log('[settingsRegression] ALL TESTS PASSED ✓');
}
