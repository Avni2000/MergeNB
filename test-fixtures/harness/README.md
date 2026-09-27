# Integration test harness

Test support lives here, split by responsibility:

| File | Responsibility |
| --- | --- |
| `playwright.ts` | Exports Playwright `test` / `expect` and manages isolated settings, temporary repositories, and session cleanup. |
| `vscode.ts` | Reads runner config and opens the resolver through VS Code commands, with a direct server fallback outside VS Code. |
| `conflictSession.ts` | Creates direct web server sessions and handles browser messages using the core merge logic and configured settings. |
| `browser.ts` | Launches Chromium and waits for the resolver UI and session connection. |
| `notebook.ts` | Applies resolutions, reads notebook fixtures, builds expected cells, and compares UI expectations with notebooks on disk. |

Playwright specs import `test` and `expect` from `playwright.ts`. VS Code host tests import startup helpers from `vscode.ts`. Both import notebook operations directly from `notebook.ts`.

Low-level repository, UI interaction, polling, and runner utilities remain in `../shared`. Notebook merge logic remains in `packages/core`.
