/**
 * @file cellMatcher.ts
 * @description Move-invariant cell matching for three-way notebook merge.
 *
 * Matching strategy:
 * 1. Hard anchors: unique ID matches, unique heading matches, then unique exact source matches.
 * 2. Global optimization: Hungarian assignment on remaining cells with a
 *    weighted score (content + output + contextual fingerprint).
 */

import { NotebookCell, Notebook, CellMapping } from './types';
import { sortByPosition } from './positionUtils';

const CODE_CONTENT_WEIGHT = 0.5;
const CODE_CONTEXT_WEIGHT = 0.2;
const CODE_OUTPUT_WEIGHT = 0.3;
const MARKDOWN_CONTENT_WEIGHT = 0.7;
const MARKDOWN_CONTEXT_WEIGHT = 0.3;
const TYPE_MISMATCH_COST = 100;
const MIN_MATCH_SCORE = 0.35;
const CONTEXT_PREVIEW_LEN = 60;

// ============================================================================
// String Similarity (SequenceMatcher-like)
// ============================================================================

function getCellSource(cell: NotebookCell): string {
    return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

function findLongestMatch(
    a: string, b: string,
    aLo: number, aHi: number,
    bLo: number, bHi: number
): [number, number, number] {
    const b2j = new Map<string, number[]>();
    for (let j = bLo; j < bHi; j++) {
        const ch = b[j];
        const arr = b2j.get(ch);
        if (arr) {
            arr.push(j);
        } else {
            b2j.set(ch, [j]);
        }
    }

    let bestI = aLo;
    let bestJ = bLo;
    let bestSize = 0;
    let j2len = new Map<number, number>();

    for (let i = aLo; i < aHi; i++) {
        const newJ2len = new Map<number, number>();
        const positions = b2j.get(a[i]);
        if (!positions) {
            j2len = newJ2len;
            continue;
        }
        for (const j of positions) {
            const k = (j2len.get(j - 1) || 0) + 1;
            newJ2len.set(j, k);
            if (k > bestSize) {
                bestI = i - k + 1;
                bestJ = j - k + 1;
                bestSize = k;
            }
        }
        j2len = newJ2len;
    }

    return [bestI, bestJ, bestSize];
}

function countMatchingChars(a: string, b: string): number {
    const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
    let total = 0;

    while (queue.length > 0) {
        const [aLo, aHi, bLo, bHi] = queue.pop()!;
        const [i, j, k] = findLongestMatch(a, b, aLo, aHi, bLo, bHi);
        if (k <= 0) continue;
        total += k;

        if (aLo < i && bLo < j) {
            queue.push([aLo, i, bLo, j]);
        }
        if (i + k < aHi && j + k < bHi) {
            queue.push([i + k, aHi, j + k, bHi]);
        }
    }

    return total;
}

function sequenceMatcherRatio(a: string, b: string): number {
    if (a === b) return 1;
    const la = a.length;
    const lb = b.length;
    if (!la && !lb) return 1;
    if (!la || !lb) return 0;
    return (2 * countMatchingChars(a, b)) / (la + lb);
}

function quickRatio(a: string, b: string): number {
    const la = a.length;
    const lb = b.length;
    if (!la && !lb) return 1;
    if (!la || !lb) return 0;

    const freqA = new Map<string, number>();
    const freqB = new Map<string, number>();
    for (const ch of a) freqA.set(ch, (freqA.get(ch) || 0) + 1);
    for (const ch of b) freqB.set(ch, (freqB.get(ch) || 0) + 1);

    let overlap = 0;
    for (const [ch, count] of freqA.entries()) {
        overlap += Math.min(count, freqB.get(ch) || 0);
    }

    return (2 * overlap) / (la + lb);
}

function realQuickRatio(a: string, b: string): number {
    const la = a.length;
    const lb = b.length;
    if (!la && !lb) return 1;
    if (!la || !lb) return 0;
    return (2 * Math.min(la, lb)) / (la + lb);
}

function compareStringsApproximate(a: string, b: string, threshold: number, maxlen?: number): boolean {
    if ((!a) !== (!b)) return false;
    if (a === b) return true;
    if (realQuickRatio(a, b) < threshold) return false;
    if (quickRatio(a, b) < threshold) return false;
    if (maxlen !== undefined && a.length > maxlen && b.length > maxlen) return false;
    return sequenceMatcherRatio(a, b) >= threshold;
}

function computeCellSimilarity(cell1: NotebookCell, cell2: NotebookCell): number {
    if (cell1.cell_type !== cell2.cell_type) return 0;

    const source1 = getCellSource(cell1);
    const source2 = getCellSource(cell2);

    if (source1 === source2) return 1;
    if (!source1 && !source2) return 1;
    if (!source1 || !source2) return 0;

    return sequenceMatcherRatio(source1, source2);
}

// ============================================================================
// Output + Context Similarity
// ============================================================================

function stableStringifyForOutputSimilarity(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(value);

    if (Array.isArray(value)) {
        return `[${value.map(stableStringifyForOutputSimilarity).join(',')}]`;
    }

    if (t === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringifyForOutputSimilarity(obj[key])}`).join(',')}}`;
    }

    return JSON.stringify(String(value));
}

