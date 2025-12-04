/**
 * ProcModel - Process information pseudo-filesystem
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * ProcModel implements the /proc filesystem, providing a file-like interface to
 * kernel process information. This mirrors the Linux /proc filesystem concept:
 * virtual files that are generated on read from live kernel data structures.
 *
 * Each process gets a directory under /proc/{uuid}/ containing virtual files:
 * - stat: Process status (JSON: id, name, parent, status, startTime)
 * - env: Environment variables (KEY=VALUE per line)
 * - cwd: Current working directory path
 * - fd/: Directory of open file descriptors
 *
 * Unlike regular files, proc files have no persistent storage. Content is
 * generated on each read from the ProcessRegistry, which the kernel maintains.
 * This ensures data is always current but means reads can vary between calls.
 *
 * The ProcModel requires a ProcessRegistry dependency to access process state.
 * This is injected at construction time, allowing tests to provide mock registries.
 *
 * STATE MACHINE (ProcHandle)
 * ==========================
 *
 *   open() ─────────> OPEN ─────────> CLOSED
 *                      │                 ^
 *                      │ first read()    │
 *                      v                 │
 *                   GENERATED ───────────┘
 *                      │                 close()
 *                      │ (content frozen)
 *
 * WHY content is frozen after first read:
 * Proc files generate content lazily. Once generated, the content is cached
 * for the lifetime of the handle. This provides consistent reads within a
 * single open session, even if the underlying process state changes.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Proc files are read-only (writes throw EROFS)
 * INV-2: Content is generated from ProcessRegistry at first read
 * INV-3: Once generated, content is immutable for handle lifetime
 * INV-4: Proc files are not seekable to negative positions
 * INV-5: Process not found returns placeholder text, not error
 * INV-6: Each proc file has a procType and processId in metadata
 *
 * CONCURRENCY MODEL
 * =================
 * The ProcessRegistry is shared mutable state maintained by the kernel.
 * Reads from the registry are not synchronized - we get a snapshot at
 * read time. The frozen-after-first-read design provides consistency
 * within a handle's lifetime.
 *
 * Multiple handles to the same proc file are independent - each generates
 * its own content snapshot on first read.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Content frozen after first read (consistency within handle)
 * RC-2: Handle closure check before every operation
 * RC-3: Process not found handled gracefully (not error)
 *
 * MEMORY MANAGEMENT
 * =================
 * - Content buffer allocated lazily on first read
 * - Buffer released on close() (set to null)
 * - ProcessRegistry is not owned - lifetime managed by kernel
 *
 * TESTABILITY
 * ===========
 * - ProcessRegistry is injectable via constructor
 * - ProcessState interface allows mock process data
 * - Exported createProcessProc function enables test setup
 *
 * @module vfs/models/proc
 */

import { PosixModel } from '@src/vfs/model.js';
import type { ModelStat, ModelContext, FieldDef } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions, SeekWhence } from '@src/vfs/handle.js';
import { ENOENT, EBADF, EACCES, EROFS, ENOTSUP } from '@src/hal/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Storage key prefix for entity metadata.
 * WHY: Consistent with other models; enables namespace partitioning.
 */
const ENTITY_PREFIX = 'entity:';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Schema definition for proc file entities.
 *
 * TESTABILITY: Exported constant allows tests to verify schema structure.
 *
 * Extended fields beyond base ModelStat:
 * - procType: Type of proc file (stat, env, cwd, fd)
 * - processId: UUID of the process this file describes
 */
const PROC_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'parent', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
    { name: 'procType', type: 'string', required: true },
    { name: 'processId', type: 'string', required: true },
    { name: 'mtime', type: 'number', required: true },
    { name: 'ctime', type: 'number', required: true },
];

/**
 * Types of proc files.
 *
 * WHY enum-like union:
 * Provides type safety for procType values while allowing string storage.
 */
type ProcType = 'stat' | 'env' | 'cwd' | 'fd';

/**
 * Process state stored in kernel.
 *
 * TESTABILITY: Exported interface allows tests to create mock process data.
 *
 * This represents the live state of a running process as maintained by
 * the kernel. The ProcessRegistry holds these records.
 */
export interface ProcessState {
    /** Process UUID - unique identifier */
    id: string;

    /** Process name - typically the command/binary name */
    name: string;

    /** Parent process UUID (null for init process) */
    parent: string | null;

    /** Current process status */
    status: 'running' | 'sleeping' | 'stopped' | 'zombie';

