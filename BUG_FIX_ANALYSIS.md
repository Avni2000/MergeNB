# Cell Sorting Bug Fix - Technical Analysis

## Problem Statement

In the three-way merge algorithm, when a new cell is inserted in one branch, it was appearing **after** the cell it should come **before**, causing cells to swap positions incorrectly.

### Example Scenario

**In the incoming branch:**
- Index 16: NEW cell "#### Why 'collision rate between spectrum pairs'?" (inserted)
- Index 17: Modified cell "This demonstrates..." (pushed down from position 16)

**In base and current branches:**
- Index 16: Original cell "This clearly demonstrates..."

**Expected behavior:**
The NEW cell (incoming[16]) should appear BEFORE the modified cell (incoming[17]) in the merged result.

**Actual buggy behavior:**
The modified cell appeared BEFORE the NEW cell, causing the wrong order.

## Root Cause

The bug was in the tie-breaking logic used when sorting cell mappings. Both `sortMappingsByPosition()` in `cellMatcher.ts` and `_sortRowsByPosition()` in `ConflictResolverPanel.ts` had identical flawed logic.

### How Cells Are Matched and Sorted

1. **Cell Matching:** Cells are matched across base/current/incoming versions using content similarity
   - Cell A: base[16], current[16], incoming[17] (same cell in all versions, moved in incoming)
   - Cell B: incoming[16] only (NEW cell, only exists in incoming)

2. **Anchor Position Calculation:** Each mapping gets an "anchor" position
   ```typescript
   anchor = baseIndex ?? currentIndex ?? incomingIndex ?? 0
   ```
   - Cell A: anchor = 16 (from baseIndex)
   - Cell B: anchor = 16 (from incomingIndex)
   - **Both have the same anchor!** This triggers the tie-breaker.

3. **Flawed Tie-Breaker Logic (BUGGY):**
   ```typescript
   // For same anchor position, base-anchored cells should come first
   const hasBaseA = a.baseIndex !== undefined;
   const hasBaseB = b.baseIndex !== undefined;
   
   if (hasBaseA !== hasBaseB) {
       return hasBaseA ? -1 : 1;  // BUG: Prioritizes base-anchored cells
   }
   ```
   
   This caused Cell A (base-anchored) to come BEFORE Cell B (not base-anchored), which is backwards!

## The Fix

Replace the flawed tie-breaker with a systematic check of all available indices:

```typescript
// Tie-breaker: compare indices from all versions to preserve insertion order
// Check each version systematically to handle cell insertions/reordering

// If both have incoming index, compare them
if (a.incomingIndex !== undefined && b.incomingIndex !== undefined) {
    if (a.incomingIndex !== b.incomingIndex) {
        return a.incomingIndex - b.incomingIndex;
    }
}

// If both have current index, compare them
if (a.currentIndex !== undefined && b.currentIndex !== undefined) {
    if (a.currentIndex !== b.currentIndex) {
        return a.currentIndex - b.currentIndex;
    }
}

// If both have base index, compare them
if (a.baseIndex !== undefined && b.baseIndex !== undefined) {
    if (a.baseIndex !== b.baseIndex) {
        return a.baseIndex - b.baseIndex;
    }
}

// Final fallback
return 0;
```

### Why This Works

For our example:
- Cell A: incoming=17, current=16, base=16
- Cell B: incoming=16, current=undefined, base=undefined

**Step 1:** Both have incoming? YES
- Compare incoming indices: 16 < 17
- Result: Cell B comes BEFORE Cell A ✓

This correctly preserves the insertion order from the incoming branch.

## Testing

### Unit Test
Created `src/test/verifyOrderingFix.ts` to test the fix with a simplified scenario.

### Real Notebook Test
Created `src/test/verifyRealNotebooks.ts` to verify the fix with the actual notebooks from the bug report.

### Results
- ✓ All existing integration tests pass
- ✓ New unit test passes
- ✓ Real notebook test passes
- ✓ Cell ordering is now correct

## Files Modified

1. **src/cellMatcher.ts** (lines 308-338)
   - Fixed `sortMappingsByPosition()` function

2. **src/webview/ConflictResolverPanel.ts** (lines 304-334)
   - Fixed `_sortRowsByPosition()` function

Both functions had identical bugs and received identical fixes.

## Impact

This fix ensures that when cells are inserted, deleted, or reordered in different branches, the merge resolution UI displays them in the correct logical order, making it easier for users to understand and resolve conflicts.

The fix handles:
- Cell insertions in any branch (incoming, current, or both)
- Cell reordering
- Cell movements due to insertions above them
- Symmetric cases (insertions in current vs incoming)
