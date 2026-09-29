import type { NotebookSemanticConflict, SemanticConflict, Notebook, MergeNBSettings } from './types';
import { assignedCellIds } from './cellIds';
import { normalizeCellSource } from './notebookUtils';
import { mergeNotebookFields } from './notebookFields';
import type { FieldConflict } from './fieldMerge';
import { buildResolvedNotebookFromRows } from './semanticResolution';

function isWhitespaceOnlyDifference(left: string, right: string): boolean {
    if (left === right) return false;
    const normalizeLines = (s: string) =>
        s.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n');
    return normalizeLines(left) === normalizeLines(right);
}

/**
 * Result of auto-resolution preprocessing
 */
export interface AutoResolveResult {
    /** Filtered conflicts that still need manual resolution */
    remainingConflicts: SemanticConflict[];
    /** Number of conflicts auto-resolved */
    autoResolvedCount: number;
    /** Description of what was auto-resolved */
    autoResolvedDescriptions: string[];
    /** The notebook with auto-resolutions applied */
    resolvedNotebook: Notebook;
    /** Current-side cells retain their original indices for the three-column view. */
    currentNotebook: Notebook;
    notebookConflicts: FieldConflict[];
    settings: MergeNBSettings;
    assignedCellIds: string[];
    /** Whether kernel metadata was auto-resolved */
    kernelAutoResolved: boolean;
}

/**
 * Apply auto-resolutions to semantic conflicts based on user settings.
 * Returns filtered conflicts that still need manual resolution.
 */
