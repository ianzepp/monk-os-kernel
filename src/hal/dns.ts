/**
 * DNS Device - Domain name resolution
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The DNS Device provides hostname resolution services, translating human-readable
 * domain names to IP addresses and vice versa. It abstracts over the system's
 * DNS resolver, which itself may use various sources: DNS servers, /etc/hosts,
 * mDNS, corporate resolvers, VPN DNS, etc.
 *
 * Three types of forward lookups are supported:
 * - lookup(): Returns both IPv4 and IPv6 addresses in system-preferred order
 * - lookup4(): Returns only IPv4 addresses (A records)
 * - lookup6(): Returns only IPv6 addresses (AAAA records)
 *
 * Reverse lookups (IP to hostname) are also supported but have significant
 * limitations. Many IPs don't have reverse DNS configured, and those that do
 * often return generic or misleading hostnames.
 *
 * DNS resolution is inherently unreliable and subject to caching, timeouts,
 * and network failures. The device returns empty arrays on resolution failure
 * rather than throwing, allowing callers to handle missing DNS gracefully.
 *
 * Host leakage: The DNS device uses the host OS's resolver configuration. This
 * means Monk processes see the same DNS view as host processes: corporate DNS
 * servers, VPN-injected DNS, split-horizon DNS, /etc/hosts overrides, and DNS
 * caching all leak through. This is intentional - Monk processes should resolve
 * names the same way the host system does.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All methods return arrays (never null/undefined), empty on failure
 * INV-2: lookup4() returns only IPv4 addresses (no colons)
 * INV-3: lookup6() returns only IPv6 addresses (contains colons)
 * INV-4: lookup() may return mixed IPv4 and IPv6
 * INV-5: Order of results is system-dependent (often prefers IPv6 if available)
 * INV-6: Resolution failure returns [], never throws
 *
 * CONCURRENCY MODEL
 * =================
 * All DNS operations are async and may take significant time (hundreds of ms
 * to seconds on timeout). Multiple lookups may be in flight concurrently:
 *
 * - Each lookup is independent and non-blocking
 * - System resolver handles caching and concurrent query optimization
 * - No shared state in the device - all operations are stateless
 *
 * Multiple processes may perform DNS lookups concurrently via syscalls. The
 * kernel serializes syscall dispatch, but DNS operations run in parallel at
 * the system level.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: No mutable state - device is completely stateless
 * RC-2: System resolver handles concurrent queries safely
 * RC-3: Results are immutable arrays - no shared mutable structures
 * RC-4: DNS cache is managed by system, not device (no TOCTOU issues)
 *
 * MEMORY MANAGEMENT
 * =================
 * - DNSDevice has no persistent state, O(1) memory footprint
 * - Result arrays are allocated per-call and GC'd after use
 * - System resolver manages its own cache and connection pools
 * - Mock device accumulates records for testing (test-only overhead)
 *
 * @module hal/dns
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * DNS device interface.
 *
 * WHY: Provides abstraction for testability and portability. Tests can inject
 * mock DNS devices with predefined responses. Alternative implementations could
 * use custom DNS servers, DNS-over-HTTPS, or static hostname files.
 */
export interface DNSDevice {
    /**
     * Resolve hostname to IP addresses.
     *
     * Bun implementation: Bun.dns.lookup()
     *
     * WHY both IPv4 and IPv6: Modern networks use both protocols. Returning
     * both allows the caller to choose or try in order (happy eyeballs).
     *
     * CAVEAT: Returns both IPv4 and IPv6 by default. Order is OS-dependent
     * and influenced by RFC 6724 (IPv6 preference) and local policy. May
     * return cached results from system resolver.
     *
     * ERROR HANDLING: Returns empty array on resolution failure. Never throws.
     * This allows callers to gracefully handle missing/unreachable DNS without
     * try-catch everywhere.
     *
     * USE CASES:
     * - Connect to service (try IPs in order until success)
     * - Verify hostname exists before operations
     * - Display resolved IPs to user
     *
     * @param host - Hostname to resolve (e.g., 'example.com')
     * @returns Array of IP addresses (IPv4 and/or IPv6), empty if not found
     */
    lookup(host: string): Promise<string[]>;

    /**
     * Resolve hostname to IPv4 addresses only.
     *
     * WHY separate method: Some services or networks require IPv4. Filtering
     * mixed results is error-prone (what if :: is IPv4-mapped IPv6?). Better
     * to request IPv4 explicitly at the DNS layer.
     *
     * INVARIANT: All returned addresses are IPv4 (no colons).
     *
     * USE CASES:
     * - Legacy IPv4-only services
     * - Testing IPv4 connectivity specifically
     * - Firewall rules that distinguish IPv4/IPv6
     *
     * @param host - Hostname to resolve
     * @returns Array of IPv4 addresses, empty if not found
     */
    lookup4(host: string): Promise<string[]>;

