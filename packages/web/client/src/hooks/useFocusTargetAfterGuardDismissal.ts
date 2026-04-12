import { useCallback, useLayoutEffect, useRef } from 'react';
import type { EditorView } from '@codemirror/view';

/**
 * Returns focus to a CodeMirror {@link EditorView} after a blocking overlay closes.
 *
 * Flow: call `prepareFocusReturn` in the same event handler that closes the guard, register
 * the editor with `onEditorReady` from `onCreateEditor`. On the next layout phase after the
 * guard unmounts, the view receives focus — no animation frames or manual DOM queries.
 */
export function useFocusTargetAfterGuardDismissal(guardOpen: boolean): {
    onEditorReady: (view: EditorView) => void;
    prepareFocusReturn: () => void;
} {
    const viewRef = useRef<EditorView | null>(null);
    const focusPendingRef = useRef(false);

    const onEditorReady = useCallback((view: EditorView) => {
        viewRef.current = view;
    }, []);

    const prepareFocusReturn = useCallback(() => {
        focusPendingRef.current = true;
    }, []);

    useLayoutEffect(() => {
        if (guardOpen || !focusPendingRef.current) {
            return;
        }
        focusPendingRef.current = false;
        viewRef.current?.focus();
    }, [guardOpen]);

    return { onEditorReady, prepareFocusReturn };
}
