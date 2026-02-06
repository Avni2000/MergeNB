/**
 * @file runIntegrationTest.ts
 * @description Generic runner that iterates over test cases sequentially.
 * 
 * Each test case:
 * 1. Creates a git repo with merge conflicts from specified notebook triplets
 * 2. Writes a config file with the workspace path and test name
 * 3. Launches VS Code with the extension and the specified test module
 * 4. Cleans up the temporary repo
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import { runTests } from '@vscode/test-electron';
import type { TestCaseDefinition } from './testHelpers';

/** Helper to run git commands */
function git(cwd: string, ...args: string[]): string {
    const cmd = `git ${args.join(' ')}`;
    try {
        return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error: any) {
        // Some git commands exit non-zero but are still useful (e.g., merge with conflicts)
        return error.stdout || '';
    }
}

/**
 * Create a temporary git repo with merge conflicts from a notebook triplet.
 * @param baseFile  Absolute path to the base notebook
 * @param currentFile  Absolute path to the current-branch notebook
 * @param incomingFile  Absolute path to the incoming-branch notebook
 */
function createMergeConflictRepo(baseFile: string, currentFile: string, incomingFile: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergeNB-integration-'));

    // Initialize git repo
    git(tmpDir, 'init');
    git(tmpDir, 'config', 'user.email', '"test@mergenb.test"');
    git(tmpDir, 'config', 'user.name', '"MergeNB Test"');

    // Create base commit
    fs.copyFileSync(baseFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"base"');

    const baseBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

    // Create current branch
    git(tmpDir, 'checkout', '-b', 'current');
    fs.copyFileSync(currentFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"current"');

    // Create incoming branch
    git(tmpDir, 'checkout', baseBranch);
    git(tmpDir, 'checkout', '-b', 'incoming');
    fs.copyFileSync(incomingFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"incoming"');

    // Merge to create conflict
    git(tmpDir, 'checkout', 'current');
    git(tmpDir, 'merge', 'incoming');

    return tmpDir;
}

/** All test cases to run sequentially */
const TEST_CASES: TestCaseDefinition[] = [
    {
        name: '02_perCellResolution',
        notebooks: ['02_base.ipynb', '02_current.ipynb', '02_incoming.ipynb'],
        testModule: './vscodeIntegration.test.js',
    },
    {
        name: '04_takeAllButtons',
        notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
        testModule: './takeAllButtons.test.js',
    },
];

async function main() {
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    const testDir = path.resolve(__dirname, '../../test');
    const configPath = path.join(os.tmpdir(), 'mergenb-test-config.json');

    let failures = 0;

    for (const testCase of TEST_CASES) {
        let testWorkspacePath: string | undefined;

        console.log(`\n${'='.repeat(60)}`);
        console.log(`Running test case: ${testCase.name}`);
        console.log(`  Notebooks: ${testCase.notebooks.join(', ')}`);
        console.log(`${'='.repeat(60)}\n`);

        try {
            // Resolve notebook file paths
            const [baseFile, currentFile, incomingFile] = testCase.notebooks.map(
                n => path.join(testDir, n)
            );

            // Verify all notebook files exist
            for (const f of [baseFile, currentFile, incomingFile]) {
                if (!fs.existsSync(f)) {
                    throw new Error(`Notebook file not found: ${f}`);
                }
            }

            // Create the merge conflict repo
            testWorkspacePath = createMergeConflictRepo(baseFile, currentFile, incomingFile);
            console.log(`Created test workspace at: ${testWorkspacePath}`);

            // Write config for the test to read
            fs.writeFileSync(configPath, JSON.stringify({
                workspacePath: testWorkspacePath,
                testName: testCase.name,
            }));

            // Resolve test module path
            const extensionTestsPath = path.resolve(__dirname, testCase.testModule);

            await runTests({
                extensionDevelopmentPath,
                extensionTestsPath,
                launchArgs: [
                    testWorkspacePath,
                    '--disable-extensions',
                    '--skip-welcome',
                    '--skip-release-notes',
                ],
            });

            console.log(`\n✓ Test case "${testCase.name}" PASSED\n`);

        } catch (err) {
            console.error(`\n✗ Test case "${testCase.name}" FAILED:`, err);
            failures++;
        } finally {
            // Cleanup
            if (testWorkspacePath) {
                try {
                    fs.rmSync(testWorkspacePath, { recursive: true, force: true });
                } catch { /* ignore */ }
            }
            try {
                fs.unlinkSync(configPath);
            } catch { /* ignore */ }
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Results: ${TEST_CASES.length - failures}/${TEST_CASES.length} passed`);
    console.log(`${'='.repeat(60)}\n`);

    if (failures > 0) {
        process.exit(1);
    }
}

main();