    /**
     * Resolve hostname to IPv6 addresses only.
     *
     * WHY separate method: Modern networks prefer IPv6. Testing IPv6 connectivity
     * requires filtering to IPv6 addresses only.
     *
     * INVARIANT: All returned addresses are IPv6 (contain colons).
     *
     * USE CASES:
     * - IPv6-only networks
     * - Testing IPv6 connectivity
     * - Services that prefer IPv6 for performance
     *
     * @param host - Hostname to resolve
     * @returns Array of IPv6 addresses, empty if not found
     */
    lookup6(host: string): Promise<string[]>;

    /**
     * Reverse DNS lookup.
     *
     * Bun implementation: Not directly supported - returns empty array
     *
     * WHY: PTR records map IPs to hostnames. Useful for logging, security
     * checks, and displaying human-readable connection sources.
     *
     * CAVEAT: Many IPs don't have reverse DNS configured. Corporate and cloud
     * IPs often return generic hostnames like 'ec2-1-2-3-4.compute.amazonaws.com'.
     * Residential IPs rarely have meaningful reverse DNS.
     *
     * CURRENT LIMITATION: Bun doesn't provide native reverse DNS API. We could
     * implement via system calls (dig, nslookup) but that's not portable or
     * efficient. For now, returns empty array with warning.
     *
     * USE CASES:
     * - Log client hostnames in server logs
     * - Verify connecting IP matches expected hostname
     * - Security checks (forward-confirmed reverse DNS)
     *
     * @param addr - IP address (IPv4 or IPv6)
     * @returns Array of hostnames (often empty or single entry)
     */
    reverse(addr: string): Promise<string[]>;
}

// =============================================================================
// MAIN IMPLEMENTATION
// =============================================================================

/**
 * Bun DNS device implementation
 *
 * Bun touchpoints:
 * - Bun.dns.lookup(hostname, options) - Forward DNS resolution
 *
 * WHY this API: Bun provides a simple, async DNS lookup API that wraps the
 * system resolver. It handles platform differences (getaddrinfo on Unix,
 * DnsQuery on Windows) and provides a uniform interface.
 *
 * Caveats:
 * - Bun.dns API is still evolving (as of Bun 1.0)
 * - Returns array of { address, family } objects OR single object
 * - Reverse lookup not yet supported by Bun
 * - Resolution can timeout (typically 5-10 seconds)
 * - Uses system DNS configuration (/etc/resolv.conf, system settings)
 *
 * Host leakage:
 * - Uses host DNS resolver configuration (/etc/resolv.conf or equivalent)
 * - Monk processes see host's DNS view: corporate DNS, split-horizon DNS,
 *   VPN settings, and local overrides (/etc/hosts) all leak through
 * - DNS cache is shared with host; cached entries from host processes visible
 * - This is intentional and desired - Monk should resolve names like host does
 *
 * TESTABILITY: Interface allows dependency injection of mock implementations.
 */
export class BunDNSDevice implements DNSDevice {
    // =========================================================================
    // FORWARD LOOKUPS
    // =========================================================================

    /**
     * Resolve hostname (both IPv4 and IPv6).
     *
     * ALGORITHM:
     * 1. Call Bun.dns.lookup(host) without family restriction
     * 2. Handle both array and single-result return formats
     * 3. Extract .address field from result objects (or use result directly)
     * 4. Return array of addresses
     * 5. On error, return empty array
     *
     * WHY try-catch: DNS resolution can fail for many reasons: hostname doesn't
     * exist, DNS server unreachable, timeout, network error. Returning empty
     * array is more ergonomic than forcing callers to handle exceptions.
     *
     * WHY check array vs object: Bun.dns.lookup returns inconsistent types:
     * array if multiple results, object if single result. We normalize to
     * always return array.
     *
     * WHY .address ?? r: Result objects have .address property, but single
     * results might be strings directly. Fallback handles both.
     *
     * @param host - Hostname to resolve
     * @returns Array of IP addresses or empty array on failure
     */
    async lookup(host: string): Promise<string[]> {
        try {
            const results = await Bun.dns.lookup(host);

            // Bun.dns.lookup returns array of { address, family } objects
            if (Array.isArray(results)) {
                return results.map((r: any) => r.address ?? r);
            }

            // Handle single result case
            return [(results as any).address ?? results];
        }
        catch (_err) {
            // DNS resolution failed (NXDOMAIN, timeout, etc.)
            return [];
        }
    }

