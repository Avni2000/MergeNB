import { stableStringify, isDictionary } from './json';

export type FieldChoice = 'base' | 'current' | 'incoming';
export type FieldResolutions = Record<string, FieldChoice>;

export interface FieldConflict {
    path: string[];
    base?: unknown;
    current?: unknown;
    incoming?: unknown;
}

interface MergeOptions {
    atomic?: (path: string[]) => boolean;
    equal?: (left: unknown, right: unknown, path: string[]) => boolean;
    choices?: FieldResolutions;
}

/** Missing keys use undefined; JSON null and empty containers remain distinct. */
export function mergeFields(
    base: unknown,
    current: unknown,
    incoming: unknown,
    options: MergeOptions = {},
    path: string[] = []
): { value: unknown; conflicts: FieldConflict[] } {
    const equal = options.equal ?? ((left, right) => stableStringify(left) === stableStringify(right));
    if (equal(current, incoming, path)) return { value: current, conflicts: [] };
    if (equal(current, base, path)) return { value: incoming, conflicts: [] };
    if (equal(incoming, base, path)) return { value: current, conflicts: [] };

    if (!options.atomic?.(path) && isDictionary(base) && isDictionary(current) && isDictionary(incoming)) {
        const entries: [string, unknown][] = [];
        const conflicts: FieldConflict[] = [];
        const keys = new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(incoming)]);
        for (const key of keys) {
            const merged = mergeFields(
                Object.hasOwn(base, key) ? base[key] : undefined,
                Object.hasOwn(current, key) ? current[key] : undefined,
                Object.hasOwn(incoming, key) ? incoming[key] : undefined,
                options, [...path, key]
            );
            if (merged.value !== undefined) entries.push([key, merged.value]);
            conflicts.push(...merged.conflicts);
        }
        return { value: Object.fromEntries(entries), conflicts };
    }

    const conflict = { path, base, current, incoming };
    const choice = options.choices?.[JSON.stringify(path)];
    return { value: choice ? conflict[choice] : current, conflicts: choice ? [] : [conflict] };
}
