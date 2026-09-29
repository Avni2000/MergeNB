import { test, expect } from '../../../test-fixtures/harness/playwright';
import { writeSettingsFile } from '../../../apps/vscode-extension/tests/settingsFile';

test('attachment-only conflicts and independent cell fields match the saved notebook', async ({ conflictRepo, conflictSession, applyAndReadNotebook }) => {
    writeSettingsFile({ 'autoResolve.stripOutputs': false, 'autoResolve.executionCount': false });
    const workspace = conflictRepo({
        base: 'edge-cases/field-preservation/base.ipynb',
        current: 'edge-cases/field-preservation/current.ipynb',
        incoming: 'edge-cases/field-preservation/incoming.ipynb',
    });
    const { page, conflictFile } = await conflictSession(workspace);
    await expect(page.locator('.conflict-row')).toHaveCount(1);
    const row = page.locator('.conflict-row');
    await expect(row.locator('.incoming-column .cell-fields')).toContainText('incoming');
    const selected = JSON.parse(decodeURIComponent((await row.locator('.incoming-column .notebook-cell').getAttribute('data-cell'))!));
    const unified = await page.locator('.identical-row').evaluateAll(elements => elements.map(element =>
        JSON.parse(decodeURIComponent(element.getAttribute('data-cell')!))));
    expect(unified[0].source).toEqual(['print(2)']);
    expect(unified[0].outputs[0].text).toBe('2\n');
    expect(unified[0].metadata.custom).toEqual({ left: 1, right: 2 });
    expect(unified[1].vendor).toEqual({ incoming: true });
    expect(unified[1].attachments['current.json']).toEqual({ 'application/json': ['keep current'] });
    expect(unified[1].attachments['unused.json']['application/vnd.test+json']).toEqual(['a', 'b']);

    await row.locator('.btn-incoming').click();
    await page.getByLabel('Renumber execution counts').uncheck();
    const notebook = await applyAndReadNotebook(page, conflictFile);
    expect(notebook.cells).toEqual([selected, ...unified]);
});

test('clean field merges reach the saved preview without any manual choices', async ({ conflictRepo, conflictSession, applyAndReadNotebook }) => {
    writeSettingsFile({ 'autoResolve.stripOutputs': false, 'autoResolve.executionCount': false });
    const workspace = conflictRepo({
        base: 'edge-cases/clean-fields/base.ipynb',
        current: 'edge-cases/clean-fields/current.ipynb',
        incoming: 'edge-cases/clean-fields/incoming.ipynb',
    });
    const { page, conflictFile } = await conflictSession(workspace);
    await expect(page.locator('.conflict-row')).toHaveCount(0);
    await page.getByLabel('Renumber execution counts').uncheck();
    const preview = JSON.parse((await page.locator('[data-resolved-notebook]').getAttribute('data-resolved-notebook'))!);
    expect(preview.cells[0].source).toEqual(['print(2)']);
    expect(preview.cells[0].outputs[0].text).toBe('2\n');
    expect(preview.cells[0].execution_count).toBe(2);
    expect(Object.keys(preview.cells[1].attachments)).toContain('current.json');
    expect(Object.keys(preview.cells[1].attachments)).toContain('unused.json');
    expect(preview.future_data).toEqual({ kept: true });
    const notebook = await applyAndReadNotebook(page, conflictFile);
    expect(notebook).toEqual(preview);
});
