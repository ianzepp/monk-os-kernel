import { describe, it, expect, beforeEach } from 'bun:test';
import { BunEntropyDevice, SeededEntropyDevice } from '@src/hal/index.js';

describe('Entropy Device', () => {
    describe('BunEntropyDevice', () => {
        let entropy: BunEntropyDevice;

        beforeEach(() => {
            entropy = new BunEntropyDevice();
        });

        describe('read', () => {
            it('should return requested number of bytes', () => {
                const bytes = entropy.read(16);
                expect(bytes.length).toBe(16);
            });

            it('should return different values on each call', () => {
                const a = entropy.read(16);
                const b = entropy.read(16);
                // Very unlikely to be equal
                expect(a).not.toEqual(b);
            });

            it('should handle size 0', () => {
                const bytes = entropy.read(0);
                expect(bytes.length).toBe(0);
            });

            it('should handle large requests up to 65536', () => {
                const bytes = entropy.read(65536);
                expect(bytes.length).toBe(65536);
            });

            it('should throw for sizes > 65536', () => {
                expect(() => entropy.read(65537)).toThrow('exceeds 65536');
            });
        });

        describe('uuid', () => {
            it('should return 36-character UUID string', () => {
                const uuid = entropy.uuid();
                expect(uuid.length).toBe(36);
            });

            it('should match UUID format (8-4-4-4-12)', () => {
                const uuid = entropy.uuid();
                const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
                expect(uuid).toMatch(pattern);
            });

            it('should have version 7 indicator', () => {
                const uuid = entropy.uuid();
                // Version is in position 14 (0-indexed)
                expect(uuid[14]).toBe('7');
            });

            it('should have correct variant bits', () => {
                const uuid = entropy.uuid();
                // Variant is in position 19 (0-indexed), should be 8, 9, a, or b
                expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
            });

            it('should generate unique UUIDs', () => {
                const uuids = new Set<string>();
                for (let i = 0; i < 1000; i++) {
                    uuids.add(entropy.uuid());
                }
                expect(uuids.size).toBe(1000);
            });

            it('should be roughly time-sortable', async () => {
                const uuid1 = entropy.uuid();
                await Bun.sleep(2); // Ensure different timestamp
                const uuid2 = entropy.uuid();
                // UUIDs generated later should sort after earlier ones
                // (first 8 characters represent part of timestamp)
                expect(uuid1 < uuid2).toBe(true);
            });
        });
    });

    describe('SeededEntropyDevice', () => {
        describe('deterministic output', () => {
            it('should produce same sequence with same seed', () => {
                const e1 = new SeededEntropyDevice(12345);
                const e2 = new SeededEntropyDevice(12345);

                const a1 = e1.read(16);
                const a2 = e2.read(16);
                expect(a1).toEqual(a2);

                const b1 = e1.read(16);
                const b2 = e2.read(16);
                expect(b1).toEqual(b2);
            });

            it('should produce different sequence with different seed', () => {
                const e1 = new SeededEntropyDevice(12345);
                const e2 = new SeededEntropyDevice(54321);

                const a1 = e1.read(16);
                const a2 = e2.read(16);
                expect(a1).not.toEqual(a2);
            });
        });

        describe('reset', () => {
            it('should restart sequence from beginning', () => {
                const entropy = new SeededEntropyDevice(12345);

                const a = entropy.read(16);
                const b = entropy.read(16);
                expect(a).not.toEqual(b);

                entropy.reset();

                const c = entropy.read(16);
                expect(a).toEqual(c);
            });
        });

        describe('seed', () => {
            it('should change seed and reset', () => {
                const entropy = new SeededEntropyDevice(12345);
                const a = entropy.read(16);

                entropy.seed(54321);
                const b = entropy.read(16);
                expect(a).not.toEqual(b);

                // Should be same as new device with same seed
                const other = new SeededEntropyDevice(54321);
                entropy.reset();
                expect(entropy.read(16)).toEqual(other.read(16));
            });
        });

        describe('uuid', () => {
            it('should generate valid UUID format', () => {
                const entropy = new SeededEntropyDevice(12345);
                const uuid = entropy.uuid();

                const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
                expect(uuid).toMatch(pattern);
            });

            it('should have version 7 indicator', () => {
                const entropy = new SeededEntropyDevice(12345);
                const uuid = entropy.uuid();
                expect(uuid[14]).toBe('7');
            });

            it('should generate deterministic UUIDs', () => {
                const e1 = new SeededEntropyDevice(12345);
                const e2 = new SeededEntropyDevice(12345);

                expect(e1.uuid()).toBe(e2.uuid());
                expect(e1.uuid()).toBe(e2.uuid());
            });

            it('should generate sortable UUIDs via counter', () => {
                const entropy = new SeededEntropyDevice(12345);
                const uuid1 = entropy.uuid();
                const uuid2 = entropy.uuid();
                // Seeded device uses counter for timestamp, so these should sort correctly
                expect(uuid1 < uuid2).toBe(true);
            });
        });

        describe('read', () => {
            it('should return requested number of bytes', () => {
                const entropy = new SeededEntropyDevice(12345);
                expect(entropy.read(32).length).toBe(32);
                expect(entropy.read(1).length).toBe(1);
                expect(entropy.read(100).length).toBe(100);
            });
        });
    });
});
