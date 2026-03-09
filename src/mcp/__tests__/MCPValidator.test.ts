// ─────────────────────────────────────────────────────────────────────────────
// MCPValidator.test.ts — Regression tests for MCPValidator.validateString()
// ─────────────────────────────────────────────────────────────────────────────
// P0.3: Ensures maxLength enforcement is exercised at the unit-test level.

import { MCPValidator } from '../MCPValidator.js';

describe('MCPValidator.validateString — maxLength enforcement', () => {
    // ── Happy path ───────────────────────────────────────────────────────

    it('returns the string when its length is under the default maxLength', () => {
        const input = 'Hello, world!';
        expect(MCPValidator.validateString(input, 'testField')).toBe(input);
    });

    it('returns an empty string (valid input)', () => {
        expect(MCPValidator.validateString('', 'testField')).toBe('');
    });

    it('returns a string exactly at the default maxLength boundary', () => {
        const input = 'a'.repeat(100_000);
        expect(MCPValidator.validateString(input, 'testField')).toBe(input);
    });

    // ── Default maxLength enforcement ────────────────────────────────────

    it('throws when the string exceeds the default maxLength (100,000)', () => {
        const input = 'x'.repeat(100_001);
        expect(() => MCPValidator.validateString(input, 'testField')).toThrow(
            /exceeds maximum length \(100000\)/
        );
    });

    // ── Custom maxLength enforcement ─────────────────────────────────────

    it('enforces a custom maxLength (e.g., 500)', () => {
        const input = 'y'.repeat(501);
        expect(() => MCPValidator.validateString(input, 'shortField', 500)).toThrow(
            /exceeds maximum length \(500\)/
        );
    });

    it('accepts a string exactly at a custom maxLength boundary', () => {
        const input = 'z'.repeat(500);
        expect(MCPValidator.validateString(input, 'shortField', 500)).toBe(input);
    });

    it('enforces a large custom maxLength (500,000) for markdown_content fields', () => {
        const input = 'm'.repeat(500_001);
        expect(() => MCPValidator.validateString(input, 'markdown_content', 500_000)).toThrow(
            /exceeds maximum length \(500000\)/
        );
    });

    it('accepts a string under a large custom maxLength (500,000)', () => {
        const input = 'm'.repeat(499_999);
        expect(MCPValidator.validateString(input, 'markdown_content', 500_000)).toBe(input);
    });

    // ── Type validation ──────────────────────────────────────────────────

    it('throws a type error for non-string input (number)', () => {
        expect(() => MCPValidator.validateString(42 as unknown, 'numField')).toThrow(
            /expected a string, got number/
        );
    });

    it('throws a type error for non-string input (undefined)', () => {
        expect(() => MCPValidator.validateString(undefined as unknown, 'undefField')).toThrow(
            /expected a string, got undefined/
        );
    });

    it('throws a type error for non-string input (null)', () => {
        expect(() => MCPValidator.validateString(null as unknown, 'nullField')).toThrow(
            /expected a string, got object/
        );
    });

    it('throws a type error for non-string input (boolean)', () => {
        expect(() => MCPValidator.validateString(true as unknown, 'boolField')).toThrow(
            /expected a string, got boolean/
        );
    });

    it('throws a type error for non-string input (object)', () => {
        expect(() => MCPValidator.validateString({} as unknown, 'objField')).toThrow(
            /expected a string, got object/
        );
    });

    // ── Error message includes field name ─────────────────────────────────

    it('includes the field name in the error message for type errors', () => {
        expect(() => MCPValidator.validateString(123 as unknown, 'my_custom_field')).toThrow(
            /Invalid my_custom_field/
        );
    });

    it('includes the field name in the error message for length errors', () => {
        const input = 'a'.repeat(101);
        expect(() => MCPValidator.validateString(input, 'my_custom_field', 100)).toThrow(
            /Invalid my_custom_field/
        );
    });
});
