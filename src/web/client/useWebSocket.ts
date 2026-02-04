/**
 * @file useWebSocket.ts
 * @description React hook for WebSocket communication with the extension.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { UnifiedConflictData, WSMessage } from './types';

interface UseWebSocketResult {
    connected: boolean;
    sessionId: string | null;
    conflictData: UnifiedConflictData | null;
    sendMessage: (message: object) => void;
    resolutionStatus: 'pending' | 'success' | 'error' | null;
    resolutionMessage: string | null;
}

export function useWebSocket(): UseWebSocketResult {
    const [connected, setConnected] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [conflictData, setConflictData] = useState<UnifiedConflictData | null>(null);
    const [resolutionStatus, setResolutionStatus] = useState<'pending' | 'success' | 'error' | null>(null);
    const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

    useEffect(() => {
        // Get session ID from URL
        const params = new URLSearchParams(window.location.search);
        const session = params.get('session') || 'default';

        // Connect WebSocket
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/?session=${encodeURIComponent(session)}`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('[MergeNB] WebSocket connected');
            setConnected(true);
            ws.send(JSON.stringify({ command: 'ready' }));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data) as WSMessage;
                console.log('[MergeNB] Received:', msg);

                if ('type' in msg) {
                    if (msg.type === 'connected') {
                        setSessionId(msg.sessionId);
                    } else if (msg.type === 'conflict-data') {
                        setConflictData(msg.data);
                    } else if (msg.type === 'resolution-success') {
                        setResolutionStatus('success');
                        setResolutionMessage(msg.message);
                    } else if (msg.type === 'resolution-error') {
                        setResolutionStatus('error');
                        setResolutionMessage(msg.message);
                    }
                }
            } catch (err) {
                console.error('[MergeNB] Failed to parse message:', err);
            }
        };

        ws.onclose = () => {
            console.log('[MergeNB] WebSocket closed');
            setConnected(false);
        };

        ws.onerror = (err) => {
            console.error('[MergeNB] WebSocket error:', err);
        };

        return () => {
            ws.close();
        };
    }, []);

    const sendMessage = useCallback((message: object & { command?: string }) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(message));
            // Only set pending status for resolve commands
            if (message.command === 'resolve') {
                setResolutionStatus('pending');
            }
        } else {
            console.warn('[MergeNB] Cannot send - WebSocket not connected');
        }
    }, []);

    return { connected, sessionId, conflictData, sendMessage, resolutionStatus, resolutionMessage };
}
