/**
 * @file logicRegression.test.ts
 * @description Lightweight regression checks for merge logic.
 *
 * These run inside the VS Code extension test host but do not require UI/browser.
 */

import * as assert from 'assert';
import { selectNonConflictMergedCell } from '../notebookUtils';
import { renumberExecutionCounts } from '../notebookParser';
import type { NotebookCell, Notebook } from '../types';

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
