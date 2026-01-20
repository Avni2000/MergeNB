# MergeNB - Jupyter Notebook Merge Conflict Resolver

A VSCode extension for resolving merge conflicts in Jupyter notebooks (`.ipynb` files). Git's default merge behavior strips execution counts to `null` and inserts `<<<<<<<`/`>>>>>>>` conflict markers, but these markers can appear anywhere in the notebook JSON—cell source, outputs, or metadata—making standard text-based conflict resolution inadequate.

This extension provides a rich UI for notebook-aware conflict resolution. Instead of treating `.ipynb` files as flat JSON, it parses the notebook structure and presents conflicts at the cell level, letting users accept local/remote/both versions per-cell while preserving valid notebook format.

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

1. **Raw markers** - `<<<<<<<`/`>>>>>>>` in JSON breaks parsing; use `analyzeRawConflicts()`
2. **HTML-styled markers** - `<span><<<<<<< local</span>` in cell source; JSON valid but cells marked as local/remote
3. **Inline conflicts** - markers within a single cell's source or outputs
4. **Semantic conflicts** - Git `UU` status without textual markers; different execution states, outputs, or cell modifications between branches

## Key Files

- `conflictDetector.ts` - Detection (`hasConflictMarkers`, `analyzeNotebookConflicts`, `detectSemanticConflicts`) and resolution (`resolveAllConflicts`)
- `gitIntegration.ts` - Git operations (retrieve base/local/remote versions from staging areas, detect `UU` status)
- `cellMatcher.ts` - Content-based cell matching algorithm for 3-way merge
- `resolver.ts` - VSCode commands and unified conflict resolution flow
- `webview/ConflictResolverPanel.ts` - Unified UI for both textual and semantic conflict resolution (3-way diff view)

## Commands

Single unified command:
- `merge-nb.findConflicts` - Find notebooks with merge conflicts (both textual and semantic), brings up the conflict resolution panel

## Testing

`npm run test:integration` 

Test files in `src/test/`:
- `04_Cascadia.ipynb` - cell-level HTML-styled conflicts
- `simple-textual-conflict.ipynb` - inline conflicts with output conflicts
- `02_base.ipynb`, `02_local.ipynb`, `02_remote.ipynb` - three-way semantic conflict test case
