/**
 * @file logicRegression.test.ts
 * @description Lightweight regression checks for merge logic.
 *
 * These run inside the VS Code extension test host but do not require UI/browser.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as conflictDetector from '../../../packages/core/src';
import * as gitIntegration from '../gitIntegration';
import {
    normalizeCellSource,
    selectNonConflictMergedCell,
    renumberExecutionCounts,
    analyzeSemanticConflictsFromMappings,
    detectReordering,
    type NotebookCell,
    type Notebook,
    type NotebookSemanticConflict,
    type CellMapping,
} from '../../../packages/core/src';
import { NotebookConflictResolver, onDidResolveConflictWithDetails, setResolverPromptTestHooks } from '../resolver';
import { createResolverStore } from '../../../packages/web/client/src/store/resolverStore';
import { buildMergeRowsFromSemantic } from '../../../packages/web/client/src/utils/mergeRowBuilder';
import { computeReorderedRowIndexSet } from '../../../packages/web/client/src/utils/reorderUtils';
import { WebConflictPanel } from '../web/WebConflictPanel';

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
            currentCell: addedCurrent,
            incomingCell: addedIncoming,
        },
    ];

    const conflicts = analyzeSemanticConflictsFromMappings(mappings);
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
            baseCell: inputBase,
            currentCell: inputCurrent,
            incomingCell: inputIncoming,
        },
    ];

    const inputConflicts = analyzeSemanticConflictsFromMappings(inputMappings);
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
            baseCell: multiBase,
            currentCell: multiCurrent,
            incomingCell: multiIncoming,
        },
    ];

    const multiConflicts = analyzeSemanticConflictsFromMappings(multiMappings);

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
    // Regression: pure reorder conflicts must surface as resolvable rows.
    //
    // A global `cell-reordered` conflict has no per-row indices, so the UI
    // builder must synthesize row conflicts for the reordered triplets.
    // Otherwise the resolver opens with 0/0 conflicts and silently preserves
    // base-order rows.
    // ---------------------------------------------------------------------
    const makeMarkdownCell = (source: string): NotebookCell => ({
        cell_type: 'markdown',
        source,
        metadata: {},
    });
    const reorderBase: Notebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
            makeMarkdownCell('intro'),
            makeMarkdownCell('alpha'),
            makeMarkdownCell('beta'),
            makeMarkdownCell('gamma'),
        ],
    };
    const reorderCurrent: Notebook = {
        ...reorderBase,
        cells: [
            makeMarkdownCell('intro'),
            makeMarkdownCell('beta'),
            makeMarkdownCell('alpha'),
            makeMarkdownCell('gamma'),
        ],
    };
    const reorderIncoming: Notebook = {
        ...reorderBase,
        cells: [
            makeMarkdownCell('intro'),
            makeMarkdownCell('alpha'),
            makeMarkdownCell('gamma'),
            makeMarkdownCell('beta'),
        ],
    };
    const reorderOnlyConflict: NotebookSemanticConflict = {
        filePath: 'reorder-only.ipynb',
        semanticConflicts: [
            {
                type: 'cell-reordered',
            },
        ],
        cellMappings: [
            {
                baseIndex: 0,
                currentIndex: 0,
                incomingIndex: 0,
                baseCell: reorderBase.cells[0],
                currentCell: reorderCurrent.cells[0],
                incomingCell: reorderIncoming.cells[0],
            },
            {
                baseIndex: 1,
                currentIndex: 2,
                incomingIndex: 1,
                baseCell: reorderBase.cells[1],
                currentCell: reorderCurrent.cells[2],
                incomingCell: reorderIncoming.cells[1],
            },
            {
                baseIndex: 2,
                currentIndex: 1,
                incomingIndex: 3,
                baseCell: reorderBase.cells[2],
                currentCell: reorderCurrent.cells[1],
                incomingCell: reorderIncoming.cells[3],
            },
            {
                baseIndex: 3,
                currentIndex: 3,
                incomingIndex: 2,
                baseCell: reorderBase.cells[3],
                currentCell: reorderCurrent.cells[3],
                incomingCell: reorderIncoming.cells[2],
            },
        ],
        base: reorderBase,
        current: reorderCurrent,
        incoming: reorderIncoming,
    };

    const reorderRows = buildMergeRowsFromSemantic(reorderOnlyConflict);
    const synthesizedReorderConflicts = reorderRows.filter(row => row.conflictType === 'cell-reordered');
    assert.deepStrictEqual(
        reorderRows.map(row => normalizeCellSource((row.baseCell ?? row.currentCell ?? row.incomingCell)!.source)),
        ['intro', 'alpha', 'beta', 'gamma'],
        'Expected reorder rows to remain anchored to the base row order'
    );
    assert.strictEqual(
        synthesizedReorderConflicts.length,
        3,
        'Expected exactly Alpha, Beta, and Gamma rows to be promoted into synthetic reorder conflicts'
    );
    assert.ok(
        synthesizedReorderConflicts.every(row => row.type === 'conflict' && row.conflictIndex !== undefined),
        'Expected synthetic reorder conflicts to have conflict indices'
    );
    assert.deepStrictEqual(
        reorderRows.map(row => !!row.isReordered),
        [false, true, true, true],
        'Expected intro to remain non-reordered while Alpha, Beta, and Gamma retain reorder state'
    );
    assert.deepStrictEqual(
        [...computeReorderedRowIndexSet(reorderRows)],
        [1, 2, 3],
        'Expected only Alpha, Beta, and Gamma row indices to be detected as reordered'
    );

    // ---------------------------------------------------------------------
    // Regression: matching reorder on both branches is not a conflict.
    //
    // If current and incoming agree on the new relative order, we should
    // preserve that order automatically instead of surfacing a manual
    // reorder conflict just because both differ from base.
    // ---------------------------------------------------------------------
    const sameReorderBaseA = makeMarkdownCell('same-reorder-a');
    const sameReorderBaseB = makeMarkdownCell('same-reorder-b');
    const sameReorderMappings: CellMapping[] = [
        {
            baseIndex: 0,
            currentIndex: 1,
            incomingIndex: 1,
            baseCell: sameReorderBaseA,
            currentCell: sameReorderBaseA,
            incomingCell: sameReorderBaseA,
        },
        {
            baseIndex: 1,
            currentIndex: 0,
            incomingIndex: 0,
            baseCell: sameReorderBaseB,
            currentCell: sameReorderBaseB,
            incomingCell: sameReorderBaseB,
        },
    ];
    const sameReorderConflicts = analyzeSemanticConflictsFromMappings(sameReorderMappings);
    assert.ok(
        !sameReorderConflicts.some(c => c.type === 'cell-reordered'),
        'Expected no reorder conflict when current and incoming agree on the reordered order'
    );
    assert.strictEqual(
        computeReorderedRowIndexSet([
            {
                type: 'identical' as const,
                baseCellIndex: 0,
                currentCellIndex: 1,
                incomingCellIndex: 1,
            },
            {
                type: 'identical' as const,
                baseCellIndex: 1,
                currentCellIndex: 0,
                incomingCellIndex: 0,
            },
        ]).size,
        0,
        'Expected no reorder rows when current and incoming preserve the same relative order'
    );

    // ---------------------------------------------------------------------
    // Regression: pure index drift from insert/delete offsets must NOT be
    // treated as reorder when relative order is preserved.
    // ---------------------------------------------------------------------
    const offsetOnlyRows = [
        {
            type: 'identical' as const,
            baseCellIndex: 0,
            currentCellIndex: 1,
            incomingCellIndex: 0,
        },
        {
            type: 'identical' as const,
            baseCellIndex: 1,
            currentCellIndex: 2,
            incomingCellIndex: 1,
        },
        {
            type: 'identical' as const,
            baseCellIndex: 2,
            currentCellIndex: 3,
            incomingCellIndex: 2,
        },
    ];
    assert.strictEqual(
        computeReorderedRowIndexSet(offsetOnlyRows).size,
        0,
        'Expected index drift with preserved relative order to not be flagged as reorder'
    );

    // ---------------------------------------------------------------------
    // Regression: unmatch/rematch must preserve global row ordering.
    //
    // When a reordered row is split, one branch-side can move ahead of the
    // original row position. The reducer must re-sort the entire row list,
    // not just insert split rows in-place, or the saved notebook order is wrong.
    // ---------------------------------------------------------------------
    const storeRows = [
        {
            type: 'identical' as const,
            baseCell: makeMarkdownCell('row-0'),
            currentCell: makeMarkdownCell('row-0'),
            incomingCell: makeMarkdownCell('row-0'),
            baseCellIndex: 0,
            currentCellIndex: 1,
            incomingCellIndex: 0,
            anchorPosition: 0,
        },
        {
            type: 'identical' as const,
            baseCell: makeMarkdownCell('row-1'),
            currentCell: makeMarkdownCell('row-1'),
            incomingCell: makeMarkdownCell('row-1'),
            baseCellIndex: 1,
            currentCellIndex: 2,
            incomingCellIndex: 1,
            anchorPosition: 1,
        },
        {
            type: 'conflict' as const,
            baseCell: makeMarkdownCell('target-base'),
            currentCell: makeMarkdownCell('target-current'),
            incomingCell: makeMarkdownCell('target-incoming'),
            baseCellIndex: 2,
            currentCellIndex: 0,
            incomingCellIndex: 2,
            conflictIndex: 0,
            conflictType: 'cell-reordered',
            anchorPosition: 2,
            isReordered: true,
        },
        {
            type: 'identical' as const,
            baseCell: makeMarkdownCell('row-3'),
            currentCell: makeMarkdownCell('row-3'),
            incomingCell: makeMarkdownCell('row-3'),
            baseCellIndex: 3,
            currentCellIndex: 3,
            incomingCellIndex: 3,
            anchorPosition: 3,
        },
    ];
    const reorderStore = createResolverStore(storeRows);
    reorderStore.getState().unmatchRow(2);

    const afterUnmatch = reorderStore.getState().rows;
    assert.strictEqual(
        afterUnmatch[0].currentCell?.source,
        'target-current',
        'Expected the current-side split row to move to the top after global re-sort'
    );
    assert.ok(
        afterUnmatch[0].isUserUnmatched,
        'Expected reordered split row to remain marked as user-unmatched after re-sort'
    );

    const targetGroupId = afterUnmatch[0].unmatchGroupId;
    assert.ok(targetGroupId, 'Expected split rows to share an unmatch group id');

    reorderStore.getState().rematchRows(targetGroupId!);

    const afterRematch = reorderStore.getState().rows;
    assert.strictEqual(afterRematch.length, storeRows.length, 'Expected rematch to restore the original row count');
    assert.strictEqual(
        afterRematch[2].currentCell?.source,
        'target-current',
        'Expected rematch to restore the original conflict row at its sorted position'
    );

    // ---------------------------------------------------------------------
    // Regression: splitting one reordered row must not make the remaining
    // reordered rows lose their unmatch eligibility.
    // ---------------------------------------------------------------------
    const multiUnmatchRows = [
        {
            type: 'conflict' as const,
            baseCell: makeMarkdownCell('swap-a'),
            currentCell: makeMarkdownCell('swap-a'),
            incomingCell: makeMarkdownCell('swap-a'),
            baseCellIndex: 0,
            currentCellIndex: 1,
            incomingCellIndex: 0,
            conflictIndex: 0,
            conflictType: 'cell-reordered',
            anchorPosition: 0,
            isReordered: true,
        },
        {
            type: 'conflict' as const,
            baseCell: makeMarkdownCell('swap-b'),
            currentCell: makeMarkdownCell('swap-b'),
            incomingCell: makeMarkdownCell('swap-b'),
            baseCellIndex: 1,
            currentCellIndex: 0,
            incomingCellIndex: 1,
            conflictIndex: 1,
            conflictType: 'cell-reordered',
            anchorPosition: 1,
            isReordered: true,
        },
    ];
    const multiUnmatchStore = createResolverStore(multiUnmatchRows);
    multiUnmatchStore.getState().unmatchRow(0);

    const rowsAfterFirstSplit = multiUnmatchStore.getState().rows;
    const remainingConflictIndex = rowsAfterFirstSplit.findIndex(row => row.currentCell?.source === 'swap-b');
    assert.notStrictEqual(
        remainingConflictIndex,
        -1,
        'Expected the second reordered row to still exist after splitting the first'
    );

    multiUnmatchStore.getState().unmatchRow(remainingConflictIndex);
    const rowsAfterSecondSplit = multiUnmatchStore.getState().rows;
    assert.strictEqual(
        rowsAfterSecondSplit.length,
        4,
        'Expected a second reordered row to remain unmatchable after the first split'
    );
    assert.strictEqual(
        new Set(rowsAfterSecondSplit.map(row => row.unmatchGroupId).filter((value): value is string => !!value)).size,
        2,
        'Expected each reordered row split to keep its own rematch group'
    );
    assert.strictEqual(
        rowsAfterSecondSplit.filter(row => row.currentCell?.source === 'swap-b' || row.incomingCell?.source === 'swap-b').length,
        2,
        'Expected the second reordered row to split into current/incoming rows'
    );

    // ---------------------------------------------------------------------
    // Regression: when current and incoming already agree semantically (for
    // example, they made the same reorder), resolveSemanticConflicts must
    // still auto-apply the merged notebook instead of bailing out early.
    // ---------------------------------------------------------------------
    const sharedReorderBase: Notebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
            makeMarkdownCell('shared-order-a'),
            makeMarkdownCell('shared-order-b'),
        ],
    };
    const sharedReorderCurrent: Notebook = {
        ...sharedReorderBase,
        cells: [
            makeMarkdownCell('shared-order-b'),
            makeMarkdownCell('shared-order-a'),
        ],
    };
    const sharedReorderIncoming: Notebook = {
        ...sharedReorderBase,
        cells: [
            makeMarkdownCell('shared-order-b'),
            makeMarkdownCell('shared-order-a'),
        ],
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergenb-shared-reorder-'));
    const conflictPath = path.join(tempDir, 'conflict.ipynb');
    // Normalize through vscode.Uri so the drive letter casing matches on Windows
    // (os.tmpdir() may return "C:\..." but vscode.Uri.file().fsPath returns "c:\...")
    const normalizedConflictPath = vscode.Uri.file(conflictPath).fsPath;
    fs.writeFileSync(conflictPath, JSON.stringify(sharedReorderBase, null, 2));

    const originalGetThreeWayVersions = gitIntegration.getThreeWayVersions;
    const originalGetCurrentBranch = gitIntegration.getCurrentBranch;
    const originalGetMergeBranch = gitIntegration.getMergeBranch;
    const originalCreateOrShow = WebConflictPanel.createOrShow;
    let openedWebPanel = false;

    try {
        (gitIntegration as any).getThreeWayVersions = async (filePath: string) => {
            if (filePath !== normalizedConflictPath) {
                return null;
            }

            return {
                base: JSON.stringify(sharedReorderBase),
                current: JSON.stringify(sharedReorderCurrent),
                incoming: JSON.stringify(sharedReorderIncoming),
            };
        };
        (gitIntegration as any).getCurrentBranch = async () => 'current';
        (gitIntegration as any).getMergeBranch = async () => 'incoming';
        (WebConflictPanel as any).createOrShow = async () => {
            openedWebPanel = true;
        };
        setResolverPromptTestHooks({
            pickRenumberExecutionCounts: () => false,
        });

        const detectedSharedReorder = await conflictDetector.detectSemanticConflicts(normalizedConflictPath, {
            getThreeWayVersions: gitIntegration.getThreeWayVersions,
            getCurrentBranch: gitIntegration.getCurrentBranch,
            getMergeBranch: gitIntegration.getMergeBranch,
        });
        assert.ok(detectedSharedReorder, 'Expected real detector to return a semantic conflict payload');
        assert.strictEqual(
            detectedSharedReorder!.semanticConflicts.length,
            0,
            'Expected real detector to suppress manual conflicts when current and incoming already agree on the reorder'
        );
        assert.deepStrictEqual(
            detectedSharedReorder!.cellMappings.map(mapping => [
                mapping.baseIndex,
                mapping.currentIndex,
                mapping.incomingIndex,
            ]),
            [
                [0, 1, 1],
                [1, 0, 0],
            ],
            'Expected real detector to preserve the shared reordered mapping through detectSemanticConflicts'
        );

        const resolver = new NotebookConflictResolver(vscode.Uri.file(tempDir));
        const resolutionPromise = new Promise<import('../resolver').ResolvedConflictDetails>((resolve, reject) => {
            const timeout = setTimeout(() => {
                subscription.dispose();
                reject(new Error('Timed out waiting for shared-reorder auto-apply resolution event'));
            }, 5000);
            const subscription = onDidResolveConflictWithDetails.event((details) => {
                if (details.uri.fsPath !== normalizedConflictPath) return;
                clearTimeout(timeout);
                subscription.dispose();
                resolve(details);
            });
        });

        await resolver.resolveSemanticConflicts(vscode.Uri.file(conflictPath));
        const resolvedDetails = await resolutionPromise;

        assert.strictEqual(openedWebPanel, false, 'Expected shared reorder to auto-apply without opening the web resolver');
        assert.ok(resolvedDetails.resolvedNotebook, 'Expected shared reorder path to emit a resolved notebook');

        const expectedSources = sharedReorderCurrent.cells.map(cell => normalizeCellSource(cell.source));
        const emittedSources = resolvedDetails.resolvedNotebook!.cells.map((cell: NotebookCell) => normalizeCellSource(cell.source));
        assert.deepStrictEqual(
            emittedSources,
            expectedSources,
            'Expected shared reorder auto-apply to preserve the agreed current/incoming order'
        );

        const writtenNotebook = JSON.parse(fs.readFileSync(conflictPath, 'utf8')) as Notebook;
        const writtenSources = writtenNotebook.cells.map(cell => normalizeCellSource(cell.source));
        assert.deepStrictEqual(
            writtenSources,
            expectedSources,
            'Expected shared reorder auto-apply to write the agreed current/incoming order to disk'
        );
    } finally {
        (gitIntegration as any).getThreeWayVersions = originalGetThreeWayVersions;
        (gitIntegration as any).getCurrentBranch = originalGetCurrentBranch;
        (gitIntegration as any).getMergeBranch = originalGetMergeBranch;
        (WebConflictPanel as any).createOrShow = originalCreateOrShow;
        setResolverPromptTestHooks(undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // ---------------------------------------------------------------------
    // Bug fix: unmatchRow must require both currentCell and incomingCell.
    //
    // A row with only base + current (no incoming) should not be unmatchable,
    // even if isReordered is true. The store guard must reject it silently.
    // ---------------------------------------------------------------------
    const twoSideOnlyRows = [
        {
            type: 'conflict' as const,
            baseCell: makeMarkdownCell('base-only-pair'),
            currentCell: makeMarkdownCell('current-only-pair'),
            incomingCell: undefined,
            baseCellIndex: 0,
            currentCellIndex: 0,
            incomingCellIndex: undefined,
            conflictIndex: 0,
            conflictType: 'cell-reordered' as const,
            anchorPosition: 0,
            isReordered: true,
        },
    ];
    const twoSideStore = createResolverStore(twoSideOnlyRows);
    twoSideStore.getState().unmatchRow(0);
    assert.strictEqual(
        twoSideStore.getState().rows.length,
        1,
        'Expected unmatchRow to be a no-op when incomingCell is missing (base+current only)'
    );
    assert.strictEqual(
        twoSideStore.getState().rows[0].isUserUnmatched,
        undefined,
        'Expected row to remain unchanged after rejected unmatch'
    );

    // Same check with base + incoming (no current)
    const baseIncomingOnlyRows = [
        {
            type: 'conflict' as const,
            baseCell: makeMarkdownCell('base-only-pair-2'),
            currentCell: undefined,
            incomingCell: makeMarkdownCell('incoming-only-pair'),
            baseCellIndex: 0,
            currentCellIndex: undefined,
            incomingCellIndex: 0,
            conflictIndex: 0,
            conflictType: 'cell-reordered' as const,
            anchorPosition: 0,
            isReordered: true,
        },
    ];
    const baseIncomingStore = createResolverStore(baseIncomingOnlyRows);
    baseIncomingStore.getState().unmatchRow(0);
    assert.strictEqual(
        baseIncomingStore.getState().rows.length,
        1,
        'Expected unmatchRow to be a no-op when currentCell is missing (base+incoming only)'
    );

    // ---------------------------------------------------------------------
    // Bug fix: buildMergeRowsFromSemantic must derive reorder from
    // cellMappings (via detectReordering), not from semanticConflicts.
    //
    // If semanticConflicts is empty but cellMappings show a reorder,
    // isReordered flags must still be set on the affected rows.
    // ---------------------------------------------------------------------
    const reorderNoSemanticBase: Notebook = {
        nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
            makeMarkdownCell('rns-a'),
            makeMarkdownCell('rns-b'),
        ],
    };
    const reorderNoSemanticCurrent: Notebook = {
        nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
            makeMarkdownCell('rns-b'),
            makeMarkdownCell('rns-a'),
        ],
    };
    const reorderNoSemanticIncoming: Notebook = {
        nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
            makeMarkdownCell('rns-a'),
            makeMarkdownCell('rns-b'),
        ],
    };
    const reorderNoSemanticConflict: NotebookSemanticConflict = {
        filePath: 'rns.ipynb',
        semanticConflicts: [],  // empty — e.g. auto-resolved
        cellMappings: [
            {
                baseIndex: 0, currentIndex: 1, incomingIndex: 0,
                baseCell: reorderNoSemanticBase.cells[0],
                currentCell: reorderNoSemanticCurrent.cells[1],
                incomingCell: reorderNoSemanticIncoming.cells[0],
            },
            {
                baseIndex: 1, currentIndex: 0, incomingIndex: 1,
                baseCell: reorderNoSemanticBase.cells[1],
                currentCell: reorderNoSemanticCurrent.cells[0],
                incomingCell: reorderNoSemanticIncoming.cells[1],
            },
        ],
        base: reorderNoSemanticBase,
        current: reorderNoSemanticCurrent,
        incoming: reorderNoSemanticIncoming,
    };
    const reorderNoSemanticRows = buildMergeRowsFromSemantic(reorderNoSemanticConflict);
    assert.ok(
        reorderNoSemanticRows.some(row => row.isReordered),
        'Expected isReordered flags even when semanticConflicts is empty but cellMappings show a reorder'
    );

    // ---------------------------------------------------------------------
    // Agreement: detectReordering(cellMappings) and computeReorderedRowIndexSet
    // must agree on whether a reorder is present.
    //
    // detectReordering runs on CellMapping[] before rows are built.
    // computeReorderedRowIndexSet runs on MergeRow[] after sorting.
    // Both use the same consecutive-pair inversion algorithm on the same
    // anchor ordering, so they must always agree.
    // ---------------------------------------------------------------------
    const agreementCases: Array<{
        label: string;
        mappings: CellMapping[];
        expectsReorder: boolean;
    }> = [
        {
            label: 'straightforward reorder (current swaps A↔B, incoming keeps base order)',
            mappings: [
                { baseIndex: 0, currentIndex: 1, incomingIndex: 0,
                  baseCell: makeMarkdownCell('agr-a'), currentCell: makeMarkdownCell('agr-a'), incomingCell: makeMarkdownCell('agr-a') },
                { baseIndex: 1, currentIndex: 0, incomingIndex: 1,
                  baseCell: makeMarkdownCell('agr-b'), currentCell: makeMarkdownCell('agr-b'), incomingCell: makeMarkdownCell('agr-b') },
            ],
            expectsReorder: true,
        },
        {
            label: 'shared reorder (both branches swap A↔B identically)',
            mappings: [
                { baseIndex: 0, currentIndex: 1, incomingIndex: 1,
                  baseCell: makeMarkdownCell('agr-a'), currentCell: makeMarkdownCell('agr-a'), incomingCell: makeMarkdownCell('agr-a') },
                { baseIndex: 1, currentIndex: 0, incomingIndex: 0,
                  baseCell: makeMarkdownCell('agr-b'), currentCell: makeMarkdownCell('agr-b'), incomingCell: makeMarkdownCell('agr-b') },
            ],
            expectsReorder: false,
        },
        {
            label: 'pure index drift (no relative order change)',
            mappings: [
                { baseIndex: 0, currentIndex: 1, incomingIndex: 0,
                  baseCell: makeMarkdownCell('agr-a'), currentCell: makeMarkdownCell('agr-a'), incomingCell: makeMarkdownCell('agr-a') },
                { baseIndex: 1, currentIndex: 2, incomingIndex: 1,
                  baseCell: makeMarkdownCell('agr-b'), currentCell: makeMarkdownCell('agr-b'), incomingCell: makeMarkdownCell('agr-b') },
            ],
            expectsReorder: false,
        },
    ];

    for (const { label, mappings, expectsReorder } of agreementCases) {
        const detectorSays = detectReordering(mappings);

        const fakeBase: Notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: mappings.map(m => m.baseCell!) };
        const fakeCurrent: Notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: mappings.map(m => m.currentCell!) };
        const fakeIncoming: Notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: mappings.map(m => m.incomingCell!) };
        const fakeConflict: NotebookSemanticConflict = {
            filePath: 'agreement-test.ipynb',
            semanticConflicts: [],
            cellMappings: mappings,
            base: fakeBase,
            current: fakeCurrent,
            incoming: fakeIncoming,
        };
        const builtRows = buildMergeRowsFromSemantic(fakeConflict);
        const rowSays = computeReorderedRowIndexSet(builtRows).size > 0;

        assert.strictEqual(detectorSays, expectsReorder, `detectReordering mismatch for: ${label}`);
        assert.strictEqual(rowSays, expectsReorder, `computeReorderedRowIndexSet mismatch for: ${label}`);
        assert.strictEqual(
            detectorSays, rowSays,
            `detectReordering and computeReorderedRowIndexSet disagree for: ${label}`
        );
    }
}
