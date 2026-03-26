/**
 * Run automated integration tests without the VS Code extension host (Playwright + web server only).
 */

import * as path from 'path';
import { createMergeConflictRepo, writeTestConfig, cleanup } from './repoSetup';
import { configContext } from '../settings';
import type { AutomatedTestDef } from './registry';
import {
    prepareIsolatedConfigPath,
    cleanupIsolatedConfigPath,
    resolveNotebookTripletPaths,
} from './testRunnerShared';
import { withLogCollection } from './logCollection';

export interface HeadlessRunResult {
    test: AutomatedTestDef;
    passed: boolean;
    error?: Error;
    durationMs: number;
    logs?: string;
}

export async function runHeadlessTest(test: AutomatedTestDef): Promise<HeadlessRunResult> {
    const start = Date.now();
    const configInfo = prepareIsolatedConfigPath(test.id);

    const { result, logs } = await withLogCollection(async () => {
        let workspacePath: string | undefined;
        let configPath: string | undefined;
        try {
            const [baseFile, currentFile, incomingFile] = resolveNotebookTripletPaths(test);
            workspacePath = createMergeConflictRepo(baseFile, currentFile, incomingFile);
            configPath = writeTestConfig(
                workspacePath,
                test.id,
                test.params,
                configInfo.testConfigPath,
            );

            return await configContext.run(
                { configPath: configInfo.configPath, testConfigPath: configInfo.testConfigPath },
                async () => {
                    const testModulePath = path.resolve(__dirname, test.testModule);
                    // Clear the test module from require.cache to ensure fresh module load.
                    // Note: This doesn't clear dependencies already loaded by the test module,
                    // so it's a best-effort isolation. True isolation is provided by
                    // AsyncLocalStorage context above for config paths.
                    delete require.cache[require.resolve(testModulePath)];
                    const testModule = require(testModulePath);
                    if (!testModule?.run || typeof testModule.run !== 'function') {
                        throw new Error(`Test module ${testModulePath} does not export run()`);
                    }
                    await Promise.resolve(testModule.run());
                    return { passed: true as const, durationMs: Date.now() - start };
                },
            );
        } catch (err) {
            return {
                passed: false as const,
                error: err instanceof Error ? err : new Error(String(err)),
                durationMs: Date.now() - start,
            };
        } finally {
            if (configPath) cleanup(configPath);
            if (workspacePath) cleanup(workspacePath);
            cleanupIsolatedConfigPath(configInfo.configRoot);
        }
    });

    return { test, ...result, logs: logs || undefined };
}
