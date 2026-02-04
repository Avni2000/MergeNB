/**
 * @file App.tsx
 * @description Root React component for the conflict resolver.
 */

import React from 'react';
import { useWebSocket } from './useWebSocket';
import { ConflictResolver } from './ConflictResolver';
import type { ConflictChoice, ResolvedRow } from './types';

export function App(): React.ReactElement {
    const { connected, conflictData, sendMessage } = useWebSocket();

    const handleResolve = (resolutions: ConflictChoice[], markAsResolved: boolean, resolvedRows: ResolvedRow[]) => {
        sendMessage({
            command: 'resolve',
            type: 'semantic',
            resolutions,
            resolvedRows,
            markAsResolved,
        });
    };

    const handleCancel = () => {
        sendMessage({ command: 'cancel' });
    };

    // Loading state
    if (!connected) {
        return (
            <div className="loading-container">
                <div className="spinner" />
                <p>Connecting to MergeNB...</p>
            </div>
        );
    }

    // Waiting for conflict data
    if (!conflictData) {
        return (
            <div className="loading-container">
                <div className="spinner" />
                <p>Loading conflict data...</p>
            </div>
        );
    }

    return (
        <ConflictResolver
            conflict={conflictData}
            onResolve={handleResolve}
            onCancel={handleCancel}
        />
    );
}
