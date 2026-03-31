/**
 * @file runIntegrationTest.ts
 * @description TUI entry point for MergeNB tests.
 *
 * Usage:
 *   node out/tests/runIntegrationTest.js                    # Interactive TUI
 *   node out/tests/runIntegrationTest.js --playwright       # Run all Playwright specs
 *   node out/tests/runIntegrationTest.js --playwright <spec># Run one spec (basename)
 *   node out/tests/runIntegrationTest.js --vscode           # Run VS Code regression tests
 *   node out/tests/runIntegrationTest.js --manual <fixture> # Open manual sandbox (02/03/04/09)
 *
 * npm scripts (see package.json):
 *   npm run test          # Interactive TUI picker
 *   npm run test:pw       # Run all Playwright specs directly
 *   npm run test:vscode   # Run VS Code regression tests
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawnSync, spawn } from 'child_process';
import { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import pc from 'picocolors';
import {
    createMergeConflictRepo,
    writeTestConfig,
    cleanup,
} from './repoSetup';
import {
    prepareIsolatedConfigPath,
    cleanupIsolatedConfigPath,
} from './testRunnerShared';

// @clack/prompts is ESM-only, so we load it lazily via dynamic import.
let _clack: any;
async function clack(): Promise<any> {
    if (!_clack) _clack = await import('@clack/prompts');
    return _clack;
}

// ─── Manual sandbox definitions ──────────────────────────────────────────────

interface ManualSandbox {
    id: string;
    label: string;
    base: string;
    current: string;
    incoming: string;
}

const MANUAL_SANDBOXES: ManualSandbox[] = [
    {
        id: '02',
        label: 'Fixture 02 — standard merge conflicts',
        base: '02_base.ipynb',
        current: '02_current.ipynb',
        incoming: '02_incoming.ipynb',
    },
    {
        id: '03',
        label: 'Fixture 03',
        base: '03_base.ipynb',
        current: '03_current.ipynb',
        incoming: '03_incoming.ipynb',
    },
    {
        id: '04',
        label: 'Fixture 04 — bulk take-all scenarios',
        base: '04_base.ipynb',
        current: '04_current.ipynb',
        incoming: '04_incoming.ipynb',
    },
    {
        id: '09',
        label: 'Fixture 09 — reordered cells',
        base: '09_reorder_base.ipynb',
        current: '09_reorder_current.ipynb',
        incoming: '09_reorder_incoming.ipynb',
    },
];

// ─── Playwright helpers ───────────────────────────────────────────────────────

function discoverSpecFiles(): string[] {
    const specDir = path.resolve(__dirname, 'playwright');
    if (!fs.existsSync(specDir)) return [];
    return fs
        .readdirSync(specDir)
        .filter(f => f.endsWith('.spec.js'))
        .sort();
}

function specLabel(filename: string): string {
    return filename.replace(/\.spec\.js$/, '');
}

function runPlaywright(specFiles: string[] = []): Promise<boolean> {
    return new Promise(resolve => {
        const args = ['playwright', 'test', ...specFiles];
        const proc = spawn('npx', args, {
            stdio: 'inherit',
            cwd: path.resolve(__dirname, '../..'),
        });
        proc.on('close', code => resolve(code === 0));
    });
}

// ─── VS Code tests ────────────────────────────────────────────────────────────

/**
 * CI-only variant: installs the .vsix (packaged by the workflow) into the
 * same VS Code instance that @vscode/test-electron downloads, then runs the
 * regression suite against it rather than the dev source tree.
 *
 * Using the test-electron binary avoids any dependency on a machine-level
 * `code` CLI, which is not guaranteed to exist in CI environments.
 */
async function runVSCodeRegressionTestsWithVsix(): Promise<boolean> {
    const projectRoot = path.resolve(__dirname, '../..');
    const configInfo = prepareIsolatedConfigPath('vscode-regression-vsix');
    const vscodeVersion = process.env.VSCODE_VERSION?.trim();

    const testDir = path.resolve(__dirname, '../../test');
    const baseFile = path.join(testDir, '02_base.ipynb');
    const currentFile = path.join(testDir, '02_current.ipynb');
    const incomingFile = path.join(testDir, '02_incoming.ipynb');

    // Find the .vsix produced by the workflow's `npx @vscode/vsce package` step.
    const vsixFiles = fs.readdirSync(projectRoot).filter(f => f.endsWith('.vsix')).sort();
    if (vsixFiles.length === 0) {
        console.error('[CI] No .vsix file found — did the package step run?');
        return false;
    }
    const vsixPath = path.join(projectRoot, vsixFiles[vsixFiles.length - 1]);
    console.log(`[CI] Using vsix: ${path.basename(vsixPath)}`);

    // Download (or reuse cached) the same VS Code that runTests will use,
    // then install the vsix into its isolated extensions directory.
    const vscodeExecutablePath = await downloadAndUnzipVSCode(
        vscodeVersion && vscodeVersion !== 'stable' ? vscodeVersion : 'stable'
    );
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    const installResult = spawnSync(cli, [...cliArgs, '--install-extension', vsixPath], {
        encoding: 'utf-8',
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (installResult.status !== 0) {
        console.error('[CI] Failed to install vsix');
        return false;
    }

    // Run the tests against the installed vsix.
    // extensionDevelopmentPath: [] — no dev-source overlay, installed vsix is sole provider.
    // --disable-extensions omitted so the installed extension loads.
    const testEnv: NodeJS.ProcessEnv = {
        ...process.env,
        MERGENB_TEST_MODE: 'true',
        MERGENB_CONFIG_PATH: configInfo.configPath,
        MERGENB_TEST_CONFIG_PATH: configInfo.testConfigPath,
    };
    delete testEnv.ELECTRON_RUN_AS_NODE;

    let workspacePath: string | undefined;
    try {
        workspacePath = createMergeConflictRepo(baseFile, currentFile, incomingFile);
        writeTestConfig(workspacePath, 'regression_vscode', undefined, configInfo.testConfigPath);

        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath: [],
            extensionTestsPath: path.resolve(__dirname, './vscodeRegression.test.js'),
            extensionTestsEnv: testEnv,
            launchArgs: [
                workspacePath,
                '--skip-welcome',
                '--skip-release-notes',
            ],
        });
        return true;
    } catch {
        return false;
    } finally {
        if (workspacePath) cleanup(workspacePath);
        cleanupIsolatedConfigPath(configInfo.configRoot);
    }
}

