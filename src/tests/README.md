# Tests Overview

The command you're probably looking for is `npm run test`, it launches an interactive picker so you can choose what to run.

 Some tests are integration tests that actually launch VS Code via `@vscode/test-electron`, drive the extension UI, and verify results with Playwright. Others are regression or unit tests that run straight in Node, testing functions directly.
 
  All of them share a common CLI runner and registry, which you can find in [registry.ts](registry.ts).

## Running Tests

From the repo root:

| Command | What it does |
|---|---|
| `npm run test` | Interactive TUI picker (default) |
| `npm run test:all` | Run all auto-included tests |
| `npm run test:list` | Print all groups and tests, **run this first!** |
| `npm run test:manual 02` | Open manual sandbox for fixture 02 |
| `node out/tests/runIntegrationTest.js --all` | Same as `test:all` |
| `node out/tests/runIntegrationTest.js --group <id>` | Run a specific group |
| `node out/tests/runIntegrationTest.js --test <id>` | Run a specific test |
| `node out/tests/runIntegrationTest.js --list` | Same as `test:list` |

---

## Adding a Test

Here are a few examples of things you might want to do; hopefully this section saves you some time instead of digging through the codebase.

**A quick note on fixtures**: if you add notebook fixtures, place them in [test/](../../test/) using the existing naming scheme (e.g. `05_base.ipynb`, `05_incoming_.ipynb`, `05_incoming.ipynb`). The current ones are from an outside project, so feel free to add or modify them; more fixtures the better, genuinely.

### Steps

1. **Create a test file** in [src/tests/](.) following the naming pattern: `<shortName>.test.ts`
2. **Register it** in [registry.ts](registry.ts) under an existing group or a new one
3. **If it needs a merge-conflict repo**, use `createMergeConflictRepo` from [repoSetup.ts](repoSetup.ts)
4. **If it needs UI interaction**, use Playwright helpers from [integrationUtils.ts](integrationUtils.ts) and setup from [testHarness.ts](testHarness.ts)

### Test Registration

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

### Integration Tests

Here's the high-level workflow - it's a bit of a chain, but each step makes sense once you see the whole picture:

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

Example:

```typescript
import { readTestConfig, setupConflictResolver, applyResolutionAndReadNotebook, assertNotebookMatches } from './testHarness';
import { collectExpectedCellsFromUI } from './integrationUtils';

export async function run() {
    const { page, conflictFile } = await setupConflictResolver(readTestConfig());

    // Collect what the UI shows before applying anything
    const expectedCells = await collectExpectedCellsFromUI(page, {
        resolveConflictChoice: async (row, conflictIndex, rowIndex) => {
            // Drive the UI here, then return which side was chosen
            // I thought this was particularly clever, so I'm leaving it in as an example - it simulates choosing 'incoming' for even rows and 'current' for odd rows
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

### Settings Override

Integration tests should temporarily disable settings that could interfere (e.g. `autoResolve`).

```typescript
const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
const prev = mergeNBConfig.get('autoResolve.executionCount');
await mergeNBConfig.update('autoResolve.executionCount', false, vscode.ConfigurationTarget.Workspace);
// ... run test ...
await mergeNBConfig.update('autoResolve.executionCount', prev, vscode.ConfigurationTarget.Workspace);
```

---

## Manual Testing

Manual sandboxes let you visually inspect the extension UI in a real VS Code window; really useful for catching things that are hard to assert programmatically.

```bash
npm run test:manual 02   # open fixture 02 in a sandbox
```

Workspaces land in `$TMP/.mergenb/manual-sandbox` (deterministic, reused across runs), and VS Code launches with `code --reuse-window`. The sandbox contains `conflict.ipynb` (active merge conflict) plus reference copies in `original-notebooks/`, base, current, and incoming.

Running `npm run test:manual` with no argument cycles through all fixtures sequentially, leaving the last one open.