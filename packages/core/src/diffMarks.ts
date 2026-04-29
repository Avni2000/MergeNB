/**
 * @file diffMarks.ts
 * @description Compute line-level and inline word-level diff marks for two
 * versions of a cell source, independent of any rendering layer.
 *
 * Strategy (industry-standard two-pass diff):
 *   1. `diffLines` to find which lines were added/removed — drives line
 *      background classes.
 *   2. `diffWordsWithSpace` between paired removed/added line hunks — drives
 *      inline highlight ranges. Word-level (not character-level) avoids the
 *      noisy single-character matching that a raw string diff produces.
 *
 * `diffWordsWithSpace` is preferred over `diffWords` so whitespace-only
 * changes survive into the result (the caller treats them as conflicts).
 */

import { diffLines, diffWordsWithSpace } from 'diff';

export type DiffSide = 'base' | 'current' | 'incoming';
export type DiffMode = 'base' | 'conflict';

export interface InlineDiffRange {
    from: number;
    to: number;
    classes: string;
}

export interface DiffMarks {
    /** Map from 0-based line index in `source` to a CSS class string. */
    lineClasses: Map<number, string>;
    /** Absolute character ranges in `source` for inline highlights. */
    inlineRanges: InlineDiffRange[];
}

interface SideClasses {
    lineClass: string;
    inlineClass: string;
}

const CONFLICT_CLASSES: SideClasses = {
    lineClass: 'diff-line diff-line-conflict',
    inlineClass: 'diff-inline-conflict',
};

const SIDE_CLASSES: Record<DiffSide, SideClasses> = {
    base: { lineClass: 'diff-line diff-line-base', inlineClass: 'diff-inline-base' },
    current: { lineClass: 'diff-line diff-line-current', inlineClass: 'diff-inline-current' },
    incoming: { lineClass: 'diff-line diff-line-incoming', inlineClass: 'diff-inline-incoming' },
};

export function computeDiffMarks(
    source: string,
    compareSource: string,
    side: DiffSide,
    diffMode: DiffMode,
): DiffMarks {
    const lineClasses = new Map<number, string>();
    const inlineRanges: InlineDiffRange[] = [];

    const sideClasses = SIDE_CLASSES[side];
    const lineOfPos = makeLineOfPos(source);

    const hunks = diffLines(compareSource, source);

    let bOffset = 0;
    let pendingRemoved = '';

    for (const hunk of hunks) {
        if (hunk.removed) {
            pendingRemoved += hunk.value;
            continue;
        }

        if (hunk.added) {
            const hunkStart = bOffset;
            const hunkEnd = bOffset + hunk.value.length;

            const isWhitespaceOnly = hunk.value.length > 0 && hunk.value.trim() === '';
            const useConflict = diffMode === 'conflict' || isWhitespaceOnly;
            const { lineClass, inlineClass } = useConflict ? CONFLICT_CLASSES : sideClasses;

            const firstLine = lineOfPos(hunkStart);
            const lastLine = lineOfPos(Math.max(hunkStart, hunkEnd - 1));
            for (let ln = firstLine; ln <= lastLine; ln++) lineClasses.set(ln, lineClass);

            if (pendingRemoved.length > 0) {
                let cursor = hunkStart;
                for (const wc of diffWordsWithSpace(pendingRemoved, hunk.value)) {
                    if (wc.removed) continue;
                    if (wc.added) {
                        inlineRanges.push({ from: cursor, to: cursor + wc.value.length, classes: inlineClass });
                    }
                    cursor += wc.value.length;
                }
            } else {
                inlineRanges.push({ from: hunkStart, to: hunkEnd, classes: inlineClass });
            }

            pendingRemoved = '';
            bOffset = hunkEnd;
            continue;
        }

        pendingRemoved = '';
        bOffset += hunk.value.length;
    }

    return { lineClasses, inlineRanges };
}

function makeLineOfPos(source: string): (pos: number) => number {
    const lineStarts: number[] = [0];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') lineStarts.push(i + 1);
    }
    return (pos: number): number => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
        }
        return lo;
    };
}
