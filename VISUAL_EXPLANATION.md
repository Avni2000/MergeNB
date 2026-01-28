# Visual Explanation of the Cell Sorting Bug Fix

## The Problem

```
Base Branch (common ancestor):
┌─────────────────────────────────────────┐
│ Cell 15                                 │
├─────────────────────────────────────────┤
│ Cell 16: "This clearly demonstrates..." │ ← Original cell at position 16
├─────────────────────────────────────────┤
│ Cell 17                                 │
└─────────────────────────────────────────┘

Current Branch (unchanged):
┌─────────────────────────────────────────┐
│ Cell 15                                 │
├─────────────────────────────────────────┤
│ Cell 16: "This clearly demonstrates..." │ ← Unchanged from base
├─────────────────────────────────────────┤
│ Cell 17                                 │
└─────────────────────────────────────────┘

Incoming Branch (new cell inserted):
┌─────────────────────────────────────────┐
│ Cell 15                                 │
├─────────────────────────────────────────┤
│ Cell 16: "#### Why collision...?"      │ ← NEW cell inserted here
├─────────────────────────────────────────┤
│ Cell 17: "This demonstrates..."        │ ← Original cell pushed down, slightly modified
├─────────────────────────────────────────┤
│ Cell 18                                 │
└─────────────────────────────────────────┘
```

## Cell Matching

The algorithm matches cells across versions:

```
Mapping A: base[16] ←→ current[16] ←→ incoming[17]
           "This clearly..."  "This clearly..."  "This demonstrates..."
           (Same cell in all 3 versions, moved down in incoming)

Mapping B: incoming[16] only
           "#### Why collision...?"
           (NEW cell, only exists in incoming)
```

## Anchor Position Calculation

Both mappings get the same anchor position:

```
Mapping A: anchor = base[16] = 16       (uses base index)
Mapping B: anchor = incoming[16] = 16   (uses incoming index)

Both have anchor = 16 → TIE! Need tie-breaker.
```

## The Bug (Old Tie-Breaker)

```
Old logic: "Base-anchored cells come first"

Mapping A: hasBase = true  (has baseIndex)
Mapping B: hasBase = false (no baseIndex)

Result: A comes before B

Final order:
  [16] Mapping A: "This demonstrates..."      ← WRONG! Should be second
  [17] Mapping B: "#### Why collision...?"    ← WRONG! Should be first
```

## The Fix (New Tie-Breaker)

```
New logic: "Compare all available indices systematically"

Step 1: Do both have incoming index?
  Mapping A: incomingIndex = 17
  Mapping B: incomingIndex = 16
  
  YES, both have incoming! Compare: 16 < 17
  
Result: B comes before A

Final order:
  [16] Mapping B: "#### Why collision...?"    ✓ CORRECT!
  [17] Mapping A: "This demonstrates..."      ✓ CORRECT!
```

## Why This Matters

In a hospital setting, the order of cells in a Jupyter notebook can be critical:
- Documentation cells must appear in the right context
- Analysis steps must be in the correct sequence
- Results must follow their corresponding code

The bug caused cells to swap positions during merge resolution, potentially leading to:
- Confusing documentation order
- Incorrect workflow sequences
- Misplaced analysis results

The fix ensures that merge resolution **preserves the logical order** intended by the authors.
