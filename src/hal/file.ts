/**
 * File Device - Host filesystem access for kernel operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The File Device provides direct access to the host filesystem for kernel-level
 * operations. This is a LOW-LEVEL, NON-STREAMING interface intended for specific
 * kernel use cases only.
 *
 * ============================================================================
 * WARNING: KERNEL USE ONLY
 * ============================================================================
 * This device is NOT for general application use. It exists for specific kernel
 * operations that require host filesystem access:
 *
 * - Loading bundled resources (schema.sql, configuration files)
 * - Kernel boot operations
 * - System initialization
 *
 * For user-space file operations, use the VFS layer which provides:
 * - Streaming I/O via channels
 * - Proper message-based communication
 * - Security boundaries and permissions
 * - Virtual filesystem abstraction
 *
 * WHY THIS EXISTS
 * ===============
 * The kernel needs to read host files during bootstrap (e.g., loading SQL schema)
 * before the VFS is initialized. This device provides that capability while
 * maintaining the HAL boundary (no direct Bun.file() calls outside HAL).
 *
 * LIMITATIONS
 * ===========
 * - Non-streaming: Reads entire file into memory at once
 * - No message passing: Direct method calls, not channel-based
 * - No write support: Read-only by design (kernel resources are read-only)
 * - No watch/subscribe: No file change notifications
 *
 * For streaming, message-based file I/O, use HAL channels or VFS.
 *
 * INVARIANTS
 * ==========
 * INV-1: read() returns entire file contents (non-streaming)
 * INV-2: readText() decodes as UTF-8
 * INV-3: All operations are async (filesystem I/O)
 * INV-4: File not found throws error (no silent null return)
 *
 * CONCURRENCY MODEL
 * =================
 * Operations are independent async calls. Multiple concurrent reads are safe
 * (filesystem handles locking). No shared mutable state in the device.
 *
 * BUN TOUCHPOINTS
 * ===============
 * - Bun.file(path) - Create file handle
 * - BunFile.arrayBuffer() - Read as bytes
 * - BunFile.text() - Read as UTF-8 string
 * - BunFile.exists() - Check existence
 * - BunFile.size - Get file size
 *
 * @module hal/file
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * File metadata.
 *
 * WHY: Allows checking file properties without reading content.
 * Useful for size checks before loading large files.
 */
export interface FileStat {
    /** File size in bytes */
    size: number;

    /** Whether the path exists */
    exists: boolean;
}

/**
 * File device interface.
 *
 * ============================================================================
 * KERNEL USE ONLY - See module documentation for restrictions.
 * ============================================================================
 *
 * WHY interface: Enables testing with mock implementations. Tests can provide
 * canned file contents without touching real filesystem.
 *
 * DESIGN: Intentionally minimal. Only read operations are supported because
 * kernel resources are read-only. For write operations, use VFS or channels.
 */
export interface FileDevice {
    /**
     * Read file as raw bytes.
     *
     * KERNEL USE ONLY: For loading binary resources during kernel bootstrap.
     *
     * WHY async: Filesystem I/O should never block the event loop.
     *
     * WHY Uint8Array: Universal byte representation. Caller can decode as
     * needed (text, JSON, binary format).
     *
     * ERROR HANDLING: Throws if file doesn't exist or read fails.
     * No silent null return - caller must handle errors explicitly.
     *
     * @param path - Absolute or relative path to file
     * @returns File contents as bytes
     * @throws Error if file not found or read fails
     */
    read(path: string): Promise<Uint8Array>;

    /**
     * Read file as UTF-8 text.
     *
     * KERNEL USE ONLY: For loading text resources (SQL schema, config files).
     *
     * WHY separate method: Common case optimization. Avoids caller needing
     * to decode bytes to string.
     *
     * WHY UTF-8: Universal text encoding. All kernel resources should be UTF-8.
     *
     * ERROR HANDLING: Throws if file doesn't exist, read fails, or content
     * is not valid UTF-8.
     *
     * @param path - Absolute or relative path to file
     * @returns File contents as UTF-8 string
     * @throws Error if file not found, read fails, or invalid UTF-8
     */
    readText(path: string): Promise<string>;

    /**
     * Check if file exists and get metadata.
     *
     * KERNEL USE ONLY: For checking resource availability before loading.
     *
     * WHY combined with exists: Single filesystem call is more efficient
     * than separate exists() and size() calls.
     *
     * @param path - Absolute or relative path to file
     * @returns File metadata (exists, size)
     */
    stat(path: string): Promise<FileStat>;
}

// =============================================================================
// BUN IMPLEMENTATION
// =============================================================================

/**
 * Bun file device implementation.
 *
 * ============================================================================
 * KERNEL USE ONLY - See module documentation for restrictions.
 * ============================================================================
 *
 * Wraps Bun.file() for host filesystem access. Maintains HAL boundary by
 * encapsulating all Bun file primitives.
 *
 * TESTABILITY: Interface allows dependency injection of mock implementations
 * for testing without real filesystem access.
 */
