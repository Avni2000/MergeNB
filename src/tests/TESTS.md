# Tests Overview

The command you're likely looking for is `npm run test` - it will launch an interactive picker that lets you choose which tests to run. See below for details

---

Some tests here are integration tests that launch VS Code via `@vscode/test-electron` and drive the extension UI + Playwright. Others are unit tests that run in Node and test individual functions or ideas. I really just treat those as regression tests and don't bother too much about updating them as the code evolves. Regardless, it tells you a lot if some test is failing, so we should try to keep them all passing - feel free to raise an issue if you see a failing test and aren't sure if it's expected or not.

This is all done via a simple cli. 

> Tests are grouped and registered in `src/tests/registry.ts`

---

## Manual Testing


I've also added some personal testing fixtures I work with outside MergeNB development, which can be launched through the samne test runner, called "sandboxes" because they allow you to open a given conflict in a real VS Code window in your TMP directory. It's good practice to just "see" the UI and how the extension is behaving with your changes.

Manual sandboxes default to a deterministic workspace at `$TMP/.mergenb/manual-sandbox`
and launch with `code --reuse-window` so one VS Code window can be reused.

`npm run test:manual` accepts exactly one fixture per run (for example, `02` with `npm run test:manual 02`). If it's not given any, it just runs through all of them sequentially and opens a sandbox for the last one.
 
 The sandbox starts with an active merge conflict in `conflict.ipynb` and includes

- `{original-notebooks}/base.ipynb`
- `{original-notebooks}/current.ipynb`
- `{original-notebooks}/incoming.ipynb` 

for quick reference.

## How To Run

Use one of these commands from the repo root:
- `npm run test` (interactive picker)
- `npm run test:all` (all tests)
- `npm run test:list` (list groups and tests)
- `node out/tests/runIntegrationTest.js --all`
- `node out/tests/runIntegrationTest.js --group <group>`
- `node out/tests/runIntegrationTest.js --test <test>`
- `node out/tests/runIntegrationTest.js --list`

---

## Adding A Test

1. Create a test file in `src/tests/` (follow existing naming patterns).
2. Add the test to a group in `src/tests/registry.ts`.
3. If the test needs a merge-conflict repo, use helpers in `src/tests/repoSetup.ts`.
4. Use Playwright helpers from `src/tests/integrationUtils.ts` for UI actions.
5. If you add a new notebook fixture, place it in `test/` with the existing naming scheme.

---

## What Each File Does

- `src/tests/registry.ts`: Defines groups and individual tests.
- `src/tests/runIntegrationTest.ts`: CLI + TUI test runner.
- `src/tests/testHarness.ts`: VS Code extension host setup.
- `src/tests/repoSetup.ts`: Merge-conflict repo creation utilities.
- `src/tests/integrationUtils.ts`: Playwright helpers for the conflict UI.
