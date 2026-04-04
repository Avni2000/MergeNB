/**
 * @file testHarness.ts
 * @description VS Code extension host lifecycle helpers for integration tests.
 *
 * Runs inside the `@vscode/test-electron` extension host. Provides:
 * - `readTestConfig`  — reads the JSON config written by the runner before launch
 * - `setupConflictResolver` — opens the conflict file, starts the web server,
 *   and connects a Playwright browser to the live session UI
 * - `applyResolutionAndReadNotebook` — clicks Apply and reads the resolved notebook
 * - `assertNotebookMatches` — compares the resolved notebook against expected cells
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, type Browser, type Page } from 'playwright';
import * as logger from '../../../packages/core/src';
import * as gitIntegration from '../gitIntegration';
import {
    detectSemanticConflicts,
    applyAutoResolutions,
    buildResolvedNotebookFromRows,
    serializeNotebook,
} from '../../../packages/core/src';
import { getSettings, configContext } from '../settings';
import { getWebServer } from '../../../packages/web/server/src';
import {
    toWebConflictData,
    type BrowserToExtensionMessage,
    type UnifiedConflict,
} from '../../../packages/web/server/src';
import {
    type ExpectedCell,
    type TestConfig,
    getCellSource,
    waitForServer,
    waitForSessionUrl,
    waitForFileWrite,
} from '../../../test-fixtures/shared/testHelpers';
import { ensureCheckboxChecked } from '../../../test-fixtures/shared/integrationUtils';

// Optional vscode import for headless test support.
let vscode: typeof import('vscode') | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running in headless mode (tests) - vscode not available
}

interface ConflictSession {
    config: TestConfig;
    workspacePath: string;
    conflictFile: string;
    serverPort: number;
    sessionId: string;
    sessionUrl: string;
    browser: Browser;
    page: Page;
}

interface SetupOptions {
    headless?: boolean;
    serverTimeoutMs?: number;
    sessionTimeoutMs?: number;
    afterNavigateDelayMs?: number;
    postHeaderDelayMs?: number;
}

interface ApplyOptions {
    markResolved?: boolean;
    postClickDelayMs?: number;
    writeTimeoutMs?: number;
}

interface NotebookMatchOptions {
    expectedLabel?: string;
    compareMetadata?: boolean;
    compareExecutionCounts?: boolean;
    renumberEnabled?: boolean;
    logCounts?: boolean;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Read the test config JSON written to disk by the runner before VS Code launched. */
