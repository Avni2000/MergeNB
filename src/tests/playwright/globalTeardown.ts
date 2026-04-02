/**
 * @file globalTeardown.ts
 * @description Playwright Test global teardown - stops the shared web server.
 *
 * This runs once after all test workers complete.
 */

import { getWebServer } from '../../web/webServer';
import * as logger from '../../../packages/core/src/logger';

async function globalTeardown(): Promise<void> {
    logger.info('[GlobalTeardown] Stopping MergeNB web server...');

    const server = getWebServer();
    if (server.isRunning()) {
        await server.stop();
    }

    logger.info('[GlobalTeardown] Web server stopped');
}

export default globalTeardown;
