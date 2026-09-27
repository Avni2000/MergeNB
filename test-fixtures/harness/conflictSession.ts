/** Create a resolver session directly against the web server for browser tests. */

import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'playwright';
import * as logger from '../../packages/core/src';
import {
    detectSemanticConflicts,
    applyAutoResolutions,
    buildResolvedNotebookFromRows,
    serializeNotebook,
} from '../../packages/core/src';
import { getSettings } from '../../apps/vscode-extension/settings';
import * as gitIntegration from '../../apps/vscode-extension/gitIntegration';
import {
    getWebServer,
    toWebConflictData,
    type BrowserToExtensionMessage,
    type UnifiedConflict,
} from '../../packages/web/server/src';
import { openConflictResolverPage, sleep, type BrowserOptions } from './browser';

export interface ConflictSession {
    workspacePath: string;
    conflictFile: string;
    serverPort: number;
    sessionId: string;
    sessionUrl: string;
    browser: Browser;
    page: Page;
}

export async function setupConflictResolverHeadless(
    workspacePath: string,
    extensionPath: string,
    options: BrowserOptions = {}
): Promise<ConflictSession> {
    const conflictFile = path.join(workspacePath, 'conflict.ipynb');

    const semanticConflict = await detectSemanticConflicts(conflictFile, {
        getThreeWayVersions: gitIntegration.getThreeWayVersions,
        getCurrentBranch: gitIntegration.getCurrentBranch,
        getMergeBranch: gitIntegration.getMergeBranch,
    });
    if (!semanticConflict) {
        throw new Error('No semantic conflicts detected.');
    }

    const settings = getSettings();
    const autoResolveResult = applyAutoResolutions(semanticConflict, settings);

    if (autoResolveResult.remainingConflicts.length === 0) {
        throw new Error('No remaining conflicts after auto-resolve.');
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
    server.setExtensionUri({ fsPath: extensionPath });

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
        if (!message || typeof message !== 'object') {
            return;
        }
        const msg = message as BrowserToExtensionMessage;
        if (typeof msg.command !== 'string') {
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
                            logger.error('[ConflictSession] Resolution handler failed:', err);
                            server.sendMessage(sessionId, {
                                type: 'resolution-error',
                                message: `Resolution handler error: ${err}`,
                            });
                        });
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

    try {
        const { browser, page } = await openConflictResolverPage(sessionUrl, options, connectionPromise);
        return {
            workspacePath,
            conflictFile,
            serverPort: server.getPort(),
            sessionId,
            sessionUrl,
            browser,
            page,
        };
    } catch (error) {
        server.closeSession(sessionId);
        throw error;
    }
}