export function readTestConfig(): TestConfig {
    const ctx = configContext.getStore();
    const override = ctx?.testConfigPath ?? process.env.MERGENB_TEST_CONFIG_PATH;
    const configPath = override && override.trim()
        ? path.resolve(override.trim())
        : path.join(os.tmpdir(), 'mergenb-test-config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/**
 * Open the conflict notebook, run `merge-nb.findConflicts`, wait for the web
 * server, and connect a Playwright browser to the session UI.
 *
 * Returns a `ConflictSession` with the `page` ready for UI interactions.
 * Closes the browser and rethrows if navigation or header verification fails.
 */
export async function setupConflictResolver(
    config: TestConfig,
    options: SetupOptions = {}
): Promise<ConflictSession> {
    if (!vscode) {
        return setupConflictResolverHeadless(config, options);
    }

    const workspacePath = config.workspacePath;
    const conflictFile = path.join(workspacePath, 'conflict.ipynb');

    const doc = await vscode.workspace.openTextDocument(conflictFile);
    await vscode.window.showTextDocument(doc);
    await sleep(1000);

    logger.info('[TestHarness] Executing merge-nb.findConflicts command...');
    await vscode.commands.executeCommand('merge-nb.findConflicts');
    logger.info('[TestHarness] merge-nb.findConflicts command executed');

    logger.info('[TestHarness] Waiting for server to start...');
    const serverPort = await waitForServer(
        () => Promise.resolve(vscode.commands.executeCommand<number>('merge-nb.getWebServerPort')),
        options.serverTimeoutMs
    );
    logger.info(`[TestHarness] Server started on port ${serverPort}`);

    const sessionUrl = await waitForSessionUrl(
        () => Promise.resolve(vscode.commands.executeCommand<string>('merge-nb.getLatestWebSessionUrl')),
        options.sessionTimeoutMs
    );
    const sessionId = new URL(sessionUrl).searchParams.get('session') || 'unknown';
    logger.info(`Session created: ${sessionId}`);

    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
        const page = await browser.newPage();

        const testUrl = sessionUrl + '&noVirtualize=1';
        await page.goto(testUrl);
        await sleep(options.afterNavigateDelayMs ?? 3000);

        await page.waitForSelector('.header-title', { timeout: 15000 });
        const title = await page.locator('.header-title').textContent();
        if (title?.trim() !== 'MergeNB') {
            throw new Error(`Expected header 'MergeNB', got '${title}'`);
        }

        await sleep(options.postHeaderDelayMs ?? 1000);

        return {
            config,
            workspacePath,
            conflictFile,
            serverPort,
            sessionId,
            sessionUrl,
            browser,
            page,
        };
    } catch (err) {
        await browser.close();
        throw err;
    }
}

async function setupConflictResolverHeadless(
    config: TestConfig,
    options: SetupOptions = {}
): Promise<ConflictSession> {
    const workspacePath = config.workspacePath;
    const conflictFile = path.join(workspacePath, 'conflict.ipynb');

    const semanticConflict = await detectSemanticConflicts(conflictFile, {
        getThreeWayVersions: gitIntegration.getThreeWayVersions,
        getCurrentBranch: gitIntegration.getCurrentBranch,
        getMergeBranch: gitIntegration.getMergeBranch,
    });
    if (!semanticConflict) {
        throw new Error('No semantic conflicts detected (headless mode).');
    }

    const settings = getSettings();
    const autoResolveResult = applyAutoResolutions(semanticConflict, settings);

    if (autoResolveResult.remainingConflicts.length === 0) {
        throw new Error('No remaining conflicts after auto-resolve (headless mode).');
    }

    const filteredSemanticConflict = {
        ...semanticConflict,
        semanticConflicts: autoResolveResult.remainingConflicts,
    };

    const unifiedConflict: UnifiedConflict = {
        filePath: conflictFile,
        type: 'semantic',
        semanticConflict: filteredSemanticConflict,
        autoResolveResult,
        hideNonConflictOutputs: settings.hideNonConflictOutputs,
        showCellHeaders: settings.showCellHeaders,
        enableUndoRedoHotkeys: settings.enableUndoRedoHotkeys,
        showBaseColumn: settings.showBaseColumn,
        theme: settings.theme,
    };

    const server = getWebServer();
    server.setTestMode(true);
    server.setExtensionUri({ fsPath: path.resolve(__dirname, '../../../..') });

    if (!server.isRunning()) {
        await server.start();
    }

    const sessionId = server.generateSessionId();
    const conflictVersion = 1;
    const sendConflictData = (): void => {
        const data = toWebConflictData(unifiedConflict, `${sessionId}:v${conflictVersion}`);
        server.sendConflictData(sessionId, data);
    };

    const handleResolution = async (
        message: Extract<BrowserToExtensionMessage, { command: 'resolve' }>
    ): Promise<void> => {
        try {
            const markAsResolved = message.markAsResolved ?? false;
            const shouldRenumber = message.renumberExecutionCounts ?? false;
            const resolvedNotebook = buildResolvedNotebookFromRows({
                semanticConflict: filteredSemanticConflict,
                resolvedRows: message.resolvedRows,
                autoResolveResult,
                settings,
                shouldRenumber,
                preferredSideHint: message.semanticChoice,
            });

            fs.writeFileSync(conflictFile, serializeNotebook(resolvedNotebook), 'utf8');
            if (markAsResolved) {
                const staged = await gitIntegration.stageFile(conflictFile);
                if (!staged) {
                    throw new Error(`Failed to stage ${path.basename(conflictFile)}`);
                }
            }

            server.sendMessage(sessionId, {
                type: 'resolution-success',
                message: 'Conflicts resolved successfully!',
            });
            await sleep(500);
            server.closeSession(sessionId);
        } catch (error) {
            server.sendMessage(sessionId, {
                type: 'resolution-error',
                message: `Failed to apply resolutions: ${error}`,
            });
        }
    };

    const handleMessage = (message: unknown): void => {
        // Validate message structure before casting to avoid undefined property access
        if (!message || typeof message !== 'object') {
            logger.error('[TestHarness] Invalid message format (not an object):', message);
            return;
        }
        const msg = message as BrowserToExtensionMessage;
        if (typeof msg.command !== 'string') {
            logger.error('[TestHarness] Invalid message format (no command property):', message);
            return;
        }
        switch (msg.command) {
            case 'ready':
                sendConflictData();
                break;
            case 'resolve':
                if ('resolvedRows' in msg) {
                    void handleResolution(msg as Extract<BrowserToExtensionMessage, { command: 'resolve' }>)
                        .catch(err => {
                            logger.error('[TestHarness] Resolution handler failed:', err);
                            server.sendMessage(sessionId, {
                                type: 'resolution-error',
                                message: `Resolution handler error: ${err}`,
                            });
                        });
                } else {
                    logger.error('[TestHarness] Resolve message missing resolvedRows');
                }
                break;
            case 'cancel':
                server.closeSession(sessionId);
                break;
        }
    };

    const { sessionUrl, connectionPromise } = await server.openSession(
        sessionId,
        handleMessage,
        unifiedConflict.theme ?? 'light',
        unifiedConflict.filePath
    );

    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
        const page = await browser.newPage();
        const testUrl = sessionUrl + '&noVirtualize=1';
        await page.goto(testUrl);
        await sleep(options.afterNavigateDelayMs ?? 3000);

        await page.waitForSelector('.header-title', { timeout: 15000 });
        const title = await page.locator('.header-title').textContent();
        if (title?.trim() !== 'MergeNB') {
            throw new Error(`Expected header 'MergeNB', got '${title}'`);
        }

        // Wait for browser 'ready' message with timeout to prevent infinite hang
        const connectionTimeoutMs = 30000;
        await Promise.race([
            connectionPromise,
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error(`Browser connection timeout after ${connectionTimeoutMs}ms`)), connectionTimeoutMs)
            ),
        ]);

        await sleep(options.postHeaderDelayMs ?? 1000);

        return {
            config,
            workspacePath,
            conflictFile,
            serverPort: server.getPort(),
            sessionId,
            sessionUrl,
            browser,
            page,
        };
    } catch (err) {
        server.closeSession(sessionId);
        await browser.close();
        throw err;
    }
}