export function applyAutoResolutions(
    semanticConflict: NotebookSemanticConflict,
    settings: MergeNBSettings
): AutoResolveResult {
    const effectiveSettings = settings;
    const remainingConflicts: SemanticConflict[] = [];
    const autoResolvedDescriptions: string[] = [];
    let autoResolvedCount = 0;
    let kernelAutoResolved = false;

    // Start with a deep copy of the current notebook as our resolved version
    const resolvedNotebook: Notebook = semanticConflict.current 
        ? JSON.parse(JSON.stringify(semanticConflict.current))
        : JSON.parse(JSON.stringify(semanticConflict.incoming!));

    const resolvedFromCurrent = Boolean(semanticConflict.current);
    const getResolvedCellIndex = (conflict: SemanticConflict): number | undefined => {
        if (resolvedFromCurrent) {
            return conflict.currentCellIndex ?? conflict.incomingCellIndex;
        }
        return conflict.incomingCellIndex ?? conflict.currentCellIndex;
    };

    // Track cell indices that had auto-resolutions applied
    const autoResolvedCellIndices = new Set<number>();

    for (const conflict of semanticConflict.semanticConflicts) {
        let autoResolved = false;

        // Auto-resolve execution count differences
        if (conflict.type === 'execution-count-changed' && effectiveSettings.autoResolveExecutionCount) {
            const resolvedCellIndex = getResolvedCellIndex(conflict);
            // Set execution_count to null on the resolved cell
            if (resolvedCellIndex !== undefined && resolvedNotebook.cells[resolvedCellIndex]) {
                resolvedNotebook.cells[resolvedCellIndex].execution_count = null;
                autoResolvedCellIndices.add(resolvedCellIndex);
            }
            autoResolved = true;
            autoResolvedCount++;
            autoResolvedDescriptions.push(`Execution count set to null (cell ${(resolvedCellIndex ?? 0) + 1})`);
        }

        // Auto-resolve outputs-changed conflicts when stripOutputs is enabled
        // Only if the source code is identical (pure output difference)
        if (conflict.type === 'outputs-changed' && effectiveSettings.stripOutputs) {
            const currentSource = conflict.currentContent?.source;
            const incomingSource = conflict.incomingContent?.source;
            
            const currentSourceStr = Array.isArray(currentSource) ? currentSource.join('') : (currentSource || '');
            const incomingSourceStr = Array.isArray(incomingSource) ? incomingSource.join('') : (incomingSource || '');
            
            // If source is identical, this is purely an output difference - auto-resolve
            if (currentSourceStr === incomingSourceStr) {
                const resolvedCellIndex = getResolvedCellIndex(conflict);
                if (resolvedCellIndex !== undefined && resolvedNotebook.cells[resolvedCellIndex]) {
                    resolvedNotebook.cells[resolvedCellIndex].outputs = [];
                    // Only null execution_count if autoResolveExecutionCount is also enabled
                    if (effectiveSettings.autoResolveExecutionCount) {
                        resolvedNotebook.cells[resolvedCellIndex].execution_count = null;
                    }
                    autoResolvedCellIndices.add(resolvedCellIndex);
                }
                autoResolved = true;
                autoResolvedCount++;
                autoResolvedDescriptions.push(`Outputs cleared (cell ${(resolvedCellIndex ?? 0) + 1})`);
            }
        }

        // Auto-resolve whitespace-only differences when enabled
        if (!autoResolved && effectiveSettings.autoResolveWhitespace) {
            if (conflict.type === 'cell-modified') {
                const currentSource = conflict.currentContent?.source;
                const incomingSource = conflict.incomingContent?.source;

                const currentSourceStr = Array.isArray(currentSource) ? currentSource.join('') : (currentSource || '');
                const incomingSourceStr = Array.isArray(incomingSource) ? incomingSource.join('') : (incomingSource || '');

                if (isWhitespaceOnlyDifference(currentSourceStr, incomingSourceStr)) {
                    autoResolved = true;
                    autoResolvedCount++;
                    const resolvedCellIndex = getResolvedCellIndex(conflict) ?? 0;
                    autoResolvedDescriptions.push(`Whitespace-only change resolved (cell ${resolvedCellIndex + 1})`);
                }
            }

            if (!autoResolved && conflict.type === 'cell-added' && conflict.currentContent && conflict.incomingContent) {
                const currentSource = normalizeCellSource(conflict.currentContent.source);
                const incomingSource = normalizeCellSource(conflict.incomingContent.source);

                if (isWhitespaceOnlyDifference(currentSource, incomingSource)) {
                    autoResolved = true;
                    autoResolvedCount++;
                    const resolvedCellIndex = getResolvedCellIndex(conflict) ?? 0;
                    autoResolvedDescriptions.push(`Whitespace-only added cell resolved (cell ${resolvedCellIndex + 1})`);
                }
            }
        }

        if (!autoResolved) {
            remainingConflicts.push(conflict);
        }
    }

    const fields = mergeNotebookFields(semanticConflict, settings.autoResolveKernelVersion);
    const kernelKeys = new Set(fields.kernelFields.map(field => field.path[1]));
    for (const key of kernelKeys) {
        const label = key === 'kernelspec' ? 'Kernel version' : 'Python version';
        autoResolvedDescriptions.push(settings.autoResolveKernelVersion
            ? `${label}: using current version`
            : `${label}: choose a value (auto-resolve disabled)`);
    }
    kernelAutoResolved = settings.autoResolveKernelVersion && kernelKeys.size > 0;
    if (kernelAutoResolved) autoResolvedCount++;

    // Strip outputs from any remaining conflicted cells if enabled
    if (effectiveSettings.stripOutputs) {
        // For remaining conflicts that weren't auto-resolved, still strip outputs
        for (const conflict of remainingConflicts) {
            const resolvedCellIndex = getResolvedCellIndex(conflict);
            if (resolvedCellIndex !== undefined && !autoResolvedCellIndices.has(resolvedCellIndex)) {
                const cell = resolvedNotebook.cells[resolvedCellIndex];
                if (cell && cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0) {
                    cell.outputs = [];
                    if (effectiveSettings.autoResolveExecutionCount) {
                        cell.execution_count = null;
                    }
                    autoResolvedDescriptions.push(`Outputs stripped (cell ${resolvedCellIndex + 1})`);
                }
            }
        }
    }
    
    const currentNotebook = resolvedNotebook;
    const mergedNotebook = buildResolvedNotebookFromRows({
        semanticConflict,
        resolvedRows: semanticConflict.cellMappings.map(mapping => ({
            baseCell: mapping.baseCell,
            currentCell: mapping.currentIndex === undefined ? undefined : currentNotebook.cells[mapping.currentIndex],
            incomingCell: mapping.incomingCell,
            baseCellIndex: mapping.baseIndex,
            currentCellIndex: mapping.currentIndex,
            incomingCellIndex: mapping.incomingIndex,
        })),
        settings,
        shouldRenumber: false,
        allowUnresolvedNotebookFields: true,
    });
    return {
        remainingConflicts,
        autoResolvedCount,
        autoResolvedDescriptions,
        resolvedNotebook: mergedNotebook,
        currentNotebook,
        notebookConflicts: fields.conflicts,
        assignedCellIds: assignedCellIds(mergedNotebook, [semanticConflict.base, semanticConflict.current, semanticConflict.incoming]),
        settings,
        kernelAutoResolved
    };
}