function normalizeMimeDataValue(value: unknown): unknown {
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
        return value.join('');
    }
    return value;
}

function compareOutputApproximate(x: Record<string, unknown>, y: Record<string, unknown>): boolean {
    if (!x || !y) return x === y;
    if (x.output_type !== y.output_type) return false;

    if (x.output_type === 'stream') {
        if (x.name !== y.name) return false;
        const xText = Array.isArray(x.text) ? (x.text as string[]).join('') : String(x.text || '');
        const yText = Array.isArray(y.text) ? (y.text as string[]).join('') : String(y.text || '');
        return compareStringsApproximate(xText, yText, 0.7, 1000);
    }

    if (x.output_type === 'error') {
        return x.ename === y.ename && x.evalue === y.evalue;
    }

    if (x.output_type === 'display_data' || x.output_type === 'execute_result') {
        const xData = (x.data || {}) as Record<string, unknown>;
        const yData = (y.data || {}) as Record<string, unknown>;
        const xKeys = new Set(Object.keys(xData));
        const yKeys = new Set(Object.keys(yData));
        if (xKeys.size !== yKeys.size) return false;
        for (const key of xKeys) {
            if (!yKeys.has(key)) return false;
            const xValue = normalizeMimeDataValue(xData[key]);
            const yValue = normalizeMimeDataValue(yData[key]);

            if (key.startsWith('text/')) {
                const xText = typeof xValue === 'string' ? xValue : stableStringifyForOutputSimilarity(xValue);
                const yText = typeof yValue === 'string' ? yValue : stableStringifyForOutputSimilarity(yValue);
                if (!compareStringsApproximate(xText, yText, 0.7, 10000)) return false;
                continue;
            }

            if (stableStringifyForOutputSimilarity(xValue) !== stableStringifyForOutputSimilarity(yValue)) {
                return false;
            }
        }
        return true;
    }

    return true;
}

function compareOutputsApproximate(
    leftOutputs: Record<string, unknown>[],
    rightOutputs: Record<string, unknown>[]
): boolean {
    if (leftOutputs.length !== rightOutputs.length) return false;
    for (let i = 0; i < leftOutputs.length; i++) {
        if (!compareOutputApproximate(leftOutputs[i], rightOutputs[i])) return false;
    }
    return true;
}

function computeOutputSimilarity(left: NotebookCell, right: NotebookCell): number {
    if (left.cell_type !== 'code' || right.cell_type !== 'code') return 0;

    const leftOutputs = (left.outputs || []) as unknown as Record<string, unknown>[];
    const rightOutputs = (right.outputs || []) as unknown as Record<string, unknown>[];

    if (leftOutputs.length === 0 && rightOutputs.length === 0) return 1;
    if (leftOutputs.length === 0 || rightOutputs.length === 0) return 0;

    return compareOutputsApproximate(leftOutputs, rightOutputs) ? 1 : 0;
}

function getContextToken(cell: NotebookCell | undefined): string {
    if (!cell) return '';
    const source = getCellSource(cell).replace(/\s+/g, ' ').trim().slice(0, CONTEXT_PREVIEW_LEN);
    return `${cell.cell_type}:${source}`;
}

