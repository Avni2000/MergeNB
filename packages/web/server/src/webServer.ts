/**
 * @file webServer.ts
 * @description HTTP and WebSocket server for web-based conflict resolution.
 * 
 * This module provides a local HTTP server that serves the conflict resolution UI
 * in a web browser. Communication between the extension and browser is done via WebSocket.
 * 
 * Architecture:
 * - HTTP server serves the React-based conflict resolver UI
 * - WebSocket provides real-time bidirectional communication
 * - Each conflict resolution session has a unique session ID
 * - The extension sends conflict data to the browser via WebSocket
 * - The browser sends resolution choices back to the extension
 */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes, randomUUID } from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import * as logger from '../../../core/src';
import type { WebConflictData } from './webTypes';

// VSCode is optional - only needed for openExternal
let vscode: typeof import('vscode') | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running in headless/test mode without VSCode
}

/** URI-like interface for test compatibility */
interface UriLike {
    fsPath: string;
}

interface WebServerOptions {
    port?: number;
    host?: string;
}

interface PendingConnection {
    resolve: (ws: WebSocket) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
}

/** Session data stored for each active conflict resolution */
interface SessionData {
    sessionToken: string;
    theme: 'dark' | 'light';
    notebookFilePath?: string;
    onMessage: (message: unknown) => void;
}

/**
 * Web server singleton that serves the conflict resolver UI.
 * 
 * Usage:
 * 1. Get instance: `getWebServer()`
 * 2. Start server: `await server.start()`
 * 3. Open session: `await server.openSession(sessionId, onMessage)`
 * 4. Browser connects and receives conflict data via WebSocket
 * 5. Resolution messages come back through onMessage callback
 */
class ConflictResolverWebServer {
    private static instance: ConflictResolverWebServer | undefined;
    
    private httpServer: http.Server | undefined;
    private wss: WebSocketServer | undefined;
    private port: number = 0;
    private host: string = '127.0.0.1';
    
    // Active WebSocket connections by session ID
    private connections: Map<string, WebSocket> = new Map();
    
    // Session data by session ID (includes conflict data and message handlers)
    private sessions: Map<string, SessionData> = new Map();
    
    // Pending connection promises (waiting for browser to connect)
    private pendingConnections: Map<string, PendingConnection> = new Map();
    
    // Extension URI for resolving static assets
    private extensionUri: UriLike | undefined;
    private latestSessionUrl: string | undefined;
    private testMode: boolean = false;

    private constructor() {}

    /**
     * Get or create the singleton instance.
     */
    public static getInstance(): ConflictResolverWebServer {
        if (!ConflictResolverWebServer.instance) {
            ConflictResolverWebServer.instance = new ConflictResolverWebServer();
        }
        return ConflictResolverWebServer.instance;
    }
 
    /**
     * Set the extension URI for resolving static assets.
     */
    public setExtensionUri(uri: UriLike): void {
        this.extensionUri = uri;
    }

    /**
     * Enable test mode. When enabled, the full session URL (including token)
     * is stored so that test harnesses can retrieve it via getLatestSessionUrl().
     * This should never be enabled in production.
     */
    public setTestMode(enabled: boolean): void {
        this.testMode = enabled;
        if (!enabled) {
            this.latestSessionUrl = undefined;
        }
    }

