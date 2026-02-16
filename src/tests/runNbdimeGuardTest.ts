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

    const workspacePath = createMergeConflictRepo(baseFile, currentFile, incomingFile);
    const isolatedGlobalConfig = path.join(
        os.tmpdir(),
        `mergenb-global-config-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );

    fs.writeFileSync(isolatedGlobalConfig, '');
    const extensionTestsEnv = {
        ...process.env,
        MERGENB_TEST_MODE: 'true',
        GIT_CONFIG_GLOBAL: isolatedGlobalConfig,
    };

    try {
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
        cleanup(workspacePath);
        cleanup(isolatedGlobalConfig);
    }
}

main().catch((error) => {
    console.error('[runNbdimeGuardTest] Failed:', error);
    process.exit(1);
});
