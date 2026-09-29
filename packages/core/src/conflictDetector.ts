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

import { NotebookSemanticConflict, Notebook, GitOperations } from './types';
import { matchCells } from './cellMatcher';
import { parseNotebook } from './notebookParser';
import { analyzeSemanticConflictsFromMappings } from './cellConflicts';
export { analyzeSemanticConflictsFromMappings } from './cellConflicts';
export { applyAutoResolutions, type AutoResolveResult } from './autoResolution';
import * as logger from './logger';

/**
 * Detect semantic conflicts (Git UU status)
 * Compares base/current/incoming versions from Git staging areas
 */
export async function detectSemanticConflicts(filePath: string, gitOps: GitOperations): Promise<NotebookSemanticConflict | null> {
    try {
        const versions = await gitOps.getThreeWayVersions(filePath);
        if (!versions) {
            return null;
        }

        const { base, current, incoming } = versions;

        let baseNotebook: Notebook | undefined;
        let currentNotebook: Notebook | undefined;
        let incomingNotebook: Notebook | undefined;

        try {
            if (base) baseNotebook = parseNotebook(base);
        } catch (error) {
            logger.warn('Failed to parse base notebook:', error);
        }

        try {
            if (current) currentNotebook = parseNotebook(current);
        } catch (error) {
            logger.warn('Failed to parse current notebook:', error);
        }

        try {
            if (incoming) incomingNotebook = parseNotebook(incoming);
        } catch (error) {
            logger.warn('Failed to parse incoming notebook:', error);
        }

        if (!currentNotebook && !incomingNotebook) {
            return null;
        }

        const cellMappings = matchCells(baseNotebook, currentNotebook, incomingNotebook);
        const semanticConflicts = analyzeSemanticConflictsFromMappings(cellMappings);

        const [currentBranch, incomingBranch] = await Promise.all([
            gitOps.getCurrentBranch(filePath),
            gitOps.getMergeBranch(filePath)
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
        logger.error('Error detecting semantic conflicts:', error);
        return null;
    }
}
