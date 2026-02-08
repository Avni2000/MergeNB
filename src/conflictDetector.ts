/**
 * @file conflictDetector.ts
 * @description Conflict detection and analysis engine for MergeNB.
 * 
 * Handles semantic conflicts (Git UU status):
 *    - Cell added/deleted/modified in both branches
 *    - Cell reordering conflicts
 *    - Output and execution count differences
 *    - Metadata changes
 * 
 * Also provides auto-resolution for trivial conflicts (execution counts,
 * outputs, kernel versions) based on user settings.
 */

import { NotebookSemanticConflict, SemanticConflict, CellMapping } from './types';
import { Notebook, NotebookCell, NotebookMetadata } from './types';
import * as gitIntegration from './gitIntegration';
import { matchCells, detectReordering } from './cellMatcher';
import { parseNotebook } from './notebookParser';
import { getSettings, MergeNBSettings } from './settings';

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
    /** Whether kernel metadata was auto-resolved */
    kernelAutoResolved: boolean;
}

/**
 * Detect semantic conflicts (Git UU status)
 * Compares base/current/incoming versions from Git staging areas
 */
export async function detectSemanticConflicts(filePath: string): Promise<NotebookSemanticConflict | null> {
    try {
        // Get the three-way versions from Git
        const versions = await gitIntegration.getThreeWayVersions(filePath);
        if (!versions) {
            return null; // Not an unmerged file
        }

        const { base, current, incoming } = versions;

        // Debug: Check if we're getting different versions
        console.log('[MergeNB] detectSemanticConflicts for:', filePath);
        console.log('[MergeNB] base length:', base?.length ?? 0);
        console.log('[MergeNB] current length:', current?.length ?? 0);
        console.log('[MergeNB] incoming length:', incoming?.length ?? 0);
        console.log('[MergeNB] base === current:', base === current);
        console.log('[MergeNB] base === incoming:', base === incoming);
        console.log('[MergeNB] current === incoming:', current === incoming);

        // Parse each version as a notebook
        let baseNotebook: Notebook | undefined;
        let currentNotebook: Notebook | undefined;
        let incomingNotebook: Notebook | undefined;

        try {
            if (base) baseNotebook = parseNotebook(base);
        } catch (error) {
            console.warn('Failed to parse base notebook:', error);
        }

        try {
            if (current) currentNotebook = parseNotebook(current);
        } catch (error) {
            console.warn('Failed to parse current notebook:', error);
        }

        try {
            if (incoming) incomingNotebook = parseNotebook(incoming);
        } catch (error) {
            console.warn('Failed to parse incoming notebook:', error);
        }


        // If we couldn't parse at least current and incoming, can't detect semantic conflicts
        if (!currentNotebook && !incomingNotebook) {
            return null;
        }

        // Match cells across versions
        const cellMappings = matchCells(baseNotebook, currentNotebook, incomingNotebook);

        // Analyze mappings to find semantic conflicts
        const semanticConflicts = analyzeSemanticConflictsFromMappings(cellMappings);

        // Get branch information
        const [currentBranch, incomingBranch] = await Promise.all([
            gitIntegration.getCurrentBranch(filePath),
            gitIntegration.getMergeBranch(filePath)
        ]);

        return {
            filePath,
            semanticConflicts,
            cellMappings,
            base: baseNotebook,
            current: currentNotebook,
            incoming: incomingNotebook,
            currentBranch: currentBranch || undefined,
            incomingBranch: incomingBranch || undefined
        };
    } catch (error) {
        console.error('Error detecting semantic conflicts:', error);
        return null;
    }
}

/**
 * Analyze cell mappings to identify semantic conflicts.
 * Exported for testing purposes.
 */
