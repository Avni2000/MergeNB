/**
 * @file index.ts
 * @description Web module exports for MergeNB browser-based conflict resolution.
 * 
 * Opens the conflict resolver in the user's default browser, communicating
 * with the extension via WebSocket.
 * 
 * Main exports:
 * - WebConflictPanel: Browser-based conflict resolution panel
 * - getWebServer: Get the singleton web server instance
 * - ConflictResolverWebServer: The HTTP/WebSocket server class
 */

export { WebConflictPanel } from './WebConflictPanel';
export { ConflictResolverWebServer, getWebServer } from './webServer';
export type { WebServerOptions, SessionData, PendingConnection } from './webServer';
export * from './webTypes';
