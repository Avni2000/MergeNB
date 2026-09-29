import type { Notebook } from './types';

export function isValidCellId(id: unknown): id is string {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export function assignedCellIds(notebook: Notebook, originals: (Notebook | undefined)[]): string[] {
    const originalIds = new Set(originals.flatMap(nb => nb?.cells.map(cell => cell.id) ?? []));
    return notebook.cells.map(cell => cell.id).filter((id): id is string =>
        id !== undefined && !originalIds.has(id)
    );
}

/** Preserve valid IDs; repair only missing, invalid, or repeated IDs in 4.5+. */
export function repairCellIds(notebook: Notebook): Notebook {
    if (notebook.nbformat_minor < 5) return notebook;
    const reserved = new Set(notebook.cells.map(cell => cell.id).filter(isValidCellId));
    const seen = new Set<string>();
    const cells = notebook.cells.map((cell, index) => {
        if (isValidCellId(cell.id) && !seen.has(cell.id)) {
            seen.add(cell.id);
            return cell;
        }
        let suffix = index + 1;
        while (reserved.has(`mergenb-${suffix}`)) suffix++;
        const id = `mergenb-${suffix}`;
        reserved.add(id);
        seen.add(id);
        return { ...cell, id };
    });
    return { ...notebook, cells };
}
