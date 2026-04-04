    /**
 * @file positionUtils.ts
 * @description Browser-safe position comparison and sorting utilities.
 * 
 * These pure functions handle cell ordering in 3-way merge views.
 * Used by both the extension (cellMatcher) and web client (ConflictResolver).
 */

interface PositionFields {
    anchor?: number;
    incoming?: number;
    current?: number;
    base?: number;
}

/**
 * Generic comparator that compares two position-like objects.
 * Accepts canonical keys: `anchor`, `incoming`, `current`, `base`.
 * 
 * Ordering logic:
 * 1. Primary sort by anchor position (anchor = base ?? current ?? incoming ?? 0)
 * 2. Tie-breaker: compare indices from all versions to preserve insertion order
 */
function compareByPosition(a: PositionFields, b: PositionFields): number {
    const posA = a.anchor ?? 0;
    const posB = b.anchor ?? 0;

    if (posA !== posB) {
        return posA - posB;
    }

    // Tie-breaker: compare indices from all versions to preserve insertion order.
    // Incoming is checked before current deliberately: after unmatch, split rows
    // carry different anchor positions, so ties here are rare.  When they do
    // occur (e.g. two additions at the same base slot), placing incoming-side
    // rows first matches the conventional 3-way merge layout where the incoming
    // column is displayed to the right; it does NOT imply priority of content.
    if (a.incoming !== undefined && b.incoming !== undefined) {
        if (a.incoming !== b.incoming) return a.incoming - b.incoming;
    }

    if (a.current !== undefined && b.current !== undefined) {
        if (a.current !== b.current) return a.current - b.current;
    }

    if (a.base !== undefined && b.base !== undefined) {
        if (a.base !== b.base) return a.base - b.base;
    }

    const hasAnyIndexA = (a.incoming ?? a.current ?? a.base) !== undefined;
    const hasAnyIndexB = (b.incoming ?? b.current ?? b.base) !== undefined;

    if (hasAnyIndexA && !hasAnyIndexB) return -1;
    if (!hasAnyIndexA && hasAnyIndexB) return 1;

    return 0;
}

/**
 * Sort a list of items using a position accessor that maps each item
 * to the canonical position fields consumed by `compareByPosition`.
 */
export function sortByPosition<T>(
    items: T[],
    accessor: (item: T) => PositionFields
): T[] {
    return [...items].sort((x, y) => compareByPosition(accessor(x), accessor(y)));
}