export function analyzeSemanticConflictsFromMappings(mappings: CellMapping[]): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];

    // Check for cell reordering
    if (detectReordering(mappings)) {
        conflicts.push({
            type: 'cell-reordered',
            description: 'Cells have been reordered between versions'
        });
    }

    for (const mapping of mappings) {
        const { baseIndex, currentIndex, incomingIndex, baseCell, currentCell, incomingCell } = mapping;

        // Case 1: Cell added in current only
        if (currentCell && !baseCell && !incomingCell) {
            conflicts.push({
                type: 'cell-added',
                currentCellIndex: currentIndex,
                currentContent: currentCell,
                description: 'Cell added in current branch'
            });
            continue;
        }

        // Case 2: Cell added in incoming only
        if (incomingCell && !baseCell && !currentCell) {
            conflicts.push({
                type: 'cell-added',
                incomingCellIndex: incomingIndex,
                incomingContent: incomingCell,
                description: 'Cell added in incoming branch'
            });
            continue;
        }

        // Case 3: Cell added in both (conflict!)
        if (currentCell && incomingCell && !baseCell) {
            const currentSource = Array.isArray(currentCell.source) ? currentCell.source.join('') : currentCell.source;
            const incomingSource = Array.isArray(incomingCell.source) ? incomingCell.source.join('') : incomingCell.source;

            if (currentSource !== incomingSource) {
                conflicts.push({
                    type: 'cell-added',
                    currentCellIndex: currentIndex,
                    incomingCellIndex: incomingIndex,
                    currentContent: currentCell,
                    incomingContent: incomingCell,
                    description: 'Different cells added in same position'
                });
            }
            continue;
        }

        // Case 4: Cell deleted in current
        if (baseCell && !currentCell && incomingCell) {
            conflicts.push({
                type: 'cell-deleted',
                baseCellIndex: baseIndex,
                incomingCellIndex: incomingIndex,
                baseContent: baseCell,
                incomingContent: incomingCell,
                description: 'Cell deleted in current branch'
            });
            continue;
        }

        // Case 5: Cell deleted in incoming
        if (baseCell && currentCell && !incomingCell) {
            conflicts.push({
                type: 'cell-deleted',
                baseCellIndex: baseIndex,
                currentCellIndex: currentIndex,
                baseContent: baseCell,
                currentContent: currentCell,
                description: 'Cell deleted in incoming branch'
            });
            continue;
        }

        // Case 6: Cell deleted in both (no conflict, just deleted)
        if (baseCell && !currentCell && !incomingCell) {
            // Not a conflict, skip
            continue;
        }

        // Case 7: Cell exists in all three - check for modifications
        if (baseCell && currentCell && incomingCell) {
            const conflicts_found = compareCells(baseCell, currentCell, incomingCell, baseIndex, currentIndex, incomingIndex);
            conflicts.push(...conflicts_found);
        }
    }

    return conflicts;
}

/**
 * Compare a cell across three versions to find specific conflicts
 */