function getContextSignature(cells: NotebookCell[], index: number): string {
    const prev = index > 0 ? getContextToken(cells[index - 1]) : 'START';
    const next = index + 1 < cells.length ? getContextToken(cells[index + 1]) : 'END';
    return `${prev}|${next}`;
}

function scoreCellPair(
    baseCells: NotebookCell[],
    baseIdx: number,
    otherCells: NotebookCell[],
    otherIdx: number
): number {
    const left = baseCells[baseIdx];
    const right = otherCells[otherIdx];

    if (left.cell_type !== right.cell_type) return 0;

    const contentScore = computeCellSimilarity(left, right);
    const outputScore = computeOutputSimilarity(left, right);
    const leftContext = getContextSignature(baseCells, baseIdx);
    const rightContext = getContextSignature(otherCells, otherIdx);
    const contextScore = sequenceMatcherRatio(leftContext, rightContext);

    if (left.cell_type === 'code' && right.cell_type === 'code') {
        return (contentScore * CODE_CONTENT_WEIGHT)
            + (contextScore * CODE_CONTEXT_WEIGHT)
            + (outputScore * CODE_OUTPUT_WEIGHT);
    }

    return (contentScore * MARKDOWN_CONTENT_WEIGHT) + (contextScore * MARKDOWN_CONTEXT_WEIGHT);
}

// ============================================================================
// Hard Anchors (IDs + Unique Headings + Unique Exact Source)
// ============================================================================

function buildUniqueValueIndex(
    cells: NotebookCell[],
    toKey: (cell: NotebookCell) => string | undefined
): Map<string, number[]> {
    const index = new Map<string, number[]>();
    for (let i = 0; i < cells.length; i++) {
        const key = toKey(cells[i]);
        if (!key) continue;
        const list = index.get(key);
        if (list) {
            list.push(i);
        } else {
            index.set(key, [i]);
        }
    }
    return index;
}

function addIdAnchors(
    baseCells: NotebookCell[],
    otherCells: NotebookCell[],
    matches: Map<number, number>,
    usedBase: Set<number>,
    usedOther: Set<number>
): void {
    const baseById = buildUniqueValueIndex(baseCells, (cell) => cell.id);
    const otherById = buildUniqueValueIndex(otherCells, (cell) => cell.id);

    for (const [id, baseIndices] of baseById.entries()) {
        if (baseIndices.length !== 1) continue;
        const otherIndices = otherById.get(id);
        if (!otherIndices || otherIndices.length !== 1) continue;

        const baseIdx = baseIndices[0];
        const otherIdx = otherIndices[0];
        if (usedBase.has(baseIdx) || usedOther.has(otherIdx)) continue;

        matches.set(baseIdx, otherIdx);
        usedBase.add(baseIdx);
        usedOther.add(otherIdx);
    }
}

function getNormalizedHeadingKey(cell: NotebookCell): string | undefined {
    if (cell.cell_type !== 'markdown') return undefined;
    const source = getCellSource(cell);
    const lines = source.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('#')) continue;

        const heading = trimmed.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!heading) return undefined;
        return `markdown_heading\u0000${heading}`;
    }

    return undefined;
}

function addUniqueHeadingAnchors(
    baseCells: NotebookCell[],
    otherCells: NotebookCell[],
    matches: Map<number, number>,
    usedBase: Set<number>,
    usedOther: Set<number>
): void {
    const baseByHeading = buildUniqueValueIndex(baseCells, getNormalizedHeadingKey);
    const otherByHeading = buildUniqueValueIndex(otherCells, getNormalizedHeadingKey);

    for (const [headingKey, baseIndices] of baseByHeading.entries()) {
        if (baseIndices.length !== 1) continue;
        const otherIndices = otherByHeading.get(headingKey);
        if (!otherIndices || otherIndices.length !== 1) continue;

        const baseIdx = baseIndices[0];
        const otherIdx = otherIndices[0];
        if (usedBase.has(baseIdx) || usedOther.has(otherIdx)) continue;

        matches.set(baseIdx, otherIdx);
        usedBase.add(baseIdx);
        usedOther.add(otherIdx);
    }
}

function getExactSourceKey(cell: NotebookCell): string {
    return `${cell.cell_type}\u0000${getCellSource(cell)}`;
}

