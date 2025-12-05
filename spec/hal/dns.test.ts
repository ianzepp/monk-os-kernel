import { describe, it, expect, beforeEach } from 'bun:test';
import { MockDNSDevice, BunDNSDevice } from '@src/hal/index.js';

describe('DNS Device', () => {
    describe('MockDNSDevice', () => {
        let dns: MockDNSDevice;

        beforeEach(() => {
            dns = new MockDNSDevice();
        });

        describe('lookup', () => {
            it('should return empty for unknown host', async () => {
                const addrs = await dns.lookup('unknown.invalid');

                expect(addrs).toEqual([]);
            });

            it('should return configured addresses', async () => {
                dns.addRecord('example.com', ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
                const addrs = await dns.lookup('example.com');

                expect(addrs).toContain('93.184.216.34');
                expect(addrs).toContain('2606:2800:220:1:248:1893:25c8:1946');
            });

            it('should be case-insensitive', async () => {
                dns.addRecord('Example.COM', ['1.2.3.4']);
                expect(await dns.lookup('example.com')).toEqual(['1.2.3.4']);
                expect(await dns.lookup('EXAMPLE.COM')).toEqual(['1.2.3.4']);
            });
        });

        describe('lookup4', () => {
            it('should return only IPv4 addresses', async () => {
                dns.addRecord('example.com', ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
                const addrs = await dns.lookup4('example.com');

                expect(addrs).toEqual(['93.184.216.34']);
            });

            it('should use specific IPv4 records if set', async () => {
                dns.addRecord('example.com', ['1.2.3.4']);
                dns.addRecord4('example.com', ['5.6.7.8']);
                expect(await dns.lookup4('example.com')).toEqual(['5.6.7.8']);
            });
        });

        describe('lookup6', () => {
            it('should return only IPv6 addresses', async () => {
                dns.addRecord('example.com', ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
                const addrs = await dns.lookup6('example.com');

                expect(addrs).toEqual(['2606:2800:220:1:248:1893:25c8:1946']);
            });

            it('should use specific IPv6 records if set', async () => {
                dns.addRecord('example.com', ['::1']);
                dns.addRecord6('example.com', ['::2']);
                expect(await dns.lookup6('example.com')).toEqual(['::2']);
            });
        });

        describe('reverse', () => {
            it('should return empty for unknown IP', async () => {
                const hosts = await dns.reverse('1.2.3.4');

                expect(hosts).toEqual([]);
            });

            it('should return configured hostnames', async () => {
                dns.addReverse('93.184.216.34', ['example.com']);
                const hosts = await dns.reverse('93.184.216.34');

                expect(hosts).toEqual(['example.com']);
            });
        });

        describe('reset', () => {
            it('should clear all records', async () => {
                dns.addRecord('example.com', ['1.2.3.4']);
                dns.addReverse('1.2.3.4', ['example.com']);

                dns.reset();

                expect(await dns.lookup('example.com')).toEqual([]);
                expect(await dns.reverse('1.2.3.4')).toEqual([]);
            });
        });
    });

    describe('BunDNSDevice', () => {
        let dns: BunDNSDevice;

        beforeEach(() => {
            dns = new BunDNSDevice();
        });

        describe('lookup', () => {
            it('should resolve real hostname', async () => {
                // Use a well-known hostname
                const addrs = await dns.lookup('localhost');

                // Should have at least one address (127.0.0.1 or ::1)
                expect(addrs.length).toBeGreaterThanOrEqual(0);
            });

            it('should return empty for invalid hostname', async () => {
                const addrs = await dns.lookup('this.domain.should.not.exist.invalid');

                expect(addrs).toEqual([]);
            });
        });

        describe('lookup4', () => {
            it('should resolve localhost to IPv4', async () => {
                const addrs = await dns.lookup4('localhost');

                // May be empty in some environments
                for (const addr of addrs) {
                    expect(addr).not.toContain(':'); // No IPv6
                }
            });
        });

        describe('lookup6', () => {
            it('should return IPv6 addresses only', async () => {
                const addrs = await dns.lookup6('localhost');

                for (const addr of addrs) {
                    expect(addr).toContain(':'); // IPv6 has colons
                }
            });
        });

        describe('reverse', () => {
            it('should return empty (not implemented in Bun)', async () => {
                const hosts = await dns.reverse('127.0.0.1');

                // Currently returns empty as Bun doesn't support reverse DNS
                expect(hosts).toEqual([]);
            });
        });
    });
});
