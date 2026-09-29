/** Deterministic JSON comparison without changing the serialized payload. */

export function isDictionary(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(value);

    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }

    if (t === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
    }

    // functions/symbols/etc. shouldn't appear in notebook JSON; stringify defensively
    return JSON.stringify(String(value));
}

