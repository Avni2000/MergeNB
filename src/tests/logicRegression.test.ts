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
import type { NotebookCell, Notebook } from '../types';
import type { CellMapping } from '../types';

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
        hideNonConflictOutputs: true,
        enableUndoRedoHotkeys: true,
        showBaseColumn: true,
        theme: 'light',
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
        hideNonConflictOutputs: true,
        enableUndoRedoHotkeys: true,
        showBaseColumn: true,
        theme: 'light',
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
}
