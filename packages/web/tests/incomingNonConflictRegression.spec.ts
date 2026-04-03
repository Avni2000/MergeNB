/**
 * @file incomingNonConflictRegression.spec.ts
 * @description Playwright Test for regression: one-sided incoming edits on non-conflict rows.
 *
 * Verifies that when base/current are equal and incoming changed a cell's source,
 * the final resolved notebook preserves incoming content for that row.
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from './fixtures';
import { applyResolutionAndReadNotebook } from './fixtures';
import { getCellSource, validateNotebookStructure } from '../../../test-fixtures/shared/testHelpers';
import * as logger from '../../core/src';

// ─── Helper Functions ───────────────────────────────────────────────────────

function readFixtureNotebook(fileName: string): any {
    const fixturePath = path.resolve(__dirname, '../../../test-fixtures', fileName);
    if (!fs.existsSync(fixturePath)) {
        throw new Error(`Fixture not found: ${fixturePath}`);
    }
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function getStep1GradientDescentSource(notebook: any, label: string): string {
    const cell = notebook?.cells?.find(
        (c: any) => getCellSource(c).includes('## Step 1: Gradient Descent')
    );

    if (!cell) {
        throw new Error(`${label}: could not find "## Step 1: Gradient Descent" cell`);
    }

    return getCellSource(cell);
}

// ─── Test Definitions ───────────────────────────────────────────────────────

test.describe('Incoming Non-Conflict Regression', () => {
    test('Preserve incoming-only content for non-conflict rows', async ({ conflictRepo, conflictSession }) => {
        logger.info('Starting incoming non-conflict regression integration test...');

        const workspacePath = conflictRepo({
            base: 'demo_base.ipynb',
            current: 'demo_current.ipynb',
            incoming: 'demo_incoming.ipynb',
        });

        const session = await conflictSession(workspacePath);
        const { page, conflictFile } = session;

        // Read fixtures for comparison
        const baseNotebook = readFixtureNotebook('demo_base.ipynb');
        const currentNotebook = readFixtureNotebook('demo_current.ipynb');
        const incomingNotebook = readFixtureNotebook('demo_incoming.ipynb');

        const baseStep1Source = getStep1GradientDescentSource(baseNotebook, 'Base fixture');
        const currentStep1Source = getStep1GradientDescentSource(currentNotebook, 'Current fixture');
        const incomingStep1Source = getStep1GradientDescentSource(incomingNotebook, 'Incoming fixture');

        // Verify fixture preconditions
        expect(baseStep1Source).toBe(currentStep1Source);
        expect(incomingStep1Source).not.toBe(baseStep1Source);

        // Verify identical rows exist
        const identicalRows = page.locator('.merge-row.identical-row');
        const identicalCount = await identicalRows.count();
        expect(identicalCount).toBeGreaterThan(0);

        // Find Step 1 row in UI
        let step1UiSource: string | undefined;
        for (let i = 0; i < identicalCount; i++) {
            const rawSource = await identicalRows.nth(i).getAttribute('data-raw-source');
            if (rawSource?.includes('## Step 1: Gradient Descent')) {
                step1UiSource = rawSource;
                break;
            }
        }

        expect(step1UiSource).toBeDefined();
        expect(step1UiSource).toContain('We need a few things to get started.');
        expect(step1UiSource).not.toContain('We need some optimization algorithm first.');

        // Resolve all conflicts
        const conflictRows = page.locator('.merge-row.conflict-row');
        const conflictCount = await conflictRows.count();
        expect(conflictCount).toBeGreaterThan(0);

        for (let i = 0; i < conflictCount; i++) {
            const row = conflictRows.nth(i);
            await row.scrollIntoViewIfNeeded();

            const incomingBtn = row.locator('.btn-incoming');
            const currentBtn = row.locator('.btn-current');
            const baseBtn = row.locator('.btn-base');
            const deleteBtn = row.locator('.btn-delete');

            if (await incomingBtn.count() > 0) {
                await incomingBtn.click();
            } else if (await currentBtn.count() > 0) {
                await currentBtn.click();
            } else if (await baseBtn.count() > 0) {
                await baseBtn.click();
            } else {
                await deleteBtn.click();
            }

            await row.locator('.resolved-cell').first().waitFor({ timeout: 5000 });
        }

        // Apply and verify
        const resolvedNotebook = await applyResolutionAndReadNotebook(page, conflictFile);
        validateNotebookStructure(resolvedNotebook);

        const resolvedStep1Source = getStep1GradientDescentSource(resolvedNotebook, 'Resolved notebook');
        expect(resolvedStep1Source).toBe(incomingStep1Source);

        logger.info('✓ Non-conflict incoming-only Step 1 content preserved');
        logger.info('✓ Notebook structure valid');
    });
});
