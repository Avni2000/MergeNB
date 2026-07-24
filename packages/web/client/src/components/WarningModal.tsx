/**
 * @file WarningModal.tsx
 * @description Shared confirm/cancel warning dialog rendered into document.body.
 */

import React, { useEffect, useId, useRef } from 'react';
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
    const titleId = useId();
    const messageId = useId();
    const cancelRef = useRef<HTMLButtonElement>(null);
    const confirmRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const previouslyFocused = document.activeElement as HTMLElement | null;
        confirmRef.current?.focus();
        return () => {
            previouslyFocused?.focus();
        };
    }, []);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
        }
        if (event.key !== 'Tab') {
            return;
        }
        const first = cancelRef.current;
        const last = confirmRef.current;
        if (!first || !last) {
            return;
        }
        if (event.shiftKey) {
            if (document.activeElement === first) {
                event.preventDefault();
                last.focus();
            }
        } else {
            if (document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    };

    return createPortal(
        <div
            className="warning-modal-overlay"
            data-testid={testId}
            data-editing-allow={editingAllow ? 'true' : undefined}
        >
            <div
                className="warning-modal"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={messageId}
                onKeyDown={handleKeyDown}
            >
                <div className="warning-icon">⚠️</div>
                <h3 id={titleId}>{title}</h3>
                <p id={messageId}>{message}</p>
                <div className="warning-actions">
                    <button className="btn-cancel" onClick={onCancel} ref={cancelRef}>
                        {cancelLabel}
                    </button>
                    <button
                        className="btn-confirm"
                        onClick={onConfirm}
                        data-testid={confirmTestId}
                        ref={confirmRef}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