function compareCells(
    baseCell: NotebookCell,
    currentCell: NotebookCell,
    incomingCell: NotebookCell,
    baseIndex?: number,
    currentIndex?: number,
    incomingIndex?: number
): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];

    // Compare source content
    const baseSource = Array.isArray(baseCell.source) ? baseCell.source.join('') : baseCell.source;
    const currentSource = Array.isArray(currentCell.source) ? currentCell.source.join('') : currentCell.source;
    const incomingSource = Array.isArray(incomingCell.source) ? incomingCell.source.join('') : incomingCell.source;

    const currentModified = currentSource !== baseSource;
    const incomingModified = incomingSource !== baseSource;

    // Both modified the source differently
    if (currentModified && incomingModified && currentSource !== incomingSource) {
        conflicts.push({
            type: 'cell-modified',
            baseCellIndex: baseIndex,
            currentCellIndex: currentIndex,
            incomingCellIndex: incomingIndex,
            baseContent: baseCell,
            currentContent: currentCell,
            incomingContent: incomingCell,
            description: 'Cell source modified in both branches differently'
        });
    }

    // Compare execution_count (only for code cells)
    if (baseCell.cell_type === 'code' && currentCell.cell_type === 'code' && incomingCell.cell_type === 'code') {
        const baseExecCount = baseCell.execution_count;
        const currentExecCount = currentCell.execution_count;
        const incomingExecCount = incomingCell.execution_count;

        if (currentExecCount !== incomingExecCount && 
            (currentExecCount !== baseExecCount || incomingExecCount !== baseExecCount)) {
            conflicts.push({
                type: 'execution-count-changed',
                baseCellIndex: baseIndex,
                currentCellIndex: currentIndex,
                incomingCellIndex: incomingIndex,
                baseContent: baseCell,
                currentContent: currentCell,
                incomingContent: incomingCell,
                description: `Execution count differs: current=${currentExecCount}, incoming=${incomingExecCount}`
            });
        }

        // Compare outputs
        const baseOutputs = JSON.stringify(baseCell.outputs || []);
        const currentOutputs = JSON.stringify(currentCell.outputs || []);
        const incomingOutputs = JSON.stringify(incomingCell.outputs || []);

        if (currentOutputs !== incomingOutputs && 
            (currentOutputs !== baseOutputs || incomingOutputs !== baseOutputs)) {
            conflicts.push({
                type: 'outputs-changed',
                baseCellIndex: baseIndex,
                currentCellIndex: currentIndex,
                incomingCellIndex: incomingIndex,
                baseContent: baseCell,
                currentContent: currentCell,
                incomingContent: incomingCell,
                description: 'Cell outputs differ between branches'
            });
        }
    }

    // Compare metadata
    const baseMetadata = JSON.stringify(baseCell.metadata);
    const currentMetadata = JSON.stringify(currentCell.metadata);
    const incomingMetadata = JSON.stringify(incomingCell.metadata);

    const currentMetadataModified = currentMetadata !== baseMetadata;
    const incomingMetadataModified = incomingMetadata !== baseMetadata;

    if (currentMetadataModified && incomingMetadataModified && currentMetadata !== incomingMetadata) {
        conflicts.push({
            type: 'metadata-changed',
            baseCellIndex: baseIndex,
            currentCellIndex: currentIndex,
            incomingCellIndex: incomingIndex,
            baseContent: baseCell,
            currentContent: currentCell,
            incomingContent: incomingCell,
            description: 'Cell metadata modified in both branches differently'
        });
    }

    return conflicts;
}

/**
 * Apply auto-resolutions to semantic conflicts based on user settings.
 * Returns filtered conflicts that still need manual resolution.
 */