    /** Process start time (ms since epoch) */
    startTime: number;

    /** Current working directory path */
    cwd: string;

    /** Environment variables (key -> value) */
    env: Record<string, string>;

    /** Open file descriptors (fd number -> path) */
    fds: Record<number, string>;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Decode a Uint8Array to a JSON object.
 *
 * WHY: Centralizes JSON deserialization with proper typing.
 *
 * @param data - Raw bytes to decode
 * @returns Parsed JSON object
 */
function decodeEntity<T>(data: Uint8Array): T {
    return JSON.parse(new TextDecoder().decode(data)) as T;
}

/**
 * Encode a JSON object to a Uint8Array.
 *
 * WHY: Centralizes JSON serialization for storage.
 *
 * @param entity - Object to encode
 * @returns Encoded bytes
 */
function encodeEntity(entity: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(entity));
}

// =============================================================================
// PROCESS REGISTRY
// =============================================================================

/**
 * Registry for process state.
 *
 * ARCHITECTURE:
 * The kernel maintains this registry, updating it as processes are
 * created, modified, and terminated. ProcModel reads from it to
 * generate virtual file content.
 *
 * TESTABILITY:
 * Separate class allows tests to create isolated registries with
 * controlled process data.
 *
 * CONCURRENCY:
 * Methods are not synchronized. The kernel is responsible for
 * coordinating updates. Readers get snapshot views.
 */
export class ProcessRegistry {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Map of process UUID to state.
     *
     * WHY Map not object:
     * Map provides better iteration and size tracking.
     * Keys are UUIDs which won't collide with object prototype.
     */
    private readonly processes = new Map<string, ProcessState>();

    // =========================================================================
    // OPERATIONS
    // =========================================================================

    /**
     * Register a new process.
     *
     * WHY overwrite on duplicate:
     * Simpler than checking - caller should ensure uniqueness.
     *
     * @param state - Process state to register
     */
    register(state: ProcessState): void {
        this.processes.set(state.id, state);
    }

    /**
     * Unregister a process.
     *
     * WHY no error on missing:
     * Idempotent removal is safer for cleanup code.
     *
     * @param id - Process UUID to remove
     */
    unregister(id: string): void {
        this.processes.delete(id);
    }

    /**
     * Get process state by UUID.
     *
     * @param id - Process UUID
     * @returns Process state or undefined if not found
     */
    get(id: string): ProcessState | undefined {
        return this.processes.get(id);
    }

    /**
     * List all registered process UUIDs.
     *
     * @returns Array of process UUIDs
     */
    list(): string[] {
        return Array.from(this.processes.keys());
    }

    /**
     * Update fields on a registered process.
     *
     * WHY partial update:
     * Allows targeted state changes without full replacement.
     *
     * @param id - Process UUID
     * @param updates - Fields to update
     */
    update(id: string, updates: Partial<ProcessState>): void {
        const state = this.processes.get(id);
        if (state) {
            Object.assign(state, updates);
        }
    }

    // =========================================================================
    // TEST HELPERS
    // =========================================================================

    /**
     * Get count of registered processes.
     *
     * TESTING: Allows tests to verify cleanup.
     *
     * @returns Number of registered processes
     */
    size(): number {
        return this.processes.size;
    }

    /**
     * Clear all registered processes.
     *
     * TESTING: Allows tests to reset state between cases.
     */
    clear(): void {
        this.processes.clear();
    }
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * ProcModel - Process information pseudo-filesystem model.
 *
 * Implements read-only virtual files backed by kernel process state.
 * Content is generated dynamically from ProcessRegistry on read.
 */
export class ProcModel extends PosixModel {
    // =========================================================================
    // MODEL IDENTITY
    // =========================================================================

    /**
     * Model identifier.
     *
     * WHY: Used by VFS to dispatch operations to the correct model.
     * INVARIANT: Always 'proc' for this model.
     */
    readonly name = 'proc';

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Process registry for accessing kernel process state.
     *
     * WHY injected:
     * Enables testing with mock process data.
     * Lifetime managed by kernel, not this model.
     */
    private readonly registry: ProcessRegistry;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new ProcModel.
     *
     * @param registry - ProcessRegistry for accessing process state
     */
    constructor(registry: ProcessRegistry) {
        super();
        this.registry = registry;
    }

    // =========================================================================
    // SCHEMA
    // =========================================================================

    /**
     * Return field definitions for proc entities.
     *
     * WHY: Enables schema validation and introspection.
     *
     * @returns Array of field definitions
     */
    fields(): FieldDef[] {
        return PROC_FIELDS;
    }