/**
 * Check "Mark as resolved", click Apply, wait for the file to be written,
 * then read and return the resolved notebook from disk.
 */
export async function applyResolutionAndReadNotebook(
    page: Page,
    conflictFile: string,
    options: ApplyOptions = {}
): Promise<any> {
    if (options.markResolved ?? true) {
        await ensureCheckboxChecked(page, 'Mark as resolved');
    }

    logger.info('\n=== Applying resolution ===');
    const applyButton = page.locator('button.btn-primary:has-text("Apply Resolution")');
    await applyButton.waitFor({ timeout: 5000 });

    if (await applyButton.isDisabled()) {
        throw new Error('Apply Resolution button is disabled');
    }

    await applyButton.click();
    await sleep(options.postClickDelayMs ?? 3000);

    const fileWritten = await waitForFileWrite(conflictFile, fs, options.writeTimeoutMs);
    if (!fileWritten) {
        logger.info('Warning: Could not confirm file write, proceeding anyway');
    }

    const notebookContent = fs.readFileSync(conflictFile, 'utf8');
    return JSON.parse(notebookContent);
}

/**
 * Assert that a resolved notebook on disk matches the expected cell list.
 *
 * Checks (in order): cell count, source, cell_type, metadata (if
 * `compareMetadata`), outputs, and execution counts (if `compareExecutionCounts`).
 * When `renumberEnabled` is true, execution counts are expected to increment
 * from 1 for every code cell that has outputs.
 *
 * Throws a descriptive error on the first category of mismatch found.
 */
