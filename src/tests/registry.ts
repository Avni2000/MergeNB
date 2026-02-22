/**
 * @file registry.ts
 * @description Test registry with grouped runnable definitions.
 *
 * Entries are organized into groups (e.g. "Per-Cell Resolution", "Take All Buttons")
 * for easy selection via CLI flags or the interactive TUI picker.
 *
 * To add a new automated test:
 *   1. Create the test module (export async function run(): Promise<void>)
 *   2. Add a TestDef entry under the appropriate group (or create a new group)
 *   3. Set `testModule`
 *
 * To add a new manual sandbox:
 *   1. Add a TestDef entry with `kind: 'manual'`
 *   2. Provide the notebook triplet to seed the temporary conflict repo
 *   3. That's it — the runner picks it up automatically.
 */

/** Shared fields for every runnable entry. */
interface TestBase {
    /** Unique identifier (used on CLI: --test <id>) */
    id: string;
    /** Short human-readable description shown in the picker */
    description: string;
    /** Notebook triplet: [base, current, incoming] relative to test/ */
    notebooks: [string, string, string];
    /** If false, `--all` will skip this entry. */
    includeInAll?: boolean;
}

/** A VS Code integration test case. */
export interface AutomatedTestDef extends TestBase {
    /** Defaults to automated when omitted. */
    kind?: 'automated';
    /** Compiled test module path relative to out/tests/ */
    testModule: string;
    /** Optional params forwarded to the test via the config file */
    params?: Record<string, unknown>;
}

/** A manual sandbox launcher (creates conflict repo + opens VS Code). */
export interface ManualSandboxDef extends TestBase {
    kind: 'manual';
}

/** A runnable entry from the test registry. */
export type TestDef = AutomatedTestDef | ManualSandboxDef;

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
                id: 'takeAll_current_single_conflict',
                description: 'Take All Current (single-conflict notebook)',
                notebooks: ['06_base.ipynb', '06_current.ipynb', '06_incoming.ipynb'],
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
            {
                id: 'regression_status_indicators',
                description: 'Status bar + file decoration update on startup/conflict/add',
                notebooks: ['02_base.ipynb', '02_current.ipynb', '02_incoming.ipynb'],
                testModule: './statusIndicatorsRegression.test.js',
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
    {
        id: 'manual',
        name: 'Manual Sandbox',
        description: 'Open throwaway merge sandbox repos for exploratory notebook resolution',
        tests: [
            {
                id: 'manual_02',
                description: 'Manual sandbox with 02 fixtures',
                notebooks: ['02_base.ipynb', '02_current.ipynb', '02_incoming.ipynb'],
                kind: 'manual',
                includeInAll: false,
            },
            {
                id: 'manual_03',
                description: 'Manual sandbox with 03 fixtures',
                notebooks: ['03_base.ipynb', '03_current.ipynb', '03_incoming.ipynb'],
                kind: 'manual',
                includeInAll: false,
            },
            {
                id: 'manual_04',
                description: 'Manual sandbox with 04 fixtures',
                notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
                kind: 'manual',
                includeInAll: false,
            },
        ],
    },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Flatten all tests from all groups into a single list. */
export function allTests(): TestDef[] {
    return TEST_GROUPS.flatMap(g => g.tests);
}

/** Tests that should be included by the `--all` flag. */
export function testsForAll(): TestDef[] {
    return allTests().filter(t => t.includeInAll !== false);
}

/** Type guard for manual sandbox entries. */
export function isManualTest(test: TestDef): test is ManualSandboxDef {
    return test.kind === 'manual';
}

/** Type guard for automated integration test entries. */
export function isAutomatedTest(test: TestDef): test is AutomatedTestDef {
    return !isManualTest(test);
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
