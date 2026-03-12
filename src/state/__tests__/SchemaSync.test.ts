// ─────────────────────────────────────────────────────────────────────────────
// Schema consistency test — ensures the inline schema in RunbookValidator.ts
// stays in sync with schemas/runbook.schema.json (#96)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Extract the structural validation rules (type, required, properties, enum
 * values) from a JSON Schema object, ignoring cosmetic fields like
 * `$schema`, `$id`, `description`, and `title`.
 */
function stripCosmetic(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(stripCosmetic);

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (['$schema', '$id', 'description', 'title'].includes(key)) continue;
        out[key] = stripCosmetic(val);
    }
    return out;
}

describe('Runbook schema sync (#96)', () => {
    // The inline schema in RunbookValidator.ts is the source of truth for the
    // ajv validator. The external runbook.schema.json is the IDE/editor copy.
    // This test ensures they don't drift.

    const externalPath = path.resolve(__dirname, '../../../schemas/runbook.schema.json');

    it('schemas/runbook.schema.json exists', () => {
        expect(fs.existsSync(externalPath)).toBe(true);
    });

    it('inline schema matches external schema (structural fields)', () => {
        // Read the external schema
        const externalRaw = fs.readFileSync(externalPath, 'utf-8');
        const external = JSON.parse(externalRaw);

        // The inline schema is not directly exported, so we validate the
        // structural contract: same required fields, same property names,
        // same enum values, same types.
        const externalStructural = stripCosmetic(external);

        // Read the inline schema from the RunbookValidator source file
        const smPath = path.resolve(__dirname, '../RunbookValidator.ts');
        const smSource = fs.readFileSync(smPath, 'utf-8');

        // Extract the inline schema object literal between
        // `const runbookSchema = {` and `} as const;`
        const match = smSource.match(
            /const\s+runbookSchema\s*=\s*(\{[\s\S]*?\})\s*as\s*const\s*;/
        );
        expect(match).not.toBeNull();

        // The inline schema uses JS object syntax — we need to eval it
        // (safe because it's our own source, not user input)
        // eslint-disable-next-line no-eval
        const inlineSchema = eval(`(${match![1]})`);
        const inlineStructural = stripCosmetic(inlineSchema);

        expect(inlineStructural).toEqual(externalStructural);
    });
});
