import * as fs from 'fs';
import { test, expect } from '../../../test-fixtures/harness/playwright';
import { parseNotebook, serializeNotebook } from '../../core/src';
import { writeSettingsFile } from '../../../apps/vscode-extension/tests/settingsFile';

test('future minor versions, unknown types, JSON arrays, and repaired IDs match the saved preview', async ({ conflictRepo, conflictSession, applyAndReadNotebook }) => {
    writeSettingsFile({ 'autoResolve.stripOutputs': false, 'autoResolve.executionCount': false });
    const workspace = conflictRepo({
        base: 'edge-cases/nbformat-compatibility/base.ipynb',
        current: 'edge-cases/nbformat-compatibility/current.ipynb',
        incoming: 'edge-cases/nbformat-compatibility/incoming.ipynb',
    });
    const { page, conflictFile } = await conflictSession(workspace);
    await expect(page.locator('.conflict-row')).toHaveCount(2);
    await page.getByRole('button', { name: 'All Incoming', exact: true }).click();
    await page.getByLabel('Renumber execution counts').uncheck();
    await expect(page.locator('.resolution-preview')).toContainText('Assigned 2 cell ID(s)');
    const preview = JSON.parse((await page.locator('[data-resolved-notebook]').getAttribute('data-resolved-notebook'))!);
    expect(preview.nbformat_minor).toBe(99);
    expect(new Set(preview.cells.map((cell: { id: string }) => cell.id)).size).toBe(4);
    expect(preview.cells[1].id).toBe('stable');
    expect(preview.cells[1].outputs[0].data['application/json']).toEqual(['a', 'b']);
    expect(preview.cells[1].outputs[0].data['application/vnd.demo+json']).toEqual(['x', 'y']);
    expect(preview.cells[1].outputs[1].output_type).toBe('vendor_future');
    expect(preview.cells[3]).not.toHaveProperty('source');
    expect(preview.cells[3].payload).toEqual({ branch: 'incoming' });
    await expect(page.locator('.resolved-cell').filter({ hasText: 'vendor_future' }).getByTestId('edit-button')).toHaveCount(0);

    const notebook = await applyAndReadNotebook(page, conflictFile);
    expect(notebook).toEqual(preview);
    expect(parseNotebook(fs.readFileSync(conflictFile, 'utf8'))).toEqual(notebook);
    expect(parseNotebook(serializeNotebook(notebook))).toEqual(notebook);
});