export function assertNotebookMatches(
    expectedCells: ExpectedCell[],
    resolvedNotebook: any,
    options: NotebookMatchOptions = {}
): void {
    const expectedNonDeleted = expectedCells.filter(c => !c.isDeleted);
    const label = options.expectedLabel || 'Expected';
    const logCounts = options.logCounts ?? true;

    if (!resolvedNotebook || !Array.isArray(resolvedNotebook.cells)) {
        throw new Error('Resolved notebook is missing cells');
    }

    if (logCounts) {
        logger.info(`Notebook on disk: ${resolvedNotebook.cells.length} cells`);
        logger.info(`${label}: ${expectedNonDeleted.length} cells`);
    }

    if (resolvedNotebook.cells.length !== expectedNonDeleted.length) {
        logger.info('Cell count mismatch:');
        logger.info('Expected cells:');
        for (const cell of expectedNonDeleted) {
            logger.info(`  Row ${cell.rowIndex}: ${cell.cellType}, ${cell.source.length} chars`);
        }
        logger.info('Actual cells:');
        for (let i = 0; i < resolvedNotebook.cells.length; i++) {
            const src = getCellSource(resolvedNotebook.cells[i]);
            logger.info(`  Cell ${i}: ${resolvedNotebook.cells[i].cell_type}, ${src.length} chars`);
        }
        throw new Error(`Cell count mismatch: expected ${expectedNonDeleted.length}, got ${resolvedNotebook.cells.length}`);
    }

    let sourceMismatches = 0;
    let typeMismatches = 0;
    let metadataMismatches = 0;
    let executionMismatches = 0;
    let outputMismatches = 0;
    let nextExecutionCount = 1;

    for (let i = 0; i < expectedNonDeleted.length; i++) {
        const expected = expectedNonDeleted[i];
        const actual = resolvedNotebook.cells[i];
        const actualSource = getCellSource(actual);

        if (expected.source !== actualSource) {
            sourceMismatches++;
            logger.info(`Source mismatch at cell ${i}:`);
            logger.info(`  Expected: "${expected.source.substring(0, 80).replace(/\n/g, '\\n')}..."`);
            logger.info(`  Actual:   "${actualSource.substring(0, 80).replace(/\n/g, '\\n')}..."`);
        }

        if (expected.cellType !== actual.cell_type) {
            typeMismatches++;
            logger.info(`Type mismatch at cell ${i}: expected ${expected.cellType}, got ${actual.cell_type}`);
        }

        if (options.compareMetadata) {
            const expectedMetadata = expected.metadata || {};
            const actualMetadata = actual.metadata || {};
            if (JSON.stringify(expectedMetadata) !== JSON.stringify(actualMetadata)) {
                metadataMismatches++;
                logger.info(`Metadata mismatch at cell ${i}`);
            }
        }

        if (expected.outputs !== undefined) {
            const actualOutputs = (actual as any).outputs || [];
            // Strip execution_count from execute_result outputs before comparing —
            // renumberExecutionCounts() updates that field on the disk copy, but the
            // expected snapshot captured from the UI still carries the original value.
            // Cell-level execution_count is already verified separately above.
            const stripExecCount = (outs: any[]) =>
                outs.map(o => o.output_type === 'execute_result'
                    ? (({ execution_count: _ec, ...rest }) => rest)(o)
                    : o);
            if (JSON.stringify(stripExecCount(expected.outputs)) !== JSON.stringify(stripExecCount(actualOutputs))) {
                outputMismatches++;
                logger.info(`Outputs mismatch at cell ${i}:`);
                logger.info(`  Expected: ${JSON.stringify(expected.outputs).substring(0, 100)}...`);
                logger.info(`  Actual:   ${JSON.stringify(actualOutputs).substring(0, 100)}...`);
            }
        }

        if (options.compareExecutionCounts && expected.cellType === 'code') {
            const expectedExecutionCount = options.renumberEnabled
                ? (expected.hasOutputs ? nextExecutionCount++ : null)
                : (expected.execution_count ?? null);
            const actualExecutionCount = actual.execution_count ?? null;
            if (expectedExecutionCount !== actualExecutionCount) {
                executionMismatches++;
                logger.info(`Execution count mismatch at cell ${i}: expected ${expectedExecutionCount}, got ${actualExecutionCount}`);
            }
        }
    }

    if (sourceMismatches > 0) {
        throw new Error(`${sourceMismatches} cells have source mismatches`);
    }

    if (typeMismatches > 0) {
        throw new Error(`${typeMismatches} cells have type mismatches`);
    }

    if (metadataMismatches > 0) {
        throw new Error(`${metadataMismatches} cells have metadata mismatches`);
    }

    if (outputMismatches > 0) {
        throw new Error(`${outputMismatches} cells have output mismatches`);
    }

    if (executionMismatches > 0) {
        throw new Error(`${executionMismatches} cells have execution count mismatches`);
    }
}
