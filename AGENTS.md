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