    /**
     * Resolve hostname to IPv4 only.
     *
     * ALGORITHM:
     * 1. Call Bun.dns.lookup(host, { family: 4 })
     * 2. Normalize array vs single result
     * 3. Extract addresses
     * 4. Return array (all IPv4)
     *
     * WHY family: 4: Requests only A records (IPv4). System resolver will not
     * query AAAA records, saving a DNS round-trip.
     *
     * @param host - Hostname to resolve
     * @returns Array of IPv4 addresses or empty array on failure
     */
    async lookup4(host: string): Promise<string[]> {
        try {
            const results = await Bun.dns.lookup(host, { family: 4 });

            if (Array.isArray(results)) {
                return results.map((r: any) => r.address ?? r);
            }

            return [(results as any).address ?? results];
        }
        catch {
            return [];
        }
    }

    /**
     * Resolve hostname to IPv6 only.
     *
     * WHY family: 6: Requests only AAAA records (IPv6). System resolver will
     * not query A records.
     *
     * @param host - Hostname to resolve
     * @returns Array of IPv6 addresses or empty array on failure
     */
    async lookup6(host: string): Promise<string[]> {
        try {
            const results = await Bun.dns.lookup(host, { family: 6 });

            if (Array.isArray(results)) {
                return results.map((r: any) => r.address ?? r);
            }

            return [(results as any).address ?? results];
        }
        catch {
            return [];
        }
    }

    // =========================================================================
    // REVERSE LOOKUPS
    // =========================================================================

    /**
     * Reverse DNS lookup (not implemented).
     *
     * WHY not implemented: Bun doesn't provide native reverse DNS API. We could
     * use system calls (dig, host, nslookup) via HostDevice, but that's:
     * - Not portable (commands differ across platforms)
     * - Slow (process spawn overhead)
     * - Fragile (parsing command output)
     *
     * FUTURE: If Bun adds reverse DNS API, implement it here. If reverse DNS
     * becomes critical, consider using dns.reverse() from Node.js dns module
     * or implementing native DNS protocol client.
     *
     * CURRENT BEHAVIOR: Logs warning and returns empty array. Callers should
     * handle empty array as "no reverse DNS available".
     *
     * @param _addr - IP address (ignored)
     * @returns Empty array (not implemented)
     */
    async reverse(_addr: string): Promise<string[]> {
        // Bun doesn't have native reverse DNS
        // We could use a system call via host device, but for now return empty
        // This is a known limitation
        console.warn('DNS reverse lookup not implemented in Bun HAL');

        return [];
    }
}

// =============================================================================
// TESTING UTILITIES
// =============================================================================

/**
 * Mock DNS device for testing
 *
 * WHY: Essential for testing network code without actual DNS lookups. Tests can:
 * - Define exact responses for specific hostnames
 * - Test failure cases (missing DNS, timeout simulation)
 * - Run deterministically without network dependencies
 * - Run in parallel without DNS server load
 *
 * DESIGN: Pre-configured hostname-to-address mappings stored in Maps. Lookups
 * check appropriate map and return configured results. Unknown hostnames return
 * empty array (resolution failure).
 *
 * TESTABILITY: Enables fast, deterministic, parallel tests of DNS-dependent code.
 *
 * Usage:
 *   const dns = new MockDNSDevice();
 *   dns.addRecord('example.com', ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
 *   dns.addRecord4('ipv4only.com', ['192.0.2.1']);
 *   dns.addRecord6('ipv6only.com', ['2001:db8::1']);
 *   dns.addReverse('93.184.216.34', ['example.com']);
 *   await dns.lookup('example.com'); // ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']
 *   await dns.lookup('unknown.com');  // []
 */
export class MockDNSDevice implements DNSDevice {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * General DNS records (both IPv4 and IPv6).
     *
     * WHY: Stores results for lookup() calls. Keys are lowercased hostnames
     * for case-insensitive lookup.
     */
    private records = new Map<string, string[]>();

    /**
     * IPv4-specific DNS records.
     *
     * WHY: Stores results for lookup4() calls. If present, used instead of
     * filtering general records. Allows tests to define different IPv4-only results.
     */
    private records4 = new Map<string, string[]>();

    /**
     * IPv6-specific DNS records.
     *
     * WHY: Stores results for lookup6() calls. If present, used instead of
     * filtering general records.
     */
    private records6 = new Map<string, string[]>();

