/**
 * @file useWebSocket.ts
 * @description React hook for WebSocket communication with the extension.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { UnifiedConflictData, WSMessage } from '../types';
import * as logger from '../../../../core/src';

interface UseWebSocketResult {
    connected: boolean;
    conflictData: UnifiedConflictData | null;
    sendMessage: (message: object) => void;
    resolutionStatus: 'success' | 'error' | null;
    resolutionMessage: string | null;
}

export function useWebSocket(): UseWebSocketResult {
    const [connected, setConnected] = useState(false);
    const [conflictData, setConflictData] = useState<UnifiedConflictData | null>(null);
    const [resolutionStatus, setResolutionStatus] = useState<'success' | 'error' | null>(null);
    const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

    useEffect(() => {
        // Get session ID from URL
        const params = new URLSearchParams(window.location.search);
        const session = params.get('session') || 'default';
        const token = params.get('token') || '';

        // Connect WebSocket
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/?session=${encodeURIComponent(session)}&token=${encodeURIComponent(token)}`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            logger.debug('[MergeNB] WebSocket connected');
            setConnected(true);
            ws.send(JSON.stringify({ command: 'ready' }));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data) as WSMessage;
                logger.debug('[MergeNB] Received:', msg);

                if ('type' in msg) {
                    if (msg.type === 'conflict-data') {
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
                logger.error('[MergeNB] Failed to parse message:', err);
            }
        };

        ws.onclose = () => {
            logger.debug('[MergeNB] WebSocket closed');
            setConnected(false);
        };

        ws.onerror = (err) => {
            logger.error('[MergeNB] WebSocket error:', err);
        };

        return () => {
            ws.close();
        };
    }, []);

    const sendMessage = useCallback((message: object & { command?: string }) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(message));
        } else {
            logger.warn('[MergeNB] Cannot send - WebSocket not connected');
        }
    }, []);

    return { connected, conflictData, sendMessage, resolutionStatus, resolutionMessage };
}
