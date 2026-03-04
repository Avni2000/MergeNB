# MergeNB - Jupyter Notebook Merge Conflict Resolver

A VSCode extension for resolving merge conflicts in Jupyter notebooks (`.ipynb` files). Git's default merge behavior strips execution counts to `null` when merging notebooks, which can cause different execution states, outputs, or cell modifications between branches.

This extension provides a rich UI for notebook-aware conflict resolution. Instead of treating `.ipynb` files as flat JSON, it parses the notebook structure and presents conflicts at the cell level, letting users accept current/incoming/both versions per-cell while preserving valid notebook format.

## Key Behaviors

- **Always parse raw JSON**: Conflicts may be in `cells[].source`, `cells[].outputs`, or `metadata`—never assume they're only in code
- **Preserve notebook validity**: Resolved output must be valid `.ipynb` JSON with proper cell structure
- **Handle execution counts**: nbdime nullifies `execution_count`; optionally restore or renumber after resolution
- **Cell-level diffing**: Show side-by-side or inline diffs for conflicting cells, not raw JSON lines

## Tech Stack

- VSCode Extension API (TypeScript)
- Custom editor or webview for conflict UI
- `nbformat`-compatible JSON parsing

## Conflict Types

1. **Semantic conflicts** - Git `UU` status; different execution states, outputs, or cell modifications between branches

## Key Files

- `conflictDetector.ts` - Detection (`analyzeNotebookConflicts`, `detectSemanticConflicts`) and resolution (`resolveAllConflicts`)
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

Integration tests use `@vscode/test-electron` to launch VS Code with merge-conflict repos. Tests are organized into groups in `src/tests/registry.ts`.

```bash
npm run test              # Interactive TUI picker to select tests
npm run test:all          # Run all tests at once
npm run test:list         # List all available test groups and tests
node out/tests/runIntegrationTest.js --all              # Direct: run all (skip build)
node out/tests/runIntegrationTest.js --group takeAll    # Direct: run one group
node out/tests/runIntegrationTest.js --test takeAll_base    # Direct: run single test
node out/tests/runIntegrationTest.js --list             # Direct: list all tests
```

### Key Test Files:

- `src/tests/registry.ts` - Test groups and definitions (add new tests here)
- `src/tests/repoSetup.ts` - Git merge-conflict repo creation
- `src/tests/runIntegrationTest.ts` - CLI + TUI runner
- `src/tests/testHarness.ts` - VS Code extension host setup, browser automation
- `src/tests/integrationUtils.ts` - Playwright helpers for conflict UI interaction

### Notebook Fixtures Available:

- `test/02_*.ipynb`
- `test/03_*.ipynb`
- `test/04_*.ipynb`