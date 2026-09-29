import { useMemo } from 'react';
import { buildResolvedNotebookFromRows, validateNotebook, type Notebook } from '../../../../core/src';
import type { ResolverSnapshot } from '../store/resolverStore';
import type { UnifiedConflictData } from '../types';
import { resolvedRowsFromState } from '../utils/resolvedRows';

export function useResolutionPreview(
    conflict: UnifiedConflictData,
    state: ResolverSnapshot,
    allResolved: boolean
): { notebook?: Notebook; error?: string } {
    return useMemo(() => {
        if (!allResolved || !conflict.semanticConflict || !conflict.autoResolveResult) return {};
        try {
            const notebook = buildResolvedNotebookFromRows({
                semanticConflict: conflict.semanticConflict,
                autoResolveResult: conflict.autoResolveResult,
                settings: conflict.autoResolveResult.settings,
                resolvedRows: resolvedRowsFromState(state),
                shouldRenumber: state.renumberExecutionCounts,
                preferredSideHint: state.takeAllChoice,
                notebookResolutions: state.notebookChoices,
            });
            validateNotebook(notebook);
            return { notebook };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }, [conflict, state.rows, state.choices, state.notebookChoices, state.renumberExecutionCounts, state.takeAllChoice, allResolved]);
}