export class BunFileDevice implements FileDevice {
    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    /**
     * Read file as raw bytes.
     *
     * ALGORITHM:
     * 1. Create Bun file handle
     * 2. Read as ArrayBuffer (throws if not found)
     * 3. Convert to Uint8Array
     * 4. Return bytes
     *
     * WHY arrayBuffer then Uint8Array: Bun.file().arrayBuffer() returns
     * ArrayBuffer. We wrap in Uint8Array for consistent byte handling.
     *
     * RACE CONDITION FIX: Removed exists() check before read. The old
     * check-then-read pattern had a TOCTOU bug where file could be deleted
     * between exists() and arrayBuffer(). Now we catch errors from the
     * read operation directly.
     *
     * @param path - File path
     * @returns File contents as bytes
     * @throws Error if file not found or read fails
     */
    async read(path: string): Promise<Uint8Array> {
        const file = Bun.file(path);

        try {
            const buffer = await file.arrayBuffer();
            return new Uint8Array(buffer);
        } catch (err) {
            // Provide clear error message for common case
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('ENOENT') || message.includes('No such file')) {
                throw new Error(`File not found: ${path}`);
            }
            throw new Error(`Failed to read file ${path}: ${message}`);
        }
    }

    /**
     * Read file as UTF-8 text.
     *
     * ALGORITHM:
     * 1. Create Bun file handle
     * 2. Read as text (Bun decodes as UTF-8, throws if not found)
     * 3. Return string
     *
     * WHY Bun.file().text(): Bun handles UTF-8 decoding efficiently.
     * Avoids manual TextDecoder usage.
     *
     * RACE CONDITION FIX: Removed exists() check before read (TOCTOU bug).
     * Now catches errors from the read operation directly.
     *
     * @param path - File path
     * @returns File contents as UTF-8 string
     * @throws Error if file not found, read fails, or invalid UTF-8
     */
    async readText(path: string): Promise<string> {
        const file = Bun.file(path);

        try {
            return await file.text();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('ENOENT') || message.includes('No such file')) {
                throw new Error(`File not found: ${path}`);
            }
            throw new Error(`Failed to read file ${path}: ${message}`);
        }
    }

    /**
     * Check file existence and get metadata.
     *
     * ALGORITHM:
     * 1. Create Bun file handle
     * 2. Check existence
     * 3. Get size (0 if not exists)
     * 4. Return metadata
     *
     * WHY no throw on not exists: stat() is meant for checking existence.
     * Caller can inspect result.exists to determine if file is present.
     *
     * @param path - File path
     * @returns File metadata
     */
    async stat(path: string): Promise<FileStat> {
        const file = Bun.file(path);
        const exists = await file.exists();

        return {
            exists,
            // WHY conditional: file.size throws if file doesn't exist
            size: exists ? file.size : 0,
        };
    }
}

// =============================================================================
// MOCK IMPLEMENTATION (TESTING)
// =============================================================================

/**
 * Mock file device for testing.
 *
 * WHY: Enables testing kernel code without real filesystem access.
 * Tests can provide canned file contents and verify read patterns.
 *
 * USAGE:
 * ```typescript
 * const mockFile = new MockFileDevice();
 * mockFile.setFile('/path/to/schema.sql', 'CREATE TABLE ...');
 *
 * const content = await mockFile.readText('/path/to/schema.sql');
 * ```
 */
export class MockFileDevice implements FileDevice {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Map of path -> content.
     *
     * WHY Map: Fast O(1) lookups by path. Paths are case-sensitive.
     */
    private files = new Map<string, Uint8Array>();

    // =========================================================================
    // TEST SETUP
    // =========================================================================

    /**
     * Set file content (bytes).
     *
     * @param path - File path
     * @param content - File content as bytes
     */
    setFile(path: string, content: Uint8Array): void {
        this.files.set(path, content);
    }

    /**
     * Set file content (text).
     *
     * WHY convenience method: Most test files are text. Avoids manual encoding.
     *
     * @param path - File path
     * @param content - File content as UTF-8 string
     */
    setTextFile(path: string, content: string): void {
        this.files.set(path, new TextEncoder().encode(content));
    }

    /**
     * Clear all files.
     *
     * WHY: Test isolation. Each test can start with clean state.
     */
    clear(): void {
        this.files.clear();
    }

    // =========================================================================
    // FILEDEVICE IMPLEMENTATION
    // =========================================================================

    async read(path: string): Promise<Uint8Array> {
        const content = this.files.get(path);
        if (!content) {
            throw new Error(`File not found: ${path}`);
        }
        // WHY copy: Prevents test mutation of internal state
        return new Uint8Array(content);
    }

    async readText(path: string): Promise<string> {
        const bytes = await this.read(path);
        return new TextDecoder().decode(bytes);
    }

    async stat(path: string): Promise<FileStat> {
        const content = this.files.get(path);
        return {
            exists: content !== undefined,
            size: content?.length ?? 0,
        };
    }
}
