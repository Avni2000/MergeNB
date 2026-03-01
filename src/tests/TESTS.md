# Tests Overview

The command you're likely looking for is `npm run test` — it launches an interactive picker so you can choose which tests to run.

---

## Architecture

Some tests are **integration tests** that launch VS Code via `@vscode/test-electron`, drive the extension UI, and verify results with Playwright. Others are **pure logic tests** that run in Node and test functions directly — no browser, no file system.

All tests share a common CLI runner and registry.

> Tests are grouped and registered in [registry.ts](registry.ts).

**High-level workflow for integration tests:**

```
Create git merge-conflict repo (repoSetup.ts)
  -> Write test config JSON to disk
  -> Launch VS Code extension host (testHarness.ts)
  -> Extension opens conflict.ipynb and finds conflicts
  -> Playwright connects to the web UI (integrationUtils.ts)
  -> Test drives UI interactions
  -> Apply resolution
  -> Read resolved notebook from disk
  -> Assert notebook matches expected state
```

---

## Running Tests

From the repo root:

| Command | What it does |
|---|---|
| `npm run test` | Interactive TUI picker (default) |
| `npm run test:all` | Run all auto-included tests |
| `npm run test:list` | Print all groups and tests |
| `npm run test:manual 02` | Open manual sandbox for fixture 02 |
| `node out/tests/runIntegrationTest.js --all` | Same as `test:all` |
| `node out/tests/runIntegrationTest.js --group <id>` | Run a specific group |
| `node out/tests/runIntegrationTest.js --test <id>` | Run a specific test |
| `node out/tests/runIntegrationTest.js --list` | Same as `test:list` |

---

## Adding a Test

### Steps

1. **Create a test file** in [src/tests/](.) following the naming pattern: `<shortName>.test.ts`
2. **Register it** in [registry.ts](registry.ts) under an existing group or a new one
3. **If it needs a merge-conflict repo**, use `createMergeConflictRepo` from [repoSetup.ts](repoSetup.ts)
4. **If it needs UI interaction**, use Playwright helpers from [integrationUtils.ts](integrationUtils.ts) and setup from [testHarness.ts](testHarness.ts)
5. **If it's pure logic**, just use Node's built-in `assert` — no VS Code or browser needed
6. **If you add notebook fixtures**, place them in [test/](../../test/) using the existing naming scheme (e.g. `base_05.ipynb`, `current_05.ipynb`, `incoming_05.ipynb`)

### Test Registration Example

```typescript
// registry.ts
{
  id: 'regression_my_new_test',
  label: 'My new regression',
  testModule: 'myNewRegression.test.js',  // compiled path relative to out/tests/
  group: 'regression',
  notebooks: ['05_base.ipynb', '05_current.ipynb', '05_incoming.ipynb'],
  params: { someOption: true },           // forwarded via config file, read with readTestConfig()
}
```

### Pure Logic Test Pattern

No VS Code host or browser — just import the function and assert:

```typescript
import * as assert from 'assert';
import { myFunction } from '../myModule';

export async function run() {
    const result = myFunction(input);
    assert.strictEqual(result, expected, 'description of what should be true');
}
```

### Integration Test Pattern

```typescript
import { readTestConfig, setupConflictResolver, applyResolutionAndReadNotebook, assertNotebookMatches } from './testHarness';
import { collectExpectedCellsFromUI } from './integrationUtils';

export async function run() {
    const { page, conflictFile } = await setupConflictResolver(readTestConfig());

    // Collect what the UI shows (before applying)
    const expectedCells = await collectExpectedCellsFromUI(page, {
        resolveConflictChoice: async (row, conflictIndex, rowIndex) => {
            // Drive the UI here, then return which side was chosen
            return { choice: rowIndex % 2 === 0 ? 'incoming' : 'current' };
        },
        includeMetadata: true,
        includeOutputs: true,
    });

    // Apply and read the written notebook
    const resolvedNotebook = await applyResolutionAndReadNotebook(page, conflictFile);

    // Assert the notebook matches what the UI showed
    assertNotebookMatches(expectedCells, resolvedNotebook, {
        compareMetadata: true,
        compareExecutionCounts: true,
        renumberEnabled: true,
    });
}
```

### Settings Override Pattern

Integration tests should temporarily disable settings that could interfere (e.g. `autoResolve`):

```typescript
const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
const prev = mergeNBConfig.get('autoResolve.executionCount');
await mergeNBConfig.update('autoResolve.executionCount', false, vscode.ConfigurationTarget.Workspace);
// ... run test ...
await mergeNBConfig.update('autoResolve.executionCount', prev, vscode.ConfigurationTarget.Workspace);
```

---

## Manual Testing

Manual sandboxes let you visually inspect the extension UI in a real VS Code window.

```bash
npm run test:manual 02   # open fixture 02 in a sandbox
npm run test:manual 03   # open fixture 03
npm run test:manual 04   # open fixture 04
```

- Workspaces land in `$TMP/.mergenb/manual-sandbox` (deterministic, reused across runs)
- VS Code launches with `code --reuse-window` so the same window is reused
- The sandbox contains `conflict.ipynb` (active merge conflict) plus reference copies:
  - `original-notebooks/base.ipynb`
  - `original-notebooks/current.ipynb`
  - `original-notebooks/incoming.ipynb`

Running `npm run test:manual` with no argument cycles through all fixtures sequentially, leaving the last one open.