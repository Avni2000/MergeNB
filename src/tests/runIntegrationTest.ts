/**
 * @file runIntegrationTest.ts
 * @description Test runner with interactive TUI picker and CLI flags.
 *
 * Usage:
 *   node out/tests/runIntegrationTest.js                  # Interactive TUI picker
 *   node out/tests/runIntegrationTest.js --all             # Run every auto-included entry
 *   node out/tests/runIntegrationTest.js --group takeAll   # Run one group
 *   node out/tests/runIntegrationTest.js --group takeAll --group undoRedo
 *   node out/tests/runIntegrationTest.js --test takeAll_base
 *   node out/tests/runIntegrationTest.js --test manual_04
 *   node out/tests/runIntegrationTest.js --manual 02
 *   node out/tests/runIntegrationTest.js --test takeAll_base --test perCell_02
 *   node out/tests/runIntegrationTest.js --list            # Print groups & tests
 *
 * npm scripts (see package.json):
 *   npm run test                          # Interactive picker
 *   npm run test -- --all                # Run all
 *   npm run test:list                    # List available tests
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
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
import {
    prepareIsolatedConfigPath,
    cleanupIsolatedConfigPath,
    resolveNotebookTripletPaths,
} from './testRunnerShared';
import { runHeadlessTest } from './headlessTestRun';
import { getWebServer } from '../web/webServer';

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
    manualFixtures: string[];
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        all: false,
        list: false,
        groups: [],
        tests: [],
        manualFixtures: [],
    };
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
        } else if (arg === '--manual' || arg === '-m') {
            i++;
            if (i < argv.length) args.manualFixtures.push(argv[i]);
        } else if (arg.startsWith('--manual=')) {
            const value = arg.slice('--manual='.length);
            if (value) args.manualFixtures.push(value);
        } else if (!arg.startsWith('-')) {
            // npm can strip unknown flags (e.g. `npm run ... --manual 02`) and
            // forward only positional values to the script.
            const looksLikeManualFixture =
                /^manual_/i.test(arg) || /^\d+(?:[\/,]\d+)*$/.test(arg);
            if (looksLikeManualFixture) {
                args.manualFixtures.push(arg);
            }
        }
        i++;
    }
    return args;
}

function manualSandboxTests(): ManualSandboxDef[] {
    return allTests().filter(isManualTest);
}

function parseManualFixtureTokens(rawValues: string[]): string[] {
    return rawValues
        .flatMap(value => value.split(/[\/,\s]+/))
        .map(value => value.trim())
        .filter(Boolean);
}

function normalizeManualFixtureToId(token: string): string {
    const normalized = token.trim().toLowerCase();
    if (normalized.startsWith('manual_')) {
        return normalized;
    }
    if (/^\d+$/.test(normalized)) {
        return `manual_${normalized.padStart(2, '0')}`;
    }
    return `manual_${normalized}`;
}

function resolveManualFixtureSelections(rawValues: string[]): {
    selectedIds: string[];
    unknownTokens: string[];
} {
    const tokens = parseManualFixtureTokens(rawValues);
    const availableByLowerId = new Map(
        manualSandboxTests().map(test => [test.id.toLowerCase(), test.id]),
    );
    const selectedIds: string[] = [];
    const seen = new Set<string>();
    const unknownTokens: string[] = [];

    for (const token of tokens) {
        const requestedId = normalizeManualFixtureToId(token);
        const resolvedId = availableByLowerId.get(requestedId);
        if (!resolvedId) {
            unknownTokens.push(token);
            continue;
        }
        if (!seen.has(resolvedId)) {
            selectedIds.push(resolvedId);
            seen.add(resolvedId);
        }
    }

    return { selectedIds, unknownTokens };
}

// ─── List command ───────────────────────────────────────────────────────────

function printTestList(): void {
    const all = allTests();
    const automatedCount = all.filter(isAutomatedTest).length;
    const manualCount = all.length - automatedCount;
    const manualFixtures = manualSandboxTests().map(test => test.id.replace(/^manual_/, ''));

    console.log();
    console.log(pc.bold('Available test entries'));
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
    if (manualFixtures.length > 0) {
        console.log(
            `  ${pc.dim('Manual fixtures:')} ${manualFixtures.join(', ')} ${pc.dim('(use --manual <fixture>)')}`,
        );
    }
    console.log();
}

// ─── TUI picker ─────────────────────────────────────────────────────────────

async function pickTestsInteractively(): Promise<TestDef[]> {
    const c = await clack();
    c.intro(pc.bgCyan(pc.black(' MergeNB Tests ')));

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

function isCodeCliAvailable(): boolean {
    const result = spawnSync('code', ['--version'], { stdio: 'ignore' });
    return !result.error && result.status === 0;
}

function resolveManualWorkspacePath(): string {
    const configured = process.env.MERGENB_MANUAL_SANDBOX_DIR?.trim();
    if (configured) {
        return path.resolve(configured);
    }
    return path.join(os.tmpdir(), '.mergenb', 'manual-sandbox');
}

interface ManualNotebookReferences {
    base: string;
    current: string;
    incoming: string;
}

function writeManualNotebookReferences(
    workspacePath: string,
    baseFile: string,
    currentFile: string,
    incomingFile: string,
): ManualNotebookReferences {
    const referenceDir = path.join(workspacePath, 'original-notebooks');
    fs.rmSync(referenceDir, { recursive: true, force: true });
    fs.mkdirSync(referenceDir, { recursive: true });

    const paths: ManualNotebookReferences = {
        base: path.join(referenceDir, 'base.ipynb'),
        current: path.join(referenceDir, 'current.ipynb'),
        incoming: path.join(referenceDir, 'incoming.ipynb'),
    };

    fs.copyFileSync(baseFile, paths.base);
    fs.copyFileSync(currentFile, paths.current);
    fs.copyFileSync(incomingFile, paths.incoming);
    fs.writeFileSync(
        path.join(referenceDir, 'README.txt'),
        [
            'Reference notebooks for manual conflict testing.',
            '',
            'Use conflict.ipynb at workspace root to resolve the merge conflict.',
            'Files in this folder mirror the original BASE/CURRENT/INCOMING fixtures.',
            '',
            '  base.ipynb     - common ancestor',
            '  current.ipynb  - current branch version',
            '  incoming.ipynb - incoming branch version',
            '',
        ].join('\n'),
    );

    return paths;
}

async function runAutomatedTest(test: AutomatedTestDef): Promise<RunResult> {
    const start = Date.now();
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    let workspacePath: string | undefined;
    const configInfo = prepareIsolatedConfigPath(test.id);
    const previousTestMode = process.env.MERGENB_TEST_MODE;
    const previousConfigPath = process.env.MERGENB_CONFIG_PATH;
    const previousTestConfigPath = process.env.MERGENB_TEST_CONFIG_PATH;
    const testEnv: NodeJS.ProcessEnv = { ...process.env, MERGENB_TEST_MODE: 'true' };
    // Some environments set this globally, which makes the VS Code binary run
    // in Node mode and reject normal Electron/Code CLI flags.
    testEnv.ELECTRON_RUN_AS_NODE = undefined;
    testEnv.MERGENB_CONFIG_PATH = configInfo.configPath;
    testEnv.MERGENB_TEST_CONFIG_PATH = configInfo.testConfigPath;
    const vscodeVersion = process.env.VSCODE_VERSION?.trim();
    process.env.MERGENB_TEST_MODE = 'true';
    process.env.MERGENB_CONFIG_PATH = configInfo.configPath;
    process.env.MERGENB_TEST_CONFIG_PATH = configInfo.testConfigPath;

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
        cleanupIsolatedConfigPath(configInfo.configRoot);
        if (previousTestMode === undefined) {
            delete process.env.MERGENB_TEST_MODE;
        } else {
            process.env.MERGENB_TEST_MODE = previousTestMode;
        }
        if (previousConfigPath === undefined) {
            delete process.env.MERGENB_CONFIG_PATH;
        } else {
            process.env.MERGENB_CONFIG_PATH = previousConfigPath;
        }
        if (previousTestConfigPath === undefined) {
            delete process.env.MERGENB_TEST_CONFIG_PATH;
        } else {
            process.env.MERGENB_TEST_CONFIG_PATH = previousTestConfigPath;
        }
    }
}

async function runManualSandbox(test: ManualSandboxDef): Promise<RunResult> {
    const start = Date.now();
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');

    try {
        const [baseFile, currentFile, incomingFile] = resolveNotebookTripletPaths(test);
        const workspacePath = createMergeConflictRepo(baseFile, currentFile, incomingFile, {
            targetDir: resolveManualWorkspacePath(),
        });
        const referencePaths = writeManualNotebookReferences(
            workspacePath,
            baseFile,
            currentFile,
            incomingFile,
        );
        const conflictNotebookPath = path.join(workspacePath, 'conflict.ipynb');
        const openArgs = [
            '--extensionDevelopmentPath',
            extensionDevelopmentPath,
            '--reuse-window',
            workspacePath,
            conflictNotebookPath,
        ];
        const openCommand = `code ${openArgs.map(arg => JSON.stringify(arg)).join(' ')}`;

        console.log(`  ${pc.dim(`Sandbox repo: ${workspacePath}`)}`);
        console.log(`  ${pc.dim(`Conflict notebook: ${conflictNotebookPath}`)}`);
        console.log(`  ${pc.dim(`Reference notebooks: ${path.dirname(referencePaths.base)}`)}`);
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

async function runSequentialTest(test: TestDef): Promise<RunResult> {
    if (isManualTest(test)) {
        return runManualSandbox(test);
    }
    return runAutomatedTest(test as AutomatedTestDef);
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

async function runAll(tests: TestDef[]): Promise<void> {
    const totalStart = Date.now();

    // Split into headless (parallelizable) and sequential (VS Code / manual) tests
    const headlessTests = tests.filter(
        (t): t is AutomatedTestDef => isAutomatedTest(t) && !t.requiresVSCode,
    );
    const sequentialTests = tests.filter(
        t => isManualTest(t) || (isAutomatedTest(t) && t.requiresVSCode),
    );

    console.log();
    console.log(pc.bold(`Running ${tests.length} entr${tests.length > 1 ? 'ies' : 'y'}…`));
    if (headlessTests.length > 0) {
        console.log(pc.dim(`  ${headlessTests.length} headless (parallel) + ${sequentialTests.length} sequential`));
    }
    console.log(pc.dim('─'.repeat(60)));

    // Run all headless tests in parallel via Promise.all
    const headlessResultsMap = new Map<string, RunResult>();
    if (headlessTests.length > 0) {
        console.log(`\n${pc.dim('Running headless tests in parallel…')}`);
        const headlessResults = await Promise.all(
            headlessTests.map(async (test): Promise<RunResult> => {
                const result = await runHeadlessTest(test);
                return { test, passed: result.passed, error: result.error, durationMs: result.durationMs };
            }),
        );
        for (const r of headlessResults) {
            headlessResultsMap.set(r.test.id, r);
        }
    }

    // Run sequential tests one at a time
    const sequentialResultsMap = new Map<string, RunResult>();
    for (const test of sequentialTests) {
        const result = await runSequentialTest(test);
        sequentialResultsMap.set(test.id, result);
    }

    // Print results in original order
    const results: RunResult[] = [];
    for (let i = 0; i < tests.length; i++) {
        const test = tests[i];
        const result = headlessResultsMap.get(test.id) ?? sequentialResultsMap.get(test.id)!;
        results.push(result);
        const prefix = pc.dim(`[${i + 1}/${tests.length}]`);
        const typeLabel = isManualTest(test)
            ? 'manual'
            : ((isAutomatedTest(test) && test.requiresVSCode) ? 'vscode' : 'headless');
        console.log(`\n${prefix} ${pc.cyan(test.id)} ${pc.dim('·')} ${test.description} ${pc.dim(`[${typeLabel}]`)}`);

        if (result.passed) {
            console.log(
                `${prefix} ${pc.green('✓ PASS')} ${pc.dim(formatDuration(result.durationMs))}`,
            );
            if (result.workspacePath) {
                console.log(`  ${pc.dim(`Workspace: ${result.workspacePath}`)}`);
                console.log(`  ${pc.dim('Note: Manual sandbox path is deterministic and reused.')}`);
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

    // Stop the web server if it was started by headless tests to ensure the process can exit
    if (getWebServer().isRunning()) {
        await getWebServer().stop();
    }

    if (failed > 0) {
        process.exit(1);
    }

    process.exit(0);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const cli = parseArgs(process.argv);
    const manualSelection = resolveManualFixtureSelections(cli.manualFixtures);

    // --list
    if (cli.list) {
        printTestList();
        return;
    }

    // --all
    if (cli.all) {
        return runAll(testsForAll());
    }

    if (manualSelection.unknownTokens.length > 0) {
        const manualFixtures = manualSandboxTests()
            .map(test => test.id.replace(/^manual_/, ''))
            .join(', ');
        console.error(
            pc.red(
                `Unknown --manual fixture selector(s): ${manualSelection.unknownTokens.join(', ')}`,
            ),
        );
        console.error(
            pc.dim(`Available manual fixtures: ${manualFixtures}`),
        );
        console.error(
            pc.dim('Examples: --manual 02, --manual 02/03, --manual manual_04'),
        );
        process.exit(1);
    }

    if (manualSelection.selectedIds.length > 1) {
        console.error(
            pc.red(
                `--manual accepts exactly one fixture, but received ${manualSelection.selectedIds.length}.`,
            ),
        );
        console.error(
            pc.dim('Use one fixture at a time, e.g. --manual 02'),
        );
        process.exit(1);
    }

    // --group / --test / --manual (can be combined)
    if (cli.groups.length > 0 || cli.tests.length > 0 || manualSelection.selectedIds.length > 0) {
        const tests = resolveTests([
            ...cli.groups,
            ...cli.tests,
            ...manualSelection.selectedIds,
        ]);
        if (tests.length === 0) {
            console.error(
                pc.red('No tests matched the given --group / --test / --manual flags.'),
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
