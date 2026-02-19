/**
 * @file registry.ts
 * @description Test registry with grouped test definitions.
 *
 * Tests are organized into groups (e.g. "Per-Cell Resolution", "Take All Buttons")
 * for easy selection via CLI flags or the interactive TUI picker.
 *
 * To add a new test:
 *   1. Create the test module (export async function run(): Promise<void>)
 *   2. Add a TestDef entry under the appropriate group (or create a new group)
 *   3. That's it — the runner picks it up automatically.
 */

/** A single integration test case. */
export interface TestDef {
    /** Unique identifier (used on CLI: --test <id>) */
    id: string;
    /** Short human-readable description shown in the picker */
    description: string;
    /** Notebook triplet: [base, current, incoming] relative to test/ */
    notebooks: [string, string, string];
    /** Compiled test module path relative to out/tests/ */
    testModule: string;
    /** Optional params forwarded to the test via the config file */
    params?: Record<string, unknown>;
}

/** A logical group of related tests. */
export interface TestGroup {
    /** Unique group identifier (used on CLI: --group <id>) */
    id: string;
    /** Display name for the picker */
    name: string;
    /** One-line description */
    description: string;
    /** Tests belonging to this group */
    tests: TestDef[];
}

// ─── Test Groups ────────────────────────────────────────────────────────────

export const TEST_GROUPS: TestGroup[] = [
    {
        id: 'perCell',
        name: 'Per-Cell Resolution',
        description: 'Cell-by-cell conflict resolution with alternating choices',
        tests: [
            {
                id: 'perCell_02',
                description: 'Check we correctly write to disk from text areas',
                notebooks: ['02_base.ipynb', '02_current.ipynb', '02_incoming.ipynb'],
                testModule: './io.test.js',
            },
        ],
    },
    {
        id: 'undoRedo',
        name: 'Undo / Redo',
        description: 'Undo/redo across branch selection, delete, edit, checkboxes, move, reorder',
        tests: [
            {
                id: 'undoRedo_02',
                description: 'Undo/redo actions (02 notebooks)',
                notebooks: ['02_base.ipynb', '02_current.ipynb', '02_incoming.ipynb'],
                testModule: './undoRedoActions.test.js',
            },
        ],
    },
    {
        id: 'takeAll',
        name: 'Take All Buttons',
        description: 'Bulk "Take All Base / Current / Incoming" resolution',
        tests: [
            {
                id: 'takeAll_base',
                description: 'Take All Base',
                notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
                testModule: './takeAllButtons.test.js',
                params: { action: 'base' },
            },
            {
                id: 'takeAll_current',
                description: 'Take All Current',
                notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
                testModule: './takeAllButtons.test.js',
                params: { action: 'current' },
            },
            {
                id: 'takeAll_incoming',
                description: 'Take All Incoming',
                notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
                testModule: './takeAllButtons.test.js',
                params: { action: 'incoming' },
            },
            {
                id: 'takeAll_current_undoRedo',
                description: 'Take All Current + undo/redo',
                notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
                testModule: './takeAllButtons.test.js',
                params: { action: 'current', undoRedo: true },
            },
            {
                id: 'takeAll_unresolved_current',
                description: 'Take All Current (Checks manual choices are respected)',
                notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
                testModule: './takeAllButtons.test.js',
                params: { action: 'current', mode: 'unresolved', manualChoice: 'incoming', manualCount: 2 },
            },
        ],
    },
    {
        id: 'regression',
        name: 'Regression',
        description: 'Regression tests for previously fixed merge behavior',
        tests: [
            {
                id: 'regression_incoming_nonconflict',
                description: 'Preserve incoming-only content for non-conflict rows',
                notebooks: ['demo_base.ipynb', 'demo_current.ipynb', 'demo_incoming.ipynb'],
                testModule: './incomingNonConflictRegression.test.js',
            },
            {
                id: 'regression_logic_metadata_renumber',
                description: 'Non-conflict metadata + renumber execution_count correctness',
                notebooks: ['demo_base.ipynb', 'demo_current.ipynb', 'demo_incoming.ipynb'],
                testModule: './logicRegression.test.js',
            },
            {
                id: 'regression_null_current_cell_indexing',
                description: 'Cell indexing when current is null (delete/modify conflict)',
                notebooks: ['demo_base.ipynb', 'demo_current.ipynb', 'demo_incoming.ipynb'],
                testModule: './nullCurrentCellIndexing.test.js',
            },
            {
                id: 'regression_settings',
                description: 'Each MergeNBSettings field is propagated and respected',
                notebooks: ['demo_base.ipynb', 'demo_current.ipynb', 'demo_incoming.ipynb'],
                testModule: './settingsRegression.test.js',
            },
        ],
    },
    {
        id: 'renderMime',
        name: 'RenderMime Outputs',
        description: 'Validate JupyterLab rendermime output rendering in web UI',
        tests: [
            {
                id: 'rendermime_markdown_logo_02',
                description: 'Render markdown local SVG assets (logo.svg) in fixture 02',
                notebooks: ['02_base.ipynb', '02_current.ipynb', '02_incoming.ipynb'],
                testModule: './rendermimeOutputs.test.js',
                params: { mode: 'markdownOnly' },
            },
            {
                id: 'rendermime_outputs_05',
                description: 'Render text/html/png/svg/json outputs and unsupported fallback',
                notebooks: ['05_mime_base.ipynb', '05_mime_current.ipynb', '05_mime_incoming.ipynb'],
                testModule: './rendermimeOutputs.test.js',
            },
        ],
    },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Flatten all tests from all groups into a single list. */
export function allTests(): TestDef[] {
    return TEST_GROUPS.flatMap(g => g.tests);
}

/** Look up a single test by its id (across all groups). */
export function findTest(id: string): TestDef | undefined {
    return allTests().find(t => t.id === id);
}

/** Look up a group by its id. */
export function findGroup(id: string): TestGroup | undefined {
    return TEST_GROUPS.find(g => g.id === id);
}

/** Resolve a list of test ids and/or group ids to a flat TestDef list. */
export function resolveTests(ids: string[]): TestDef[] {
    const result: TestDef[] = [];
    const seen = new Set<string>();

    for (const id of ids) {
        const group = findGroup(id);
        if (group) {
            for (const t of group.tests) {
                if (!seen.has(t.id)) {
                    result.push(t);
                    seen.add(t.id);
                }
            }
            continue;
        }
        const test = findTest(id);
        if (test && !seen.has(test.id)) {
            result.push(test);
            seen.add(test.id);
        }
    }

    return result;
}