function addUniqueSourceAnchors(
    baseCells: NotebookCell[],
    otherCells: NotebookCell[],
    matches: Map<number, number>,
    usedBase: Set<number>,
    usedOther: Set<number>
): void {
    const baseBySource = buildUniqueValueIndex(baseCells, getExactSourceKey);
    const otherBySource = buildUniqueValueIndex(otherCells, getExactSourceKey);

    for (const [sourceKey, baseIndices] of baseBySource.entries()) {
        if (baseIndices.length !== 1) continue;
        const otherIndices = otherBySource.get(sourceKey);
        if (!otherIndices || otherIndices.length !== 1) continue;

        const baseIdx = baseIndices[0];
        const otherIdx = otherIndices[0];
        if (usedBase.has(baseIdx) || usedOther.has(otherIdx)) continue;

        matches.set(baseIdx, otherIdx);
        usedBase.add(baseIdx);
        usedOther.add(otherIdx);
    }
}

function collectUnmatchedIndices(length: number, used: Set<number>): number[] {
    const result: number[] = [];
    for (let i = 0; i < length; i++) {
        if (!used.has(i)) result.push(i);
    }
    return result;
}

// ============================================================================
// Hungarian Assignment (minimum cost)
// ============================================================================

function transposeMatrix(matrix: number[][]): number[][] {
    if (matrix.length === 0) return [];
    const rows = matrix.length;
    const cols = matrix[0].length;
    const transposed: number[][] = Array.from({ length: cols }, () => Array(rows).fill(0));
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            transposed[j][i] = matrix[i][j];
        }
    }
    return transposed;
}

/**
 * Hungarian algorithm for rectangular matrices where rows <= cols.
 * Returns assigned column index for each row.
 */
