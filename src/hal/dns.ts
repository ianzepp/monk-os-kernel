/**
 * DNS Device
 *
 * Domain name resolution.
 *
 * Bun touchpoints:
 * - Bun.dns.lookup() for forward lookups
 * - Bun.dns.reverse() for reverse lookups (if available)
 *
 * Caveats:
 * - DNS lookups are async and may timeout
 * - Results may be cached by OS or Bun
 * - IPv4 and IPv6 results may be returned together
 * - Reverse DNS often fails or returns generic PTR records
 * - No direct control over DNS servers used (system resolver)
 *
 * Host leakage:
 * - Uses host DNS resolver configuration (/etc/resolv.conf or equivalent).
 * - Monk processes see host's DNS view: corporate DNS, split-horizon,
 *   VPN settings, and local overrides (/etc/hosts) all leak through.
 * - DNS cache is shared with host; cached entries from host processes visible.
 */

/**
 * DNS device interface.
 */
export interface DNSDevice {
    /**
     * Resolve hostname to IP addresses.
     *
     * Bun: Bun.dns.lookup()
     *
     * Caveat: Returns both IPv4 and IPv6 by default. Order is
     * OS-dependent (happy eyeballs). May return cached results.
     *
     * @param host - Hostname to resolve
     * @returns Array of IP addresses (IPv4 and/or IPv6)
     */
    lookup(host: string): Promise<string[]>;

    /**
     * Resolve hostname to IPv4 addresses only.
     *
     * @param host - Hostname to resolve
     * @returns Array of IPv4 addresses
     */
    lookup4(host: string): Promise<string[]>;

    /**
     * Resolve hostname to IPv6 addresses only.
     *
     * @param host - Hostname to resolve
     * @returns Array of IPv6 addresses
     */
    lookup6(host: string): Promise<string[]>;

    /**
     * Reverse DNS lookup.
     *
     * Bun: May not be directly supported; uses system resolver
     *
     * Caveat: Many IPs don't have reverse DNS configured.
     * Corporate/cloud IPs often return generic hostnames.
     *
     * @param addr - IP address
     * @returns Array of hostnames (often empty or single entry)
     */
    reverse(addr: string): Promise<string[]>;
}

/**
 * Bun DNS device implementation
 *
 * Bun touchpoints:
 * - Bun.dns.lookup(hostname, options)
 *
 * Caveats:
 * - Bun.dns API is still evolving
 * - Reverse lookup may require different approach
 */
export class BunDNSDevice implements DNSDevice {
    async lookup(host: string): Promise<string[]> {
        try {
            const results = await Bun.dns.lookup(host);
            // Bun.dns.lookup returns array of { address, family } objects
            if (Array.isArray(results)) {
                return results.map((r: any) => r.address ?? r);
            }
            // Handle single result case
            return [(results as any).address ?? results];
        } catch (err) {
            // DNS resolution failed
            return [];
        }
    }

    async lookup4(host: string): Promise<string[]> {
        try {
            const results = await Bun.dns.lookup(host, { family: 4 });
            if (Array.isArray(results)) {
                return results.map((r: any) => r.address ?? r);
            }
            return [(results as any).address ?? results];
        } catch {
            return [];
        }
    }

    async lookup6(host: string): Promise<string[]> {
        try {
            const results = await Bun.dns.lookup(host, { family: 6 });
            if (Array.isArray(results)) {
                return results.map((r: any) => r.address ?? r);
            }
            return [(results as any).address ?? results];
        } catch {
            return [];
        }
    }

    async reverse(_addr: string): Promise<string[]> {
        // Bun doesn't have native reverse DNS
        // We could use a system call via host device, but for now return empty
        // This is a known limitation
        console.warn('DNS reverse lookup not implemented in Bun HAL');
        return [];
    }
}

/**
 * Mock DNS device for testing
 *
 * Provides configurable DNS responses.
 *
 * Usage:
 *   const dns = new MockDNSDevice();
 *   dns.addRecord('example.com', ['93.184.216.34']);
 *   dns.addReverse('93.184.216.34', ['example.com']);
 *   await dns.lookup('example.com'); // ['93.184.216.34']
 */
export class MockDNSDevice implements DNSDevice {
    private records = new Map<string, string[]>();
    private records4 = new Map<string, string[]>();
    private records6 = new Map<string, string[]>();
    private reverseRecords = new Map<string, string[]>();

    /**
     * Add forward DNS record.
     */
    addRecord(host: string, addresses: string[]): void {
        this.records.set(host.toLowerCase(), addresses);
    }

    /**
     * Add IPv4-specific record.
     */
    addRecord4(host: string, addresses: string[]): void {
        this.records4.set(host.toLowerCase(), addresses);
    }

    /**
     * Add IPv6-specific record.
     */
    addRecord6(host: string, addresses: string[]): void {
        this.records6.set(host.toLowerCase(), addresses);
    }

    /**
     * Add reverse DNS record.
     */
    addReverse(addr: string, hostnames: string[]): void {
        this.reverseRecords.set(addr, hostnames);
    }

    /**
     * Clear all records.
     */
    reset(): void {
        this.records.clear();
        this.records4.clear();
        this.records6.clear();
        this.reverseRecords.clear();
    }

    async lookup(host: string): Promise<string[]> {
        return this.records.get(host.toLowerCase()) ?? [];
    }

    async lookup4(host: string): Promise<string[]> {
        // Check specific records first, fall back to general
        const specific = this.records4.get(host.toLowerCase());
        if (specific) return specific;

        // Filter general records for IPv4
        const general = this.records.get(host.toLowerCase()) ?? [];
        return general.filter((addr) => !addr.includes(':'));
    }

    async lookup6(host: string): Promise<string[]> {
        const specific = this.records6.get(host.toLowerCase());
        if (specific) return specific;

        const general = this.records.get(host.toLowerCase()) ?? [];
        return general.filter((addr) => addr.includes(':'));
    }

    async reverse(addr: string): Promise<string[]> {
        return this.reverseRecords.get(addr) ?? [];
    }
}
