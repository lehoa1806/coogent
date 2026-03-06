import { TiktokenEncoder } from '../TiktokenEncoder.js';
import type { TokenEncoder } from '../ContextScoper.js';

describe('TiktokenEncoder', () => {
    let encoder: TiktokenEncoder;

    beforeEach(() => {
        encoder = new TiktokenEncoder();
    });

    test('implements the TokenEncoder interface', () => {
        // TypeScript compile-time check — runtime assertion that the shape is correct
        const asInterface: TokenEncoder = encoder;
        expect(typeof asInterface.countTokens).toBe('function');
    });

    test('countTokens returns a positive integer for non-empty strings', () => {
        const count = encoder.countTokens('The quick brown fox jumps over the lazy dog.');
        expect(count).toBeGreaterThan(0);
        expect(Number.isInteger(count)).toBe(true);
    });

    test('countTokens returns 0 for empty string', () => {
        const count = encoder.countTokens('');
        expect(count).toBe(0);
    });

    test('token count is reasonably close to known values for cl100k_base', () => {
        // "Hello, world!" is ~4 tokens with cl100k_base
        const count = encoder.countTokens('Hello, world!');
        expect(count).toBeGreaterThanOrEqual(3);
        expect(count).toBeLessThanOrEqual(6);
    });

    test('encoder is reusable across multiple calls', () => {
        const first = encoder.countTokens('First call');
        const second = encoder.countTokens('Second call');
        const third = encoder.countTokens('Third call');

        expect(first).toBeGreaterThan(0);
        expect(second).toBeGreaterThan(0);
        expect(third).toBeGreaterThan(0);
    });

    test('longer strings produce proportionally more tokens', () => {
        const short = encoder.countTokens('Hello');
        const long = encoder.countTokens('Hello '.repeat(100));
        expect(long).toBeGreaterThan(short);
    });
});
