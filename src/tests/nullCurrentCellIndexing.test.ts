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
import type { NotebookSemanticConflict, Notebook, NotebookCell, SemanticConflict } from '../types';

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
        current: null as any, // Simulate delete/modify conflict where current is null
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
    // Assert: The bug causes wrong cells to be modified
    // -------------------------------------------------------------------------

    // BUG: The code uses currentCellIndex to index into resolvedNotebook.cells
    // But resolvedNotebook was cloned from incoming, so cells are at incomingCellIndex!
    
    // What happens with the bug:
    // - conflict[0].currentCellIndex = 0, should affect incoming cell 1
    //   Bug: modifies resolvedNotebook.cells[0] (wrong cell!)
    // - conflict[1].currentCellIndex = 1, should affect incoming cell 2
    //   Bug: modifies resolvedNotebook.cells[1] (wrong cell!)

    // With the bug, cells at indices 0 and 1 are incorrectly modified
    // Cell 0 should retain execution_count: 5 (it wasn't in the conflict)
    // Cell 1 should retain execution_count: 10 (it wasn't in the conflict)
    // But bug modifies them because it uses currentCellIndex instead of incomingCellIndex

    const cell0 = result.resolvedNotebook?.cells[0];
    const cell1 = result.resolvedNotebook?.cells[1];
    const cell2 = result.resolvedNotebook?.cells[2];

    console.log('[nullCurrentCellIndexing] Cell execution counts:', {
        cell0: cell0?.execution_count,
        cell1: cell1?.execution_count,
        cell2: cell2?.execution_count,
    });

    // Expected behavior (AFTER FIX):
    // - Cell 0 should be untouched: execution_count = 5
    // - Cell 1 should be nullified (conflict.incomingCellIndex = 1): execution_count = null
    // - Cell 2 should be nullified (conflict.incomingCellIndex = 2): execution_count = null

    // Actual behavior (WITH BUG):
    // - Cell 0 is wrongly nullified (conflict[0].currentCellIndex = 0): execution_count = null
    // - Cell 1 is wrongly nullified (conflict[1].currentCellIndex = 1): execution_count = null
    // - Cell 2 is untouched: execution_count = 15

    // Test for the bug (this will currently fail until the bug is fixed)
    try {
        // After the fix, cell 0 should not be modified
        assert.strictEqual(
            cell0?.execution_count,
            5,
            'Cell 0 should not be modified (was not in conflict)'
        );
        
        // After the fix, cells 1 and 2 should be nullified
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

        console.log('[nullCurrentCellIndexing] ✓ Test passed - bug is FIXED!');
    } catch (error: any) {
        // Document the current buggy behavior
        console.log('[nullCurrentCellIndexing] ✗ Test failed - bug is PRESENT (expected)');
        console.log('[nullCurrentCellIndexing] Error:', error.message);
        console.log('[nullCurrentCellIndexing] Current (buggy) behavior:');
        console.log('  - Cell 0 execution_count:', cell0?.execution_count, '(should be 5, but bug sets to null)');
        console.log('  - Cell 1 execution_count:', cell1?.execution_count, '(should be null, but bug sets to null)');
        console.log('  - Cell 2 execution_count:', cell2?.execution_count, '(should be null, but bug leaves as 15)');
        
        // Currently, the bug causes:
        // - cell0.execution_count = null (WRONG, should be 5)
        // - cell1.execution_count = null (CORRECT by accident)
        // - cell2.execution_count = 15 (WRONG, should be null)
        
        // Verify the buggy behavior
        assert.strictEqual(
            cell0?.execution_count,
            null,
            'BUG DETECTED: Cell 0 wrongly nullified because currentCellIndex=0 was used instead of incomingCellIndex'
        );
        assert.strictEqual(
            cell2?.execution_count,
            15,
            'BUG DETECTED: Cell 2 not nullified because currentCellIndex=1 was used instead of incomingCellIndex=2'
        );
        
        console.log('[nullCurrentCellIndexing] Bug confirmed: Using currentCellIndex on incoming-cloned notebook');
        throw new Error(
            'Bug detected: resolvedNotebook uses currentCellIndex to index cells cloned from incoming. ' +
            'Should use incomingCellIndex when semanticConflict.current is null.'
        );
    }
}
