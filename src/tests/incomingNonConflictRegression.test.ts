/**
 * @file incomingNonConflictRegression.test.ts
 * @description Regression test for one-sided incoming edits on non-conflict rows.
 *
 * Verifies that when base/current are equal and incoming changed a cell's source,
 * the final resolved notebook preserves incoming content for that row.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    readTestConfig,
    setupConflictResolver,
    applyResolutionAndReadNotebook,
} from './testHarness';
import { getCellSource, validateNotebookStructure } from './testHelpers';

function readFixtureNotebook(fileName: string): any {
    const fixturePath = path.resolve(__dirname, '../../test', fileName);
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

export async function run(): Promise<void> {
    console.log('Starting incoming non-conflict regression integration test...');

    let browser: import('playwright').Browser | undefined;
    let page: import('playwright').Page | undefined;

    try {
        const config = readTestConfig();
        const session = await setupConflictResolver(config);
        browser = session.browser;
        page = session.page;

        const baseNotebook = readFixtureNotebook('demo_base.ipynb');
        const currentNotebook = readFixtureNotebook('demo_current.ipynb');
        const incomingNotebook = readFixtureNotebook('demo_incoming.ipynb');

        const baseStep1Source = getStep1GradientDescentSource(baseNotebook, 'Base fixture');
        const currentStep1Source = getStep1GradientDescentSource(currentNotebook, 'Current fixture');
        const incomingStep1Source = getStep1GradientDescentSource(incomingNotebook, 'Incoming fixture');

        if (baseStep1Source !== currentStep1Source) {
            throw new Error('Fixture precondition failed: expected base and current Step 1 to match');
        }
        if (incomingStep1Source === baseStep1Source) {
            throw new Error('Fixture precondition failed: expected incoming Step 1 to differ from base/current');
        }

        const identicalRows = page.locator('.merge-row.identical-row');
        const identicalCount = await identicalRows.count();
        if (identicalCount === 0) {
            throw new Error('Expected at least one identical row');
        }

        let step1UiSource: string | undefined;
        for (let i = 0; i < identicalCount; i++) {
            const rawSource = await identicalRows.nth(i).getAttribute('data-raw-source');
            if (rawSource?.includes('## Step 1: Gradient Descent')) {
                step1UiSource = rawSource;
                break;
            }
        }

        if (!step1UiSource) {
            throw new Error('Could not find Step 1 identical row in UI');
        }

        if (!step1UiSource.includes('We need a few things to get started.')) {
            throw new Error('UI did not preserve incoming-only Step 1 content');
        }

        if (step1UiSource.includes('We need some optimization algorithm first.')) {
            throw new Error('UI incorrectly used current/base Step 1 content');
        }

        const conflictRows = page.locator('.merge-row.conflict-row');
        const conflictCount = await conflictRows.count();
        if (conflictCount === 0) {
            throw new Error('Expected at least one conflict row to resolve');
        }

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

        const resolvedNotebook = await applyResolutionAndReadNotebook(page, session.conflictFile);
        validateNotebookStructure(resolvedNotebook);

        const resolvedStep1Source = getStep1GradientDescentSource(resolvedNotebook, 'Resolved notebook');

        if (resolvedStep1Source !== incomingStep1Source) {
            throw new Error(
                'Regression: resolved Step 1 cell does not match incoming-only edit'
            );
        }

        console.log('✓ Non-conflict incoming-only Step 1 content preserved');
        console.log('✓ Notebook structure valid');
    } finally {
        if (page) await page.close();
        if (browser) await browser.close();
    }
}
