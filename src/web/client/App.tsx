/**
 * @file App.tsx
 * @description Root React component for the conflict resolver.
 */

import React from 'react';
import { useWebSocket } from './useWebSocket';
import { ConflictResolver } from './ConflictResolver';
import type { ConflictChoice, ResolvedRow } from './types';

export function App(): React.ReactElement {
    const { connected, conflictData, sendMessage, resolutionStatus, resolutionMessage } = useWebSocket();

    const handleResolve = (resolutions: ConflictChoice[], markAsResolved: boolean, renumberExecutionCounts: boolean, resolvedRows: ResolvedRow[]) => {
        sendMessage({
            command: 'resolve',
            type: 'semantic',
            resolutions,
            resolvedRows,
            markAsResolved,
            renumberExecutionCounts,
        });
    };

    const handleCancel = () => {
        sendMessage({ command: 'cancel' });
    };

    // Success state - check this FIRST so we don't go back to loading when WebSocket disconnects
    if (resolutionStatus === 'success') {
        return (
            <div className="loading-container">
                <div className="success-icon">✓</div>
                <p className="success-message">{resolutionMessage}</p>
                <p className="success-subtitle">
                    You can close this tab and return to VSCode.
                </p>
            </div>
        );
    }

    // Error state - check this SECOND so we don't go back to loading if there's an error
    if (resolutionStatus === 'error') {
        return (
            <div className="loading-container">
                <div className="error-icon">✕</div>
                <p className="error-message">{resolutionMessage}</p>
                <button
                    className="retry-button"
                    onClick={() => window.location.reload()}
                >
                    Try Again
                </button>
            </div>
        );
    }

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
