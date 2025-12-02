/**
 * Kernel Types Tests
 */

import { describe, it, expect } from 'bun:test';
import { SIGTERM, SIGKILL, TERM_GRACE_MS, MAX_HANDLES } from '@src/kernel/types.js';

describe('Kernel Constants', () => {
    describe('Signals', () => {
        it('SIGTERM should be 15', () => {
            expect(SIGTERM).toBe(15);
        });

        it('SIGKILL should be 9', () => {
            expect(SIGKILL).toBe(9);
        });
    });

    describe('TERM_GRACE_MS', () => {
        it('should be a reasonable grace period', () => {
            expect(TERM_GRACE_MS).toBeGreaterThan(0);
            expect(TERM_GRACE_MS).toBeLessThanOrEqual(30000);
        });
    });

    describe('Handle Limits', () => {
        it('MAX_HANDLES should be a reasonable limit', () => {
            // Unified limit for all handle types (files, sockets, pipes, ports, channels)
            expect(MAX_HANDLES).toBeGreaterThanOrEqual(64);
            expect(MAX_HANDLES).toBeLessThanOrEqual(4096);
        });
    });
});
