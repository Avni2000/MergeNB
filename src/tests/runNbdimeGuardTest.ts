/**
 * Standalone runner for notebook-tool compatibility guard tests.
 *
 * Uses VS Code extension host without Playwright/browser automation.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { createMergeConflictRepo, cleanup } from './repoSetup';

async function main(): Promise<void> {
    if (process.env.MERGENB_NBDIME_GUARD_CI !== 'true') {
        throw new Error('runNbdimeGuardTest is CI-only. Set MERGENB_NBDIME_GUARD_CI=true in CI.');
    }

    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    const testDir = path.resolve(__dirname, '../../test');
    const extensionTestsPath = path.resolve(__dirname, './nbdimeGuard.test.js');
    const vscodeVersion = process.env.VSCODE_VERSION?.trim();

    const baseFile = path.join(testDir, '02_base.ipynb');
    const currentFile = path.join(testDir, '02_current.ipynb');
    const incomingFile = path.join(testDir, '02_incoming.ipynb');

    for (const notebook of [baseFile, currentFile, incomingFile]) {
        if (!fs.existsSync(notebook)) {
            throw new Error(`Notebook fixture not found: ${notebook}`);
        }
    }

    const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const isolatedGlobalConfig = path.join(
        os.tmpdir(),
        `mergenb-global-config-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );

    fs.writeFileSync(isolatedGlobalConfig, '');
    process.env.GIT_CONFIG_GLOBAL = isolatedGlobalConfig;
    delete process.env.ELECTRON_RUN_AS_NODE;

    let workspacePath: string | undefined;
    const extensionTestsEnv: NodeJS.ProcessEnv = {
        ...process.env,
        MERGENB_TEST_MODE: 'true',
        GIT_CONFIG_GLOBAL: isolatedGlobalConfig,
    };
    delete extensionTestsEnv.ELECTRON_RUN_AS_NODE;

    try {
        workspacePath = createMergeConflictRepo(baseFile, currentFile, incomingFile);
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            extensionTestsEnv,
            ...(vscodeVersion && vscodeVersion !== 'stable' ? { version: vscodeVersion } : {}),
            launchArgs: [
                workspacePath,
                '--disable-extensions',
                '--skip-welcome',
                '--skip-release-notes',
            ],
        });
    } finally {
        if (workspacePath) {
            cleanup(workspacePath);
        }
        cleanup(isolatedGlobalConfig);
        if (previousGitConfigGlobal === undefined) {
            delete process.env.GIT_CONFIG_GLOBAL;
        } else {
            process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
        }
        if (previousElectronRunAsNode === undefined) {
            delete process.env.ELECTRON_RUN_AS_NODE;
        } else {
            process.env.ELECTRON_RUN_AS_NODE = previousElectronRunAsNode;
        }
    }
}

main().catch((error) => {
    console.error('[runNbdimeGuardTest] Failed:', error);
    process.exit(1);
});