function hungarianRowsAtMostCols(cost: number[][]): number[] {
    const rowCount = cost.length;
    const colCount = rowCount > 0 ? cost[0].length : 0;

    const u = new Array(rowCount + 1).fill(0);
    const v = new Array(colCount + 1).fill(0);
    const p = new Array(colCount + 1).fill(0);
    const way = new Array(colCount + 1).fill(0);

    for (let i = 1; i <= rowCount; i++) {
        p[0] = i;
        let j0 = 0;
        const minv = new Array(colCount + 1).fill(Number.POSITIVE_INFINITY);
        const used = new Array(colCount + 1).fill(false);

        do {
            used[j0] = true;
            const i0 = p[j0];
            let delta = Number.POSITIVE_INFINITY;
            let j1 = 0;

            for (let j = 1; j <= colCount; j++) {
                if (used[j]) continue;
                const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
                if (cur < minv[j]) {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if (minv[j] < delta) {
                    delta = minv[j];
                    j1 = j;
                }
            }

            for (let j = 0; j <= colCount; j++) {
                if (used[j]) {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
        } while (p[j0] !== 0);

        do {
            const j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        } while (j0 !== 0);
    }

    const assignment = new Array(rowCount).fill(-1);
    for (let j = 1; j <= colCount; j++) {
        if (p[j] > 0) {
            assignment[p[j] - 1] = j - 1;
        }
    }
    return assignment;
}

function solveHungarian(cost: number[][]): Array<[number, number]> {
    const rows = cost.length;
    const cols = rows > 0 ? cost[0].length : 0;
    if (rows === 0 || cols === 0) return [];

    if (rows <= cols) {
        const rowToCol = hungarianRowsAtMostCols(cost);
        const pairs: Array<[number, number]> = [];
        for (let row = 0; row < rowToCol.length; row++) {
            const col = rowToCol[row];
            if (col >= 0) pairs.push([row, col]);
        }
        return pairs;
    }

    const transposed = transposeMatrix(cost);
    const colToRow = hungarianRowsAtMostCols(transposed);
    const pairs: Array<[number, number]> = [];
    for (let col = 0; col < colToRow.length; col++) {
        const row = colToRow[col];
        if (row >= 0) pairs.push([row, col]);
    }
    return pairs;
}

// ============================================================================
// Pairwise Matching (base -> other)
// ============================================================================

function matchCellsGlobal(baseCells: NotebookCell[], otherCells: NotebookCell[]): Map<number, number> {
    const matches = new Map<number, number>();
    if (baseCells.length === 0 || otherCells.length === 0) return matches;

    const usedBase = new Set<number>();
    const usedOther = new Set<number>();

    addIdAnchors(baseCells, otherCells, matches, usedBase, usedOther);
    addUniqueHeadingAnchors(baseCells, otherCells, matches, usedBase, usedOther);
    addUniqueSourceAnchors(baseCells, otherCells, matches, usedBase, usedOther);

    const unmatchedBase = collectUnmatchedIndices(baseCells.length, usedBase);
    const unmatchedOther = collectUnmatchedIndices(otherCells.length, usedOther);

    if (unmatchedBase.length === 0 || unmatchedOther.length === 0) return matches;

    const costMatrix: number[][] = unmatchedBase.map((baseIdx) =>
        unmatchedOther.map((otherIdx) => {
            const baseCell = baseCells[baseIdx];
            const otherCell = otherCells[otherIdx];
            if (baseCell.cell_type !== otherCell.cell_type) {
                return TYPE_MISMATCH_COST;
            }
            const score = scoreCellPair(baseCells, baseIdx, otherCells, otherIdx);
            if (score < MIN_MATCH_SCORE) {
                return TYPE_MISMATCH_COST;
            }
            return 1 - score;
        })
    );

    const assignments = solveHungarian(costMatrix);
    for (const [row, col] of assignments) {
        const cost = costMatrix[row][col];
        if (cost >= TYPE_MISMATCH_COST) continue;

        const baseIdx = unmatchedBase[row];
        const otherIdx = unmatchedOther[col];
        matches.set(baseIdx, otherIdx);
    }

    return matches;
}

function computeMatchConfidence(
    leftCells: NotebookCell[],
    leftIdx: number | undefined,
    rightCells: NotebookCell[],
    rightIdx: number | undefined
): number {
    if (leftIdx === undefined || rightIdx === undefined) return 0;
    return scoreCellPair(leftCells, leftIdx, rightCells, rightIdx);
}

// ============================================================================
// Public API
// ============================================================================

export function matchCells(
    base: Notebook | null | undefined,
    current: Notebook | null | undefined,
    incoming: Notebook | null | undefined
): CellMapping[] {
    if (!base && !current && !incoming) {
        return [];
    }

    const mappings: CellMapping[] = [];
    const baseCells = base?.cells || [];
    const currentCells = current?.cells || [];
    const incomingCells = incoming?.cells || [];

    // No base available: match current directly against incoming.
    if (baseCells.length === 0) {
        const currentToIncoming = matchCellsGlobal(currentCells, incomingCells);
        const usedIncoming = new Set<number>();

        for (let currentIdx = 0; currentIdx < currentCells.length; currentIdx++) {
            const incomingIdx = currentToIncoming.get(currentIdx);
            if (incomingIdx !== undefined) {
                mappings.push({
                    currentIndex: currentIdx,
                    incomingIndex: incomingIdx,
                    matchConfidence: computeMatchConfidence(currentCells, currentIdx, incomingCells, incomingIdx),
                    currentCell: currentCells[currentIdx],
                    incomingCell: incomingCells[incomingIdx]
                });
                usedIncoming.add(incomingIdx);
                continue;
            }

            mappings.push({
                currentIndex: currentIdx,
                matchConfidence: 1,
                currentCell: currentCells[currentIdx]
            });
        }

        for (let incomingIdx = 0; incomingIdx < incomingCells.length; incomingIdx++) {
            if (usedIncoming.has(incomingIdx)) continue;
            mappings.push({
                incomingIndex: incomingIdx,
                matchConfidence: 1,
                incomingCell: incomingCells[incomingIdx]
            });
        }

        return sortMappingsByPosition(mappings);
    }

    const baseToCurrent = matchCellsGlobal(baseCells, currentCells);
    const baseToIncoming = matchCellsGlobal(baseCells, incomingCells);
    const usedCurrent = new Set<number>();
    const usedIncoming = new Set<number>();

    for (let baseIdx = 0; baseIdx < baseCells.length; baseIdx++) {
        const currentIdx = baseToCurrent.get(baseIdx);
        const incomingIdx = baseToIncoming.get(baseIdx);

        mappings.push({
            baseIndex: baseIdx,
            currentIndex: currentIdx,
            incomingIndex: incomingIdx,
            matchConfidence: Math.max(
                computeMatchConfidence(baseCells, baseIdx, currentCells, currentIdx),
                computeMatchConfidence(baseCells, baseIdx, incomingCells, incomingIdx)
            ),
            baseCell: baseCells[baseIdx],
            currentCell: currentIdx !== undefined ? currentCells[currentIdx] : undefined,
            incomingCell: incomingIdx !== undefined ? incomingCells[incomingIdx] : undefined
        });

        if (currentIdx !== undefined) usedCurrent.add(currentIdx);
        if (incomingIdx !== undefined) usedIncoming.add(incomingIdx);
    }

    const unmatchedCurrentCells: NotebookCell[] = [];
    const unmatchedCurrentIndices: number[] = [];
    const unmatchedIncomingCells: NotebookCell[] = [];
    const unmatchedIncomingIndices: number[] = [];

    for (let currentIdx = 0; currentIdx < currentCells.length; currentIdx++) {
        if (usedCurrent.has(currentIdx)) continue;
        unmatchedCurrentCells.push(currentCells[currentIdx]);
        unmatchedCurrentIndices.push(currentIdx);
    }

    for (let incomingIdx = 0; incomingIdx < incomingCells.length; incomingIdx++) {
        if (usedIncoming.has(incomingIdx)) continue;
        unmatchedIncomingCells.push(incomingCells[incomingIdx]);
        unmatchedIncomingIndices.push(incomingIdx);
    }

    const unmatchedMatches = matchCellsGlobal(unmatchedCurrentCells, unmatchedIncomingCells);
    const newlyMatchedIncoming = new Set<number>();

    for (let localCurrentIdx = 0; localCurrentIdx < unmatchedCurrentCells.length; localCurrentIdx++) {
        const globalCurrentIdx = unmatchedCurrentIndices[localCurrentIdx];
        const localIncomingIdx = unmatchedMatches.get(localCurrentIdx);
        if (localIncomingIdx === undefined) {
            mappings.push({
                currentIndex: globalCurrentIdx,
                matchConfidence: 1,
                currentCell: currentCells[globalCurrentIdx]
            });
            continue;
        }

        const globalIncomingIdx = unmatchedIncomingIndices[localIncomingIdx];
        mappings.push({
            currentIndex: globalCurrentIdx,
            incomingIndex: globalIncomingIdx,
            matchConfidence: computeMatchConfidence(currentCells, globalCurrentIdx, incomingCells, globalIncomingIdx),
            currentCell: currentCells[globalCurrentIdx],
            incomingCell: incomingCells[globalIncomingIdx]
        });
        newlyMatchedIncoming.add(localIncomingIdx);
    }

    for (let localIncomingIdx = 0; localIncomingIdx < unmatchedIncomingCells.length; localIncomingIdx++) {
        if (newlyMatchedIncoming.has(localIncomingIdx)) continue;
        const globalIncomingIdx = unmatchedIncomingIndices[localIncomingIdx];
        mappings.push({
            incomingIndex: globalIncomingIdx,
            matchConfidence: 1,
            incomingCell: incomingCells[globalIncomingIdx]
        });
    }

    return sortMappingsByPosition(mappings);
}

function sortMappingsByPosition(mappings: CellMapping[]): CellMapping[] {
    return sortByPosition(mappings, (mapping) => ({
        anchor: mapping.baseIndex ?? mapping.currentIndex ?? mapping.incomingIndex ?? 0,
        base: mapping.baseIndex,
        current: mapping.currentIndex,
        incoming: mapping.incomingIndex
    }));
}

export function detectReordering(mappings: CellMapping[]): boolean {
    const withAllThree = mappings.filter(
        (mapping) =>
            mapping.baseIndex !== undefined &&
            mapping.currentIndex !== undefined &&
            mapping.incomingIndex !== undefined
    );

    if (withAllThree.length < 2) return false;

    for (let i = 1; i < withAllThree.length; i++) {
        const prev = withAllThree[i - 1];
        const curr = withAllThree[i];

        const baseOrdered = curr.baseIndex! > prev.baseIndex!;
        const currentOrdered = curr.currentIndex! > prev.currentIndex!;
        const incomingOrdered = curr.incomingIndex! > prev.incomingIndex!;

        if (baseOrdered !== currentOrdered || baseOrdered !== incomingOrdered) {
            return true;
        }
    }

    return false;
}
