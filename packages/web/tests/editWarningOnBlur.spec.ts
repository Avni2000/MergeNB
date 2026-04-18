/**
 * @file editWarningOnBlur.spec.ts
 * @description Verifies resolved-cell edits autosave on blur and that warnings
 * only appear for destructive actions that would discard edited content.
 *
 * Flow under test:
 * 1. Resolve a conflict (e.g. "Use Current")
 * 2. Enter edit mode on the resolved cell
 * 3. Click somewhere outside the editor (blur)
 * 4. Expect the draft to autosave and edit mode to exit
 * 5. Expect warnings only when a destructive action discards edited content
 */

import { test, expect } from './fixtures';
import {
    enterResolvedEditMode,
    fillResolvedEditor,
} from '../../../test-fixtures/shared/integrationUtils';
import {
    readSettingsFileSnapshot,
    restoreSettingsFileSnapshot,
    writeSettingsFile,
} from '../../../apps/vscode-extension/tests/settingsFile';

const CONFLICT_2_FIXTURES = {
    base: 'general/conflict_2/base.ipynb',
    current: 'general/conflict_2/current.ipynb',
    incoming: 'general/conflict_2/incoming.ipynb',
};

test.describe('Edit Warning on Blur', () => {
    test('clicking outside autosaves the draft and exits edit mode', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
            });

            const workspacePath = conflictRepo(CONFLICT_2_FIXTURES);

            const session = await conflictSession(workspacePath);
            const { page } = session;

            // Resolve the first conflict by clicking whichever branch button is available
            const conflictRows = page.locator('.merge-row.conflict-row');
            const firstConflict = conflictRows.first();
            await firstConflict.scrollIntoViewIfNeeded();

            // Pick first available resolution button (current, incoming, or base)
            const resolveBtn = firstConflict.locator('.btn-resolve.btn-current, .btn-resolve.btn-incoming, .btn-resolve.btn-base').first();
            await resolveBtn.waitFor({ timeout: 10000 });
            await resolveBtn.click();

            // Wait for the resolved cell to appear
            await firstConflict.locator('.resolved-cell').waitFor({ timeout: 5000 });

            // Enter edit mode
            const editor = await enterResolvedEditMode(firstConflict);
            await fillResolvedEditor(editor, 'autosaved blur edit');

            // Verify the editor is visible
            await expect(editor).toBeVisible();

            // Click outside the editor — on the header, which is well outside the resolved cell
            await page.locator('.header-title').click();

            // Blur should autosave and return to the static resolved view without a modal.
            await expect(firstConflict.locator('[data-testid="edit-warning-modal"]')).toHaveCount(0);
            const staticPre = firstConflict.locator('.resolved-content-static');
            await staticPre.waitFor({ timeout: 5000 });
            await expect(staticPre).toContainText('autosaved blur edit');

        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('clicking another row action autosaves the first editor and opens the next one', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
            });

            const workspacePath = conflictRepo(CONFLICT_2_FIXTURES);

            const session = await conflictSession(workspacePath);
            const { page } = session;

            const conflictRows = page.locator('.merge-row.conflict-row');
            const firstConflict = conflictRows.first();
            const secondConflict = conflictRows.nth(1);

            await conflictRows.first().waitFor({ timeout: 10000 });
            expect(await conflictRows.count()).toBeGreaterThan(1);

            for (const row of [firstConflict, secondConflict]) {
                await row.scrollIntoViewIfNeeded();
                const resolveBtn = row.locator('.btn-resolve.btn-current, .btn-resolve.btn-incoming, .btn-resolve.btn-base').first();
                await resolveBtn.waitFor({ timeout: 10000 });
                await resolveBtn.click();
                await row.locator('.resolved-cell').waitFor({ timeout: 5000 });
            }

            const editor = await enterResolvedEditMode(firstConflict);
            await fillResolvedEditor(editor, 'autosaved before switching rows');

            const secondEditButton = secondConflict.locator('[data-testid="edit-button"]');
            await secondEditButton.click();

            await expect(firstConflict.locator('.resolved-content-static')).toContainText('autosaved before switching rows');
            await expect(firstConflict.locator('.resolved-content-input')).toHaveCount(0);
            await expect(secondConflict.locator('.resolved-content-input')).toBeVisible({ timeout: 5000 });

        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('blur no longer disables other row actions behind a modal', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
            });

            const workspacePath = conflictRepo(CONFLICT_2_FIXTURES);

            const session = await conflictSession(workspacePath);
            const { page } = session;

            const conflictRows = page.locator('.merge-row.conflict-row');
            const firstConflict = conflictRows.first();
            const secondConflict = conflictRows.nth(1);

            await conflictRows.first().waitFor({ timeout: 10000 });
            expect(await conflictRows.count()).toBeGreaterThan(1);

            for (const row of [firstConflict, secondConflict]) {
                await row.scrollIntoViewIfNeeded();
                const resolveBtn = row.locator('.btn-resolve.btn-current, .btn-resolve.btn-incoming, .btn-resolve.btn-base').first();
                await resolveBtn.waitFor({ timeout: 10000 });
                await resolveBtn.click();
                await row.locator('.resolved-cell').waitFor({ timeout: 5000 });
            }

            const firstEditor = await enterResolvedEditMode(firstConflict);
            await expect(firstEditor).toBeVisible();

            await fillResolvedEditor(firstEditor, 'autosave and continue');

            const firstUndoButton = firstConflict.locator('button:has-text("Undo resolution")');
            const secondEditButton = secondConflict.locator('[data-testid="edit-button"]');
            const secondUndoButton = secondConflict.locator('button:has-text("Undo resolution")');

            await expect(firstUndoButton).toBeEnabled();
            await expect(secondEditButton).toBeEnabled();
            await expect(secondUndoButton).toBeEnabled();

            await page.locator('.header-title').click();

            await expect(page.locator('[data-testid="edit-warning-modal"]')).toHaveCount(0);
            await expect(firstConflict.locator('.resolved-content-static')).toContainText('autosave and continue');
            await expect(secondConflict.locator('.resolved-content-input')).toHaveCount(0);
            await expect(page.locator('[data-testid="undo-warning-modal"]')).toHaveCount(0);

            await secondEditButton.click();
            await expect(secondConflict.locator('.resolved-content-input')).toBeVisible({ timeout: 5000 });
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('undo resolution warns before discarding edited resolved content', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
            });

            const workspacePath = conflictRepo(CONFLICT_2_FIXTURES);

            const session = await conflictSession(workspacePath);
            const { page } = session;

            const firstConflict = page.locator('.merge-row.conflict-row').first();
            await firstConflict.scrollIntoViewIfNeeded();

            const resolveBtn = firstConflict.locator('.btn-resolve.btn-current, .btn-resolve.btn-incoming, .btn-resolve.btn-base').first();
            await resolveBtn.waitFor({ timeout: 10000 });
            await resolveBtn.click();
            await firstConflict.locator('.resolved-cell').waitFor({ timeout: 5000 });

            const editor = await enterResolvedEditMode(firstConflict);
            await fillResolvedEditor(editor, 'edited resolved content');

            await firstConflict.locator('button:has-text("Undo resolution")').click();

            const warningModal = page.locator('.warning-modal');
            await expect(warningModal).toBeVisible({ timeout: 3000 });
            await expect(warningModal.locator('h3')).toHaveText('Discard edits and undo resolution?');
            await expect(warningModal.locator('p')).toContainText('Undoing this resolution will discard those changes.');

            await warningModal.locator('button:has-text("Keep my edits")').click();
            await expect(warningModal).not.toBeVisible();
            await expect(firstConflict.locator('.resolved-content-static')).toBeVisible();

            await firstConflict.locator('button:has-text("Undo resolution")').click();
            await warningModal.locator('button:has-text("Undo resolution")').click();
            await firstConflict.locator('.resolved-cell').waitFor({ state: 'detached', timeout: 5000 });
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });
});