async function runVSCodeRegressionTests(): Promise<boolean> {
    if (process.env.CI) {
        return runVSCodeRegressionTestsWithVsix();
    }

    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    const testDir = path.resolve(__dirname, '../../test');
    const configInfo = prepareIsolatedConfigPath('vscode-regression');
    const vscodeVersion = process.env.VSCODE_VERSION?.trim();

    const baseFile = path.join(testDir, '02_base.ipynb');
    const currentFile = path.join(testDir, '02_current.ipynb');
    const incomingFile = path.join(testDir, '02_incoming.ipynb');

    const testEnv: NodeJS.ProcessEnv = {
        ...process.env,
        MERGENB_TEST_MODE: 'true',
        MERGENB_CONFIG_PATH: configInfo.configPath,
        MERGENB_TEST_CONFIG_PATH: configInfo.testConfigPath,
    };
    delete testEnv.ELECTRON_RUN_AS_NODE;

    let workspacePath: string | undefined;
    try {
        workspacePath = createMergeConflictRepo(baseFile, currentFile, incomingFile);
        writeTestConfig(workspacePath, 'regression_vscode', undefined, configInfo.testConfigPath);

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath: path.resolve(__dirname, './vscodeRegression.test.js'),
            extensionTestsEnv: testEnv,
            ...(vscodeVersion && vscodeVersion !== 'stable' ? { version: vscodeVersion } : {}),
            launchArgs: [
                workspacePath,
                '--disable-extensions',
                '--skip-welcome',
                '--skip-release-notes',
            ],
        });
        return true;
    } catch {
        return false;
    } finally {
        if (workspacePath) cleanup(workspacePath);
        cleanupIsolatedConfigPath(configInfo.configRoot);
    }
}

// ─── Manual sandbox ───────────────────────────────────────────────────────────

function isCodeCliAvailable(): boolean {
    const result = spawnSync('code', ['--version'], { stdio: 'ignore' });
    return !result.error && result.status === 0;
}

function resolveManualWorkspacePath(): string {
    const configured = process.env.MERGENB_MANUAL_SANDBOX_DIR?.trim();
    if (configured) return path.resolve(configured);
    return path.join(os.tmpdir(), '.mergenb', 'manual-sandbox');
}

function openManualSandbox(sandbox: ManualSandbox): void {
    const testDir = path.resolve(__dirname, '../../test');
    const baseFile = path.join(testDir, sandbox.base);
    const currentFile = path.join(testDir, sandbox.current);
    const incomingFile = path.join(testDir, sandbox.incoming);

    for (const f of [baseFile, currentFile, incomingFile]) {
        if (!fs.existsSync(f)) {
            throw new Error(`Notebook not found: ${f}`);
        }
    }

    const workspacePath = createMergeConflictRepo(baseFile, currentFile, incomingFile, {
        targetDir: resolveManualWorkspacePath(),
    });

    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    const conflictNotebookPath = path.join(workspacePath, 'conflict.ipynb');
    const openArgs = [
        '--extensionDevelopmentPath', extensionDevelopmentPath,
        '--reuse-window',
        workspacePath,
        conflictNotebookPath,
    ];

    console.log(`  ${pc.dim(`Sandbox: ${workspacePath}`)}`);
    console.log(`  ${pc.dim(`Conflict notebook: ${conflictNotebookPath}`)}`);

    if (isCodeCliAvailable()) {
        const launched = spawnSync('code', openArgs, { stdio: 'inherit' });
        if (launched.error) throw launched.error;
    } else {
        const cmd = `code ${openArgs.map(a => JSON.stringify(a)).join(' ')}`;
        console.log(`  ${pc.yellow(`VS Code CLI not found. Open manually:`)}`);
        console.log(`  ${pc.dim(cmd)}`);
    }
}