    /**
     * Reverse DNS records (IP to hostname).
     *
     * WHY: Stores results for reverse() calls. Keys are IP addresses.
     */
    private reverseRecords = new Map<string, string[]>();

    // =========================================================================
    // CONTROL METHODS (testing only)
    // =========================================================================

    /**
     * Add forward DNS record.
     *
     * WHY: Allows tests to define hostname resolution results. Can include
     * both IPv4 and IPv6 addresses.
     *
     * WHY lowercase: DNS is case-insensitive. Lowercasing keys ensures
     * example.COM and example.com are treated identically.
     *
     * @param host - Hostname
     * @param addresses - IP addresses (IPv4 and/or IPv6)
     */
    addRecord(host: string, addresses: string[]): void {
        this.records.set(host.toLowerCase(), addresses);
    }

    /**
     * Add IPv4-specific record.
     *
     * WHY separate: Allows tests to define different results for lookup4()
     * than lookup(). Useful for testing IPv4 fallback behavior.
     *
     * @param host - Hostname
     * @param addresses - IPv4 addresses
     */
    addRecord4(host: string, addresses: string[]): void {
        this.records4.set(host.toLowerCase(), addresses);
    }

    /**
     * Add IPv6-specific record.
     *
     * @param host - Hostname
     * @param addresses - IPv6 addresses
     */
    addRecord6(host: string, addresses: string[]): void {
        this.records6.set(host.toLowerCase(), addresses);
    }

    /**
     * Add reverse DNS record.
     *
     * WHY: Allows tests to verify reverse DNS handling. Most tests won't need
     * this, but it's useful for testing security features that use reverse DNS.
     *
     * @param addr - IP address
     * @param hostnames - Hostnames (typically one, but multiple allowed)
     */
    addReverse(addr: string, hostnames: string[]): void {
        this.reverseRecords.set(addr, hostnames);
    }

    /**
     * Clear all records.
     *
     * WHY: Allows test cleanup without creating new instances.
     *
     * TESTABILITY: Enables test isolation - each test can start with clean
     * DNS state.
     */
    reset(): void {
        this.records.clear();
        this.records4.clear();
        this.records6.clear();
        this.reverseRecords.clear();
    }

    // =========================================================================
    // DNSDEVICE IMPLEMENTATION
    // =========================================================================

    /**
     * Look up hostname (both IPv4 and IPv6).
     *
     * ALGORITHM:
     * 1. Lowercase hostname for case-insensitive lookup
     * 2. Check records map
     * 3. Return configured addresses or empty array
     *
     * WHY async: Matches DNSDevice interface. Even though mock is synchronous,
     * keeping it async allows tests to await consistently.
     *
     * @param host - Hostname to resolve
     * @returns Configured addresses or empty array
     */
    async lookup(host: string): Promise<string[]> {
        return this.records.get(host.toLowerCase()) ?? [];
    }

    /**
     * Look up hostname (IPv4 only).
     *
     * ALGORITHM:
     * 1. Check IPv4-specific records first
     * 2. If found, return them
     * 3. Otherwise, filter general records for IPv4 (no colons)
     * 4. Return result
     *
     * WHY filter general records: If test only defines general records, we
     * should still return IPv4 addresses when lookup4() is called. Filtering
     * by "no colons" reliably distinguishes IPv4 from IPv6.
     *
     * @param host - Hostname to resolve
     * @returns IPv4 addresses or empty array
     */
    async lookup4(host: string): Promise<string[]> {
        // Check specific records first, fall back to general
        const specific = this.records4.get(host.toLowerCase());

        if (specific) {
            return specific;
        }

        // Filter general records for IPv4
        const general = this.records.get(host.toLowerCase()) ?? [];

        return general.filter(addr => !addr.includes(':'));
    }

    /**
     * Look up hostname (IPv6 only).
     *
     * WHY filter by colons: IPv6 addresses always contain colons. IPv4 never do.
     * This is a reliable discriminator.
     *
     * @param host - Hostname to resolve
     * @returns IPv6 addresses or empty array
     */
    async lookup6(host: string): Promise<string[]> {
        const specific = this.records6.get(host.toLowerCase());

        if (specific) {
            return specific;
        }

        const general = this.records.get(host.toLowerCase()) ?? [];

        return general.filter(addr => addr.includes(':'));
    }

    /**
     * Reverse lookup.
     *
     * @param addr - IP address
     * @returns Configured hostnames or empty array
     */
    async reverse(addr: string): Promise<string[]> {
        return this.reverseRecords.get(addr) ?? [];
    }
}
