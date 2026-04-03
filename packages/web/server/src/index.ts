/**
 * @file index.ts
 * @description Web module exports for MergeNB browser-based conflict resolution.
 *
 * Opens the conflict resolver in the user's default browser, communicating
 * with the extension via WebSocket.
 *
 * Main exports:
 * - getWebServer: Get the singleton web server instance
 */


export { getWebServer } from './webServer';

export * from './webTypes';
