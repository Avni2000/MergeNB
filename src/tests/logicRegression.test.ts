/**
 * @file logicRegression.test.ts
 * @description Lightweight regression checks for merge logic.
 *
 * These run inside the VS Code extension test host but do not require UI/browser.
 */

import * as assert from 'assert';
import { selectNonConflictMergedCell } from '../notebookUtils';
import { renumberExecutionCounts } from '../notebookParser';
import { analyzeSemanticConflictsFromMappings } from '../conflictDetector';
import { inferPreferredSide } from '../resolver';
import { collectRowConflictIndexes, hasUnmappedReorderConflict } from '../web/client/conflictRowUtils';
import type { MergeRow as MergeRowType } from '../web/client/types';
import type { NotebookCell, Notebook, SemanticConflict } from '../types';
import type { CellMapping } from '../types';
import type { ResolvedRow } from '../web/webTypes';

export async function run(): Promise<void> {
    // ---------------------------------------------------------------------
    // Regression: one-sided metadata edits on non-conflict rows must not drop
    // ---------------------------------------------------------------------
    const baseCell: NotebookCell = {
        cell_type: 'markdown',
        source: 'hello',
        metadata: { tags: ['keep'] },
    };
    const currentCell: NotebookCell = {
        cell_type: 'markdown',
        source: 'hello',
        metadata: { tags: ['keep'] },
    };
    const incomingCell: NotebookCell = {
        cell_type: 'markdown',
        source: 'hello',
        metadata: { tags: ['keep'], custom: { added: true } },
    };

    const mergedMeta = selectNonConflictMergedCell(baseCell, currentCell, incomingCell);
    assert.strictEqual(mergedMeta, incomingCell, 'Expected incoming cell when only incoming metadata differs from base');

    // ---------------------------------------------------------------------
    // Regression: "added in both" with same source but different metadata
    // must be surfaced as a conflict (otherwise we silently drop one side).
    // ---------------------------------------------------------------------
    const addedCurrent: NotebookCell = {
        cell_type: 'markdown',
        source: 'same',
        metadata: { a: 1 },
    };
    const addedIncoming: NotebookCell = {
        cell_type: 'markdown',
        source: 'same',
        metadata: { a: 1, b: 2 },
    };

    const mappings: CellMapping[] = [
        {
            currentIndex: 0,
            incomingIndex: 0,
            matchConfidence: 1,
            currentCell: addedCurrent,
            incomingCell: addedIncoming,
        },
    ];

    const conflicts = analyzeSemanticConflictsFromMappings(mappings, {
        autoResolveExecutionCount: true,
        autoResolveKernelVersion: true,
        stripOutputs: true,
        autoResolveWhitespace: true,
        hideNonConflictOutputs: false,
        showCellHeaders: false,
        enableUndoRedoHotkeys: true,
        showBaseColumn: true,
        theme: 'dark',
    });
    assert.ok(
        conflicts.some(c => c.type === 'metadata-changed'),
        'Expected metadata-changed conflict for added-in-both metadata difference'
    );

    // ---------------------------------------------------------------------
    // Regression: source/input payload differences must remain conflicts even
    // when stripOutputs is enabled (the default path).
    // ---------------------------------------------------------------------
    const inputBase: NotebookCell = {
        cell_type: 'code',
        source: "svg_payload = \"<svg><text>INPUT_BASE</text></svg>\"",
        metadata: {},
        execution_count: null,
        outputs: [],
    };
    const inputCurrent: NotebookCell = {
        cell_type: 'code',
        source: "svg_payload = \"<svg><text>INPUT_CURRENT</text></svg>\"",
        metadata: {},
        execution_count: null,
        outputs: [],
    };
    const inputIncoming: NotebookCell = {
        cell_type: 'code',
        source: "svg_payload = \"<svg><text>INPUT_INCOMING</text></svg>\"",
        metadata: {},
        execution_count: null,
        outputs: [],
    };

    const inputMappings: CellMapping[] = [
        {
            baseIndex: 0,
            currentIndex: 0,
            incomingIndex: 0,
            matchConfidence: 1,
            baseCell: inputBase,
            currentCell: inputCurrent,
            incomingCell: inputIncoming,
        },
    ];

    const inputConflicts = analyzeSemanticConflictsFromMappings(inputMappings, {
        autoResolveExecutionCount: true,
        autoResolveKernelVersion: true,
        stripOutputs: true,
        autoResolveWhitespace: true,
        hideNonConflictOutputs: false,
        showCellHeaders: false,
        enableUndoRedoHotkeys: true,
        showBaseColumn: true,
        theme: 'dark',
    });
    assert.ok(
        inputConflicts.some(c => c.type === 'cell-modified'),
        'Expected cell-modified conflict for differing input payload sources'
    );

    // ---------------------------------------------------------------------
    // Regression: renumbering must update execute_result.execution_count too
    // ---------------------------------------------------------------------
    const notebook: Notebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
            {
                cell_type: 'code',
                source: '1 + 1',
                metadata: {},
                execution_count: 99,
                outputs: [
                    {
                        output_type: 'execute_result',
                        execution_count: 99,
                        data: { 'text/plain': '2' },
                    },
                ],
            },
            {
                cell_type: 'code',
                source: 'print("x")',
                metadata: {},
                execution_count: 100,
                outputs: [],
            },
        ],
    };

    const renumbered = renumberExecutionCounts(notebook);
    assert.strictEqual(renumbered.cells[0].execution_count, 1);
    const out0 = renumbered.cells[0].outputs?.[0] as any;
    assert.strictEqual(out0.execution_count, 1, 'Expected execute_result.execution_count to match renumbered cell execution_count');
    assert.strictEqual(renumbered.cells[1].execution_count, null, 'Expected unexecuted code cell execution_count to be null');

    // ---------------------------------------------------------------------
    // Regression: multiple conflict types for the same cell triplet must all
    // be detected and ordered correctly.
    //
    // When both source AND metadata are modified differently in both branches,
    // analyzeSemanticConflictsFromMappings must return both 'cell-modified'
    // AND 'metadata-changed' for the same cell indices.
    //
    // This is the prerequisite condition for the UI-layer conflictMap bug:
    // buildMergeRowsFromSemantic was using Map.set() without checking for an
    // existing key, so only the LAST conflict per cell survived.  The fix
    // changes Map.set() to a has()-guarded set so the FIRST (and most
    // important) conflict — 'cell-modified' — is preserved.
    // ---------------------------------------------------------------------
    const multiBase: NotebookCell = {
        cell_type: 'code',
        source: 'x = 1',
        metadata: { tags: ['original'] },
        execution_count: 1,
        outputs: [],
    };
    const multiCurrent: NotebookCell = {
        cell_type: 'code',
        source: 'x = 2',                    // source changed in current
        metadata: { tags: ['from-current'] }, // metadata changed in current
        execution_count: 1,
        outputs: [],
    };
    const multiIncoming: NotebookCell = {
        cell_type: 'code',
        source: 'x = 3',                     // source changed differently in incoming
        metadata: { tags: ['from-incoming'] }, // metadata changed differently in incoming
        execution_count: 1,
        outputs: [],
    };

    const multiMappings: CellMapping[] = [
        {
            baseIndex: 0,
            currentIndex: 0,
            incomingIndex: 0,
            matchConfidence: 1,
            baseCell: multiBase,
            currentCell: multiCurrent,
            incomingCell: multiIncoming,
        },
    ];

    const multiConflicts = analyzeSemanticConflictsFromMappings(multiMappings, {
        autoResolveExecutionCount: false,
        autoResolveKernelVersion: false,
        stripOutputs: false,
        autoResolveWhitespace: false,
        hideNonConflictOutputs: false,
        showCellHeaders: false,
        enableUndoRedoHotkeys: true,
        showBaseColumn: true,
        theme: 'dark',
    });

    assert.ok(
        multiConflicts.some(c => c.type === 'cell-modified'),
        'Expected cell-modified conflict when source differs in both branches'
    );
    assert.ok(
        multiConflicts.some(c => c.type === 'metadata-changed'),
        'Expected metadata-changed conflict when metadata differs in both branches'
    );

    const cellModified = multiConflicts.find(c => c.type === 'cell-modified')!;
    const metadataChanged = multiConflicts.find(c => c.type === 'metadata-changed')!;

    // Both conflicts must share the same cell indices — this is what causes
    // the key collision in the UI's conflictMap (base-current-incoming triplet).
    assert.strictEqual(
        cellModified.baseCellIndex,
        metadataChanged.baseCellIndex,
        'cell-modified and metadata-changed must reference the same base cell index'
    );
    assert.strictEqual(
        cellModified.currentCellIndex,
        metadataChanged.currentCellIndex,
        'cell-modified and metadata-changed must reference the same current cell index'
    );
    assert.strictEqual(
        cellModified.incomingCellIndex,
        metadataChanged.incomingCellIndex,
        'cell-modified and metadata-changed must reference the same incoming cell index'
    );

    // cell-modified must be detected BEFORE metadata-changed so that when the
    // UI fix preserves the first conflict per key, it picks the more-important one.
    assert.ok(
        multiConflicts.indexOf(cellModified) < multiConflicts.indexOf(metadataChanged),
        'cell-modified should appear before metadata-changed in the conflict list'
    );

    // ---------------------------------------------------------------------
    // Regression: reorder-only semantic conflicts (no cell indices) must be
    // detectable as "unmapped reorder" so UI accounting cannot drop them.
    // ---------------------------------------------------------------------
    const rows: MergeRowType[] = [
        { type: 'identical', currentCellIndex: 0, incomingCellIndex: 0 },
        { type: 'conflict', conflictIndex: 4, currentCellIndex: 1, incomingCellIndex: 1 },
        { type: 'conflict', conflictIndex: 4, currentCellIndex: 2, incomingCellIndex: 2 },
    ];
    const rowConflictIndexes = collectRowConflictIndexes(rows);
    assert.deepStrictEqual([...rowConflictIndexes], [4], 'Row conflict indexes should be deduplicated');

    const reorderOnly: SemanticConflict[] = [{
        type: 'cell-reordered',
        description: 'Cells reordered',
    }];
    assert.strictEqual(
        hasUnmappedReorderConflict(reorderOnly, new Set<number>()),
        true,
        'Expected reorder-only conflict with no indices to be treated as unmapped'
    );
    assert.strictEqual(
        hasUnmappedReorderConflict(reorderOnly, new Set<number>([0])),
        false,
        'Expected reorder-only conflict mapped by row index to not be treated as unmapped'
    );
    assert.strictEqual(
        hasUnmappedReorderConflict([{
            type: 'cell-reordered',
            currentCellIndex: 0,
            description: 'Indexed reorder',
        }], new Set<number>()),
        false,
        'Expected indexed reorder conflict to not be treated as unmapped'
    );

    // ---------------------------------------------------------------------
    // Regression: explicit semanticChoice hint should drive ordering even when
    // there are no per-row resolution choices (reorder-only flow).
    // ---------------------------------------------------------------------
    const hintOnlyRows: ResolvedRow[] = [
        { currentCellIndex: 0, incomingCellIndex: 1 },
    ];
    assert.strictEqual(
        inferPreferredSide(hintOnlyRows, 'incoming'),
        'incoming',
        'Expected preferredSideHint to be used when rows have no explicit resolutions'
    );

    const mixedRows: ResolvedRow[] = [
        {
            currentCell: { cell_type: 'code', source: 'a', metadata: {} },
            incomingCell: { cell_type: 'code', source: 'a', metadata: {} },
            resolution: { choice: 'current', resolvedContent: 'a' },
        },
        {
            currentCell: { cell_type: 'code', source: 'b', metadata: {} },
            incomingCell: { cell_type: 'code', source: 'b', metadata: {} },
            resolution: { choice: 'incoming', resolvedContent: 'b' },
        },
    ];
    assert.strictEqual(
        inferPreferredSide(mixedRows),
        undefined,
        'Expected mixed manual choices to not infer a global preferred side'
    );
    assert.strictEqual(
        inferPreferredSide(mixedRows, 'current'),
        'current',
        'Expected explicit preferredSideHint to override mixed per-row choices'
    );
}
