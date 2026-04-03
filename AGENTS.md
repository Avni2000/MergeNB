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

## Test Structure

Tests are distributed across the monorepo:

- `test-fixtures/` - Notebook fixture files (`.ipynb` triplets for base/current/incoming)
- `test-fixtures/shared/` - Shared test infrastructure used by both VSCode and Playwright tests:
  - `repoSetup.ts` - Creates temporary git repos with merge conflicts from fixture triplets
  - `testHelpers.ts` - Shared types (`ExpectedCell`, `TestConfig`), server health-check utils
  - `testRunnerShared.ts` - Isolated config path helpers for test runners
  - `integrationUtils.ts` - Playwright `Page`/`Locator` helpers for driving the conflict UI
- `apps/vscode-extension/tests/` - VSCode extension host tests (`@vscode/test-electron`):
  - `runIntegrationTest.ts` - Master TUI/CLI runner (entry point for `npm run test`)
  - `runNbdimeGuardTest.ts` - CI-only nbdime guard runner
  - `testHarness.ts` - Extension host lifecycle and headless conflict resolver setup
  - `gitTestUtils.ts` - Git CLI helpers for regression tests
  - `settingsFile.ts` - Settings file read/write helpers
  - `vscodeRegression.test.ts`, `e2eResolution.test.ts`, etc. - Test suites
- `packages/web/tests/` - Playwright browser tests:
  - `fixtures.ts` - Playwright Test fixtures (conflict repo setup, session management)
  - `globalSetup.ts` / `globalTeardown.ts` - Shared web server lifecycle
  - `*.spec.ts` - Test specs

## Commands

Single unified command:
- `merge-nb.findConflicts` - Find notebooks with merge conflicts, brings up the conflict resolution panel

## Testing

Integration tests use `@vscode/test-electron` to launch VS Code with merge-conflict repos.

```bash
npm run test              # Interactive TUI picker to select tests
npm run test:all          # Run all tests at once
npm run test:pw           # Run Playwright specs directly
npm run test:vscode       # Run VS Code regression tests
npm run test:e2e          # Run E2E resolution tests
node out/apps/vscode-extension/tests/runIntegrationTest.js --vscode     # Direct: run VS Code tests (skip build)
node out/apps/vscode-extension/tests/runIntegrationTest.js --e2e        # Direct: run E2E tests
node out/apps/vscode-extension/tests/runIntegrationTest.js --playwright # Direct: run Playwright specs
```

### Key Test Files:

- `test-fixtures/shared/repoSetup.ts` - Git merge-conflict repo creation
- `test-fixtures/shared/integrationUtils.ts` - Playwright helpers for conflict UI interaction
- `apps/vscode-extension/tests/runIntegrationTest.ts` - CLI + TUI runner
- `apps/vscode-extension/tests/testHarness.ts` - VS Code extension host setup, browser automation
- `packages/web/tests/fixtures.ts` - Playwright Test fixtures

### Notebook Fixtures Available:

- `test-fixtures/02_*.ipynb`
- `test-fixtures/03_*.ipynb`
- `test-fixtures/04_*.ipynb`