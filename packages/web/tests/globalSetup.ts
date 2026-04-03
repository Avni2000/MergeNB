/**
 * @file globalSetup.ts
 * @description Playwright Test global setup - starts the shared web server.
 *
 * This runs once before all test workers start. The web server is started
 * as a shared resource that all parallel workers can connect to.
 */

import { getWebServer } from '../server/src';
import * as path from 'path';
import * as logger from '../../core/src';

async function globalSetup(): Promise<void> {
    logger.info('[GlobalSetup] Starting MergeNB web server...');

    const server = getWebServer();

    // Set test mode and extension URI for headless operation
    server.setTestMode(true);
    server.setExtensionUri({ fsPath: path.resolve(__dirname, '../../..') });

    if (!server.isRunning()) {
        await server.start();
    }

    const port = server.getPort();
    logger.info(`[GlobalSetup] Web server started on port ${port}`);

    // Store the port in an environment variable for workers to access
    process.env.MERGENB_TEST_SERVER_PORT = String(port);
}


export default globalSetup;