// ─── TUI ──────────────────────────────────────────────────────────────────────

async function runTUI(): Promise<void> {
    const c = await clack();
    c.intro(pc.bgCyan(pc.black(' MergeNB Tests ')));

    const mode = await c.select({
        message: 'What do you want to run?',
        options: [
            { value: 'playwright', label: 'Playwright tests', hint: 'headless browser, parallel' },
            { value: 'vscode', label: 'VS Code regression tests', hint: 'extension host via @vscode/test-electron' },
            { value: 'manual', label: 'Open manual sandbox', hint: 'creates a conflict repo and opens VS Code' },
        ],
    });

    if (c.isCancel(mode)) { c.cancel('Cancelled.'); process.exit(0); }

    if (mode === 'playwright') {
        await runPlaywrightTUI(c);
        return;
    }

    if (mode === 'vscode') {
        c.outro('Running VS Code regression tests…');
        const passed = await runVSCodeRegressionTests();
        if (!passed) process.exit(1);
        return;
    }

    // mode === 'manual'
    await runManualTUI(c);
}

async function runPlaywrightTUI(c: any): Promise<void> {
    const subMode = await c.select({
        message: 'Which Playwright tests?',
        options: [
            { value: 'all', label: 'All specs', hint: 'npx playwright test' },
            { value: 'pick', label: 'Pick specific spec(s)' },
        ],
    });

    if (c.isCancel(subMode)) { c.cancel('Cancelled.'); process.exit(0); }

    let specFiles: string[] = [];

    if (subMode === 'pick') {
        const available = discoverSpecFiles();
        if (available.length === 0) {
            c.cancel('No compiled spec files found. Run npm run compile-tests first.');
            process.exit(1);
        }

        const selected = await c.multiselect({
            message: 'Select specs to run',
            options: available.map(f => ({ value: f, label: specLabel(f) })),
            required: true,
        });

        if (c.isCancel(selected)) { c.cancel('Cancelled.'); process.exit(0); }
        specFiles = (selected as string[]).map(f =>
            path.join('out/tests/playwright', f)
        );
    }

    c.outro(specFiles.length > 0
        ? `Running: ${specFiles.map(specLabel).join(', ')}`
        : 'Running all Playwright specs…'
    );

    const passed = await runPlaywright(specFiles);
    if (!passed) process.exit(1);
}

async function runManualTUI(c: any): Promise<void> {
    const selected = await c.select({
        message: 'Select fixture',
        options: MANUAL_SANDBOXES.map(s => ({
            value: s.id,
            label: s.label,
        })),
    });

    if (c.isCancel(selected)) { c.cancel('Cancelled.'); process.exit(0); }

    const sandbox = MANUAL_SANDBOXES.find(s => s.id === selected)!;
    c.outro(`Opening sandbox: ${sandbox.label}`);
    openManualSandbox(sandbox);
}

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

interface CliArgs {
    playwright: boolean;
    playwrightSpecs: string[];
    vscode: boolean;
    manual: string | null;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { playwright: false, playwrightSpecs: [], vscode: false, manual: null };
    let i = 2;
    while (i < argv.length) {
        const arg = argv[i];
        if (arg === '--playwright' || arg === '-p') {
            args.playwright = true;
            // Consume subsequent non-flag args as spec names
            while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
                i++;
                args.playwrightSpecs.push(argv[i]);
            }
        } else if (arg === '--vscode' || arg === '-v') {
            args.vscode = true;
        } else if (arg === '--manual' || arg === '-m') {
            i++;
            if (i < argv.length) args.manual = argv[i];
        } else if (arg.startsWith('--manual=')) {
            args.manual = arg.slice('--manual='.length) || null;
        }
        i++;
    }
    return args;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const cli = parseArgs(process.argv);

    if (cli.playwright) {
        const specFiles = cli.playwrightSpecs.map(s => {
            const name = s.endsWith('.spec.js') ? s : `${s}.spec.js`;
            return path.join('out/tests/playwright', name);
        });
        const passed = await runPlaywright(specFiles.length > 0 ? specFiles : []);
        if (!passed) process.exit(1);
        return;
    }

    if (cli.vscode) {
        const passed = await runVSCodeRegressionTests();
        if (!passed) process.exit(1);
        return;
    }

    if (cli.manual) {
        const id = cli.manual.replace(/^0+/, '') || cli.manual;
        const paddedId = id.padStart(2, '0');
        const sandbox = MANUAL_SANDBOXES.find(
            s => s.id === id || s.id === paddedId
        );
        if (!sandbox) {
            const available = MANUAL_SANDBOXES.map(s => s.id).join(', ');
            console.error(pc.red(`Unknown manual fixture: ${cli.manual}`));
            console.error(pc.dim(`Available: ${available}`));
            process.exit(1);
        }
        openManualSandbox(sandbox);
        return;
    }

    await runTUI();
}

main().catch(err => {
    console.error(pc.red('Fatal error:'), err);
    process.exit(1);
});
