/**
 * Kernel Types Tests
 */

import { describe, it, expect } from 'bun:test';
import { SIGTERM, SIGKILL, TERM_GRACE_MS, MAX_FDS, MAX_PORTS } from '@src/kernel/types.js';

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

    describe('Resource Limits', () => {
        it('MAX_FDS should be a reasonable limit', () => {
            expect(MAX_FDS).toBeGreaterThanOrEqual(64);
            expect(MAX_FDS).toBeLessThanOrEqual(4096);
        });

        it('MAX_PORTS should be a reasonable limit', () => {
            expect(MAX_PORTS).toBeGreaterThanOrEqual(16);
            expect(MAX_PORTS).toBeLessThanOrEqual(1024);
        });

        it('MAX_FDS should be greater than MAX_PORTS', () => {
            // Files are more common than ports
            expect(MAX_FDS).toBeGreaterThan(MAX_PORTS);
        });
    });
});