    // =========================================================================
    // CORE OPERATIONS
    // =========================================================================

    /**
     * Open a proc file for reading.
     *
     * ALGORITHM:
     * 1. Verify not opened for writing (proc is read-only)
     * 2. Load entity metadata to get procType and processId
     * 3. Create ProcHandle with registry reference
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param flags - Open flags
     * @param _opts - Open options (unused for proc)
     * @returns ProcHandle for reading
     * @throws EROFS - If opened for writing
     * @throws ENOENT - If proc file entity not found
     */
    async open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        // Proc files are strictly read-only
        if (flags.write) {
            throw new EROFS('Proc files are read-only');
        }

        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Proc file not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat & { procType: ProcType; processId: string }>(data);

        return new ProcHandle(ctx, id, entity.procType, entity.processId, this.registry, flags);
    }

    /**
     * Get metadata for a proc file.
     *
     * WHY size is 0:
     * Proc files have no fixed size - content is generated on read.
     * Size could vary between reads as process state changes.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @returns Entity metadata with size=0
     * @throws ENOENT - If proc file not found
     */
    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`Proc file not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat>(data);
        return {
            ...entity,
            size: 0, // Size computed dynamically on read
        };
    }

    /**
     * Update metadata on a proc file.
     *
     * WHY this throws:
     * Proc files are read-only. Their metadata is set at creation
     * and reflects the process they describe, not user-modifiable.
     *
     * @throws EROFS - Always (proc files are read-only)
     */
    async setstat(_ctx: ModelContext, _id: string, _fields: Partial<ModelStat>): Promise<void> {
        throw new EROFS('Proc files are read-only');
    }

    /**
     * Create a new proc file.
     *
     * WHY this is allowed:
     * The kernel creates proc files when processes start. This is
     * a privileged operation - regular users cannot create arbitrary
     * proc files (enforced at VFS permission layer, not here).
     *
     * @param ctx - Model context
     * @param parent - Parent folder UUID
     * @param name - File name
     * @param fields - Must include procType and processId
     * @returns Created entity UUID
     */
    async create(
        ctx: ModelContext,
        parent: string,
        name: string,
        fields?: Partial<ModelStat> & { procType?: ProcType; processId?: string }
    ): Promise<string> {
        const id = ctx.hal.entropy.uuid();
        const now = ctx.hal.clock.now();

        const entity = {
            id,
            model: 'proc',
            name,
            parent,
            owner: fields?.owner ?? ctx.caller,
            procType: fields?.procType ?? 'stat',
            processId: fields?.processId ?? '',
            size: 0,
            mtime: now,
            ctime: now,
        };

        await ctx.hal.storage.put(`${ENTITY_PREFIX}${id}`, encodeEntity(entity));

        return id;
    }

    /**
     * Delete a proc file.
     *
     * WHY this is allowed:
     * The kernel deletes proc files when processes exit. Like create,
     * this is privileged but not enforced here.
     *
     * @param ctx - Model context
     * @param id - Entity UUID to delete
     */
    async unlink(ctx: ModelContext, id: string): Promise<void> {
        await ctx.hal.storage.delete(`${ENTITY_PREFIX}${id}`);
    }

    /**
     * List children of a proc folder.
     *
     * Finds all proc entities with the given parent.
     *
     * @param ctx - Model context
     * @param id - Parent folder UUID
     * @yields Child entity UUIDs
     */
    async *list(ctx: ModelContext, id: string): AsyncIterable<string> {
        for await (const key of ctx.hal.storage.list(ENTITY_PREFIX)) {
            const data = await ctx.hal.storage.get(key);
            if (!data) continue;

            const entity = decodeEntity<{ parent: string; model: string; id: string }>(data);
            if (entity.parent === id && entity.model === 'proc') {
                yield entity.id;
            }
        }
    }
}

// =============================================================================
// PROC HANDLE
// =============================================================================

/**
 * ProcHandle - Handle for reading proc files.
 *
 * Content is generated lazily on first read from ProcessRegistry.
 * Once generated, content is frozen for the handle's lifetime.
 */
class ProcHandle implements FileHandle {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique handle identifier.
     *
     * WHY: Enables handle tracking and revocation.
     */
    readonly id: string;

    /**
     * Path this handle was opened with.
     *
     * WHY: Required by FileHandle interface. Empty here because we open by ID.
     */
    readonly path: string = '';

    /**
     * Open flags.
     *
     * INVARIANT: write flag is always false (checked at open time).
     */
    readonly flags: OpenFlags;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether handle has been closed.
     *
     * INVARIANT: Once true, never becomes false.
     */
    private _closed = false;

    /**
     * Type of proc file.
     *
     * WHY stored: Determines content generation logic.
     */
    private readonly procType: ProcType;

    /**
     * UUID of the process this file describes.
     *
     * WHY stored: Used to look up process in registry.
     */
    private readonly processId: string;

    /**
     * Reference to process registry.
     *
     * WHY not copied: Need live access to current process state.
     */
    private readonly registry: ProcessRegistry;

    /**
     * Generated content buffer.
     *
     * WHY nullable: Content is generated lazily on first read.
     * Once generated, remains frozen until close().
     *
     * INVARIANT: Once non-null, content never changes.
     */
    private content: Uint8Array | null = null;

    /**
     * Current read position.
     *
     * INVARIANT: Always >= 0.
     */
    private position = 0;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new ProcHandle.
     *
     * @param ctx - Model context for UUID generation
     * @param _entityId - Entity UUID (unused, for logging)
     * @param procType - Type of proc file
     * @param processId - UUID of process
     * @param registry - Process registry
     * @param flags - Open flags
     */
    constructor(
        ctx: ModelContext,
        _entityId: string,
        procType: ProcType,
        processId: string,
        registry: ProcessRegistry,
        flags: OpenFlags
    ) {
        this.id = ctx.hal.entropy.uuid();
        this.procType = procType;
        this.processId = processId;
        this.registry = registry;
        this.flags = flags;
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Whether handle is closed.
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    /**
     * Read bytes from proc file.
     *
     * ALGORITHM:
     * 1. Validate handle state and permissions
     * 2. Generate content on first read (lazy)
     * 3. Return requested bytes from current position
     * 4. Advance position
     *
     * WHY content is frozen after first read:
     * Provides consistency within a handle's lifetime. Multiple reads
     * return consistent data even if process state changes.
     *
     * @param size - Maximum bytes to read (default: remaining)
     * @returns Bytes read (empty at EOF)
     * @throws EBADF - If handle is closed
     * @throws EACCES - If handle not opened for reading
     */
    async read(size?: number): Promise<Uint8Array> {
        // RACE FIX: Check closure state first
        if (this._closed) {
            throw new EBADF('Handle closed');
        }
        if (!this.flags.read) {
            throw new EACCES('Handle not opened for reading');
        }

        // Generate content lazily on first read
        if (this.content === null) {
            this.content = this.generateContent();
        }

        const remaining = this.content.length - this.position;
        const toRead = size !== undefined ? Math.min(size, remaining) : remaining;

        // At or past EOF
        if (toRead <= 0) {
            return new Uint8Array(0);
        }

        const result = this.content.slice(this.position, this.position + toRead);
        this.position += toRead;
        return result;
    }

    // =========================================================================
    // WRITE OPERATIONS
    // =========================================================================

    /**
     * Write to proc file.
     *
     * WHY this throws:
     * Proc files are read-only. They reflect kernel state, which
     * cannot be modified through the filesystem interface.
     *
     * @throws EROFS - Always (proc files are read-only)
     */
    async write(_data: Uint8Array): Promise<number> {
        throw new EROFS('Proc files are read-only');
    }

    // =========================================================================
    // POSITION OPERATIONS
    // =========================================================================

    /**
     * Seek to a position in the proc file.
     *
     * WHY seeking is supported:
     * Allows re-reading content or skipping to specific offsets.
     * Content is generated on first read and then frozen.
     *
     * @param offset - Byte offset from whence
     * @param whence - Reference point
     * @returns New position
     * @throws EBADF - If handle is closed
     * @throws ENOTSUP - If whence is invalid
     */
    async seek(offset: number, whence: SeekWhence): Promise<number> {
        // RACE FIX: Check closure state first
        if (this._closed) {
            throw new EBADF('Handle closed');
        }

        // Generate content if needed for seeking (need to know length)
        if (this.content === null) {
            this.content = this.generateContent();
        }

        let newPos: number;
        switch (whence) {
            case 'start':
                newPos = offset;
                break;
            case 'current':
                newPos = this.position + offset;
                break;
            case 'end':
                newPos = this.content.length + offset;
                break;
            default:
                throw new ENOTSUP(`Invalid whence: ${whence}`);
        }

        // Clamp to 0 (no negative positions)
        // WHY clamp not error: More forgiving for common seek patterns
        if (newPos < 0) {
            newPos = 0;
        }

        this.position = newPos;
        return this.position;
    }

    /**
     * Get current position.
     *
     * @returns Current byte offset
     */
    async tell(): Promise<number> {
        return this.position;
    }

    // =========================================================================
    // FLUSH OPERATIONS
    // =========================================================================

    /**
     * Sync proc file.
     *
     * WHY this is a no-op:
     * Proc files are read-only and have no backing storage.
     * There's nothing to sync.
     */
    async sync(): Promise<void> {
        // No-op for proc files
    }

    /**
     * Close handle and release resources.
     *
     * Releases the content buffer. Safe to call multiple times.
     */
    async close(): Promise<void> {
        this._closed = true;
        this.content = null; // Release memory
    }

    /**
     * AsyncDisposable support.
     */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Generate content for this proc file.
     *
     * ALGORITHM:
     * 1. Look up process in registry
     * 2. If not found, return placeholder text
     * 3. Format content based on procType
     *
     * WHY placeholder instead of error:
     * Process may have exited between file listing and read.
     * Returning a graceful message is more user-friendly than error.
     *
     * @returns Generated content bytes
     */
    private generateContent(): Uint8Array {
        const process = this.registry.get(this.processId);
        if (!process) {
            return new TextEncoder().encode('(process not found)\n');
        }

        let text: string;
        switch (this.procType) {
            case 'stat':
                // JSON format for machine parsing
                text = JSON.stringify(
                    {
                        id: process.id,
                        name: process.name,
                        parent: process.parent,
                        status: process.status,
                        startTime: process.startTime,
                    },
                    null,
                    2
                ) + '\n';
                break;

            case 'env':
                // KEY=VALUE format (one per line)
                text = Object.entries(process.env)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\n') + '\n';
                break;

            case 'cwd':
                // Plain path string
                text = process.cwd + '\n';
                break;

            case 'fd':
                // Tab-separated FD number and path
                text = Object.entries(process.fds)
                    .map(([fd, path]) => `${fd}\t${path}`)
                    .join('\n') + '\n';
                break;

            default:
                text = '(unknown proc type)\n';
        }

        return new TextEncoder().encode(text);
    }
}

// =============================================================================
// INITIALIZATION HELPERS
// =============================================================================

/**
 * Create proc entries for a new process.
 *
 * ALGORITHM:
 * 1. Create process folder under /proc
 * 2. Create virtual files: stat, env, cwd
 * 3. Create fd subdirectory
 *
 * WHY exported:
 * Called by kernel when spawning new processes.
 * Also useful for test setup.
 *
 * @param ctx - Model context
 * @param procFolderId - UUID of /proc folder
 * @param processState - State of the new process
 * @returns UUID of the created process folder
 */
export async function createProcessProc(
    ctx: ModelContext,
    procFolderId: string,
    processState: ProcessState
): Promise<string> {
    // ProcModel for creating proc files
    const procModel = new ProcModel(new ProcessRegistry());

    // Helper to create virtual folders via HAL storage (no SQL needed for /proc)
    const createVirtualFolder = async (
        parent: string,
        name: string,
        owner: string
    ): Promise<string> => {
        const id = ctx.hal.entropy.uuid();
        const now = ctx.hal.clock.now();
        const stat: ModelStat = {
            id,
            model: 'folder',
            name,
            parent,
            owner,
            size: 0,
            mtime: now,
            ctime: now,
        };
        await ctx.hal.storage.put(
            `entity:${id}`,
            new TextEncoder().encode(JSON.stringify(stat))
        );
        return id;
    };

    // Create process folder: /proc/{uuid}
    const processFolderId = await createVirtualFolder(
        procFolderId,
        processState.id,
        processState.id
    );

    // Define the standard proc files to create
    const procFiles: Array<{ name: string; procType: ProcType }> = [
        { name: 'stat', procType: 'stat' },
        { name: 'env', procType: 'env' },
        { name: 'cwd', procType: 'cwd' },
    ];

    // Create each proc file
    for (const { name, procType } of procFiles) {
        await procModel.create(ctx, processFolderId, name, {
            owner: processState.id,
            procType,
            processId: processState.id,
        } as ModelStat & { procType: ProcType; processId: string });
    }

    // Create fd subdirectory for file descriptors
    await createVirtualFolder(processFolderId, 'fd', processState.id);

    return processFolderId;
}
