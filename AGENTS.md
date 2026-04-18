# MergeNB - Jupyter Notebook Merge Conflict Resolver

A VSCode extension for resolving merge conflicts in Jupyter notebooks (`.ipynb` files). 
This extension provides a rich UI for notebook-aware conflict resolution. 

## Rules

Always respect settings when working on features. Settings can be found in `apps/vscode-extension/settings.ts`

Follow conventional commits and commit often. 
- Prefer shorter commits with bullet points instead of listing every change in every file.

Tests should always verify on-disk and UI content match. 

Handle notebook metadata as needed for the task.

Unified cells are cells that don't have merge conflicts -- where base/current
/incoming match, or incoming overwrites current cleanly.

Core logic should always be in `packages/core`

Always follow DRY principles. Run find-dead-code as needed.

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

#### Generic Conflicts:

+- `test-fixtures/general/conflict_{0..13}/{base,current,incoming}.ipynb`

#### Specific Edge Case Conflict:

- `test-fixtures/edge-cases/mime-output-rendering/{base,current,incoming}.ipynb`
- `test-fixtures/edge-cases/reordered-cells/{base,current,incoming}.ipynb`
- `test-fixtures/edge-cases/settings-matrix/{base,current,incoming}.ipynb`
- `test-fixtures/edge-cases/single-conflict/{base,current,incoming}.ipynb`
- `test-fixtures/edge-cases/syntax-highlighting/{base,current,incoming}.ipynb`
