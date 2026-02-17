/**
 * @file nullCurrentCellIndexing.test.ts
 * @description Test for bug where resolvedNotebook is cloned from incoming
 *              (when current is null), but the code incorrectly uses currentCellIndex
 *              instead of incomingCellIndex to index into cells.
 *
 * Scenario: Delete/Modify conflict where current branch deleted the notebook
 *           and incoming branch modified it. Git stage 2 (current) is null.
 */

import * as assert from 'assert';
import { applyAutoResolutions } from '../conflictDetector';
import type { NotebookSemanticConflict, Notebook, SemanticConflict } from '../types';

export async function run(): Promise<void> {
    console.log('[nullCurrentCellIndexing] Starting test...');

    // -------------------------------------------------------------------------
    // Setup: Delete/Modify conflict
    // - Current branch: deleted the notebook (current = null)
    // - Incoming branch: modified the notebook (3 cells with different exec counts)
    // -------------------------------------------------------------------------

    const incomingNotebook: Notebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
            {
                cell_type: 'code',
                source: 'print("cell 0")',
                metadata: {},
                execution_count: 5,
                outputs: [],
            },
            {
                cell_type: 'code',
                source: 'print("cell 1")',
                metadata: {},
                execution_count: 10,
                outputs: [],
            },
            {
                cell_type: 'code',
                source: 'print("cell 2")',
                metadata: {},
                execution_count: 15,
                outputs: [],
            },
        ],
    };

    // Create semantic conflicts where cells have different indices in current vs incoming
    // When current is null, currentCellIndex might be undefined or pointing to a different position
    const conflicts: SemanticConflict[] = [
        {
            type: 'execution-count-changed',
            // Cell at index 1 in incoming, but currentCellIndex is 0 (wrong!)
            currentCellIndex: 0,
            incomingCellIndex: 1,
            currentContent: undefined,
            incomingContent: incomingNotebook.cells[1],
            description: 'Execution count mismatch on cell 1',
        },
        {
            type: 'execution-count-changed',
            // Cell at index 2 in incoming, but currentCellIndex is 1 (wrong!)
            currentCellIndex: 1,
            incomingCellIndex: 2,
            currentContent: undefined,
            incomingContent: incomingNotebook.cells[2],
            description: 'Execution count mismatch on cell 2',
        },
    ];

    const semanticConflict: NotebookSemanticConflict = {
        filePath: '/tmp/test.ipynb',
        semanticConflicts: conflicts,
        cellMappings: [],
        base: undefined,
        current: undefined, // Simulate delete/modify conflict where current is null
        incoming: incomingNotebook,
    };

    // -------------------------------------------------------------------------
    // Execute: Apply auto-resolutions with autoResolveExecutionCount enabled
    // -------------------------------------------------------------------------

    const result = applyAutoResolutions(semanticConflict, {
        autoResolveExecutionCount: true,
        autoResolveKernelVersion: false,
        stripOutputs: false,
        autoResolveWhitespace: false,
        hideNonConflictOutputs: false,
        enableUndoRedoHotkeys: false,
        showBaseColumn: false,
        theme: 'light',
    });

    console.log('[nullCurrentCellIndexing] Auto-resolution result:', {
        autoResolvedCount: result.autoResolvedCount,
        remainingConflicts: result.remainingConflicts.length,
        resolvedNotebook: result.resolvedNotebook,
    });

    // -------------------------------------------------------------------------
    // Assert: auto-resolution summary is correct
    // -------------------------------------------------------------------------

    assert.strictEqual(
        result.autoResolvedCount,
        2,
        'Should have resolved 2 execution-count conflicts automatically'
    );

    assert.strictEqual(
        result.remainingConflicts.length,
        0,
        'Should have no remaining conflicts after auto-resolution'
    );

    // -------------------------------------------------------------------------
    // Assert: incomingCellIndex is used when current notebook is null
    // -------------------------------------------------------------------------

    const cell0 = result.resolvedNotebook?.cells[0];
    const cell1 = result.resolvedNotebook?.cells[1];
    const cell2 = result.resolvedNotebook?.cells[2];

    console.log('[nullCurrentCellIndexing] Cell execution counts:', {
        cell0: cell0?.execution_count,
        cell1: cell1?.execution_count,
        cell2: cell2?.execution_count,
    });

    assert.strictEqual(
        cell0?.execution_count,
        5,
        'Cell 0 should not be modified (was not in conflict)'
    );

    assert.strictEqual(
        cell1?.execution_count,
        null,
        'Cell 1 execution_count should be null (was in conflict at incomingCellIndex 1)'
    );

    assert.strictEqual(
        cell2?.execution_count,
        null,
        'Cell 2 execution_count should be null (was in conflict at incomingCellIndex 2)'
    );

    console.log('[nullCurrentCellIndexing] ✓ Test passed');
}