export function applyAutoResolutions(
    semanticConflict: NotebookSemanticConflict,
    settings?: MergeNBSettings
): AutoResolveResult {
    const effectiveSettings = settings || getSettings();
    const remainingConflicts: SemanticConflict[] = [];
    const autoResolvedDescriptions: string[] = [];
    let autoResolvedCount = 0;
    let kernelAutoResolved = false;

    // Start with a deep copy of the current notebook as our resolved version
    const resolvedNotebook: Notebook = semanticConflict.current 
        ? JSON.parse(JSON.stringify(semanticConflict.current))
        : JSON.parse(JSON.stringify(semanticConflict.incoming!));

    // Track cell indices that had auto-resolutions applied
    const autoResolvedCellIndices = new Set<number>();

    for (const conflict of semanticConflict.semanticConflicts) {
        let autoResolved = false;

        // Auto-resolve execution count differences
        if (conflict.type === 'execution-count-changed' && effectiveSettings.autoResolveExecutionCount) {
            // Set execution_count to null on the resolved cell
            if (conflict.currentCellIndex !== undefined && resolvedNotebook.cells[conflict.currentCellIndex]) {
                resolvedNotebook.cells[conflict.currentCellIndex].execution_count = null;
                autoResolvedCellIndices.add(conflict.currentCellIndex);
            }
            autoResolved = true;
            autoResolvedCount++;
            autoResolvedDescriptions.push(`Execution count set to null (cell ${(conflict.currentCellIndex ?? 0) + 1})`);
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
                if (conflict.currentCellIndex !== undefined && resolvedNotebook.cells[conflict.currentCellIndex]) {
                    resolvedNotebook.cells[conflict.currentCellIndex].outputs = [];
                    resolvedNotebook.cells[conflict.currentCellIndex].execution_count = null;
                    autoResolvedCellIndices.add(conflict.currentCellIndex);
                }
                autoResolved = true;
                autoResolvedCount++;
                autoResolvedDescriptions.push(`Outputs cleared (cell ${(conflict.currentCellIndex ?? 0) + 1})`);
            }
        }

        if (!autoResolved) {
            remainingConflicts.push(conflict);
        }
    }

    // Auto-resolve kernel version differences (notebook-level metadata)
    if (effectiveSettings.autoResolveKernelVersion) {
        const currentKernel = semanticConflict.current?.metadata?.kernelspec;
        const incomingKernel = semanticConflict.incoming?.metadata?.kernelspec;
        const baseKernel = semanticConflict.base?.metadata?.kernelspec;

        // Check if kernel versions differ between current and incoming
        if (currentKernel && incomingKernel) {
            const currentKernelStr = JSON.stringify(currentKernel);
            const incomingKernelStr = JSON.stringify(incomingKernel);
            const baseKernelStr = baseKernel ? JSON.stringify(baseKernel) : '';

            if (currentKernelStr !== incomingKernelStr && 
                (currentKernelStr !== baseKernelStr || incomingKernelStr !== baseKernelStr)) {
                // Use current kernel (already in resolvedNotebook)
                kernelAutoResolved = true;
                autoResolvedCount++;
                autoResolvedDescriptions.push('Kernel version: using current version');
            }
        }

        // Also check language_info version
        const currentLangInfo = semanticConflict.current?.metadata?.language_info;
        const incomingLangInfo = semanticConflict.incoming?.metadata?.language_info;
        const baseLangInfo = semanticConflict.base?.metadata?.language_info;

        if (currentLangInfo && incomingLangInfo) {
            const currentLangStr = JSON.stringify(currentLangInfo);
            const incomingLangStr = JSON.stringify(incomingLangInfo);
            const baseLangStr = baseLangInfo ? JSON.stringify(baseLangInfo) : '';

            if (currentLangStr !== incomingLangStr && 
                (currentLangStr !== baseLangStr || incomingLangStr !== baseLangStr)) {
                // Use current language_info (already in resolvedNotebook)
                if (!kernelAutoResolved) {
                    autoResolvedCount++;
                    autoResolvedDescriptions.push('Python version: using current version');
                }
                kernelAutoResolved = true;
            }
        }
    }

    // Strip outputs from any remaining conflicted cells if enabled
    if (effectiveSettings.stripOutputs) {
        // For remaining conflicts that weren't auto-resolved, still strip outputs
        for (const conflict of remainingConflicts) {
            if (conflict.currentCellIndex !== undefined && !autoResolvedCellIndices.has(conflict.currentCellIndex)) {
                const cell = resolvedNotebook.cells[conflict.currentCellIndex];
                if (cell && cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0) {
                    cell.outputs = [];
                    autoResolvedDescriptions.push(`Outputs stripped (cell ${conflict.currentCellIndex + 1})`);
                }
            }
        }
    }

    return {
        remainingConflicts,
        autoResolvedCount,
        autoResolvedDescriptions,
        resolvedNotebook,
        kernelAutoResolved
    };
}

/**
 * Check if a notebook has kernel version differences between current and incoming
 */
export function hasKernelVersionConflict(
    current?: Notebook,
    incoming?: Notebook,
    base?: Notebook
): boolean {
    if (!current || !incoming) return false;

    const currentKernel = current.metadata?.kernelspec;
    const incomingKernel = incoming.metadata?.kernelspec;
    const baseKernel = base?.metadata?.kernelspec;

    if (!currentKernel || !incomingKernel) return false;

    const currentStr = JSON.stringify(currentKernel);
    const incomingStr = JSON.stringify(incomingKernel);
    const baseStr = baseKernel ? JSON.stringify(baseKernel) : '';

    return currentStr !== incomingStr && (currentStr !== baseStr || incomingStr !== baseStr);
}
