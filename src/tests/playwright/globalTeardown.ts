/**
 * @file globalTeardown.ts
 * @description Playwright Test global teardown - stops the shared web server.
 *
 * This runs once after all test workers complete.
 */

import { getWebServer } from '../../web/webServer';

async function globalTeardown(): Promise<void> {
    console.log('[GlobalTeardown] Stopping MergeNB web server...');

    const server = getWebServer();
    if (server.isRunning()) {
        await server.stop();
    }

    console.log('[GlobalTeardown] Web server stopped');
}

export default globalTeardown;