    /**
     * Start the server if not already running.
     */
    public async start(options: WebServerOptions = {}): Promise<number> {
        if (this.httpServer && this.port > 0) {
            return this.port;
        }

        // Use IPv4 loopback by default to avoid IPv6-only binding on Windows.
        this.host = options.host || '127.0.0.1';

        return new Promise((resolve, reject) => {
            this.httpServer = http.createServer((req, res) => {
                this.handleHttpRequest(req, res);
            });

            this.wss = new WebSocketServer({ server: this.httpServer });
            
            this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
                this.handleWebSocketConnection(ws, req);
            });

            this.wss.on('error', (error: Error) => {
                logger.error('[MergeNB Web] WebSocket server error:', error);
            });

            // Use port 0 to get an available port
            const preferredPort = options.port || 0;
            
            this.httpServer.listen(preferredPort, this.host, () => {
                const address = this.httpServer!.address();
                if (address && typeof address === 'object') {
                    this.port = address.port;
                    logger.debug(`[MergeNB Web] Server started at http://${this.host}:${this.port}`);
                    resolve(this.port);
                } else {
                    reject(new Error('Could not get server address'));
                }
            });

            this.httpServer.on('error', (error: Error) => {
                logger.error('[MergeNB Web] HTTP server error:', error);
                reject(error);
            });
        });
    }

    /**
     * Stop the server.
     */
    public async stop(): Promise<void> {
        // Close all WebSocket connections
        for (const ws of this.connections.values()) {
            ws.close();
        }
        this.connections.clear();
        this.sessions.clear();
        
        // Reject all pending connections
        for (const pending of this.pendingConnections.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Server stopped'));
        }
        this.pendingConnections.clear();

        return new Promise((resolve) => {
            if (this.wss) {
                this.wss.close(() => {
                    if (this.httpServer) {
                        this.httpServer.close(() => {
                            this.port = 0;
                            logger.debug('[MergeNB Web] Server stopped');
                            resolve();
                        });
                    } else {
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Check if server is running.
     */
    public isRunning(): boolean {
        return this.httpServer !== undefined && this.port > 0;
    }

    /**
     * Get the current server URL.
     */
    public getServerUrl(): string {
        return `http://${this.host}:${this.port}`;
    }

    /**
     * Get the current port.
     */
    public getPort(): number {
        return this.port;
    }

    /**
     * Generate a unique session ID.
     */
    public generateSessionId(): string {
        return `session-${this.generateSecret()}`;
    }

    /**
     * Get the latest session URL (test/debug helper).
     */
    public getLatestSessionUrl(): string | undefined {
        return this.latestSessionUrl;
    }

    /**
     * Open a new conflict resolution session in the browser.
     * Returns the session URL and a promise that resolves when the browser connects via WebSocket.
     *
     * @param sessionId - Unique identifier for this session
     * @param onMessage - Callback for handling messages from the browser
     * @returns Object with sessionUrl and connectionPromise
     */
    public async openSession(
        sessionId: string,
        onMessage: (message: unknown) => void,
        theme: 'dark' | 'light' = 'light',
        notebookFilePath?: string
    ): Promise<{ sessionUrl: string; connectionPromise: Promise<WebSocket> }> {
        const sessionToken = this.generateSecret();

        // Store session data
        this.sessions.set(sessionId, {
            sessionToken,
            theme,
            notebookFilePath,
            onMessage
        });

        // Create a pending connection promise
        const connectionPromise = new Promise<WebSocket>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingConnections.delete(sessionId);
                this.sessions.delete(sessionId);
                reject(new Error('Browser connection timeout - no WebSocket connection received within 30 seconds'));
            }, 30000); // 30 second timeout

            this.pendingConnections.set(sessionId, {
                resolve,
                reject,
                timeout
            });
        });

        // Build the session URL
        const sessionUrl = `${this.getServerUrl()}/?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(sessionToken)}`;
        if (this.testMode) {
            this.latestSessionUrl = sessionUrl;
        }
        const redactedUrl = `${this.getServerUrl()}/?session=${encodeURIComponent(sessionId)}&token=REDACTED`;
        logger.debug(`[MergeNB Web] Opening browser to: ${redactedUrl}`);
        if (vscode) {
            await vscode.env.openExternal(vscode.Uri.parse(sessionUrl));
        } else {
            logger.debug(`[MergeNB Web] VSCode not available, skipping browser open. URL: ${redactedUrl}`);
        }

        return { sessionUrl, connectionPromise };
    }

    /**
     * Send a message to a specific session via WebSocket.
     */
    public sendMessage(sessionId: string, message: object): boolean {
        const ws = this.connections.get(sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            return true;
        }
        logger.warn(`[MergeNB Web] Cannot send message - no active connection for session: ${sessionId}`);
        return false;
    }

    /**
     * Send conflict data to a session.
     * This is called after the browser connects to send the initial conflict data.
     */
    public sendConflictData(sessionId: string, conflictData: WebConflictData): boolean {
        return this.sendMessage(sessionId, {
            type: 'conflict-data',
            data: conflictData
        });
    }

    /**
     * Close a specific session.
     */
    public closeSession(sessionId: string): void {
        const ws = this.connections.get(sessionId);
        if (ws) {
            ws.close();
            this.connections.delete(sessionId);
        }
        this.sessions.delete(sessionId);
        
        const pending = this.pendingConnections.get(sessionId);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingConnections.delete(sessionId);
            pending.reject(new Error('Session closed before WebSocket connected'));
        }

        logger.debug(`[MergeNB Web] Session closed: ${sessionId}`);
    }

    /**
     * Set baseline security headers on every response.
     */
    private setSecurityHeaders(res: http.ServerResponse): void {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; frame-ancestors 'none'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
    }

    /**
     * Handle HTTP requests.
     */
    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        this.setSecurityHeaders(res);

        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const pathname = url.pathname;
        const sessionId = url.searchParams.get('session');
        const sessionToken = url.searchParams.get('token');
        const origin = req.headers.origin;
        const expectedOrigin = `http://${this.host}:${this.port}`;

        // Only allow same-origin requests (compared against server-bound address, not request headers).
        if (origin && origin === expectedOrigin) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Vary', 'Origin');
        }

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (pathname === '/' || pathname === '/index.html') {
            // Serve minimal HTML shell that loads the React app
            const session = sessionId ? this.sessions.get(sessionId) : undefined;
            
            if (session && sessionToken && sessionToken === session.sessionToken) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(this.getHtmlShell(session.theme));
            } else {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html>
<html>
<head><title>MergeNB - Session Not Found</title></head>
<body style="font-family: system-ui; padding: 40px; background: #1e1e1e; color: #d4d4d4;">
    <h1>Session Not Found</h1>
    <p>The requested conflict resolution session could not be found.</p>
    <p>This may happen if:</p>
    <ul>
        <li>The session has expired or been closed</li>
        <li>The URL was copied incorrectly</li>
        <li>The extension was reloaded</li>
    </ul>
    <p><a href="#" onclick="window.close()">Close this window</a></p>
</body>
</html>`);
            }
        } else if (pathname === '/client.js' || pathname === '/client.js.map') {
            // Serve bundled React app from dist/web/
            this.serveStaticFile(res, pathname);
        } else if (pathname.startsWith('/fonts/')) {
            // Serve bundled web fonts from dist/web/fonts/
            this.serveStaticFile(res, pathname);
        } else if (pathname.startsWith('/katex/')) {
            // Serve KaTeX files from dist/web/katex/
            this.serveStaticFile(res, pathname);
        } else if (pathname === '/notebook-asset') {
            this.serveNotebookAsset(url, res);
        } else if (pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: 'ok', 
                port: this.port,
                activeSessions: this.sessions.size,
                activeConnections: this.connections.size
            }));
        } else {
            // 404 for other paths
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    }

    /**
     * Serve static files from dist/web/.
     * Validates that the resolved file path stays within the intended directory
     * to prevent directory traversal attacks.
     */
    private serveStaticFile(res: http.ServerResponse, pathname: string): void {
        const fileName = pathname.replace(/^\//, '');
        
        // Reject pathnames containing ".." to prevent directory traversal
        if (fileName.includes('..')) {
            logger.warn(`[MergeNB Web] Rejected path with ".." traversal: ${pathname}`);
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        const baseDir = this.extensionUri
            ? path.join(this.extensionUri.fsPath, 'dist', 'web')
            : path.join(__dirname, '..', '..', 'dist', 'web');
        
        const filePath = path.join(baseDir, fileName);

        // Resolve both paths to absolute paths and verify the file is within the base directory
        const resolvedBasePath = path.resolve(baseDir);
        const resolvedFilePath = path.resolve(filePath);

        if (!resolvedFilePath.startsWith(resolvedBasePath + path.sep) && resolvedFilePath !== resolvedBasePath) {
            logger.warn(`[MergeNB Web] Path traversal attempt blocked: ${pathname} -> ${resolvedFilePath}`);
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                logger.error(`[MergeNB Web] Failed to read ${filePath}:`, err.message);
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            } else {
                const ext = path.extname(fileName).toLowerCase();
                res.writeHead(200, { 'Content-Type': this.getContentType(ext) });
                res.end(data);
            }
        });
    }

    /**
     * Serve notebook-relative assets for markdown/html rendering in the web UI.
     *
     * Endpoint format:
     *   /notebook-asset?session=<sessionId>&path=<relative-path-from-notebook-dir>
     */
    private serveNotebookAsset(url: URL, res: http.ServerResponse): void {
        const sessionId = url.searchParams.get('session');
        const sessionToken = url.searchParams.get('token');
        const requestedPath = url.searchParams.get('path');

        if (!sessionId || !sessionToken || !requestedPath) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing session, token, or path');
            return;
        }

        const session = this.sessions.get(sessionId);
        if (!session?.notebookFilePath || session.sessionToken !== sessionToken) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Session not found');
            return;
        }

        const sanitizedPath = requestedPath.split(/[?#]/)[0];
        if (!sanitizedPath || sanitizedPath.includes('\0')) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid path');
            return;
        }

        // Reject protocols and network-path references.
        if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(sanitizedPath) || sanitizedPath.startsWith('//')) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        // Asset paths are restricted to the notebook directory (and its subdirectories).
        if (path.isAbsolute(sanitizedPath)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        const notebookDir = path.dirname(session.notebookFilePath);
        const resolvedNotebookDir = path.resolve(notebookDir);
        const resolvedAssetPath = path.resolve(notebookDir, sanitizedPath);

        if (
            !resolvedAssetPath.startsWith(resolvedNotebookDir + path.sep) &&
            resolvedAssetPath !== resolvedNotebookDir
        ) {
            logger.warn(`[MergeNB Web] Notebook asset traversal blocked: ${requestedPath} -> ${resolvedAssetPath}`);
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        fs.readFile(resolvedAssetPath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }

            const ext = path.extname(resolvedAssetPath).toLowerCase();
            res.writeHead(200, { 'Content-Type': this.getContentType(ext) });
            res.end(data);
        });
    }

    private getContentType(ext: string): string {
        const contentTypes: Record<string, string> = {
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.map': 'application/json',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.otf': 'font/otf',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.bmp': 'image/bmp',
            '.txt': 'text/plain; charset=utf-8',
            '.md': 'text/markdown; charset=utf-8',
            '.html': 'text/html; charset=utf-8',
            '.ipynb': 'application/x-ipynb+json',
        };
        return contentTypes[ext] || 'application/octet-stream';
    }

    /**
     * Generate minimal HTML shell that loads the React app.
     */
    private getHtmlShell(theme: 'dark' | 'light' = 'light'): string {
        const isDark = theme === 'dark';
        const loadingBg = isDark ? '#1D1915' : '#EAE2D5';
        const loadingText = isDark ? '#EFE7DB' : '#1A202C';
        const spinnerBorder = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)';
        const spinnerAccent = isDark ? '#7FB9C7' : '#569cd6';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MergeNB - Conflict Resolver</title>
    <!-- Preload critical fonts to prevent FOUC -->
    <link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@300..700&family=JetBrains+Mono:ital,wght@0,400..700;1,400..700&family=Playfair+Display:ital,wght@1,500&display=swap" as="style">
    <link rel="stylesheet" href="/katex/katex.min.css">
    <style>
        body { margin: 0; background: ${loadingBg}; }
        .loading-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            gap: 16px;
            color: ${loadingText};
            font-family: system-ui, -apple-system, sans-serif;
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid ${spinnerBorder};
            border-top-color: ${spinnerAccent};
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div id="root" data-theme="${theme === 'dark' ? 'dark' : 'light'}">
        <div class="loading-container">
            <div class="spinner"></div>
            <p>Loading MergeNB...</p>
        </div>
    </div>
    <script type="module" src="/client.js"></script>
</body>
</html>`;
    }

    /**
     * Handle WebSocket connections.
     */
    private handleWebSocketConnection(ws: WebSocket, req: http.IncomingMessage): void {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const sessionId = url.searchParams.get('session');
        const sessionToken = url.searchParams.get('token');

        if (!sessionId || !sessionToken) {
            ws.close(1008, 'Missing session credentials');
            return;
        }

        const session = this.sessions.get(sessionId);
        if (!session || session.sessionToken !== sessionToken) {
            ws.close(1008, 'Invalid session credentials');
            return;
        }

        logger.debug(`[MergeNB Web] WebSocket connected for session: ${sessionId}`);

        // Store the connection
        this.connections.set(sessionId, ws);

        // Resolve pending connection promise if exists
        const pending = this.pendingConnections.get(sessionId);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingConnections.delete(sessionId);
            pending.resolve(ws);
        }

        // Handle incoming messages
        ws.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                logger.debug(`[MergeNB Web] Received message from session ${sessionId}:`, message.command || message.type);
                
                if (session?.onMessage) {
                    session.onMessage(message);
                }
            } catch (error) {
                logger.error('[MergeNB Web] Error parsing WebSocket message:', error);
            }
        });

        ws.on('close', () => {
            logger.debug(`[MergeNB Web] WebSocket closed for session: ${sessionId}`);
            this.connections.delete(sessionId);
        });

        ws.on('error', (error: Error) => {
            logger.error(`[MergeNB Web] WebSocket error for session ${sessionId}:`, error);
        });

    }

    private generateSecret(): string {
        if (typeof randomUUID === 'function') {
            return randomUUID();
        }
        return randomBytes(16).toString('hex');
    }
}

/**
 * Get the conflict resolver web server instance.
 */
export function getWebServer(): ConflictResolverWebServer {
    return ConflictResolverWebServer.getInstance();
}
