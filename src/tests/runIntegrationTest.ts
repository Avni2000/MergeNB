/**
 * @file runIntegrationTest.ts
 * @description Integration test runner with interactive TUI picker and CLI flags.
 *
 * Usage:
 *   node out/tests/runIntegrationTest.js                  # Interactive TUI picker
 *   node out/tests/runIntegrationTest.js --all             # Run every auto-included entry
 *   node out/tests/runIntegrationTest.js --group takeAll   # Run one group
 *   node out/tests/runIntegrationTest.js --group takeAll --group undoRedo
 *   node out/tests/runIntegrationTest.js --test takeAll_base
 *   node out/tests/runIntegrationTest.js --test manual_04
 *   node out/tests/runIntegrationTest.js --test takeAll_base --test perCell_02
 *   node out/tests/runIntegrationTest.js --list            # Print groups & tests
 *
 * npm scripts (see package.json):
 *   npm run test:integration              # Interactive picker
 *   npm run test:integration -- --all     # Run all
 *   npm run test:integration -- --list    # List available tests
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { runTests } from '@vscode/test-electron';
import pc from 'picocolors';
import {
    TEST_GROUPS,
    allTests,
    testsForAll,
    resolveTests,
    isAutomatedTest,
    isManualTest,
    type AutomatedTestDef,
    type ManualSandboxDef,
    type TestDef,
} from './registry';
import {
    createMergeConflictRepo,
    writeTestConfig,
    cleanup,
} from './repoSetup';

// @clack/prompts is ESM-only, so we load it lazily via dynamic import.
let _clack: any;
async function clack(): Promise<any> {
    if (!_clack) _clack = await import('@clack/prompts');
    return _clack;
}

// ─── CLI arg parsing ────────────────────────────────────────────────────────

interface CliArgs {
    all: boolean;
    list: boolean;
    groups: string[];
    tests: string[];
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { all: false, list: false, groups: [], tests: [] };
    let i = 2; // skip node + script
    while (i < argv.length) {
        const arg = argv[i];
        if (arg === '--all') {
            args.all = true;
        } else if (arg === '--list' || arg === '-l') {
            args.list = true;
        } else if (arg === '--group' || arg === '-g') {
            i++;
            if (i < argv.length) args.groups.push(argv[i]);
        } else if (arg === '--test' || arg === '-t') {
            i++;
            if (i < argv.length) args.tests.push(argv[i]);
        }
        i++;
    }
    return args;
}

// ─── List command ───────────────────────────────────────────────────────────

function printTestList(): void {
    const all = allTests();
    const automatedCount = all.filter(isAutomatedTest).length;
    const manualCount = all.length - automatedCount;

    console.log();
    console.log(pc.bold('Available integration entries'));
    console.log(pc.dim('─'.repeat(60)));

    for (const group of TEST_GROUPS) {
        console.log();
        console.log(
            `  ${pc.cyan(pc.bold(group.id))}  ${pc.dim('·')}  ${group.name}`,
        );
        console.log(`  ${pc.dim(group.description)}`);

        for (const test of group.tests) {
            const typeHint = isManualTest(test) ? 'manual' : 'automated';
            console.log(
                `    ${pc.yellow(test.id.padEnd(32))} ${pc.dim(`[${typeHint}] ${test.description}`)}`,
            );
        }
    }

    console.log();
    console.log(pc.dim('─'.repeat(60)));
    console.log(
        `  ${pc.dim('Total:')} ${all.length} entries in ${TEST_GROUPS.length} groups`,
    );
    console.log(
        `  ${pc.dim('Breakdown:')} ${automatedCount} automated, ${manualCount} manual`,
    );
    console.log();
}

// ─── TUI picker ─────────────────────────────────────────────────────────────

async function pickTestsInteractively(): Promise<TestDef[]> {
    const c = await clack();
    c.intro(pc.bgCyan(pc.black(' MergeNB Integration Tests ')));

    const mode = await c.select({
        message: 'What do you want to run?',
        options: [
            { value: 'all', label: 'Run all auto-included entries', hint: `${testsForAll().length} entries` },
            { value: 'group', label: 'Pick test group(s)' },
            { value: 'test', label: 'Pick individual test(s) / sandboxes' },
        ],
    });

    if (c.isCancel(mode)) {
        c.cancel('Cancelled.');
        process.exit(0);
    }

    if (mode === 'all') {
        return testsForAll();
    }

    if (mode === 'group') {
        const selectedGroups = await c.multiselect({
            message: 'Select group(s) to run',
            options: TEST_GROUPS.map(g => ({
                value: g.id,
                label: g.name,
                hint: `${g.tests.length} test${g.tests.length > 1 ? 's' : ''} — ${g.description}`,
            })),
            required: true,
        });

        if (c.isCancel(selectedGroups)) {
            c.cancel('Cancelled.');
            process.exit(0);
        }

        return resolveTests(selectedGroups as string[]);
    }

    // mode === 'test'
    // Show tests organized under group headers
    const options: Array<{ value: string; label: string; hint?: string }> = [];
    for (const group of TEST_GROUPS) {
        for (const test of group.tests) {
            options.push({
                value: test.id,
                label: test.description,
                hint: pc.dim(`${group.name} • ${isManualTest(test) ? 'manual' : 'automated'}`),
            });
        }
    }

    const selectedTests = await c.multiselect({
        message: 'Select entries to run',
        options,
        required: true,
    });

    if (c.isCancel(selectedTests)) {
        c.cancel('Cancelled.');
        process.exit(0);
    }

    return resolveTests(selectedTests as string[]);
}

// ─── Runner ─────────────────────────────────────────────────────────────────

interface RunResult {
    test: TestDef;
    passed: boolean;
    error?: Error;
    durationMs: number;
    workspacePath?: string;
}

function resolveNotebookTripletPaths(test: TestDef): [string, string, string] {
    const testDir = path.resolve(__dirname, '../../test');
    const [baseFile, currentFile, incomingFile] = test.notebooks.map(n =>
        path.join(testDir, n),
    ) as [string, string, string];

    for (const f of [baseFile, currentFile, incomingFile]) {
        if (!fs.existsSync(f)) {
            throw new Error(`Notebook not found: ${f}`);
        }
    }

    return [baseFile, currentFile, incomingFile];
}

function isCodeCliAvailable(): boolean {
    const result = spawnSync('code', ['--version'], { stdio: 'ignore' });
    return !result.error && result.status === 0;
}

async function runAutomatedTest(test: AutomatedTestDef): Promise<RunResult> {
    const start = Date.now();
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    let workspacePath: string | undefined;
    const testEnv: NodeJS.ProcessEnv = { ...process.env, MERGENB_TEST_MODE: 'true' };
    // Some environments set this globally, which makes the VS Code binary run
    // in Node mode and reject normal Electron/Code CLI flags.
    testEnv.ELECTRON_RUN_AS_NODE = undefined;
    const vscodeVersion = process.env.VSCODE_VERSION?.trim();
    process.env.MERGENB_TEST_MODE = 'true';

    try {
        const [baseFile, currentFile, incomingFile] = resolveNotebookTripletPaths(test);
        workspacePath = createMergeConflictRepo(baseFile, currentFile, incomingFile);
        const configPath = writeTestConfig(workspacePath, test.id, test.params);

        const extensionTestsPath = path.resolve(__dirname, test.testModule);

        try {
            await runTests({
                extensionDevelopmentPath,
                extensionTestsPath,
                extensionTestsEnv: testEnv,
                ...(vscodeVersion && vscodeVersion !== 'stable' ? { version: vscodeVersion } : {}),
                launchArgs: [
                    workspacePath,
                    '--disable-extensions',
                    '--skip-welcome',
                    '--skip-release-notes',
                ],
            });
        } finally {
            cleanup(configPath);
        }

        return { test, passed: true, durationMs: Date.now() - start };
    } catch (err) {
        return {
            test,
            passed: false,
            error: err instanceof Error ? err : new Error(String(err)),
            durationMs: Date.now() - start,
        };
    } finally {
        if (workspacePath) cleanup(workspacePath);
    }
}

async function runManualSandbox(test: ManualSandboxDef): Promise<RunResult> {
    const start = Date.now();
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');

    try {
        const [baseFile, currentFile, incomingFile] = resolveNotebookTripletPaths(test);
        const workspacePath = createMergeConflictRepo(baseFile, currentFile, incomingFile);
        const openArgs = [
            '--extensionDevelopmentPath',
            extensionDevelopmentPath,
            '--new-window',
            workspacePath,
        ];
        const openCommand = `code ${openArgs.map(arg => JSON.stringify(arg)).join(' ')}`;

        console.log(`  ${pc.dim(`Sandbox repo: ${workspacePath}`)}`);
        console.log(`  ${pc.dim(`Open command: ${openCommand}`)}`);

        if (isCodeCliAvailable()) {
            const launched = spawnSync('code', openArgs, { stdio: 'inherit' });
            if (launched.error) {
                throw launched.error;
            }
            if ((launched.status ?? 0) !== 0) {
                throw new Error(
                    `VS Code CLI 'code' exited with status ${launched.status ?? 'unknown'}`,
                );
            }
        } else {
            console.log(
                `  ${pc.yellow(`VS Code CLI 'code' not found. Open manually with the command above.`)}`,
            );
        }

        return {
            test,
            passed: true,
            durationMs: Date.now() - start,
            workspacePath,
        };
    } catch (err) {
        return {
            test,
            passed: false,
            error: err instanceof Error ? err : new Error(String(err)),
            durationMs: Date.now() - start,
        };
    }
}

async function runTest(test: TestDef): Promise<RunResult> {
    if (isManualTest(test)) {
        return runManualSandbox(test);
    }
    return runAutomatedTest(test);
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

async function runAll(tests: TestDef[]): Promise<void> {
    const totalStart = Date.now();
    const results: RunResult[] = [];

    console.log();
    console.log(pc.bold(`Running ${tests.length} entr${tests.length > 1 ? 'ies' : 'y'}…`));
    console.log(pc.dim('─'.repeat(60)));

    for (let i = 0; i < tests.length; i++) {
        const test = tests[i];
        const prefix = pc.dim(`[${i + 1}/${tests.length}]`);
        const typeLabel = isManualTest(test) ? 'manual' : 'automated';
        console.log(`\n${prefix} ${pc.cyan(test.id)} ${pc.dim('·')} ${test.description} ${pc.dim(`[${typeLabel}]`)}`);

        const result = await runTest(test);
        results.push(result);

        if (result.passed) {
            console.log(
                `${prefix} ${pc.green('✓ PASS')} ${pc.dim(formatDuration(result.durationMs))}`,
            );
            if (result.workspacePath) {
                console.log(`  ${pc.dim(`Workspace: ${result.workspacePath}`)}`);
                console.log(`  ${pc.dim('Note: Manual sandboxes are intentionally preserved.')}`);
            }
        } else {
            console.log(
                `${prefix} ${pc.red('✗ FAIL')} ${pc.dim(formatDuration(result.durationMs))}`,
            );
            if (result.error) {
                console.log(`  ${pc.red(result.error.message)}`);
            }
        }
    }

    // Summary
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const totalDuration = Date.now() - totalStart;

    console.log();
    console.log(pc.dim('─'.repeat(60)));
    console.log(
        pc.bold('Results: ') +
            pc.green(`${passed} passed`) +
            (failed > 0 ? `, ${pc.red(`${failed} failed`)}` : '') +
            pc.dim(` (${formatDuration(totalDuration)})`),
    );

    if (failed > 0) {
        console.log();
        console.log(pc.red(pc.bold('Failed tests:')));
        for (const r of results.filter(r => !r.passed)) {
            console.log(`  ${pc.red('✗')} ${r.test.id}: ${r.error?.message ?? 'unknown error'}`);
        }
    }

    console.log();

    if (failed > 0) {
        process.exit(1);
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const cli = parseArgs(process.argv);

    // --list
    if (cli.list) {
        printTestList();
        return;
    }

    // --all
    if (cli.all) {
        return runAll(testsForAll());
    }

    // --group / --test (can be combined)
    if (cli.groups.length > 0 || cli.tests.length > 0) {
        const tests = resolveTests([...cli.groups, ...cli.tests]);
        if (tests.length === 0) {
            console.error(
                pc.red('No tests matched the given --group / --test flags.'),
            );
            console.error(pc.dim('Run with --list to see available ids.'));
            process.exit(1);
        }
        return runAll(tests);
    }

    // Interactive TUI picker (default when no flags)
    const tests = await pickTestsInteractively();
    return runAll(tests);
}

main().catch(err => {
    console.error(pc.red('Fatal error:'), err);
    process.exit(1);
});
