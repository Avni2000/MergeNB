# MergeNB - Jupyter Notebook Merge Conflict Resolver

A VSCode extension for resolving merge conflicts in Jupyter notebooks (`.ipynb` files). Git's default merge behavior strips execution counts to `null` and inserts `<<<<<<<`/`>>>>>>>` conflict markers, but these markers can appear anywhere in the notebook JSON—cell source, outputs, or metadata—making standard text-based conflict resolution inadequate.

This extension provides a rich UI for notebook-aware conflict resolution. Instead of treating `.ipynb` files as flat JSON, it parses the notebook structure and presents conflicts at the cell level, letting users accept current/incoming/both versions per-cell while preserving valid notebook format.

## Key Behaviors

- **Always parse raw JSON**: Conflicts may be in `cells[].source`, `cells[].outputs`, or `metadata`—never assume they're only in code
- **Preserve notebook validity**: Resolved output must be valid `.ipynb` JSON with proper cell structure
- **Handle execution counts**: Git nullifies `execution_count`; optionally restore or renumber after resolution
- **Cell-level diffing**: Show side-by-side or inline diffs for conflicting cells, not raw JSON lines

## Tech Stack

- VSCode Extension API (TypeScript)
- Custom editor or webview for conflict UI
- `nbformat`-compatible JSON parsing

## Conflict Types

1. **Semantic conflicts** - Git `UU` status; different execution states, outputs, or cell modifications between branches

## Key Files

- `conflictDetector.ts` - Detection (`hasConflictMarkers`, `analyzeNotebookConflicts`, `detectSemanticConflicts`) and resolution (`resolveAllConflicts`)
- `gitIntegration.ts` - Git operations (retrieve base/current/incoming versions from staging areas, detect `UU` status)
- `cellMatcher.ts` - Content-based cell matching algorithm for 3-way merge
- `positionUtils.ts` - Browser-safe position comparison/sorting utilities for cell ordering
- `notebookUtils.ts` - Browser-safe notebook helpers (normalizeCellSource, getCellPreview)
- `diffUtils.ts` - LCS-based text diffing with inline change detection
- `resolver.ts` - VSCode commands and unified conflict resolution flow
- `web/WebConflictPanel.ts` - Opens conflict resolver in browser via local web server
- `web/webServer.ts` - HTTP/WebSocket server for browser-based UI
- `web/client/` - React-based conflict resolution UI

## Commands

Single unified command:
- `merge-nb.findConflicts` - Find notebooks with merge conflicts, brings up the conflict resolution panel

## Testing

`npm run test:integration` 

Test files in `src/test/`:
- `04_Cascadia.ipynb` - cell-level HTML-styled conflicts
- `simple-textual-conflict.ipynb` - inline conflicts with output conflicts
- `02_base.ipynb`, `02_current.ipynb`, `02_incoming.ipynb` - three-way semantic conflict test case
