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

/**
 * Detect semantic conflicts (Git UU status)
 * Compares base/current/incoming versions from Git staging areas
 */
export async function detectSemanticConflicts(filePath: string, gitOps: GitOperations): Promise<NotebookSemanticConflict | null> {
    const versions = await gitOps.getThreeWayVersions(filePath);
    if (!versions) {
        return null;
    }

    const { base, current, incoming } = versions;

    const readSide = (content: string | null, side: string): Notebook | undefined => {
        if (content === null) return undefined;
        try { return parseNotebook(content); }
        catch (error) { throw new Error(`Cannot read ${side} notebook: ${error instanceof Error ? error.message : String(error)}`); }
    };
    const baseNotebook = readSide(base, 'base');
    const currentNotebook = readSide(current, 'current');
    const incomingNotebook = readSide(incoming, 'incoming');

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
}
