/**
 * @file editWarningOnBlur.spec.ts
 * @description Verifies the edit-warning modal appears when the user clicks
 * outside a resolved cell that is in edit mode.
 *
 * Flow under test:
 * 1. Resolve a conflict (e.g. "Use Current")
 * 2. Enter edit mode on the resolved cell
 * 3. Click somewhere outside the editor (blur)
 * 4. Expect the "Save edits before leaving?" warning modal to appear
 * 5. Dismiss via "Keep editing" or "Save edits"
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

test.describe('Edit Warning on Blur', () => {
    test('shows warning modal when clicking outside a resolved cell in edit mode', async ({ conflictRepo, conflictSession }, testInfo) => {
        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
            });

            const workspacePath = conflictRepo({
                base: '02_base.ipynb',
                current: '02_current.ipynb',
                incoming: '02_incoming.ipynb',
            });

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
            await enterResolvedEditMode(firstConflict);

            // Verify the editor is visible
            const editor = firstConflict.locator('.resolved-content-input');
            await expect(editor).toBeVisible();

            // Click outside the editor — on the header, which is well outside the resolved cell
            await page.locator('.header-title').click();

            // The edit warning modal should appear
            const warningModal = page.locator('[data-testid="edit-warning-modal"]');
            await expect(warningModal).toBeVisible({ timeout: 3000 });

            const viewport = page.viewportSize();
            const overlayBounds = await warningModal.boundingBox();
            expect(viewport).not.toBeNull();
            expect(overlayBounds).not.toBeNull();
            expect(overlayBounds!.x).toBeLessThanOrEqual(1);
            expect(overlayBounds!.y).toBeLessThanOrEqual(1);
            expect(overlayBounds!.width).toBeGreaterThanOrEqual((viewport?.width ?? 0) - 2);
            expect(overlayBounds!.height).toBeGreaterThanOrEqual((viewport?.height ?? 0) - 2);

            // Verify modal content
            await expect(warningModal.locator('h3')).toHaveText('Save edits before leaving?');

            // Dismiss by clicking "Keep editing"
            await warningModal.locator('button:has-text("Keep editing")').click();

            // Modal should close
            await expect(warningModal).not.toBeVisible();

            // Editor should still be visible (still in edit mode)
            await expect(editor).toBeVisible();

        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('save edits button in warning modal saves and exits edit mode', async ({ conflictRepo, conflictSession }) => {
        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
            });

            const workspacePath = conflictRepo({
                base: '02_base.ipynb',
                current: '02_current.ipynb',
                incoming: '02_incoming.ipynb',
            });

            const session = await conflictSession(workspacePath);
            const { page } = session;

            // Resolve the first conflict
            const conflictRows = page.locator('.merge-row.conflict-row');
            const firstConflict = conflictRows.first();
            await firstConflict.scrollIntoViewIfNeeded();

            const resolveBtn = firstConflict.locator('.btn-resolve.btn-current, .btn-resolve.btn-incoming, .btn-resolve.btn-base').first();
            await resolveBtn.waitFor({ timeout: 10000 });
            await resolveBtn.click();
            await firstConflict.locator('.resolved-cell').waitFor({ timeout: 5000 });

            // Enter edit mode
            await enterResolvedEditMode(firstConflict);

            // Click outside the editor
            await page.locator('.header-title').click();

            // Warning modal should appear
            const warningModal = page.locator('[data-testid="edit-warning-modal"]');
            await expect(warningModal).toBeVisible({ timeout: 3000 });

            // Click "Save edits" in the warning modal
            await warningModal.locator('[data-testid="edit-warning-save"]').click();

            // Modal should close and editor should be replaced by static content
            await expect(warningModal).not.toBeVisible();
            await firstConflict.locator('.resolved-content-static').waitFor({ timeout: 5000 });

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

            const workspacePath = conflictRepo({
                base: '02_base.ipynb',
                current: '02_current.ipynb',
                incoming: '02_incoming.ipynb',
            });

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
            await expect(firstConflict.locator('.resolved-content-input')).toBeVisible();

            await firstConflict.locator('button:has-text("Undo resolution")').click();
            await warningModal.locator('button:has-text("Undo resolution")').click();
            await firstConflict.locator('.resolved-cell').waitFor({ state: 'detached', timeout: 5000 });
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });
});
