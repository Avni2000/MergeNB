/**
 * @file WarningModal.tsx
 * @description Shared confirm/cancel warning dialog rendered into document.body.
 */

import React from 'react';
import { createPortal } from 'react-dom';

interface WarningModalProps {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
    /** data-testid for the overlay element (used to locate the modal in tests). */
    testId?: string;
    /** data-testid for the confirm button. */
    confirmTestId?: string;
    /** Mark the overlay as an editing-allowed surface so editor blur autosave is suppressed. */
    editingAllow?: boolean;
}

export function WarningModal({
    title,
    message,
    confirmLabel,
    cancelLabel = 'Keep my edits',
    onConfirm,
    onCancel,
    testId,
    confirmTestId,
    editingAllow = false,
}: WarningModalProps): React.ReactElement {
    return createPortal(
        <div
            className="warning-modal-overlay"
            data-testid={testId}
            data-editing-allow={editingAllow ? 'true' : undefined}
        >
            <div className="warning-modal">
                <div className="warning-icon">⚠️</div>
                <h3>{title}</h3>
                <p>{message}</p>
                <div className="warning-actions">
                    <button className="btn-cancel" onClick={onCancel}>
                        {cancelLabel}
                    </button>
                    <button
                        className="btn-confirm"
                        onClick={onConfirm}
                        data-testid={confirmTestId}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
